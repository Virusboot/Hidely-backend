const fs = require('fs');
const db = require('../config/db');
const { uploadToCloudinary } = require('../config/cloudinary');
const { ensureUserBlocksTable, getBlockStatus, isNotMutuallyBlockedSql } = require('../utils/blockHelper');
const {
  ensureTagMentionSchema,
  normalizeUsernameList,
  extractMentionUsernames,
  evaluateTagMentionTargets,
  buildRestrictionErrorMessage,
} = require('../utils/privacyHelper');

function approvedTaggedUsersSql(postIdExpr, currentUserParam) {
  return `COALESCE(
    (
      SELECT json_agg(
        json_build_object(
          'id', tu.id,
          'name', tu.name,
          'username', tu.username,
          'profile_picture', tu.profile_picture
        )
        ORDER BY pt.created_at ASC
      )
      FROM post_tags pt
      INNER JOIN users tu ON pt.tagged_user_id = tu.id
      WHERE pt.post_id = ${postIdExpr}
        AND pt.status = 'approved'
        AND ${isNotMutuallyBlockedSql('tu.id', currentUserParam)}
    ),
    '[]'::json
  ) AS tagged_users`;
}

let postLocationColumnsPromise = null;
function ensurePostLocationColumns() {
  if (!postLocationColumnsPromise) {
    postLocationColumnsPromise = db.query(`
      ALTER TABLE posts 
      ADD COLUMN IF NOT EXISTS duplicate_cluster_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS location_accuracy_meters DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS location_source VARCHAR(50),
      ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS canonical_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS normalized_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS landmark_type VARCHAR(100),
      ADD COLUMN IF NOT EXISTS city VARCHAR(100),
      ADD COLUMN IF NOT EXISTS state VARCHAR(100),
      ADD COLUMN IF NOT EXISTS country VARCHAR(100),
      ADD COLUMN IF NOT EXISTS ai_confidence DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS place_id INTEGER;
    `).catch((err) => {
      postLocationColumnsPromise = null;
      console.error('Error ensuring post location columns:', err.message);
    });
  }
  return postLocationColumnsPromise;
}

function cleanupTempFile(file) {
  if (file && file.path && fs.existsSync(file.path)) {
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}
  }
}

/**
 * Create a new travel post
 * POST /api/posts
 */
exports.createPost = async (req, res) => {
  const userId = req.user.id;
  const { 
    caption, 
    location, 
    category,
    latitude,
    longitude,
    location_accuracy_meters,
    location_source,
    location_captured_at,
    canonical_name,
    normalized_name,
    landmark_type,
    city,
    state,
    country,
    ai_confidence,
    duplicate_cluster_id,
    tagged_usernames
  } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'Please upload a media file (image or video) for the post.' });
  }

  try {
    await ensureTagMentionSchema();

    const requestedTaggedUsernames = normalizeUsernameList(tagged_usernames);
    const taggedSet = new Set(requestedTaggedUsernames);
    const captionMentions = extractMentionUsernames(caption || '').filter((u) => !taggedSet.has(u));

    const tagEval = await evaluateTagMentionTargets({
      actorId: userId,
      usernames: requestedTaggedUsernames,
      mode: 'tag',
    });
    if (tagEval.rejectedUsers.length > 0) {
      cleanupTempFile(req.file);
      return res.status(403).json({
        error: buildRestrictionErrorMessage(tagEval.rejectedUsers, 'tag'),
        tag_restricted: true,
        restricted_usernames: tagEval.rejectedUsers.map((u) => u.username).filter(Boolean),
      });
    }

    const mentionEval = await evaluateTagMentionTargets({
      actorId: userId,
      usernames: captionMentions,
      mode: 'mention',
    });
    if (mentionEval.rejectedUsers.length > 0) {
      cleanupTempFile(req.file);
      return res.status(403).json({
        error: buildRestrictionErrorMessage(mentionEval.rejectedUsers, 'mention'),
        mention_restricted: true,
        restricted_usernames: mentionEval.rejectedUsers.map((u) => u.username).filter(Boolean),
      });
    }

    // Upload the file to Cloudinary in the posts folder
    const imageUrl = await uploadToCloudinary(req.file.path, 'hidely/posts');

    await ensurePostLocationColumns();

    // Coordinate & accuracy validation
    let validLat = null;
    let validLng = null;
    let validAccuracy = null;
    let validSource = null;
    let validCapturedAt = null;

    if (latitude !== undefined && latitude !== null && latitude !== '') {
      const parsedLat = parseFloat(latitude);
      if (Number.isFinite(parsedLat) && parsedLat >= -90 && parsedLat <= 90) {
        validLat = parsedLat;
      }
    }

    if (longitude !== undefined && longitude !== null && longitude !== '') {
      const parsedLng = parseFloat(longitude);
      if (Number.isFinite(parsedLng) && parsedLng >= -180 && parsedLng <= 180) {
        validLng = parsedLng;
      }
    }

    // Reject (0.0, 0.0) / uninitialized "null island" or single incomplete axis
    if (
      validLat === null ||
      validLng === null ||
      (Math.abs(validLat) < 0.0001 && Math.abs(validLng) < 0.0001)
    ) {
      validLat = null;
      validLng = null;
    }

    if (location_accuracy_meters !== undefined && location_accuracy_meters !== null && location_accuracy_meters !== '') {
      const parsedAcc = parseFloat(location_accuracy_meters);
      if (Number.isFinite(parsedAcc) && parsedAcc >= 0) {
        validAccuracy = parsedAcc;
      }
    }

    if (location_source === 'camera_capture' || location_source === 'manual' || location_source === 'photo_exif') {
      validSource = location_source;
    }

    if (location_captured_at && !isNaN(Date.parse(location_captured_at))) {
      validCapturedAt = new Date(location_captured_at).toISOString();
    }

    // Place Identity calculations
    const rawLocation = (location || '').toString().trim();
    const safeLocation = rawLocation.slice(0, 150);
    const cName = (canonical_name || rawLocation || '').toString().trim().slice(0, 255);
    const placeName = cName.slice(0, 150);
    const normName = (normalized_name || cName.toLowerCase().replace(/[^a-z0-9]/g, '')).toString().slice(0, 255);
    const rawAiConf = parseFloat(ai_confidence);
    const parsedAiConfidence = Number.isFinite(rawAiConf) ? rawAiConf : 0.95;
    const safeLandmarkType = (landmark_type || '').toString().trim().slice(0, 100);
    const hasValidCoords = validLat !== null && validLng !== null;
    const clusterId = duplicate_cluster_id
      ? duplicate_cluster_id.toString().slice(0, 100)
      : (hasValidCoords ? `cluster_${validLat.toFixed(3)}_${validLng.toFixed(3)}` : null);

    // Infer city/state if missing from multi-part "Place, City" / "City, State" display strings
    let resolvedCity = (city || '').toString().trim();
    let resolvedState = (state || '').toString().trim();
    let resolvedCountry = (country || '').toString().trim();
    if (!resolvedCity && rawLocation.includes(',')) {
      const locParts = rawLocation.split(',').map((s) => s.trim()).filter(Boolean);
      if (locParts.length >= 2) {
        resolvedCity = locParts[1];
      }
    }
    resolvedCity = resolvedCity.slice(0, 100);
    resolvedState = resolvedState.slice(0, 100);
    resolvedCountry = resolvedCountry.slice(0, 100);

    // Auto-match or create Master Place in `places` table BEFORE inserting reward flags
    let masterPlaceId = null;
    let isNewMasterPlace = false;
    let isDuplicatePlace = false;
    if (placeName !== '' && placeName.toLowerCase() !== 'unknown location') {
      try {
        const placeSearch = await db.query(
          'SELECT id, latitude, longitude FROM places WHERE LOWER(name) = LOWER($1) LIMIT 1',
          [placeName]
        );
        if (placeSearch.rows.length > 0) {
          masterPlaceId = placeSearch.rows[0].id;
          isDuplicatePlace = true;
          const existingLat = parseFloat(placeSearch.rows[0].latitude);
          const existingLng = parseFloat(placeSearch.rows[0].longitude);
          if (
            hasValidCoords &&
            Math.abs(existingLat) < 0.0001 &&
            Math.abs(existingLng) < 0.0001
          ) {
            await db.query(
              'UPDATE places SET latitude = $1, longitude = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
              [validLat, validLng, masterPlaceId]
            );
          }
        } else if (hasValidCoords) {
          const newPlace = await db.query(
            `INSERT INTO places (name, description, category, latitude, longitude, rating, image_url, is_featured)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              placeName,
              `Hidden travel location: ${cName}`,
              (category || 'Nature').toString().slice(0, 100),
              validLat,
              validLng,
              4.8,
              imageUrl,
              true
            ]
          );
          masterPlaceId = newPlace.rows[0].id;
          isNewMasterPlace = true;
        }
      } catch (err) {
        console.error('Error auto-linking master place:', err.message || err);
      }
    }

    let newPostResult;
    try {
      newPostResult = await db.query(
        `INSERT INTO posts 
         (user_id, caption, image_url, location, category, latitude, longitude, location_accuracy_meters, location_source, location_captured_at, canonical_name, normalized_name, landmark_type, city, state, country, ai_confidence, duplicate_cluster_id, place_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) 
         RETURNING *`,
        [
          userId, 
          caption || '', 
          imageUrl, 
          safeLocation, 
          (category || '').toString().slice(0, 100),
          validLat,
          validLng,
          validAccuracy,
          validSource,
          validCapturedAt,
          cName,
          normName,
          safeLandmarkType,
          resolvedCity,
          resolvedState,
          resolvedCountry,
          parsedAiConfidence,
          clusterId,
          masterPlaceId
        ]
      );
    } catch (insertErr) {
      console.error('Extended post insert failed, attempting auto-migration and retry:', insertErr.message);
      try {
        postLocationColumnsPromise = null;
        await ensurePostLocationColumns();

        newPostResult = await db.query(
          `INSERT INTO posts 
           (user_id, caption, image_url, location, category, latitude, longitude, location_accuracy_meters, location_source, location_captured_at, canonical_name, normalized_name, landmark_type, city, state, country, ai_confidence, duplicate_cluster_id, place_id) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) 
           RETURNING *`,
          [
            userId, 
            caption || '', 
            imageUrl, 
            safeLocation, 
            (category || '').toString().slice(0, 100),
            validLat,
            validLng,
            validAccuracy,
            validSource,
            validCapturedAt,
            cName,
            normName,
            safeLandmarkType,
            resolvedCity,
            resolvedState,
            resolvedCountry,
            parsedAiConfidence,
            clusterId,
            masterPlaceId
          ]
        );
      } catch (fallbackErr) {
        console.error('Retrying standard insert with core columns:', fallbackErr.message);
        newPostResult = await db.query(
          `INSERT INTO posts (user_id, caption, image_url, location, category) 
           VALUES ($1, $2, $3, $4, $5) 
           RETURNING *`,
          [userId, caption || '', imageUrl, safeLocation, (category || '').toString().slice(0, 100)]
        );
      }
    }

    const post = newPostResult.rows[0];

    try {
      const rewardService = require('../services/rewardService');
      await rewardService.processPostRewards({
        userId,
        postId: post.id,
        isCameraCapture: validSource === 'camera_capture',
        locationAccuracyMeters: validAccuracy,
        isNewMasterPlace,
        isDuplicatePlace,
      });
    } catch (rewardErr) {
      console.error('Error processing post rewards:', rewardErr.message);
    }

    // Persist post tags and send tag/mention/follower notifications
    const approvedTags = [];
    const pendingTagUsernames = [];
    const directNotifiedIds = new Set();
    let authorName = 'Someone';

    try {
      const authorResult = await db.query('SELECT name, username FROM users WHERE id = $1', [userId]);
      authorName = authorResult.rows[0]?.name || authorResult.rows[0]?.username || 'Someone';
    } catch (_) {}

    for (const taggedUser of tagEval.allowedUsers) {
      const isSelf = parseInt(taggedUser.id, 10) === parseInt(userId, 10);
      const tagStatus = !isSelf && taggedUser.manually_approve_tags ? 'pending' : 'approved';
      try {
        await db.query(
          `INSERT INTO post_tags (post_id, tagged_user_id, tagged_by_user_id, status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (post_id, tagged_user_id) DO UPDATE SET status = EXCLUDED.status`,
          [post.id, taggedUser.id, userId, tagStatus]
        );

        if (tagStatus === 'approved') {
          approvedTags.push({
            id: taggedUser.id,
            name: taggedUser.name,
            username: taggedUser.username,
            profile_picture: taggedUser.profile_picture,
          });
        } else if (taggedUser.username) {
          pendingTagUsernames.push(taggedUser.username);
        }

        if (!isSelf) {
          directNotifiedIds.add(taggedUser.id);
          const notifType = tagStatus === 'pending' ? 'tag_request' : 'tag';
          const notifText = tagStatus === 'pending'
            ? `${authorName} tagged you in a post. Tap to review.`
            : `${authorName} tagged you in a post.`;
          await db.query(
            `INSERT INTO notifications (user_id, actor_id, type, post_id, text)
             VALUES ($1, $2, $3, $4, $5)`,
            [taggedUser.id, userId, notifType, post.id, notifText]
          );
        }
      } catch (tagErr) {
        console.error('Error recording post tag:', tagErr.message);
      }
    }

    for (const mentionedUser of mentionEval.allowedUsers) {
      const isSelf = parseInt(mentionedUser.id, 10) === parseInt(userId, 10);
      if (isSelf || directNotifiedIds.has(mentionedUser.id)) continue;
      directNotifiedIds.add(mentionedUser.id);
      try {
        await db.query(
          `INSERT INTO notifications (user_id, actor_id, type, post_id, text)
           VALUES ($1, $2, 'mention', $3, $4)`,
          [mentionedUser.id, userId, post.id, `${authorName} mentioned you in a caption.`]
        );
      } catch (mentionErr) {
        console.error('Error sending caption mention notification:', mentionErr.message);
      }
    }

    // Send notifications to all remaining followers (excluding author & already notified users)
    try {
      const excludedIds = Array.from(directNotifiedIds);
      await db.query(
        `INSERT INTO notifications (user_id, actor_id, type, post_id, text)
         SELECT follower_id, $1, 'new_post', $2, $3
         FROM user_follows
         WHERE following_id = $1 AND follower_id != $1
           AND NOT (follower_id = ANY($4::int[]))
           AND ${isNotMutuallyBlockedSql('follower_id', '$1')}`,
        [
          userId,
          post.id,
          `${authorName} posted a new travel post.`,
          excludedIds
        ]
      );
    } catch (notifErr) {
      console.error('Error sending post notifications:', notifErr.message);
    }

    post.tagged_users = approvedTags;

    return res.status(201).json({
      message: pendingTagUsernames.length > 0
        ? 'Post created. Some tags are pending approval.'
        : 'Post created successfully.',
      post,
      pending_tag_usernames: pendingTagUsernames,
    });
  } catch (error) {
    cleanupTempFile(req.file);
    console.error('Error creating post:', error);
    return res.status(500).json({ error: error.message || 'Server error creating post.' });
  }
};

/**
 * Fetch global feed posts
 */


/**
 * GET /api/posts/feed
 */
exports.getFeed = async (req, res) => {
  const userId = req.user ? req.user.id : null;
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const offset = parseInt(req.query.offset) || 0;

  try {
    await ensureTagMentionSchema();
    await ensurePostLocationColumns();
    const blockFilter = isNotMutuallyBlockedSql('u.id', '$1');

    const feedResult = await db.query(
      `SELECT 
        p.id, 
        p.caption, 
        p.image_url, 
        p.location, 
        p.category, 
        p.latitude,
        p.longitude,
        p.location_source,
        p.location_accuracy_meters,
        p.canonical_name,
        p.landmark_type,
        p.city,
        p.state,
        p.country,
        p.likes_count, 
        p.created_at,
        u.id AS author_id,
        u.name AS author_name,
        u.username AS author_username,
        u.profile_picture AS author_profile_picture,
        (
          LOWER(u.username) IN ('hidely_official', 'hidely') 
          OR (SELECT COUNT(*)::int FROM posts p_cnt WHERE p_cnt.user_id = u.id) >= 50 
          OR (SELECT COUNT(*)::int FROM user_follows f_cnt WHERE f_cnt.following_id = u.id) >= 50000
        ) AS author_is_verified,
        (
          LOWER(u.username) IN ('hidely_official', 'hidely') 
          OR (SELECT COUNT(*)::int FROM posts p_cnt WHERE p_cnt.user_id = u.id) >= 50 
          OR (SELECT COUNT(*)::int FROM user_follows f_cnt WHERE f_cnt.following_id = u.id) >= 50000
        ) AS is_verified,
        EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $1) AS is_liked,
        EXISTS(SELECT 1 FROM post_bookmarks WHERE post_id = p.id AND user_id = $1) AS is_bookmarked,
        (SELECT COUNT(*)::int FROM post_comments WHERE post_id = p.id) AS comments_count,
        ${approvedTaggedUsersSql('p.id', '$1')}
      FROM posts p
      INNER JOIN users u ON p.user_id = u.id
      WHERE ${blockFilter}
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
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

    const postCreator = postResult.rows[0].user_id;
    if (postCreator !== userId) {
      const blockStatus = await getBlockStatus(userId, postCreator);
      if (blockStatus.blocked) {
        return res.status(403).json({ error: 'Cannot interact with this post.', blocked: true });
      }
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

    const postCreator = postResult.rows[0].user_id;
    if (postCreator !== userId) {
      const blockStatus = await getBlockStatus(userId, postCreator);
      if (blockStatus.blocked) {
        return res.status(403).json({ error: 'Cannot interact with this post.', blocked: true });
      }
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
    await ensurePostLocationColumns();
    const savedResult = await db.query(
      `SELECT 
        p.id, 
        p.caption, 
        p.image_url, 
        p.location, 
        p.category, 
        p.latitude,
        p.longitude,
        p.location_source,
        p.location_accuracy_meters,
        p.canonical_name,
        p.landmark_type,
        p.city,
        p.state,
        p.country,
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
  if (isNaN(userId)) {
    return res.status(200).json({ posts: [] });
  }
  const currentUserId = req.user ? req.user.id : null;

  try {
    await ensureTagMentionSchema();
    await ensurePostLocationColumns();
    if (currentUserId && parseInt(currentUserId, 10) !== userId) {
      const blockStatus = await getBlockStatus(currentUserId, userId);
      if (blockStatus.blocked) {
        return res.status(200).json({ posts: [], blocked: true });
      }
    }

    const postsResult = await db.query(
      `SELECT 
        p.id, 
        p.caption, 
        p.image_url, 
        p.location, 
        p.category, 
        p.latitude,
        p.longitude,
        p.location_source,
        p.location_accuracy_meters,
        p.canonical_name,
        p.landmark_type,
        p.city,
        p.state,
        p.country,
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
        ) AS comments_count,
        ${approvedTaggedUsersSql('p.id', '$2')}
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
    await ensureUserBlocksTable();
    const commenterBlockFilter = isNotMutuallyBlockedSql('u.id', '$2');
    const postAuthorBlockFilter = isNotMutuallyBlockedSql('p.user_id', '$2');

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
      INNER JOIN posts p ON c.post_id = p.id
      INNER JOIN users u ON c.user_id = u.id
      WHERE c.post_id = $1
        AND ${commenterBlockFilter}
        AND ${postAuthorBlockFilter}
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
    await ensureTagMentionSchema();

    const postResult = await db.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    const postCreator = postResult.rows[0].user_id;
    if (postCreator !== userId) {
      const blockStatus = await getBlockStatus(userId, postCreator);
      if (blockStatus.blocked) {
        return res.status(403).json({ error: 'Cannot comment on this post.', blocked: true });
      }
    }

    const mentionHandles = extractMentionUsernames(text);
    const mentionEval = await evaluateTagMentionTargets({
      actorId: userId,
      usernames: mentionHandles,
      mode: 'mention',
    });
    if (mentionEval.rejectedUsers.length > 0) {
      return res.status(403).json({
        error: buildRestrictionErrorMessage(mentionEval.rejectedUsers, 'mention'),
        mention_restricted: true,
        restricted_usernames: mentionEval.rejectedUsers.map((u) => u.username).filter(Boolean),
      });
    }

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

    const actorName = userResult.rows[0].name || userResult.rows[0].username || 'Someone';
    const snippet = `${text.trim().substring(0, 30)}${text.trim().length > 30 ? '...' : ''}`;

    // Send comment notification to post author if commented by someone else
    if (postCreator !== userId) {
      await db.query(
        `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, text)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          postCreator,
          userId,
          'comment',
          postId,
          result.rows[0].id,
          `${actorName} commented: "${snippet}"`
        ]
      );
    }

    // Send mention notifications to mentioned users (excluding self & postCreator who received comment notification)
    for (const mentionedUser of mentionEval.allowedUsers) {
      const targetId = parseInt(mentionedUser.id, 10);
      if (targetId === parseInt(userId, 10) || targetId === parseInt(postCreator, 10)) continue;
      try {
        await db.query(
          `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, text)
           VALUES ($1, $2, 'mention', $3, $4, $5)`,
          [
            targetId,
            userId,
            postId,
            result.rows[0].id,
            `${actorName} mentioned you in a comment: "${snippet}"`
          ]
        );
      } catch (mentionErr) {
        console.error('Error sending comment mention notification:', mentionErr.message);
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
 * Delete a comment
 * DELETE /api/posts/comment/:commentId
 */
exports.deleteComment = async (req, res) => {
  const userId = req.user.id;
  const commentId = parseInt(req.params.commentId);

  if (isNaN(commentId)) {
    return res.status(400).json({ error: 'Invalid comment ID.' });
  }

  try {
    // 1. Fetch comment & parent post info to verify permission
    const commentRes = await db.query(
      `SELECT c.id, c.user_id AS comment_author_id, c.post_id, p.user_id AS post_author_id 
       FROM post_comments c
       JOIN posts p ON c.post_id = p.id
       WHERE c.id = $1`,
      [commentId]
    );

    if (commentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found.' });
    }

    const comment = commentRes.rows[0];

    // Allow deletion if requester is either comment author OR post owner
    if (comment.comment_author_id !== userId && comment.post_author_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this comment.' });
    }

    // 2. Delete comment, likes, and notifications
    await db.query('DELETE FROM post_comment_likes WHERE comment_id = $1', [commentId]);
    await db.query('DELETE FROM notifications WHERE comment_id = $1', [commentId]);
    await db.query('DELETE FROM post_comments WHERE id = $1', [commentId]);

    return res.status(200).json({
      success: true,
      message: 'Comment deleted successfully.',
      commentId: commentId,
      postId: comment.post_id
    });
  } catch (error) {
    console.error('Error deleting comment:', error);
    return res.status(500).json({ error: 'Server error deleting comment.' });
  }
};

/**
 * Get a single post by ID
 * GET /api/posts/:id
 */
exports.getPostById = async (req, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return res.status(404).json({ error: 'Post not found.' });
  }
  const currentUserId = req.user ? req.user.id : null;

  try {
    await ensureTagMentionSchema();
    await ensurePostLocationColumns();
    const blockFilter = isNotMutuallyBlockedSql('u.id', '$2');

    const postResult = await db.query(
      `SELECT 
        p.id, 
        p.caption, 
        p.image_url, 
        p.location, 
        p.category, 
        p.latitude,
        p.longitude,
        p.location_source,
        p.location_accuracy_meters,
        p.canonical_name,
        p.landmark_type,
        p.city,
        p.state,
        p.country,
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
        ) AS comments_count,
        ${approvedTaggedUsersSql('p.id', '$2')}
      FROM posts p
      INNER JOIN users u ON p.user_id = u.id
      WHERE p.id = $1 AND ${blockFilter}`,
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
 * GET /api/posts/explore?category=...&city=...&search=...&sortBy=...&limit=...&offset=...
 */
exports.getExplorePosts = async (req, res) => {
  const { category, city, search, sortBy } = req.query;
  const currentUserId = req.user ? req.user.id : null;

  try {
    let parsedLimit = 50;
    let parsedOffset = 0;

    if (req.query.limit !== undefined && req.query.limit !== null && String(req.query.limit).trim() !== '') {
      const rawLimit = String(req.query.limit).trim();
      const lim = parseInt(rawLimit, 10);
      if (isNaN(lim) || lim <= 0 || String(lim) !== rawLimit) {
        return res.status(400).json({ error: 'Invalid limit parameter.' });
      }
      parsedLimit = Math.min(lim, 100);
    }

    if (req.query.offset !== undefined && req.query.offset !== null && String(req.query.offset).trim() !== '') {
      const rawOffset = String(req.query.offset).trim();
      const off = parseInt(rawOffset, 10);
      if (isNaN(off) || off < 0 || String(off) !== rawOffset) {
        return res.status(400).json({ error: 'Invalid offset parameter.' });
      }
      parsedOffset = off;
    }

    await ensureTagMentionSchema();
    await ensurePostLocationColumns();
    const exploreBlockFilter = isNotMutuallyBlockedSql('u.id', '$1');

    let query = `
      WITH target_posts AS (
        SELECT 
          p.id, 
          p.caption, 
          p.image_url, 
          p.location, 
          p.category, 
          p.latitude,
          p.longitude,
          p.location_source,
          p.location_accuracy_meters,
          p.canonical_name,
          p.landmark_type,
          p.city,
          p.state,
          p.country,
          p.likes_count, 
          p.created_at,
          u.id AS author_id,
          u.name AS author_name,
          u.username AS author_username,
          u.profile_picture AS author_profile_picture
        FROM posts p
        INNER JOIN users u ON p.user_id = u.id
        WHERE ${exploreBlockFilter}
    `;

    const queryParams = [currentUserId];
    let paramIndex = 2;

    if (category && category !== 'All') {
      const catLower = category.toLowerCase().trim();
      if (catLower.includes('mountain')) {
        query += ` AND (p.category ILIKE '%mountain%')`;
      } else if (catLower.includes('waterfall')) {
        query += ` AND (p.category ILIKE '%waterfall%')`;
      } else if (catLower.includes('river')) {
        query += ` AND (p.category ILIKE '%river%')`;
      } else if (catLower.includes('trek')) {
        query += ` AND (p.category ILIKE '%trek%')`;
      } else if (catLower.includes('camp')) {
        query += ` AND (p.category ILIKE '%camp%')`;
      } else if (catLower.includes('lake')) {
        query += ` AND (p.category ILIKE '%lake%')`;
      } else if (catLower.includes('beach')) {
        query += ` AND (p.category ILIKE '%beach%')`;
      } else if (catLower.includes('forest')) {
        query += ` AND (p.category ILIKE '%forest%')`;
      } else if (catLower.includes('heritage') || catLower.includes('historic')) {
        query += ` AND (p.category ILIKE '%heritage%' OR p.category ILIKE '%historic%')`;
      } else if (catLower.includes('temple')) {
        query += ` AND (p.category ILIKE '%temple%' OR p.caption ILIKE '%temple%' OR p.location ILIKE '%temple%' OR p.caption ILIKE '%mandir%')`;
      } else if (catLower.includes('fort')) {
        query += ` AND (p.category ILIKE '%fort%' OR p.caption ILIKE '%fort%' OR p.location ILIKE '%fort%')`;
      } else if (catLower.includes('desert')) {
        query += ` AND (p.category ILIKE '%desert%')`;
      } else {
        query += ` AND p.category ILIKE $${paramIndex}`;
        queryParams.push(`%${category}%`);
        paramIndex++;
      }
    }

    if (city && city !== 'All') {
      query += ` AND (p.location ILIKE $${paramIndex} OR p.city ILIKE $${paramIndex} OR p.state ILIKE $${paramIndex})`;
      queryParams.push(`%${city}%`);
      paramIndex++;
    }

    if (search && search.trim() !== '') {
      query += ` AND (p.caption ILIKE $${paramIndex} OR p.location ILIKE $${paramIndex} OR p.canonical_name ILIKE $${paramIndex} OR p.city ILIKE $${paramIndex} OR p.state ILIKE $${paramIndex} OR p.category ILIKE $${paramIndex})`;
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    let orderClause = `ORDER BY p.created_at DESC`;
    let outerOrderClause = `ORDER BY tp.created_at DESC`;

    if (sortBy === 'A-Z') {
      orderClause = `ORDER BY p.caption ASC`;
      outerOrderClause = `ORDER BY tp.caption ASC`;
    } else if (sortBy === 'Z-A') {
      orderClause = `ORDER BY p.caption DESC`;
      outerOrderClause = `ORDER BY tp.caption DESC`;
    }

    query += ` ${orderClause}`;

    if (parsedLimit !== null) {
      query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      queryParams.push(parsedLimit, parsedOffset);
      paramIndex += 2;
    }

    query += `
      )
      SELECT 
        tp.id,
        tp.caption,
        tp.image_url,
        tp.location,
        tp.category,
        tp.latitude,
        tp.longitude,
        tp.location_source,
        tp.location_accuracy_meters,
        tp.canonical_name,
        tp.landmark_type,
        tp.city,
        tp.state,
        tp.country,
        tp.likes_count,
        tp.created_at,
        tp.author_id,
        tp.author_name,
        tp.author_username,
        tp.author_profile_picture,
        COALESCE(liked.is_liked, FALSE) AS is_liked,
        COALESCE(bookmarked.is_bookmarked, FALSE) AS is_bookmarked,
        COALESCE(comments.comments_count, 0)::int AS comments_count,
        ${approvedTaggedUsersSql('tp.id', '$1')}
      FROM target_posts tp
      LEFT JOIN LATERAL (
        SELECT TRUE AS is_liked
        FROM post_likes
        WHERE post_id = tp.id
          AND user_id = $1
        LIMIT 1
      ) liked ON TRUE
      LEFT JOIN LATERAL (
        SELECT TRUE AS is_bookmarked
        FROM post_bookmarks
        WHERE post_id = tp.id
          AND user_id = $1
        LIMIT 1
      ) bookmarked ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS comments_count
        FROM post_comments
        WHERE post_id = tp.id
      ) comments ON TRUE
      ${outerOrderClause}
    `;

    const result = await db.query(query, queryParams);

    return res.status(200).json({
      posts: result.rows,
    });
  } catch (error) {
    console.error('Error fetching explore posts:', error);
    return res.status(500).json({ error: 'Server error fetching explore posts.' });
  }
};

/**
 * Delete a post by ID
 * DELETE /api/posts/:id
 */
exports.deletePost = async (req, res) => {
  const userId = req.user.id;
  const postId = parseInt(req.params.id);

  if (isNaN(postId)) {
    return res.status(400).json({ error: 'Invalid post ID.' });
  }

  try {
    const postCheck = await db.query('SELECT * FROM posts WHERE id = $1', [postId]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    if (postCheck.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this post.' });
    }

    await db.query('DELETE FROM post_likes WHERE post_id = $1', [postId]);
    await db.query('DELETE FROM post_bookmarks WHERE post_id = $1', [postId]);
    await db.query('DELETE FROM post_comments WHERE post_id = $1', [postId]);
    await db.query('DELETE FROM notifications WHERE post_id = $1', [postId]);
    await db.query('DELETE FROM post_tags WHERE post_id = $1', [postId]).catch(() => {});
    await db.query('DELETE FROM posts WHERE id = $1', [postId]);

    return res.status(200).json({ message: 'Post deleted successfully.' });
  } catch (error) {
    console.error('Error deleting post:', error);
    return res.status(500).json({ error: 'Server error deleting post.' });
  }
};

