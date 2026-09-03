const express = require('express');
const router = express.Router();
const gamificationController = require('../controllers/gamificationController');
const { verifyToken, optionalToken } = require('../middleware/authMiddleware');

// Public / Optional Auth Leaderboard
router.get('/leaderboard', optionalToken, gamificationController.getLeaderboard);
router.get('/badges', optionalToken, gamificationController.getBadges);

// Authenticated User Gamification
router.get('/me', verifyToken, gamificationController.getUserGamificationProfile);
router.get('/points/history', verifyToken, gamificationController.getPointHistory);
router.post('/badges/featured', verifyToken, gamificationController.setFeaturedBadge);

module.exports = router;
