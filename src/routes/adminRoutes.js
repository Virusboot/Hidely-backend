const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminMiddleware = require('../middleware/adminMiddleware');
const { loginLimiter } = require('../middleware/rateLimiter');
const upload = require('../middleware/upload');

function validateIntParam(paramName) {
  return (req, res, next) => {
    const val = parseInt(req.params[paramName], 10);
    if (!Number.isInteger(val) || val <= 0 || String(val) !== String(req.params[paramName]).trim()) {
      return res.status(400).json({ error: `Invalid ${paramName} parameter.` });
    }
    req.params[paramName] = String(val);
    next();
  };
}

// Public Admin Auth (rate limited)
router.post('/login', loginLimiter, adminController.loginAdmin);

// Protected Admin Endpoints
router.use(adminMiddleware);

// Dashboard
router.get('/stats', adminController.getDashboardStats);

// Users Management
router.get('/users', adminController.getUsers);
router.put('/users/:id', validateIntParam('id'), adminController.updateUser);
router.delete('/users/:id', validateIntParam('id'), adminController.deleteUser);

// Curated Places Management
router.get('/places', adminController.getPlaces);
router.post('/places', upload.single('image'), adminController.createPlace);
router.put('/places/:id', validateIntParam('id'), upload.single('image'), adminController.updatePlace);
router.delete('/places/:id', validateIntParam('id'), adminController.deletePlace);

// Posts Moderation
router.get('/posts', adminController.getPosts);
router.delete('/posts/:id', validateIntParam('id'), adminController.deletePost);

// Content Reports Moderation Queue (24h Safety SLA)
router.get('/reports', adminController.getReports);
router.patch('/reports/:id', validateIntParam('id'), adminController.moderateReport);

// Broadcast Notifications
router.post('/broadcast', adminController.broadcastNotification);

// Reward Configuration Management
router.get('/rewards/config', adminController.getRewardConfig);
router.put('/rewards/config', adminController.updateRewardConfig);

module.exports = router;
