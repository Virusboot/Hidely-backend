const db = require('../config/db');

// Ensure DB indexes for notifications query optimization
(async () => {
  try {
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read)`);
  } catch (err) {
    console.error('Error creating notifications table indexes:', err);
  }
})();

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
    const result = await db.query(
      `SELECT 
        n.id,
        n.type,
        n.post_id,
        n.comment_id,
        n.text,
        n.is_read,
        n.created_at,
        u.id AS actor_id,
        u.name AS actor_name,
        u.username AS actor_username,
        u.profile_picture AS actor_profile_picture,
        COALESCE(u.is_verified, FALSE) AS actor_is_verified,
        p.image_url AS post_image_url
      FROM notifications n
      INNER JOIN users u ON n.actor_id = u.id
      LEFT JOIN posts p ON n.post_id = p.id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const unreadResult = await db.query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
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
    await db.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
      [notificationId, userId]
    );

    const unreadResult = await db.query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
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
    const result = await db.query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
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
