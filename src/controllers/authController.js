const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { sendOTPEmail } = require('../config/email');

const JWT_SECRET = process.env.JWT_SECRET || 'hidely_super_secret_jwt_key_2026';

// Helper to generate a 4-digit OTP matching the Flutter UI boxes
function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}




/**
 * Register User
 * POST /api/auth/register
 */
exports.register = async (req, res) => {
  const { name, email, password, username } = req.body;

  if (!name || !email || !password || !username) {
    return res.status(400).json({ error: 'Please provide all details (name, email, username, password).' });
  }

  const usernameClean = username.toLowerCase().trim();

  try {
    // Check if user already exists
    const userCheck = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'An account already exists with this email.' });
    }

    // Check if username is already taken
    const usernameCheck = await db.query('SELECT * FROM users WHERE username = $1', [usernameClean]);
    if (usernameCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Insert user (defaults: is_verified = false)
    const newUser = await db.query(
      'INSERT INTO users (name, email, password_hash, username) VALUES ($1, $2, $3, $4) RETURNING id, name, email, username, is_verified',
      [name.trim(), email.toLowerCase().trim(), passwordHash, usernameClean]
    );

    // Generate OTP
    const otpCode = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    // Store OTP in database
    await db.query(
      'INSERT INTO otps (email, otp_code, expires_at) VALUES ($1, $2, $3)',
      [email.toLowerCase().trim(), otpCode, expiresAt]
    );

    // Send email containing OTP
    try {
      await sendOTPEmail(email.toLowerCase().trim(), otpCode);
    } catch (emailErr) {
      console.error('Failed to send OTP email:', emailErr);
    }

    // Log the OTP to console for development verification
    console.log(`\n===========================================`);
    console.log(`[DEV] OTP Code for ${email}: ${otpCode}`);
    console.log(`===========================================\n`);

    return res.status(201).json({
      message: 'Registration successful. An OTP has been sent to your email.',
      email: newUser.rows[0].email,
      // For ease of local development, we can send it in response (or omit in production)
      dev_otp: otpCode, 
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
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Please provide email and OTP.' });
  }

  try {
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

    // Verify OTP matches
    if (dbOtp.otp_code !== otp.trim()) {
      return res.status(400).json({ error: 'Invalid OTP code. Please check and try again.' });
    }

    // Set user as verified
    const userResult = await db.query(
      'UPDATE users SET is_verified = TRUE WHERE email = $1 RETURNING id, name, email, username, is_verified',
      [emailLower]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    const user = userResult.rows[0];

    // Generate JWT token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    // Clean up used OTPs
    await db.query('DELETE FROM otps WHERE email = $1', [emailLower]);

    return res.status(200).json({
      message: 'OTP verified successfully.',
      token,
      user,
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
  const { email, password } = req.body;

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
      // Re-generate OTP
      const otpCode = generateOTP();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await db.query(
        'INSERT INTO otps (email, otp_code, expires_at) VALUES ($1, $2, $3)',
        [emailLower, otpCode, expiresAt]
      );

      // Send email containing OTP
      try {
        await sendOTPEmail(emailLower, otpCode);
      } catch (emailErr) {
        console.error('Failed to send login verification OTP email:', emailErr);
      }

      console.log(`\n===========================================`);
      console.log(`[DEV] New OTP for unverified login (${emailLower}): ${otpCode}`);
      console.log(`===========================================\n`);

      return res.status(403).json({
        error: 'Please verify your account first.',
        requiresVerification: true,
        email: user.email,
        dev_otp: otpCode,
      });
    }

    // Generate JWT token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    return res.status(200).json({
      message: 'Logged in successfully.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        bio: user.bio,
        profile_picture: user.profile_picture,
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
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Please provide an email address.' });
  }

  try {
    const emailLower = email.toLowerCase().trim();

    // Check user exists
    const userResult = await db.query('SELECT * FROM users WHERE email = $1', [emailLower]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'No account found with this email.' });
    }

    // Generate OTP
    const otpCode = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.query(
      'INSERT INTO otps (email, otp_code, expires_at) VALUES ($1, $2, $3)',
      [emailLower, otpCode, expiresAt]
    );

    // Send email containing OTP
    try {
      await sendOTPEmail(emailLower, otpCode);
    } catch (emailErr) {
      console.error('Failed to send forgot password OTP email:', emailErr);
    }

    console.log(`\n===========================================`);
    console.log(`[DEV] Forgot Password OTP for ${emailLower}: ${otpCode}`);
    console.log(`===========================================\n`);

    return res.status(200).json({
      message: 'Password reset OTP has been generated.',
      email: emailLower,
      dev_otp: otpCode,
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
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Please provide all details (email, otp, newPassword).' });
  }

  try {
    const emailLower = email.toLowerCase().trim();

    // Find the latest valid OTP
    const otpResult = await db.query(
      'SELECT * FROM otps WHERE email = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [emailLower]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({ error: 'OTP expired or not found.' });
    }

    if (otpResult.rows[0].otp_code !== otp.trim()) {
      return res.status(400).json({ error: 'Invalid OTP code.' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Update password
    await db.query('UPDATE users SET password_hash = $1 WHERE email = $2', [passwordHash, emailLower]);

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
  const { oldPassword, newPassword } = req.body;
  const userId = req.user.id;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Please provide both current and new passwords.' });
  }

  try {
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

    // Update password
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);

    return res.status(200).json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Error in changePassword:', error);
    return res.status(500).json({ error: 'Server error. Please try again later.' });
  }
};

