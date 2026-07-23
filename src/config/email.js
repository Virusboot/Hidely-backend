const nodemailer = require('nodemailer');

// Create the transporter using environment variables or a default mock structure
const createTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[SMTP] Missing SMTP configuration environment variables. Emails will not be sent.');
    return null;
  }

  return nodemailer.createTransport({
    host: host,
    port: parseInt(port),
    secure: parseInt(port) === 465, // true for 465, false for other ports
    auth: {
      user: user,
      pass: pass,
    },
  });
};

/**
 * Send OTP Verification Email
 * @param {string} toEmail - Recipient email address
 * @param {string} otpCode - 4-digit OTP code
 */
const sendOTPEmail = async (toEmail, otpCode) => {
  const transporter = createTransporter();

  if (!transporter) {
    console.warn(`[SMTP] Skipped sending OTP email to ${toEmail} because SMTP is not configured.`);
    return false;
  }

  const mailOptions = {
    from: `"Hidely App" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: 'Hidely - Verify Your Email Address',
    text: `Hello,\n\nThank you for signing up on Hidely! Your verification code is: ${otpCode}\n\nThis OTP is valid for 10 minutes.\n\nBest regards,\nThe Hidely Team`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #6C63FF; text-align: center;">Welcome to Hidely!</h2>
        <p>Hello,</p>
        <p>Thank you for signing up on Hidely! Please use the following One-Time Password (OTP) to verify your email address:</p>
        <div style="text-align: center; margin: 30px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #111; border: 2px dashed #6C63FF; padding: 10px 20px; border-radius: 6px; background-color: #f9f9f9; display: inline-block;">
            ${otpCode}
          </span>
        </div>
        <p style="color: #666; font-size: 14px;">This OTP is valid for <strong>10 minutes</strong>. Please do not share this code with anyone.</p>
        <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 20px 0;">
        <p style="font-size: 12px; color: #999; text-align: center;">If you did not request this email, you can safely ignore it.</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[SMTP] OTP Email sent successfully to ${toEmail}. Message ID: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`[SMTP] Error sending email to ${toEmail}:`, error);
    return false;
  }
};

module.exports = {
  sendOTPEmail,
};
