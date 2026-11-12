const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');
const chatController = require('../controllers/chatController');

router.use(authMiddleware);

router.get('/conversations', chatController.getConversations);
router.post('/direct', chatController.getOrCreateDirectConversation);
router.get('/conversations/:conversationId/messages', chatController.getMessages);
router.post('/conversations/:conversationId/messages', upload.chatMedia.single('media'), chatController.sendMessage);
router.post('/messages/:messageId/reactions', chatController.toggleReaction);
router.patch('/conversations/:conversationId/read', chatController.markAsRead);
router.patch('/conversations/:conversationId/pin', chatController.togglePin);
router.patch('/conversations/:conversationId/mute', chatController.toggleMute);
router.patch('/conversations/:conversationId/archive', chatController.toggleArchive);

module.exports = router;
