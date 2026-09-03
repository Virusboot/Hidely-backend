const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const multer = require('multer');
const path = require('path');
const chatController = require('../controllers/chatController');

// Multer storage configuration for chat media
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'chat-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

router.use(authMiddleware);

router.get('/conversations', chatController.getConversations);
router.post('/direct', chatController.getOrCreateDirectConversation);
router.get('/conversations/:conversationId/messages', chatController.getMessages);
router.post('/conversations/:conversationId/messages', upload.single('media'), chatController.sendMessage);
router.post('/messages/:messageId/reactions', chatController.toggleReaction);
router.patch('/conversations/:conversationId/read', chatController.markAsRead);
router.patch('/conversations/:conversationId/pin', chatController.togglePin);
router.patch('/conversations/:conversationId/mute', chatController.toggleMute);
router.patch('/conversations/:conversationId/archive', chatController.toggleArchive);

module.exports = router;
