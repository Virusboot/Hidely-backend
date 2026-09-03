const db = require('../config/db');
const { uploadToCloudinary } = require('../config/cloudinary');

/**
 * Get current user profile details
 * GET /api/users/profile
 */
exports.getProfile = async (req, res) => {
  const userId = req.user.id;

  try {
    // Ensure gender column exists
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(50) DEFAULT ''`);
    } catch (_) {}

    const userResult = await db.query(
      'SELECT id, name, email, username, pronouns, COALESCE(gender, \'\') as gender, bio, profile_picture, is_verified FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    const user = userResult.rows[0];

    // Get live post count from DB
    const postsCountResult = await db.query('SELECT COUNT(*) FROM posts WHERE user_id = $1', [userId]);
    const postsCount = parseInt(postsCountResult.rows[0].count);

    // Get live follower/following count from DB
    const followersResult = await db.query('SELECT COUNT(*)::int FROM user_follows WHERE following_id = $1', [userId]);
    const followingsResult = await db.query('SELECT COUNT(*)::int FROM user_follows WHERE follower_id = $1', [userId]);

    return res.status(200).json({
      user: {
        ...user,
        posts_count: postsCount,
        followers_count: followersResult.rows[0].count || 0,
        followings_count: followingsResult.rows[0].count || 0,
      },
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return res.status(500).json({ error: 'Server error fetching profile details.' });
  }
};

/**
 * Update user profile details
 * PUT /api/users/profile
 */
exports.updateProfile = async (req, res) => {
  const userId = req.user.id;
  const { name, username, pronouns, gender, bio } = req.body;

  try {
    // Ensure gender column exists
    try {
      await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(50) DEFAULT ''`);
    } catch (_) {}

    const usernameClean = username ? username.trim().toLowerCase() : null;

    // Check if username is already taken by another user
    if (usernameClean) {
      const usernameCheck = await db.query('SELECT * FROM users WHERE username = $1 AND id != $2', [
        usernameClean,
        userId,
      ]);
      if (usernameCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Username is already taken.' });
      }
    }

    // Build update query
    let query = 'UPDATE users SET ';
    const params = [];
    let paramIndex = 1;

    if (name !== undefined) {
      query += `name = $${paramIndex}, `;
      params.push(name.trim());
      paramIndex++;
    }
    if (usernameClean !== undefined) {
      query += `username = $${paramIndex}, `;
      params.push(usernameClean);
      paramIndex++;
    }
    if (pronouns !== undefined) {
      query += `pronouns = $${paramIndex}, `;
      params.push(pronouns.trim());
      paramIndex++;
    }
    if (gender !== undefined) {
      query += `gender = $${paramIndex}, `;
      params.push(gender.trim());
      paramIndex++;
    }
    if (bio !== undefined) {
      query += `bio = $${paramIndex}, `;
      params.push(bio.trim());
      paramIndex++;
    }

    // File uploaded via Multer
    if (req.file) {
      const profilePicUrl = await uploadToCloudinary(req.file.path, 'hidely/profiles');
      query += `profile_picture = $${paramIndex}, `;
      params.push(profilePicUrl);
      paramIndex++;
    }

    // Remove trailing comma and space
    if (params.length === 0) {
      return res.status(400).json({ error: 'No fields provided for update.' });
    }

    query = query.slice(0, -2);
    query += ` WHERE id = $${paramIndex} RETURNING id, name, email, username, pronouns, COALESCE(gender, '') as gender, bio, profile_picture, is_verified`;
    params.push(userId);

    const updateResult = await db.query(query, params);

    return res.status(200).json({
      message: 'Profile updated successfully.',
      user: updateResult.rows[0],
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    return res.status(500).json({ error: 'Server error updating profile details.' });
  }
};

/**
 * Get specific creator profile details by username
 * GET /api/users/profile/:username
 */
exports.getCreatorProfile = async (req, res) => {
  const { username } = req.params;
  const currentUserId = req.user ? req.user.id : null;

  try {
    const userResult = await db.query(
      'SELECT id, name, username, pronouns, bio, profile_picture, is_verified FROM users WHERE username = $1',
      [username.trim().toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found.' });
    }

    const creator = userResult.rows[0];

    // Get posts of this creator
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
      [creator.id, currentUserId]
    );

    const postsCount = postsResult.rows.length;

    // Get followers/following
    const followersResult = await db.query('SELECT COUNT(*)::int FROM user_follows WHERE following_id = $1', [creator.id]);
    const followingsResult = await db.query('SELECT COUNT(*)::int FROM user_follows WHERE follower_id = $1', [creator.id]);
    
    let isFollowing = false;
    if (currentUserId) {
      const followCheck = await db.query('SELECT * FROM user_follows WHERE follower_id = $1 AND following_id = $2', [currentUserId, creator.id]);
      isFollowing = followCheck.rows.length > 0;
    }

    return res.status(200).json({
      creator: {
        ...creator,
        posts_count: postsCount,
        followers_count: followersResult.rows[0].count || 0,
        followings_count: followingsResult.rows[0].count || 0,
        is_following: isFollowing,
      },
      posts: postsResult.rows,
    });
  } catch (error) {
    console.error('Error fetching creator profile:', error);
    return res.status(500).json({ error: 'Server error fetching creator details.' });
  }
};

/**
 * Toggle follow/unfollow a creator
 * POST /api/users/follow/:creatorId
 */
exports.toggleFollow = async (req, res) => {
  const followerId = req.user.id;
  const followingId = parseInt(req.params.creatorId);

  if (followerId === followingId) {
    return res.status(400).json({ error: 'You cannot follow yourself.' });
  }

  try {
    // Verify target user exists
    const targetCheck = await db.query('SELECT * FROM users WHERE id = $1', [followingId]);
    if (targetCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found.' });
    }

    const followCheck = await db.query(
      'SELECT * FROM user_follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, followingId]
    );

    let isFollowing = false;

    if (followCheck.rows.length > 0) {
      // Unfollow
      await db.query('DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2', [
        followerId,
        followingId,
      ]);
      isFollowing = false;
    } else {
      // Follow
      await db.query('INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)', [
        followerId,
        followingId,
      ]);
      isFollowing = true;

      // Send follow notification
      const followerInfo = await db.query('SELECT name, username FROM users WHERE id = $1', [followerId]);
      const followerName = followerInfo.rows[0].name || followerInfo.rows[0].username;
      
      await db.query(
        `INSERT INTO notifications (user_id, actor_id, type, text)
         VALUES ($1, $2, $3, $4)`,
        [
          followingId,
          followerId,
          'follow',
          `${followerName} started following you.`
        ]
      );
    }

    return res.status(200).json({
      message: isFollowing ? 'Followed creator successfully.' : 'Unfollowed creator successfully.',
      is_following: isFollowing,
    });
  } catch (error) {
    console.error('Error toggling follow:', error);
    return res.status(500).json({ error: 'Server error toggling follow status.' });
  }
};

/**
 * Get followed creators list
 * GET /api/users/following
 */
exports.getFollowing = async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT 
        u.id,
        u.name,
        u.username,
        u.profile_picture
      FROM users u
      INNER JOIN user_follows f ON u.id = f.following_id
      WHERE f.follower_id = $1`,
      [userId]
    );

    return res.status(200).json({
      following: result.rows,
    });
  } catch (error) {
    console.error('Error fetching following list:', error);
    return res.status(500).json({ error: 'Server error fetching following list.' });
  }
};

/**
 * Get leaderboard rankings
 * GET /api/users/leaderboard
 */
exports.getLeaderboard = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
        id,
        name,
        username,
        profile_picture,
        COALESCE(points, 7120) as points,
        pronouns,
        bio,
        is_verified
      FROM users
      WHERE username IS NOT NULL AND username != ''
      ORDER BY points DESC, id ASC`
    );

    return res.status(200).json({
      leaderboard: result.rows,
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({ error: 'Server error fetching leaderboard.' });
  }
};
