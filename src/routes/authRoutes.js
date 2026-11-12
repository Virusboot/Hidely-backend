const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');
const {
  registerLimiter,
  loginLimiter,
  otpLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  availabilityLimiter,
} = require('../middleware/rateLimiter');

// Registration route
router.post('/register', registerLimiter, authController.register);

// Check Email or Username availability
router.post('/check-availability', availabilityLimiter, authController.checkAvailability);

// Send Email Verification OTP (during signup)
router.post('/send-email-otp', otpLimiter, authController.sendEmailOTP);

// Verify Email OTP (during signup)
router.post('/verify-email-otp', otpLimiter, authController.verifyEmailOTP);

// OTP Verification route
router.post('/verify-otp', otpLimiter, authController.verifyOTP);

// Login route
router.post('/login', loginLimiter, authController.login);

// Forgot password request route
router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);

// Reset password route
router.post('/reset-password', resetPasswordLimiter, authController.resetPassword);

// Change password (for logged in users)
router.post('/change-password', authMiddleware, authController.changePassword);

module.exports = router;
