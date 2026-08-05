const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const authMiddleware = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');

// Create a post (private, expects multipart request with 'image')
router.post('/', authMiddleware, upload.single('image'), postController.createPost);

// Get global posts feed (optional auth for guest access)
router.get('/feed', authMiddleware.optional, postController.getFeed);

// Get explore category posts (optional auth)
router.get('/explore', authMiddleware.optional, postController.getExplorePosts);

// Fetch saved/bookmarked posts for logged-in user (private)
// (इसे dynamic '/:id' रूट से ऊपर कर दिया गया है ताकि Express इसे पहले मैच करे)
router.get('/saved', authMiddleware, postController.getSavedPosts);

// Get single post by ID (optional auth to verify like/bookmark status)
router.get('/:id', authMiddleware.optional, postController.getPostById);

// Delete a post by ID (private)
router.delete('/:id', authMiddleware, postController.deletePost);

// Toggle like on a post (private)
router.post('/:id/like', authMiddleware, postController.toggleLike);

// Toggle bookmark on a post (private)
router.post('/:id/bookmark', authMiddleware, postController.toggleBookmark);

// Get comments for a post (public, optional auth to verify comment like status)
router.get('/:id/comments', authMiddleware.optional, postController.getComments);

// Add a comment to a post (private)
router.post('/:id/comment', authMiddleware, postController.addComment);

// Toggle comment like status (private)
router.post('/comment/:commentId/like', authMiddleware, postController.toggleLikeComment);

// Get all posts of a specific user (public, checks like/bookmark with optional token)
router.get('/user/:userId', authMiddleware.optional, postController.getUserPosts);

module.exports = router;
