const db = require('../config/db');
const { uploadToCloudinary } = require('../config/cloudinary');
const { ensureUserBlocksTable, getBlockStatus, isNotMutuallyBlockedSql } = require('../utils/blockHelper');
const {
  ensureTagMentionSchema,
  normalizeAudiencePolicy,
  parseStrictAudiencePolicy,
  evaluateTagMentionTargets,
  buildRestrictionErrorMessage,
  tagMentionCapabilityColumnsSql,
  stripTagFromCaptionSuffix,
} = require('../utils/privacyHelper');

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
    const postsCount = parseInt(row.posts_count || 0);
    const followersCount = parseInt(row.followers_count || 0);
    const cleanUsername = (row.username || '').toLowerCase().trim();
    const isOfficial = cleanUsername === 'hidely_official' || cleanUsername === 'hidely';
    const isVerified = isOfficial || postsCount >= 50 || followersCount >= 50000;

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
        is_verified: isVerified,
        posts_count: postsCount,
        followers_count: followersCount,
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
    const cleanUsername = username ? username.trim().replace(/^@/, '') : '';
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
       WHERE LOWER(u.username) = LOWER($1) OR u.username = $1 OR u.id::text = $1`,
      [cleanUsername, currentUserId]
    );

    if (creatorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found.' });
    }

    const creatorRow = creatorResult.rows[0];

    if (currentUserId && parseInt(currentUserId, 10) !== parseInt(creatorRow.id, 10)) {
      const blockStatus = await getBlockStatus(currentUserId, creatorRow.id);
      if (blockStatus.blocked) {
        return res.status(403).json({
          error: blockStatus.blockedByA ? 'You have blocked this user.' : 'This profile is unavailable.',
          blocked: true,
          blocked_by_me: blockStatus.blockedByA,
          blocked_me: blockStatus.blockedByB,
          posts: [],
        });
      }
    }

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

    const postsCount = parseInt(creatorRow.posts_count || 0);
    const followersCount = parseInt(creatorRow.followers_count || 0);
    const cleanUname = (cleanUsername || '').toLowerCase().trim();
    const isOfficial = cleanUname === 'hidely_official' || cleanUname === 'hidely';
    const isVerified = isOfficial || postsCount >= 50 || followersCount >= 50000;

    return res.status(200).json({
      creator: {
        id: creatorRow.id,
        name: creatorRow.name,
        username: creatorRow.username,
        pronouns: creatorRow.pronouns,
        bio: creatorRow.bio,
        profile_picture: creatorRow.profile_picture,
        is_verified: isVerified,
        posts_count: postsCount,
        followers_count: followersCount,
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

    const blockStatus = await getBlockStatus(followerId, followingId);
    if (blockStatus.blocked) {
      return res.status(403).json({
        error: 'Cannot follow or interact with a blocked user.',
        blocked: true,
      });
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

    if (currentUserId && parseInt(currentUserId, 10) !== parseInt(targetUserId, 10)) {
      const targetBlock = await getBlockStatus(currentUserId, targetUserId);
      if (targetBlock.blocked) {
        return res.status(403).json({ error: 'This profile is unavailable.', blocked: true, following: [] });
      }
    }

    await ensureUserBlocksTable();
    const blockFilter = isNotMutuallyBlockedSql('u.id', '$2');

    const result = await db.query(
      `SELECT 
        u.id,
        u.name,
        u.username,
        u.profile_picture,
        u.bio,
        (
          LOWER(u.username) IN ('hidely_official', 'hidely') 
          OR (SELECT COUNT(*)::int FROM posts p_sub WHERE p_sub.user_id = u.id) >= 50 
          OR (SELECT COUNT(*)::int FROM user_follows f_sub WHERE f_sub.following_id = u.id) >= 50000
        ) AS is_verified,
        EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $2 AND following_id = u.id) as is_following
      FROM users u
      INNER JOIN user_follows f ON u.id = f.following_id
      WHERE f.follower_id = $1 AND ${blockFilter}
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

    if (currentUserId && parseInt(currentUserId, 10) !== parseInt(targetUserId, 10)) {
      const targetBlock = await getBlockStatus(currentUserId, targetUserId);
      if (targetBlock.blocked) {
        return res.status(403).json({ error: 'This profile is unavailable.', blocked: true, followers: [] });
      }
    }

    await ensureUserBlocksTable();
    const blockFilter = isNotMutuallyBlockedSql('u.id', '$2');

    const result = await db.query(
      `SELECT 
        u.id,
        u.name,
        u.username,
        u.profile_picture,
        u.bio,
        (
          LOWER(u.username) IN ('hidely_official', 'hidely') 
          OR (SELECT COUNT(*)::int FROM posts p_sub WHERE p_sub.user_id = u.id) >= 50 
          OR (SELECT COUNT(*)::int FROM user_follows f_sub WHERE f_sub.following_id = u.id) >= 50000
        ) AS is_verified,
        EXISTS(SELECT 1 FROM user_follows WHERE follower_id = $2 AND following_id = u.id) as is_following
      FROM users u
      INNER JOIN user_follows f ON u.id = f.follower_id
      WHERE f.following_id = $1 AND ${blockFilter}
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
    await ensureTagMentionSchema();
    const currentUserId = req.user ? req.user.id : null;
    const blockFilter = isNotMutuallyBlockedSql('u.id', '$1');

    const result = await db.query(
      `SELECT 
        u.id,
        u.name,
        u.username,
        u.profile_picture,
        COALESCE(u.points, 7120) as points,
        u.pronouns,
        u.bio,
        (
          LOWER(u.username) IN ('hidely_official', 'hidely') 
          OR (SELECT COUNT(*)::int FROM posts p_sub WHERE p_sub.user_id = u.id) >= 50 
          OR (SELECT COUNT(*)::int FROM user_follows f_sub WHERE f_sub.following_id = u.id) >= 50000
        ) AS is_verified,
        ${tagMentionCapabilityColumnsSql('$1', 'u')}
      FROM users u
      WHERE u.username IS NOT NULL AND u.username != '' AND ${blockFilter}
      ORDER BY points DESC, u.id ASC`,
      [currentUserId]
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

    await ensureTagMentionSchema();
    const currentUserId = req.user ? req.user.id : null;
    const blockFilter = isNotMutuallyBlockedSql('u.id', '$2');

    const searchTerm = `%${q.trim()}%`;
    const result = await db.query(
      `SELECT 
        u.id,
        u.name,
        u.username,
        u.profile_picture,
        u.bio,
        (
          LOWER(u.username) IN ('hidely_official', 'hidely') 
          OR (SELECT COUNT(*)::int FROM posts p_sub WHERE p_sub.user_id = u.id) >= 50 
          OR (SELECT COUNT(*)::int FROM user_follows f_sub WHERE f_sub.following_id = u.id) >= 50000
        ) AS is_verified,
        ${tagMentionCapabilityColumnsSql('$2', 'u')}
      FROM users u
      WHERE (u.username ILIKE $1 OR u.name ILIKE $1) AND ${blockFilter}
      ORDER BY u.id DESC
      LIMIT 20`,
      [searchTerm, currentUserId]
    );

    return res.status(200).json({
      users: result.rows,
    });
  } catch (error) {
    console.error('Error searching users:', error);
    return res.status(500).json({ error: 'Server error searching users.' });
  }
};

/**
 * Get list of users blocked by the authenticated user
 * GET /api/users/blocked
 */
exports.getBlockedUsers = async (req, res) => {
  const blockerId = req.user.id;
  try {
    await ensureUserBlocksTable();
    const result = await db.query(
      `SELECT u.id, u.name, u.username, u.profile_picture, ub.created_at AS blocked_at
       FROM user_blocks ub
       INNER JOIN users u ON u.id = ub.blocked_id
       WHERE ub.blocker_id = $1
       ORDER BY ub.created_at DESC`,
      [blockerId]
    );

    return res.status(200).json({
      success: true,
      blocked_users: result.rows.map((r) => r.username).filter(Boolean),
      users: result.rows,
    });
  } catch (error) {
    console.error('Error fetching blocked users:', error);
    return res.status(500).json({ error: 'Server error fetching blocked users.' });
  }
};

/**
 * Block a user by username or ID
 * POST /api/users/block/:identifier
 */
exports.blockUser = async (req, res) => {
  const blockerId = req.user.id;
  const rawIdentifier = req.params.identifier || '';
  const cleanIdentifier = rawIdentifier.trim().replace(/^@/, '');

  if (!cleanIdentifier) {
    return res.status(400).json({ error: 'Target username or ID is required.' });
  }

  try {
    await ensureUserBlocksTable();
    const targetRes = await db.query(
      `SELECT id, username, name
       FROM users
       WHERE LOWER(username) = LOWER($1) OR username = $1 OR id::text = $1
       LIMIT 1`,
      [cleanIdentifier]
    );

    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: 'Target user not found.' });
    }

    const target = targetRes.rows[0];
    if (parseInt(target.id, 10) === parseInt(blockerId, 10)) {
      return res.status(400).json({ error: 'You cannot block yourself.' });
    }

    await db.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [blockerId, target.id]
    );

    // Sever mutual follow relationships immediately
    await db.query(
      `DELETE FROM user_follows
       WHERE (follower_id = $1 AND following_id = $2)
          OR (follower_id = $2 AND following_id = $1)`,
      [blockerId, target.id]
    );

    return res.status(200).json({
      success: true,
      message: 'User blocked successfully.',
      blocked_username: target.username,
      blocked_user_id: target.id,
    });
  } catch (error) {
    console.error('Error blocking user:', error);
    return res.status(500).json({ error: 'Server error blocking user.' });
  }
};

/**
 * Unblock a user by username or ID
 * DELETE /api/users/block/:identifier
 */
exports.unblockUser = async (req, res) => {
  const blockerId = req.user.id;
  const rawIdentifier = req.params.identifier || '';
  const cleanIdentifier = rawIdentifier.trim().replace(/^@/, '');

  if (!cleanIdentifier) {
    return res.status(400).json({ error: 'Target username or ID is required.' });
  }

  try {
    await ensureUserBlocksTable();
    const targetRes = await db.query(
      `SELECT id, username
       FROM users
       WHERE LOWER(username) = LOWER($1) OR username = $1 OR id::text = $1
       LIMIT 1`,
      [cleanIdentifier]
    );

    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: 'Target user not found.' });
    }

    const target = targetRes.rows[0];
    await db.query(
      `DELETE FROM user_blocks
       WHERE blocker_id = $1 AND blocked_id = $2`,
      [blockerId, target.id]
    );

    return res.status(200).json({
      success: true,
      message: 'User unblocked successfully.',
      unblocked_username: target.username,
      unblocked_user_id: target.id,
    });
  } catch (error) {
    console.error('Error unblocking user:', error);
    return res.status(500).json({ error: 'Server error unblocking user.' });
  }
};

/**
 * Get current user's Tags & Mentions privacy settings
 * GET /api/users/privacy/tags-mentions
 */
exports.getTagMentionSettings = async (req, res) => {
  const userId = req.user.id;
  try {
    await ensureTagMentionSchema();
    const result = await db.query(
      `SELECT
        COALESCE(allow_tags_from, 'everyone') AS allow_tags_from,
        COALESCE(allow_mentions_from, 'everyone') AS allow_mentions_from,
        COALESCE(manually_approve_tags, FALSE) AS manually_approve_tags
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const row = result.rows[0];
    const blockFilter = isNotMutuallyBlockedSql('u.id', '$1');
    const pendingRes = await db.query(
      `SELECT COUNT(*)::int AS pending_count
       FROM post_tags pt
       INNER JOIN posts p ON pt.post_id = p.id
       INNER JOIN users u ON p.user_id = u.id
       WHERE pt.tagged_user_id = $1
         AND pt.status = 'pending'
         AND ${blockFilter}`,
      [userId]
    );

    return res.status(200).json({
      success: true,
      settings: {
        allow_tags_from: normalizeAudiencePolicy(row.allow_tags_from),
        allow_mentions_from: normalizeAudiencePolicy(row.allow_mentions_from),
        manually_approve_tags: row.manually_approve_tags === true,
      },
      pending_tags_count: pendingRes.rows[0]?.pending_count || 0,
    });
  } catch (error) {
    console.error('Error fetching tag/mention settings:', error);
    return res.status(500).json({ error: 'Server error fetching tags and mentions settings.' });
  }
};

/**
 * Update current user's Tags & Mentions privacy settings
 * PUT /api/users/privacy/tags-mentions
 */
exports.updateTagMentionSettings = async (req, res) => {
  const userId = req.user.id;
  const { allow_tags_from, allow_mentions_from, manually_approve_tags } = req.body || {};

  try {
    await ensureTagMentionSchema();

    const sets = [];
    const params = [];
    let paramIndex = 1;

    if (allow_tags_from !== undefined) {
      const parsed = parseStrictAudiencePolicy(allow_tags_from);
      if (!parsed) {
        return res.status(400).json({
          error: "Invalid allow_tags_from value. Expected 'everyone', 'following', or 'no_one'.",
        });
      }
      sets.push(`allow_tags_from = $${paramIndex}`);
      params.push(parsed);
      paramIndex++;
    }

    if (allow_mentions_from !== undefined) {
      const parsed = parseStrictAudiencePolicy(allow_mentions_from);
      if (!parsed) {
        return res.status(400).json({
          error: "Invalid allow_mentions_from value. Expected 'everyone', 'following', or 'no_one'.",
        });
      }
      sets.push(`allow_mentions_from = $${paramIndex}`);
      params.push(parsed);
      paramIndex++;
    }

    if (manually_approve_tags !== undefined) {
      let boolVal = null;
      if (typeof manually_approve_tags === 'boolean') {
        boolVal = manually_approve_tags;
      } else if (typeof manually_approve_tags === 'string') {
        const lower = manually_approve_tags.trim().toLowerCase();
        if (lower === 'true' || lower === '1') boolVal = true;
        if (lower === 'false' || lower === '0') boolVal = false;
      } else if (manually_approve_tags === 1 || manually_approve_tags === 0) {
        boolVal = manually_approve_tags === 1;
      }

      if (boolVal === null) {
        return res.status(400).json({
          error: 'Invalid manually_approve_tags value. Expected boolean.',
        });
      }

      sets.push(`manually_approve_tags = $${paramIndex}`);
      params.push(boolVal);
      paramIndex++;
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No tag/mention settings provided.' });
    }

    params.push(userId);
    const updateRes = await db.query(
      `UPDATE users
       SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex}
       RETURNING
         COALESCE(allow_tags_from, 'everyone') AS allow_tags_from,
         COALESCE(allow_mentions_from, 'everyone') AS allow_mentions_from,
         COALESCE(manually_approve_tags, FALSE) AS manually_approve_tags`,
      params
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const row = updateRes.rows[0];
    return res.status(200).json({
      success: true,
      message: 'Tags and mentions settings updated successfully.',
      settings: {
        allow_tags_from: normalizeAudiencePolicy(row.allow_tags_from),
        allow_mentions_from: normalizeAudiencePolicy(row.allow_mentions_from),
        manually_approve_tags: row.manually_approve_tags === true,
      },
    });
  } catch (error) {
    console.error('Error updating tag/mention settings:', error);
    return res.status(500).json({ error: 'Server error updating tags and mentions settings.' });
  }
};

/**
 * Check whether current user can tag or @mention the supplied usernames
 * POST /api/users/privacy/check-tags-mentions
 * Body: { usernames: string[], mode: 'tag' | 'mention' }
 */
exports.checkTagMentionEligibility = async (req, res) => {
  const actorId = req.user.id;
  const { usernames, mode } = req.body || {};
  const cleanMode = mode === 'tag' ? 'tag' : 'mention';

  try {
    const evalResult = await evaluateTagMentionTargets({
      actorId,
      usernames: usernames || [],
      mode: cleanMode,
    });

    const restricted = evalResult.rejectedUsers;
    return res.status(200).json({
      success: true,
      mode: cleanMode,
      allowed: evalResult.allowedUsers,
      restricted,
      not_found: evalResult.notFoundUsernames,
      all_allowed: restricted.length === 0,
      message: restricted.length > 0 ? buildRestrictionErrorMessage(restricted, cleanMode) : null,
    });
  } catch (error) {
    console.error('Error checking tag/mention eligibility:', error);
    return res.status(500).json({ error: 'Server error checking eligibility.' });
  }
};

/**
 * Get all posts in which the authenticated user is tagged (pending approval + approved)
 * GET /api/users/tags
 */
exports.getTaggedPosts = async (req, res) => {
  const userId = req.user.id;
  try {
    await ensureTagMentionSchema();
    const blockFilter = isNotMutuallyBlockedSql('u.id', '$1');

    const result = await db.query(
      `SELECT
        pt.id AS tag_id,
        pt.post_id,
        pt.status AS tag_status,
        pt.created_at AS tagged_at,
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
       FROM post_tags pt
       INNER JOIN posts p ON pt.post_id = p.id
       INNER JOIN users u ON p.user_id = u.id
       WHERE pt.tagged_user_id = $1 AND ${blockFilter}
       ORDER BY (CASE WHEN pt.status = 'pending' THEN 0 ELSE 1 END) ASC, pt.created_at DESC`,
      [userId]
    );

    const pendingCount = result.rows.filter((r) => r.tag_status === 'pending').length;

    return res.status(200).json({
      success: true,
      tags: result.rows,
      pending_count: pendingCount,
    });
  } catch (error) {
    console.error('Error fetching tagged posts:', error);
    return res.status(500).json({ error: 'Server error fetching tagged posts.' });
  }
};

/**
 * Approve or remove a post tag for the authenticated user
 * PATCH /api/users/tags/:postId  { action: 'approve' | 'remove' }
 */
exports.respondToPostTag = async (req, res) => {
  const userId = req.user.id;
  const postId = parseInt(req.params.postId, 10);
  const action = ((req.body && req.body.action) || '').toString().trim().toLowerCase();

  if (isNaN(postId)) {
    return res.status(400).json({ error: 'Invalid post ID.' });
  }

  if (action !== 'approve' && action !== 'remove') {
    return res.status(400).json({ error: "Invalid action. Expected 'approve' or 'remove'." });
  }

  try {
    await ensureTagMentionSchema();

    const tagCheck = await db.query(
      `SELECT pt.id, pt.status, p.caption, u.username
       FROM post_tags pt
       INNER JOIN posts p ON p.id = pt.post_id
       INNER JOIN users u ON u.id = pt.tagged_user_id
       WHERE pt.post_id = $1 AND pt.tagged_user_id = $2
       LIMIT 1`,
      [postId, userId]
    );

    if (tagCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tag entry not found for this post.' });
    }

    const existing = tagCheck.rows[0];

    if (action === 'approve') {
      await db.query(
        `UPDATE post_tags SET status = 'approved' WHERE post_id = $1 AND tagged_user_id = $2`,
        [postId, userId]
      );
      return res.status(200).json({
        success: true,
        message: 'Tag approved.',
        status: 'approved',
        post_id: postId,
      });
    }

    // Remove tag
    await db.query(
      `DELETE FROM post_tags WHERE post_id = $1 AND tagged_user_id = $2`,
      [postId, userId]
    );

    if (existing.caption && existing.username) {
      const cleanedCaption = stripTagFromCaptionSuffix(existing.caption, existing.username);
      if (cleanedCaption !== existing.caption) {
        await db.query('UPDATE posts SET caption = $1 WHERE id = $2', [cleanedCaption, postId]);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Tag removed from post.',
      status: 'removed',
      post_id: postId,
    });
  } catch (error) {
    console.error('Error updating post tag:', error);
    return res.status(500).json({ error: 'Server error updating post tag.' });
  }
};

/**
 * Remove a tag on a post where the current user was tagged
 * DELETE /api/users/tags/:postId
 */
exports.removePostTag = async (req, res) => {
  req.body = { ...(req.body || {}), action: 'remove' };
  return exports.respondToPostTag(req, res);
};
