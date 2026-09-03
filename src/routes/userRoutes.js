const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authMiddleware = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');

// Fetch current user details (private)
router.get('/profile', authMiddleware, userController.getProfile);

// Update current user details (private, allows optional file upload)
router.put('/profile', authMiddleware, upload.single('avatar'), userController.updateProfile);

// Fetch another creator's profile by username (public, optional auth to verify follow status)
router.get('/profile/:username', authMiddleware.optional, userController.getCreatorProfile);

// Toggle follow a user (private)
router.post('/follow/:creatorId', authMiddleware, userController.toggleFollow);

// Get list of followed creators (private)
router.get('/following', authMiddleware, userController.getFollowing);

// Search users by username or name (public/optional auth)
router.get('/search', authMiddleware.optional, userController.searchUsers);

module.exports = router;
