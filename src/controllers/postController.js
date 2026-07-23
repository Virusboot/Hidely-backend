const db = require('../config/db');
const { uploadToCloudinary } = require('../config/cloudinary');

/**
 * Create a new travel post
 * POST /api/posts
 */
exports.createPost = async (req, res) => {
  const userId = req.user.id;
  const { caption, location, category } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'Please upload a media file (image or video) for the post.' });
  }

  try {
    // Upload the file to Cloudinary in the posts folder
    const imageUrl = await uploadToCloudinary(req.file.path, 'hidely/posts');

    const newPostResult = await db.query(
      'INSERT INTO posts (user_id, caption, image_url, location, category) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [userId, caption || '', imageUrl, location || '', category || '']
    );

    const post = newPostResult.rows[0];

    // Increment points for the user (+100 points for discovering a place)
    await db.query('UPDATE users SET points = COALESCE(points, 7120) + 100 WHERE id = $1', [userId]);

    // Fetch creator's name/username
    const authorResult = await db.query('SELECT name, username FROM users WHERE id = $1', [userId]);
    const authorName = authorResult.rows[0].name || authorResult.rows[0].username;

    // Trigger notification to the author themselves about points earned
    await db.query(
      `INSERT INTO notifications (user_id, actor_id, type, post_id, text)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        userId,
        'points_earned',
        post.id,
        'You discovered a new place and earned 100 points!'
      ]
    );

    // Send notifications to all followers
    const followers = await db.query('SELECT follower_id FROM user_follows WHERE following_id = $1', [userId]);
    for (const row of followers.rows) {
      await db.query(
        `INSERT INTO notifications (user_id, actor_id, type, post_id, text)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          row.follower_id,
          userId,
          'new_post',
          post.id,
          `${authorName} posted a new travel post.`
        ]
      );
    }

    return res.status(201).json({
      message: 'Post created successfully.',
      post,
    });
  } catch (error) {
    console.error('Error creating post:', error);
    return res.status(500).json({ error: 'Server error creating post.' });
  }
};

/**
 * Fetch global feed posts
 * GET /api/posts/feed
 */
exports.getFeed = async (req, res) => {
  const userId = req.user.id;

  try {
    // Left outer join to check if the current user liked the post
    const feedResult = await db.query(
      `SELECT 
        p.id, 
        p.caption, 
        p.image_url, 
        p.location, 
        p.category, 
        p.likes_count, 
        p.created_at,
        u.id AS author_id,
        u.name AS author_name,
        u.username AS author_username,
        u.profile_picture AS author_profile_picture,
        COALESCE(
          (SELECT TRUE FROM post_likes WHERE post_id = p.id AND user_id = $1 LIMIT 1), 
          FALSE
        ) AS is_liked,
        COALESCE(
          (SELECT TRUE FROM post_bookmarks WHERE post_id = p.id AND user_id = $1 LIMIT 1), 
          FALSE
        ) AS is_bookmarked,
        COALESCE(
          (SELECT COUNT(*)::int FROM post_comments WHERE post_id = p.id), 
          0
        ) AS comments_count
      FROM posts p
      INNER JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC`,
      [userId]
    );

    return res.status(200).json({
      feed: feedResult.rows,
    });
  } catch (error) {
    console.error('Error fetching post feed:', error);
    return res.status(500).json({ error: 'Server error fetching posts feed.' });
  }
};

/**
 * Toggle like/unlike on a post
 * POST /api/posts/:id/like
 */
exports.toggleLike = async (req, res) => {
  const userId = req.user.id;
  const postId = parseInt(req.params.id);

  try {
    // Check if post exists
    const postResult = await db.query('SELECT * FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    // Check if user already liked the post
    const likeCheck = await db.query('SELECT * FROM post_likes WHERE user_id = $1 AND post_id = $2', [
      userId,
      postId,
    ]);

    let isLiked = false;

    if (likeCheck.rows.length > 0) {
      // Unlike post: remove row
      await db.query('DELETE FROM post_likes WHERE user_id = $1 AND post_id = $2', [userId, postId]);
      // Decrement likes count
      await db.query('UPDATE posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = $1', [postId]);
      isLiked = false;
    } else {
      // Like post: insert row
      await db.query('INSERT INTO post_likes (user_id, post_id) VALUES ($1, $2)', [userId, postId]);
      // Increment likes count
      await db.query('UPDATE posts SET likes_count = likes_count + 1 WHERE id = $1', [postId]);
      isLiked = true;

      // Send notification if liked by someone else
      const postCreator = postResult.rows[0].user_id;
      if (postCreator !== userId) {
        const actorInfo = await db.query('SELECT name, username FROM users WHERE id = $1', [userId]);
        const actorName = actorInfo.rows[0].name || actorInfo.rows[0].username;
        await db.query(
          `INSERT INTO notifications (user_id, actor_id, type, post_id, text)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            postCreator,
            userId,
            'like',
            postId,
            `${actorName} liked your AR capture.`
          ]
        );
      }
    }

    // Fetch updated likes count
    const updatedPost = await db.query('SELECT likes_count FROM posts WHERE id = $1', [postId]);

    return res.status(200).json({
      message: isLiked ? 'Post liked.' : 'Post unliked.',
      is_liked: isLiked,
      likes_count: updatedPost.rows[0].likes_count,
    });
  } catch (error) {
    console.error('Error toggling like:', error);
    return res.status(500).json({ error: 'Server error toggling like.' });
  }
};

/**
 * Toggle bookmark/save on a post
 * POST /api/posts/:id/bookmark
 */
exports.toggleBookmark = async (req, res) => {
  const userId = req.user.id;
  const postId = parseInt(req.params.id);

  try {
    // Check if post exists
    const postResult = await db.query('SELECT * FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    // Check if user already bookmarked
    const bookmarkCheck = await db.query(
      'SELECT * FROM post_bookmarks WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );

    let isBookmarked = false;

    if (bookmarkCheck.rows.length > 0) {
      // Unbookmark
      await db.query('DELETE FROM post_bookmarks WHERE user_id = $1 AND post_id = $2', [
        userId,
        postId,
      ]);
      isBookmarked = false;
    } else {
      // Bookmark
      await db.query('INSERT INTO post_bookmarks (user_id, post_id) VALUES ($1, $2)', [
        userId,
        postId,
      ]);
      isBookmarked = true;
    }

    return res.status(200).json({
      message: isBookmarked ? 'Post bookmarked.' : 'Post unbookmarked.',
      is_bookmarked: isBookmarked,
    });
  } catch (error) {
    console.error('Error toggling bookmark:', error);
    return res.status(500).json({ error: 'Server error toggling bookmark.' });
  }
};

/**
 * Get all bookmarked posts for current user
 * GET /api/posts/saved
 */
exports.getSavedPosts = async (req, res) => {
  const userId = req.user.id;

  try {
    const savedResult = await db.query(
      `SELECT 
        p.id, 
        p.caption, 
        p.image_url, 
        p.location, 
        p.category, 
        p.likes_count, 
        p.created_at,
        u.id AS author_id,
        u.name AS author_name,
        u.username AS author_username,
        u.profile_picture AS author_profile_picture,
        TRUE AS is_bookmarked,
        COALESCE(
          (SELECT TRUE FROM post_likes WHERE post_id = p.id AND user_id = $1 LIMIT 1), 
          FALSE
        ) AS is_liked,
        COALESCE(
          (SELECT COUNT(*)::int FROM post_comments WHERE post_id = p.id), 
          0
        ) AS comments_count
      FROM posts p
      INNER JOIN post_bookmarks pb ON p.id = pb.post_id
      INNER JOIN users u ON p.user_id = u.id
      WHERE pb.user_id = $1
      ORDER BY pb.created_at DESC`,
      [userId]
    );

    return res.status(200).json({
      saved: savedResult.rows,
    });
  } catch (error) {
    console.error('Error fetching saved posts:', error);
    return res.status(500).json({ error: 'Server error fetching saved posts.' });
  }
};

/**
 * Get posts of a specific user
 * GET /api/posts/user/:userId
 */
exports.getUserPosts = async (req, res) => {
  const userId = parseInt(req.params.userId);
  const currentUserId = req.user ? req.user.id : null;

  try {
    const postsResult = await db.query(
      `SELECT 
        p.id, 
        p.caption, 
        p.image_url, 
        p.location, 
        p.category, 
        p.likes_count, 
        p.created_at,
        COALESCE(
          (SELECT TRUE FROM post_likes WHERE post_id = p.id AND user_id = $2 LIMIT 1), 
          FALSE
        ) AS is_liked,
        COALESCE(
          (SELECT TRUE FROM post_bookmarks WHERE post_id = p.id AND user_id = $2 LIMIT 1), 
          FALSE
        ) AS is_bookmarked,
        COALESCE(
          (SELECT COUNT(*)::int FROM post_comments WHERE post_id = p.id), 
          0
        ) AS comments_count
      FROM posts p 
      WHERE p.user_id = $1 
      ORDER BY p.created_at DESC`,
      [userId, currentUserId]
    );

    return res.status(200).json({
      posts: postsResult.rows,
    });
  } catch (error) {
    console.error('Error fetching user posts:', error);
    return res.status(500).json({ error: 'Server error fetching user posts.' });
  }
};

/**
 * Get all comments for a post
 * GET /api/posts/:id/comments
 */
exports.getComments = async (req, res) => {
  const postId = parseInt(req.params.id);
  const currentUserId = req.user ? req.user.id : null;

  try {
    const result = await db.query(
      `SELECT 
        c.id,
        c.text,
        c.created_at,
        u.id AS user_id,
        u.name,
        u.username,
        u.profile_picture,
        COALESCE(
          (SELECT TRUE FROM post_comment_likes WHERE comment_id = c.id AND user_id = $2 LIMIT 1), 
          FALSE
        ) AS is_liked,
        COALESCE(
          (SELECT COUNT(*)::int FROM post_comment_likes WHERE comment_id = c.id), 
          0
        ) AS likes_count
      FROM post_comments c
      INNER JOIN users u ON c.user_id = u.id
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC`,
      [postId, currentUserId]
    );

    return res.status(200).json({ comments: result.rows });
  } catch (error) {
    console.error('Error fetching comments:', error);
    return res.status(500).json({ error: 'Server error fetching comments.' });
  }
};

/**
 * Add a comment to a post
 * POST /api/posts/:id/comment
 */
exports.addComment = async (req, res) => {
  const userId = req.user.id;
  const postId = parseInt(req.params.id);
  const { text } = req.body;

  if (!text || text.trim() === '') {
    return res.status(400).json({ error: 'Comment text is required.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO post_comments (post_id, user_id, text)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [postId, userId, text.trim()]
    );

    // Also fetch the commenter's profile info
    const userResult = await db.query(
      'SELECT id, name, username, profile_picture FROM users WHERE id = $1',
      [userId]
    );

    const comment = {
      ...result.rows[0],
      ...userResult.rows[0],
      user_id: userId,
    };

    // Send comment notification to post author if commented by someone else
    const postResult = await db.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length > 0) {
      const postCreator = postResult.rows[0].user_id;
      if (postCreator !== userId) {
        const actorName = userResult.rows[0].name || userResult.rows[0].username;
        await db.query(
          `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, text)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            postCreator,
            userId,
            'comment',
            postId,
            result.rows[0].id,
            `${actorName} commented: "${text.trim().substring(0, 30)}${text.trim().length > 30 ? '...' : ''}"`
          ]
        );
      }
    }

    return res.status(201).json({
      message: 'Comment added.',
      comment,
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    return res.status(500).json({ error: 'Server error adding comment.' });
  }
};

/**
 * Toggle comment like
 * POST /api/posts/comment/:commentId/like
 */
exports.toggleLikeComment = async (req, res) => {
  const userId = req.user.id;
  const commentId = parseInt(req.params.commentId);

  try {
    // Check if comment exists
    const commentCheck = await db.query('SELECT * FROM post_comments WHERE id = $1', [commentId]);
    if (commentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found.' });
    }

    const likeCheck = await db.query(
      'SELECT * FROM post_comment_likes WHERE comment_id = $1 AND user_id = $2',
      [commentId, userId]
    );

    let isLiked = false;

    if (likeCheck.rows.length > 0) {
      await db.query('DELETE FROM post_comment_likes WHERE comment_id = $1 AND user_id = $2', [
        commentId,
        userId,
      ]);
      isLiked = false;
    } else {
      await db.query('INSERT INTO post_comment_likes (comment_id, user_id) VALUES ($1, $2)', [
        commentId,
        userId,
      ]);
      isLiked = true;

      // Trigger comment like notification
      const commentCreator = commentCheck.rows[0].user_id;
      if (commentCreator !== userId) {
        const actorInfo = await db.query('SELECT name, username FROM users WHERE id = $1', [userId]);
        const actorName = actorInfo.rows[0].name || actorInfo.rows[0].username;
        await db.query(
          `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, text)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            commentCreator,
            userId,
            'comment_like',
            commentCheck.rows[0].post_id,
            commentId,
            `${actorName} liked your comment: "${commentCheck.rows[0].text.trim().substring(0, 20)}${commentCheck.rows[0].text.trim().length > 20 ? '...' : ''}"`
          ]
        );
      }
    }

    const countResult = await db.query(
      'SELECT COUNT(*)::int AS likes_count FROM post_comment_likes WHERE comment_id = $1',
      [commentId]
    );

    return res.status(200).json({
      message: isLiked ? 'Comment liked.' : 'Comment unliked.',
      is_liked: isLiked,
      likes_count: countResult.rows[0].likes_count,
    });
  } catch (error) {
    console.error('Error toggling comment like:', error);
    return res.status(500).json({ error: 'Server error toggling comment like.' });
  }
};

/**
 * Get a single post by ID
 * GET /api/posts/:id
 */
exports.getPostById = async (req, res) => {
  const postId = parseInt(req.params.id);
  const currentUserId = req.user ? req.user.id : null;

  try {
    const postResult = await db.query(
      `SELECT 
        p.id, 
        p.caption, 
        p.image_url, 
        p.location, 
        p.category, 
        p.likes_count, 
        p.created_at,
        u.id AS author_id,
        u.name AS author_name,
        u.username AS author_username,
        u.profile_picture AS author_profile_picture,
        COALESCE(
          (SELECT TRUE FROM post_likes WHERE post_id = p.id AND user_id = $2 LIMIT 1), 
          FALSE
        ) AS is_liked,
        COALESCE(
          (SELECT TRUE FROM post_bookmarks WHERE post_id = p.id AND user_id = $2 LIMIT 1), 
          FALSE
        ) AS is_bookmarked,
        COALESCE(
          (SELECT COUNT(*)::int FROM post_comments WHERE post_id = p.id), 
          0
        ) AS comments_count
      FROM posts p
      INNER JOIN users u ON p.user_id = u.id
      WHERE p.id = $1`,
      [postId, currentUserId]
    );

    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    return res.status(200).json({
      post: postResult.rows[0],
    });
  } catch (error) {
    console.error('Error fetching post by id:', error);
    return res.status(500).json({ error: 'Server error fetching post.' });
  }
};

/**
 * Fetch explore/categories posts with filtering and sorting
 * GET /api/posts/explore
 */
exports.getExplorePosts = async (req, res) => {
  const { category, city, search, sortBy } = req.query;
  const currentUserId = req.user ? req.user.id : null;

  try {
    let query = `
      SELECT 
        p.id, 
        p.caption, 
        p.image_url, 
        p.location, 
        p.category, 
        p.likes_count, 
        p.created_at,
        u.id AS author_id,
        u.name AS author_name,
        u.username AS author_username,
        u.profile_picture AS author_profile_picture,
        COALESCE(
          (SELECT TRUE FROM post_likes WHERE post_id = p.id AND user_id = $1 LIMIT 1), 
          FALSE
        ) AS is_liked,
        COALESCE(
          (SELECT TRUE FROM post_bookmarks WHERE post_id = p.id AND user_id = $1 LIMIT 1), 
          FALSE
        ) AS is_bookmarked,
        COALESCE(
          (SELECT COUNT(*)::int FROM post_comments WHERE post_id = p.id), 
          0
        ) AS comments_count
      FROM posts p
      INNER JOIN users u ON p.user_id = u.id
      WHERE 1=1
    `;

    const queryParams = [currentUserId];
    let paramIndex = 2;

    if (category && category !== 'All') {
      query += ` AND p.category = $${paramIndex}`;
      queryParams.push(category);
      paramIndex++;
    }

    if (city && city !== 'All') {
      query += ` AND p.location ILIKE $${paramIndex}`;
      queryParams.push(`%${city}%`);
      paramIndex++;
    }

    if (search && search.trim() !== '') {
      query += ` AND (p.caption ILIKE $${paramIndex} OR p.location ILIKE $${paramIndex} OR p.category ILIKE $${paramIndex})`;
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    if (sortBy === 'A-Z') {
      query += ` ORDER BY p.caption ASC`;
    } else if (sortBy === 'Z-A') {
      query += ` ORDER BY p.caption DESC`;
    } else {
      query += ` ORDER BY p.created_at DESC`;
    }

    const result = await db.query(query, queryParams);

    return res.status(200).json({
      posts: result.rows,
    });
  } catch (error) {
    console.error('Error fetching explore posts:', error);
    return res.status(500).json({ error: 'Server error fetching explore posts.' });
  }
};
