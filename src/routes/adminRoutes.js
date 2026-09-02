const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminMiddleware = require('../middleware/adminMiddleware');
const upload = require('../middleware/upload');

// Public Admin Auth
router.post('/login', adminController.loginAdmin);

// Protected Admin Endpoints
router.use(adminMiddleware);

// Dashboard
router.get('/stats', adminController.getDashboardStats);

// Users Management
router.get('/users', adminController.getUsers);
router.put('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.deleteUser);

// Curated Places Management
router.get('/places', adminController.getPlaces);
router.post('/places', upload.single('image'), adminController.createPlace);
router.put('/places/:id', upload.single('image'), adminController.updatePlace);
router.delete('/places/:id', adminController.deletePlace);

// Posts Moderation
router.get('/posts', adminController.getPosts);
router.delete('/posts/:id', adminController.deletePost);

// Broadcast Notifications
router.post('/broadcast', adminController.broadcastNotification);

module.exports = router;
