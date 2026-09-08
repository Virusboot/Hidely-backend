const { Resend } = require('resend');
const nodemailer = require('nodemailer');

// Resend Configuration and Environment Validation
const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL;

if (!resendApiKey) {
  if (process.env.NODE_ENV === 'production') {
    console.warn('[Resend] Warning: RESEND_API_KEY environment variable is missing in production. Email delivery will be skipped.');
  } else {
    console.warn('[Resend] RESEND_API_KEY environment variable is not configured.');
  }
}

if (!resendFromEmail && process.env.NODE_ENV === 'production') {
  console.warn('[Resend] Warning: RESEND_FROM_EMAIL environment variable is missing in production.');
}

// Initialize Resend SDK instance if API key is provided
const resend = resendApiKey ? new Resend(resendApiKey) : null;

/**
 * Legacy SMTP Transporter retained for backward compatibility
 */
const createTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host: host,
    port: parseInt(port),
    secure: parseInt(port) === 465,
    auth: {
      user: user,
      pass: pass,
    },
    family: 4,
  });
};

/**
 * Send OTP Verification Email via Resend Email API
 * @param {string} toEmail - Recipient email address
 * @param {string} otpCode - 4-digit OTP code
 * @returns {Promise<boolean>} True if email delivery to Resend API succeeded, false otherwise
 */
const sendOTPEmail = async (toEmail, otpCode) => {
  if (!toEmail) {
    console.error('[Email] Cannot send OTP: No recipient email provided.');
    return false;
  }

  // Primary production email sending path using Resend API SDK
  if (resendApiKey && resend) {
    const fromAddress = resendFromEmail || 'Hidely App <onboarding@resend.dev>';
    const subject = 'Hidely - Verify Your Email Address';
    const textContent = `Hello,\n\nThank you for signing up on Hidely! Your verification code is: ${otpCode}\n\nThis OTP is valid for 10 minutes.\n\nBest regards,\nThe Hidely Team`;
    const htmlContent = `
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
    `;

    try {
      const { data, error } = await resend.emails.send({
        from: fromAddress,
        to: [toEmail],
        subject: subject,
        text: textContent,
        html: htmlContent,
      });

      if (error) {
        console.error(`[Resend] Error sending email to ${toEmail}:`, error.message || error);
        return false;
      }

      console.log(`[Resend] OTP Email sent successfully to ${toEmail}. Message ID: ${data?.id}`);
      return true;
    } catch (error) {
      console.error(`[Resend] Exception while sending email to ${toEmail}:`, error.message || error);
      return false;
    }
  }

  console.warn(`[Resend] RESEND_API_KEY is not configured. Email delivery to ${toEmail} skipped.`);
  return false;
};

module.exports = {
  sendOTPEmail,
  createTransporter,
};

