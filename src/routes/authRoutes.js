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
} = require('../middleware/rateLimiter');

// Registration route
router.post('/register', registerLimiter, authController.register);

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
