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

// Get list of followers (private/optional)
router.get('/followers', authMiddleware.optional, userController.getFollowers);
router.get('/followers/:username', authMiddleware.optional, userController.getFollowers);

// Get list of followed creators (private/optional)
router.get('/following', authMiddleware.optional, userController.getFollowing);
router.get('/following/:username', authMiddleware.optional, userController.getFollowing);

// Search users by username or name (public/optional auth)
router.get('/search', authMiddleware.optional, userController.searchUsers);

// Blocked users management (private)
router.get('/blocked', authMiddleware, userController.getBlockedUsers);
router.post('/block/:identifier', authMiddleware, userController.blockUser);
router.delete('/block/:identifier', authMiddleware, userController.unblockUser);

// Tags & Mentions privacy settings & post tag approvals (private)
router.get('/privacy/tags-mentions', authMiddleware, userController.getTagMentionSettings);
router.put('/privacy/tags-mentions', authMiddleware, userController.updateTagMentionSettings);
router.post('/privacy/check-tags-mentions', authMiddleware, userController.checkTagMentionEligibility);
router.get('/tags', authMiddleware, userController.getTaggedPosts);
router.patch('/tags/:postId', authMiddleware, userController.respondToPostTag);
router.delete('/tags/:postId', authMiddleware, userController.removePostTag);

module.exports = router;
