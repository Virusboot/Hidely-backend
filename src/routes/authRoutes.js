const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

// Registration route
router.post('/register', authController.register);

// OTP Verification route
router.post('/verify-otp', authController.verifyOTP);

// Login route
router.post('/login', authController.login);

// Forgot password request route
router.post('/forgot-password', authController.forgotPassword);

// Reset password route
router.post('/reset-password', authController.resetPassword);

// Change password (for logged in users)
router.post('/change-password', authMiddleware, authController.changePassword);

module.exports = router;
