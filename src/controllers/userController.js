const db = require('../config/db');
const { uploadToCloudinary } = require('../config/cloudinary');

/**
 * Get current user profile details
 * GET /api/users/profile
 */
exports.getProfile = async (req, res) => {
  const userId = req.user.id;

  try {
    const userResult = await db.query(
      `SELECT 
        u.id, 
        u.name, 
        u.email, 
        u.username, 
        u.pronouns, 
        COALESCE(u.gender, '') AS gender, 
        u.bio, 
        u.profile_picture, 
        u.is_verified,
        (SELECT COUNT(*)::int FROM posts WHERE user_id = u.id) AS posts_count,
        (SELECT COUNT(*)::int FROM user_follows WHERE following_id = u.id) AS followers_count,
        (SELECT COUNT(*)::int FROM user_follows WHERE follower_id = u.id) AS followings_count
       FROM users u
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    const row = userResult.rows[0];

    return res.status(200).json({
      user: {
        id: row.id,
        name: row.name,
        email: row.email,
        username: row.username,
        pronouns: row.pronouns,
        gender: row.gender,
        bio: row.bio,
        profile_picture: row.profile_picture,
        is_verified: row.is_verified,
        posts_count: parseInt(row.posts_count || 0),
        followers_count: parseInt(row.followers_count || 0),
        followings_count: parseInt(row.followings_count || 0),
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
    const creatorResult = await db.query(
      `SELECT 
        u.id, 
        u.name, 
        u.username, 
        u.pronouns, 
        u.bio, 
        u.profile_picture, 
        u.is_verified,
        (SELECT COUNT(*)::int FROM posts WHERE user_id = u.id) AS posts_count,
        (SELECT COUNT(*)::int FROM user_follows WHERE following_id = u.id) AS followers_count,
        (SELECT COUNT(*)::int FROM user_follows WHERE follower_id = u.id) AS followings_count,
        COALESCE(
          (SELECT TRUE FROM user_follows WHERE follower_id = $2 AND following_id = u.id LIMIT 1),
          FALSE
        ) AS is_following
       FROM users u
       WHERE u.username = $1`,
      [username.trim().toLowerCase(), currentUserId]
    );

    if (creatorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found.' });
    }

    const creatorRow = creatorResult.rows[0];

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
      [creatorRow.id, currentUserId]
    );

    return res.status(200).json({
      creator: {
        id: creatorRow.id,
        name: creatorRow.name,
        username: creatorRow.username,
        pronouns: creatorRow.pronouns,
        bio: creatorRow.bio,
        profile_picture: creatorRow.profile_picture,
        is_verified: creatorRow.is_verified,
        posts_count: parseInt(creatorRow.posts_count || 0),
        followers_count: parseInt(creatorRow.followers_count || 0),
        followings_count: parseInt(creatorRow.followings_count || 0),
        is_following: creatorRow.is_following === true,
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
  const creatorParam = req.params.creatorId;

  if (!creatorParam) {
    return res.status(400).json({ error: 'Creator ID or username is required.' });
  }

  try {
    // Verify target user exists by ID or username
    const targetCheck = await db.query(
      'SELECT id FROM users WHERE id::text = $1 OR username = $2',
      [creatorParam, creatorParam.toLowerCase().trim()]
    );
    if (targetCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found.' });
    }

    const followingId = targetCheck.rows[0].id;

    if (parseInt(followerId) === parseInt(followingId)) {
      return res.status(400).json({ error: 'You cannot follow yourself.' });
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
      const followerName = followerInfo.rows[0]?.name || followerInfo.rows[0]?.username || 'Someone';
      
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
 * GET /api/users/following/:username
 */
exports.getFollowing = async (req, res) => {
  try {
    let targetUserId = req.user ? req.user.id : null;
    const { username } = req.params;

    if (username) {
      const userRes = await db.query(
        'SELECT id FROM users WHERE username = $1 OR id::text = $1',
        [username.toLowerCase().trim()]
      );
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'User not found.' });
      }
      targetUserId = userRes.rows[0].id;
    }

    if (!targetUserId) {
      return res.status(400).json({ error: 'User ID or username is required.' });
    }

    const currentUserId = req.user ? req.user.id : null;

    const result = await db.query(
      `SELECT 
        u.id,
        u.name,
        u.username,
        u.profile_picture,
        u.bio,
        u.is_verified,
        EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $2 AND following_id = u.id) as is_following
      FROM users u
      INNER JOIN user_follows f ON u.id = f.following_id
      WHERE f.follower_id = $1
      ORDER BY f.created_at DESC`,
      [targetUserId, currentUserId]
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
 * Get followers list
 * GET /api/users/followers
 * GET /api/users/followers/:username
 */
exports.getFollowers = async (req, res) => {
  try {
    let targetUserId = req.user ? req.user.id : null;
    const { username } = req.params;

    if (username) {
      const userRes = await db.query(
        'SELECT id FROM users WHERE username = $1 OR id::text = $1',
        [username.toLowerCase().trim()]
      );
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'User not found.' });
      }
      targetUserId = userRes.rows[0].id;
    }

    if (!targetUserId) {
      return res.status(400).json({ error: 'User ID or username is required.' });
    }

    const currentUserId = req.user ? req.user.id : null;

    const result = await db.query(
      `SELECT 
        u.id,
        u.name,
        u.username,
        u.profile_picture,
        u.bio,
        u.is_verified,
        EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $2 AND following_id = u.id) as is_following
      FROM users u
      INNER JOIN user_follows f ON u.id = f.follower_id
      WHERE f.following_id = $1
      ORDER BY f.created_at DESC`,
      [targetUserId, currentUserId]
    );

    return res.status(200).json({
      followers: result.rows,
    });
  } catch (error) {
    console.error('Error fetching followers list:', error);
    return res.status(500).json({ error: 'Server error fetching followers list.' });
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

/**
 * Search users by username or name
 * GET /api/users/search?q=query
 */
exports.searchUsers = async (req, res) => {
  try {
    const q = req.query.q || req.query.query || '';
    if (!q.trim()) {
      return res.status(200).json({ users: [] });
    }

    const searchTerm = `%${q.trim()}%`;
    const result = await db.query(
      `SELECT 
        id,
        name,
        username,
        profile_picture,
        bio,
        is_verified
      FROM users
      WHERE (username ILIKE $1 OR name ILIKE $1)
      ORDER BY id DESC
      LIMIT 20`,
      [searchTerm]
    );

    return res.status(200).json({
      users: result.rows,
    });
  } catch (error) {
    console.error('Error searching users:', error);
    return res.status(500).json({ error: 'Server error searching users.' });
  }
};
