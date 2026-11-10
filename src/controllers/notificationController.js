const db = require('../config/db');
const { ensureUserBlocksTable, isNotMutuallyBlockedSql } = require('../utils/blockHelper');



/**
 * Helper to create a notification row safely (used by rewardService and controllers)
 */
exports.createNotification = async ({
  userId,
  actorId = null,
  type = 'system_announcement',
  postId = null,
  commentId = null,
  title = '',
  message = '',
  text = '',
}) => {
  if (!userId) return null;

  let resolvedActorId = actorId;
  if (!resolvedActorId) {
    try {
      const officialRes = await db.query(
        `SELECT id FROM users
         WHERE username IN ('hidely_official', 'hidely', 'admin') OR is_admin = TRUE
         ORDER BY id ASC LIMIT 1`
      );
      resolvedActorId = officialRes.rows[0]?.id || userId;
    } catch (_) {
      resolvedActorId = userId;
    }
  }

  const rawTitle = (title || '').toString().trim();
  const rawMessage = (message || '').toString().trim();
  const rawText = (text || '').toString().trim();

  let finalText = rawText;
  if (!finalText) {
    if (rawTitle && rawMessage) {
      finalText = `${rawTitle} — ${rawMessage}`;
    } else {
      finalText = rawMessage || rawTitle || 'You have a new notification.';
    }
  }

  const insertRes = await db.query(
    `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, text)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, resolvedActorId, type, postId, commentId, finalText]
  );

  return insertRes.rows[0] || null;
};

/**
 * Fetch notifications for the current user (paginated)
 * GET /api/notifications?page=1&limit=30
 */
exports.getNotifications = async (req, res) => {
  const userId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
  const offset = (page - 1) * limit;

  try {
    await ensureUserBlocksTable();
    const blockFilter = isNotMutuallyBlockedSql('n.actor_id', '$1');

    const result = await db.query(
      `SELECT 
        n.id,
        n.type,
        n.post_id,
        n.comment_id,
        n.text,
        n.is_read,
        n.created_at,
        COALESCE(u.id, n.actor_id) AS actor_id,
        COALESCE(NULLIF(TRIM(u.name), ''), NULLIF(TRIM(u.username), ''), 'Hidely') AS actor_name,
        COALESCE(NULLIF(TRIM(u.username), ''), 'hidely') AS actor_username,
        COALESCE(u.profile_picture, '') AS actor_profile_picture,
        COALESCE(u.is_verified, FALSE) AS actor_is_verified,
        p.image_url AS post_image_url
      FROM notifications n
      LEFT JOIN users u ON n.actor_id = u.id
      LEFT JOIN posts p ON n.post_id = p.id
      WHERE n.user_id = $1 AND ${blockFilter}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const unreadResult = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM notifications n
       WHERE n.user_id = $1 AND n.is_read = FALSE AND ${blockFilter}`,
      [userId]
    );

    return res.status(200).json({
      notifications: result.rows,
      unread_count: unreadResult.rows[0]?.count || 0,
      page,
      limit,
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return res.status(500).json({ error: 'Server error fetching notifications.' });
  }
};

/**
 * Mark a single notification as read
 * PATCH /api/notifications/:id/read
 */
exports.markSingleAsRead = async (req, res) => {
  const userId = req.user.id;
  const notificationId = req.params.id;

  try {
    await ensureUserBlocksTable();
    const blockFilter = isNotMutuallyBlockedSql('n.actor_id', '$1');

    await db.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
      [notificationId, userId]
    );

    const unreadResult = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM notifications n
       WHERE n.user_id = $1 AND n.is_read = FALSE AND ${blockFilter}`,
      [userId]
    );

    return res.status(200).json({
      message: 'Notification marked as read.',
      unread_count: unreadResult.rows[0]?.count || 0,
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    return res.status(500).json({ error: 'Server error marking notification as read.' });
  }
};

/**
 * Mark all notifications as read
 * POST /api/notifications/read
 */
exports.markAsRead = async (req, res) => {
  const userId = req.user.id;

  try {
    await db.query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1',
      [userId]
    );

    return res.status(200).json({
      message: 'All notifications marked as read.',
      unread_count: 0,
    });
  } catch (error) {
    console.error('Error marking notifications as read:', error);
    return res.status(500).json({ error: 'Server error marking notifications as read.' });
  }
};

/**
 * Get unread notification count
 * GET /api/notifications/unread-count
 */
exports.getUnreadCount = async (req, res) => {
  const userId = req.user.id;

  try {
    await ensureUserBlocksTable();
    const blockFilter = isNotMutuallyBlockedSql('n.actor_id', '$1');

    const result = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM notifications n
       WHERE n.user_id = $1 AND n.is_read = FALSE AND ${blockFilter}`,
      [userId]
    );

    return res.status(200).json({
      unread_count: result.rows[0].count,
    });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    return res.status(500).json({ error: 'Server error fetching unread count.' });
  }
};
