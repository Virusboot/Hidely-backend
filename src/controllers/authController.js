const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { sendOTPEmail } = require('../config/email');
const { JWT_SECRET } = require('../config/jwt');

const MAX_OTP_ATTEMPTS = 5;
const USERNAME_REGEX = /^[a-z0-9._]{3,30}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let authSecurityColsEnsured = false;

async function ensureAuthSecurityColumns() {
  if (authSecurityColsEnsured) return;
  try {
    await db.query(`
      ALTER TABLE otps
      ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;

      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS accepted_terms_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS is_adult_confirmed BOOLEAN DEFAULT TRUE;
    `);
    authSecurityColsEnsured = true;
  } catch (err) {
    // Non-fatal in mocked unit tests or legacy DB contexts
    console.warn('[Auth] ensureAuthSecurityColumns notice:', err.message);
  }
}

// Cryptographically secure 4-digit OTP generator
function generateOTP() {
  return crypto.randomInt(1000, 10000).toString();
}

function timingSafeOtpMatch(expectedOtp, suppliedOtp) {
  const a = Buffer.from(String(expectedOtp || '').trim(), 'utf8');
  const b = Buffer.from(String(suppliedOtp || '').trim(), 'utf8');
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (password.length > 72) {
    return 'Password cannot exceed 72 characters.';
  }
  return null;
}

function signAuthToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, tv: Number(user.token_version || 0) },
    JWT_SECRET,
    { expiresIn: '90d' }
  );
}




/**
 * Register User
 * POST /api/auth/register
 */
exports.register = async (req, res) => {
  const { name, email, password, username, gender, age_confirmed, terms_accepted } = req.body || {};

  if (!name || !email || !password || !username) {
    return res.status(400).json({ error: 'Please provide all details (name, email, username, password).' });
  }

  if (age_confirmed === false || terms_accepted === false) {
    return res.status(400).json({
      error: 'You must confirm that you are 18+ years old and agree to Hidely Terms & Privacy Policy.',
    });
  }

  const emailLower = email.toString().toLowerCase().trim();
  const usernameClean = username.toString().toLowerCase().trim();
  const nameClean = name.toString().trim();

  if (!EMAIL_REGEX.test(emailLower)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  if (!USERNAME_REGEX.test(usernameClean)) {
    return res.status(400).json({
      error: 'Username must be 3-30 characters using only lowercase letters, numbers, underscores, or periods.',
    });
  }

  const passwordErr = validatePasswordStrength(password);
  if (passwordErr) {
    return res.status(400).json({ error: passwordErr });
  }

  try {
    await ensureAuthSecurityColumns();

    // Check if user already exists (never delete existing rows blindly)
    const userCheck = await db.query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [emailLower]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'An account already exists with this email.' });
    }

    // Check if username is already taken
    const usernameCheck = await db.query('SELECT id FROM users WHERE LOWER(username) = $1 LIMIT 1', [usernameClean]);
    if (usernameCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    // Require prior server-verified OTP proof before account creation
    const verifiedOtpCheck = await db.query(
      `SELECT id FROM otps
       WHERE email = $1
         AND verified_at IS NOT NULL
         AND verified_at > NOW() - INTERVAL '30 minutes'
       ORDER BY verified_at DESC
       LIMIT 1`,
      [emailLower]
    );
    if (verifiedOtpCheck.rows.length === 0) {
      return res.status(400).json({
        error: 'Email verification required. Please verify your email OTP before completing registration.',
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const genderClean = (gender || '').toString().trim();

    let newUser;
    try {
      newUser = await db.query(
        `INSERT INTO users (name, email, password_hash, username, gender, is_verified, token_version, accepted_terms_at, is_adult_confirmed)
         VALUES ($1, $2, $3, $4, $5, TRUE, 0, CURRENT_TIMESTAMP, TRUE)
         RETURNING id, name, email, username, gender, bio, profile_picture, is_verified, COALESCE(token_version, 0) AS token_version`,
        [nameClean, emailLower, passwordHash, usernameClean, genderClean]
      );
    } catch (colErr) {
      if (colErr && colErr.code === '42703') {
        newUser = await db.query(
          `INSERT INTO users (name, email, password_hash, username, gender, is_verified)
           VALUES ($1, $2, $3, $4, $5, TRUE)
           RETURNING id, name, email, username, gender, bio, profile_picture, is_verified`,
          [nameClean, emailLower, passwordHash, usernameClean, genderClean]
        );
      } else {
        throw colErr;
      }
    }

    const user = newUser.rows[0];
    await db.query('DELETE FROM otps WHERE email = $1', [emailLower]);

    const token = signAuthToken(user);

    return res.status(201).json({
      message: 'Registration successful!',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        gender: user.gender || '',
        bio: user.bio || '',
        profile_picture: user.profile_picture || '',
        is_verified: user.is_verified,
      },
    });
  } catch (error) {
    console.error('Error in registration:', error);
    return res.status(500).json({ error: 'Server error. Please try again later.' });
  }
};

/**
 * Verify OTP
 * POST /api/auth/verify-otp
 */
exports.verifyOTP = async (req, res) => {
  const { email, otp } = req.body || {};

  if (!email || !otp) {
    return res.status(400).json({ error: 'Please provide email and OTP.' });
  }

  try {
    await ensureAuthSecurityColumns();
    const emailLower = email.toLowerCase().trim();

    // Get the latest valid OTP for this email
    const otpResult = await db.query(
      'SELECT * FROM otps WHERE email = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [emailLower]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({ error: 'OTP expired or not found. Please request a new one.' });
    }

    const dbOtp = otpResult.rows[0];
    if (Number(dbOtp.attempts || 0) >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({
        error: 'Too many failed OTP attempts. Please request a new verification code.',
      });
    }

    // Verify OTP matches using timing-safe comparison
    if (!timingSafeOtpMatch(dbOtp.otp_code, otp)) {
      await db.query(
        'UPDATE otps SET attempts = COALESCE(attempts, 0) + 1 WHERE id = $1',
        [dbOtp.id]
      ).catch(() => {});
      return res.status(400).json({ error: 'Invalid OTP code. Please check and try again.' });
    }

    // Set user as verified
    let userResult;
    try {
      userResult = await db.query(
        'UPDATE users SET is_verified = TRUE WHERE email = $1 RETURNING id, name, email, username, gender, bio, profile_picture, is_verified, COALESCE(token_version, 0) AS token_version',
        [emailLower]
      );
    } catch (colErr) {
      if (colErr && colErr.code === '42703') {
        userResult = await db.query(
          'UPDATE users SET is_verified = TRUE WHERE email = $1 RETURNING id, name, email, username, gender, bio, profile_picture, is_verified',
          [emailLower]
        );
      } else {
        throw colErr;
      }
    }

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    const user = userResult.rows[0];

    // Generate JWT token
    const token = signAuthToken(user);

    // Clean up used OTPs
    await db.query('DELETE FROM otps WHERE email = $1', [emailLower]);

    return res.status(200).json({
      message: 'OTP verified successfully.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        gender: user.gender || '',
        bio: user.bio || '',
        profile_picture: user.profile_picture || '',
        is_verified: user.is_verified,
      },
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return res.status(500).json({ error: 'Server error. Please try again later.' });
  }
};

/**
 * Login User
 * POST /api/auth/login
 */
exports.login = async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter both email and password.' });
  }

  try {
    const emailLower = email.toLowerCase().trim();

    // Check user exists
    const userResult = await db.query('SELECT * FROM users WHERE email = $1', [emailLower]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const user = userResult.rows[0];

    // Check password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // If not verified, require verification
    if (!user.is_verified) {
      await ensureAuthSecurityColumns();
      const otpCode = generateOTP();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await db.query('DELETE FROM otps WHERE email = $1', [emailLower]);
      await db.query(
        'INSERT INTO otps (email, otp_code, expires_at) VALUES ($1, $2, $3)',
        [emailLower, otpCode, expiresAt]
      );

      // Send email containing OTP (non-blocking background task)
      sendOTPEmail(emailLower, otpCode).catch(emailErr => {
        console.error('Failed to send login verification OTP email:', emailErr);
      });

      return res.status(403).json({
        error: 'Please verify your account first.',
        requiresVerification: true,
        email: user.email,
      });
    }

    // Generate JWT token
    const token = signAuthToken(user);

    return res.status(200).json({
      message: 'Logged in successfully.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username || '',
        gender: user.gender || '',
        bio: user.bio || '',
        profile_picture: user.profile_picture || '',
        is_verified: user.is_verified,
      },
    });
  } catch (error) {
    console.error('Error during login:', error);
    return res.status(500).json({ error: 'Server error. Please try again later.' });
  }
};

/**
 * Forgot Password
 * POST /api/auth/forgot-password
 */
exports.forgotPassword = async (req, res) => {
  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: 'Please provide an email address.' });
  }

  try {
    await ensureAuthSecurityColumns();
    const emailLower = email.toLowerCase().trim();

    // Check user exists
    const userResult = await db.query('SELECT id FROM users WHERE email = $1', [emailLower]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'No account found with this email.' });
    }

    // Replace previous OTPs and generate CSPRNG OTP
    const otpCode = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.query('DELETE FROM otps WHERE email = $1', [emailLower]);
    await db.query(
      'INSERT INTO otps (email, otp_code, expires_at) VALUES ($1, $2, $3)',
      [emailLower, otpCode, expiresAt]
    );

    // Send email containing OTP (non-blocking background task)
    sendOTPEmail(emailLower, otpCode).catch(emailErr => {
      console.error('Failed to send forgot password OTP email:', emailErr);
    });

    return res.status(200).json({
      message: 'Password reset OTP has been sent to your registered email.',
      email: emailLower,
    });
  } catch (error) {
    console.error('Error in forgotPassword:', error);
    return res.status(500).json({ error: 'Server error. Please try again later.' });
  }
};

/**
 * Reset Password
 * POST /api/auth/reset-password
 */
exports.resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body || {};

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Please provide all details (email, otp, newPassword).' });
  }

  const passwordErr = validatePasswordStrength(newPassword);
  if (passwordErr) {
    return res.status(400).json({ error: passwordErr });
  }

  try {
    await ensureAuthSecurityColumns();
    const emailLower = email.toLowerCase().trim();

    // Find the latest valid OTP
    const otpResult = await db.query(
      'SELECT * FROM otps WHERE email = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [emailLower]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({ error: 'OTP expired or not found.' });
    }

    const dbOtp = otpResult.rows[0];
    if (Number(dbOtp.attempts || 0) >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({
        error: 'Too many failed OTP attempts. Please request a new reset OTP.',
      });
    }

    if (!timingSafeOtpMatch(dbOtp.otp_code, otp)) {
      await db.query(
        'UPDATE otps SET attempts = COALESCE(attempts, 0) + 1 WHERE id = $1',
        [dbOtp.id]
      ).catch(() => {});
      return res.status(400).json({ error: 'Invalid OTP code.' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Update password and revoke all existing JWT sessions by bumping token_version
    try {
      await db.query(
        'UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE email = $2',
        [passwordHash, emailLower]
      );
    } catch (colErr) {
      if (colErr && colErr.code === '42703') {
        await db.query('UPDATE users SET password_hash = $1 WHERE email = $2', [passwordHash, emailLower]);
      } else {
        throw colErr;
      }
    }

    // Clean up OTPs
    await db.query('DELETE FROM otps WHERE email = $1', [emailLower]);

    return res.status(200).json({ message: 'Password has been reset successfully.' });
  } catch (error) {
    console.error('Error in resetPassword:', error);
    return res.status(500).json({ error: 'Server error. Please try again later.' });
  }
};

/**
 * Change Password (for logged in users)
 * POST /api/auth/change-password
 */
exports.changePassword = async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const userId = req.user.id;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Please provide both current and new passwords.' });
  }

  const passwordErr = validatePasswordStrength(newPassword);
  if (passwordErr) {
    return res.status(400).json({ error: passwordErr });
  }

  try {
    await ensureAuthSecurityColumns();

    // Fetch user
    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = userResult.rows[0];

    // Check old password matches
    const isMatch = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Incorrect current password.' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Update password and revoke all prior sessions; issue fresh token for current caller
    let updatedUser;
    try {
      const updateRes = await db.query(
        `UPDATE users
         SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING id, email, COALESCE(token_version, 0) AS token_version`,
        [passwordHash, userId]
      );
      updatedUser = updateRes.rows[0];
    } catch (colErr) {
      if (colErr && colErr.code === '42703') {
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
        updatedUser = { id: user.id, email: user.email, token_version: 0 };
      } else {
        throw colErr;
      }
    }

    const newToken = signAuthToken(updatedUser);

    return res.status(200).json({
      message: 'Password changed successfully.',
      token: newToken,
    });
  } catch (error) {
    console.error('Error in changePassword:', error);
    return res.status(500).json({ error: 'Server error. Please try again later.' });
  }
};

/**
 * Send OTP for Email Verification (Sign up)
 * POST /api/auth/send-email-otp
 */
exports.sendEmailOTP = async (req, res) => {
  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: 'Please enter your email address.' });
  }

  const emailLower = email.toString().toLowerCase().trim();
  if (!EMAIL_REGEX.test(emailLower)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    await ensureAuthSecurityColumns();

    // Check if an account already exists with this email
    const userCheck = await db.query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [emailLower]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'An account already exists with this email.' });
    }

    // Clean up any old OTPs for this email
    await db.query('DELETE FROM otps WHERE email = $1', [emailLower]);

    // Generate CSPRNG 4-digit OTP code
    const otpCode = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await db.query(
      'INSERT INTO otps (email, otp_code, expires_at) VALUES ($1, $2, $3)',
      [emailLower, otpCode, expiresAt]
    );

    // Send email via Resend / SMTP
    sendOTPEmail(emailLower, otpCode).catch(err => {
      console.error('[Resend/SMTP] Error sending signup verification OTP:', err);
    });

    const allowDevOtp =
      process.env.NODE_ENV !== 'production' &&
      process.env.ALLOW_DEV_OTP === 'true';

    console.log(`[Signup OTP] Verification code generated for ${emailLower}.`);

    return res.status(200).json({
      message: 'Verification code sent to your email.',
      ...(allowDevOtp ? { dev_otp: otpCode } : {}),
    });
  } catch (error) {
    console.error('Error in sendEmailOTP:', error);
    return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
};

/**
 * Verify Email OTP (Sign up step)
 * POST /api/auth/verify-email-otp
 */
exports.verifyEmailOTP = async (req, res) => {
  const { email, otp } = req.body || {};

  if (!email || !otp) {
    return res.status(400).json({ error: 'Please enter email and verification code.' });
  }

  const emailLower = email.toString().toLowerCase().trim();

  try {
    await ensureAuthSecurityColumns();

    const otpResult = await db.query(
      'SELECT * FROM otps WHERE email = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [emailLower]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({ error: 'Code expired or not found. Please request a new one.' });
    }

    const dbOtp = otpResult.rows[0];
    if (Number(dbOtp.attempts || 0) >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({
        error: 'Too many failed verification attempts. Please request a new code.',
      });
    }

    if (!timingSafeOtpMatch(dbOtp.otp_code, otp)) {
      await db.query(
        'UPDATE otps SET attempts = COALESCE(attempts, 0) + 1 WHERE id = $1',
        [dbOtp.id]
      ).catch(() => {});
      return res.status(400).json({ error: 'Invalid verification code. Please check and try again.' });
    }

    await db.query(
      'UPDATE otps SET verified_at = CURRENT_TIMESTAMP WHERE id = $1',
      [dbOtp.id]
    ).catch(() => {});

    return res.status(200).json({
      message: 'Email verified successfully!',
    });
  } catch (error) {
    console.error('Error in verifyEmailOTP:', error);
    return res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
};

/**
 * Check Email or Username Availability (Sign up pre-validation)
 * POST /api/auth/check-availability
 */
exports.checkAvailability = async (req, res) => {
  const { email, username } = req.body;

  try {
    if (email) {
      const emailClean = email.toLowerCase().trim();
      const userCheck = await db.query(
        'SELECT id, is_verified FROM users WHERE email = $1',
        [emailClean]
      );
      if (userCheck.rows.length > 0 && userCheck.rows[0].is_verified) {
        return res.status(400).json({
          available: false,
          error: 'An account already exists with this email.',
          field: 'email',
        });
      }
    }

    if (username) {
      const usernameClean = username.toLowerCase().trim();
      const userCheck = await db.query(
        'SELECT id, is_verified FROM users WHERE username = $1',
        [usernameClean]
      );
      if (userCheck.rows.length > 0 && userCheck.rows[0].is_verified) {
        return res.status(400).json({
          available: false,
          error: 'Username is already taken.',
          field: 'username',
        });
      }
    }

    return res.status(200).json({
      available: true,
      message: 'Available.',
    });
  } catch (error) {
    console.error('Error in checkAvailability:', error);
    return res.status(500).json({ error: 'Server error checking availability.' });
  }
};



