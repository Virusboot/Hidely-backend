const db = require('../config/db');

/**
 * Fetch all notifications for the current user
 * GET /api/notifications
 */
exports.getNotifications = async (req, res) => {
  const userId = req.user.id;

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
        p.image_url AS post_image_url
      FROM notifications n
      INNER JOIN users u ON n.actor_id = u.id
      LEFT JOIN posts p ON n.post_id = p.id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC`,
      [userId]
    );

    return res.status(200).json({
      notifications: result.rows,
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return res.status(500).json({ error: 'Server error fetching notifications.' });
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
