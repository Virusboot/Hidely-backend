const db = require('../config/db');
const { getIo } = require('../socket');
const { uploadToCloudinary } = require('../config/cloudinary');

/**
 * Get User Inbox Conversations
 * GET /api/chat/conversations
 */
exports.getConversations = async (req, res) => {
  const userId = req.user.id;
  const { archived } = req.query;

  try {
    const isArchivedParam = archived === 'true';

    const result = await db.query(
      `SELECT 
        c.id,
        c.type,
        c.name,
        c.created_at,
        c.updated_at,
        cm.is_pinned,
        cm.is_muted,
        cm.is_archived,
        cm.last_read_message_id,
        (
          SELECT json_build_object(
            'id', m.id,
            'text', m.text,
            'type', m.type,
            'sender_id', m.sender_id,
            'created_at', m.created_at
          )
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) AS last_message,
        (
          SELECT COUNT(*)::int
          FROM messages m
          WHERE m.conversation_id = c.id
            AND m.id > cm.last_read_message_id
            AND m.sender_id != $1
        ) AS unread_count,
        (
          SELECT json_agg(json_build_object(
            'id', u.id,
            'name', u.name,
            'username', u.username,
            'profile_picture', u.profile_picture,
            'is_verified', COALESCE(u.is_verified, false)
          ))
          FROM conversation_members cm2
          JOIN users u ON cm2.user_id = u.id
          WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
        ) AS participants
       FROM conversations c
       JOIN conversation_members cm ON c.id = cm.conversation_id
       WHERE cm.user_id = $1 AND cm.is_archived = $2
       ORDER BY cm.is_pinned DESC, c.updated_at DESC`,
      [userId, isArchivedParam]
    );

    res.json({ success: true, conversations: result.rows });
  } catch (err) {
    console.error('Error fetching conversations:', err);
    res.status(500).json({ error: 'Failed to fetch conversations.' });
  }
};

/**
 * Get or Create Direct Conversation with Target User
 * POST /api/chat/direct
 */
exports.getOrCreateDirectConversation = async (req, res) => {
  const userId = req.user.id;
  const { targetUserId } = req.body;

  if (!targetUserId || parseInt(targetUserId) === userId) {
    return res.status(400).json({ error: 'Valid target user ID is required.' });
  }

  const targetId = parseInt(targetUserId);

  try {
    // Check if a direct conversation pair already exists
    const existing = await db.query(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members cm1 ON c.id = cm1.conversation_id
       JOIN conversation_members cm2 ON c.id = cm2.conversation_id
       WHERE c.type = 'DIRECT'
         AND cm1.user_id = $1
         AND cm2.user_id = $2
       LIMIT 1`,
      [userId, targetId]
    );

    if (existing.rows.length > 0) {
      return res.json({ success: true, conversationId: existing.rows[0].id, isNew: false });
    }

    // Target user check
    const targetUser = await db.query('SELECT name, username FROM users WHERE id = $1', [targetId]);
    if (targetUser.rows.length === 0) {
      return res.status(404).json({ error: 'Target user not found.' });
    }

    // Create new direct conversation
    const newConv = await db.query(
      `INSERT INTO conversations (type, created_by) VALUES ('DIRECT', $1) RETURNING id`,
      [userId]
    );
    const convId = newConv.rows[0].id;

    // Add members
    await db.query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [convId, userId, targetId]
    );

    res.json({ success: true, conversationId: convId, isNew: true });
  } catch (err) {
    console.error('Error creating direct conversation:', err);
    res.status(500).json({ error: 'Failed to create conversation.' });
  }
};

/**
 * Get Conversation Messages
 * GET /api/chat/conversations/:conversationId/messages
 */
exports.getMessages = async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const limit = parseInt(req.query.limit) || 50;

  try {
    // Verify membership
    const memberCheck = await db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to access this conversation.' });
    }

    const messagesResult = await db.query(
      `SELECT 
        m.id,
        m.conversation_id,
        m.sender_id,
        m.type,
        m.text,
        m.reply_to_message_id,
        m.shared_entity_type,
        m.shared_entity_id,
        m.latitude,
        m.longitude,
        m.created_at,
        m.deleted_at,
        u.name AS sender_name,
        u.username AS sender_username,
        u.profile_picture AS sender_profile_picture,
        (
          SELECT json_agg(json_build_object(
            'id', ma.id,
            'type', ma.type,
            'url', ma.url,
            'thumbnail_url', ma.thumbnail_url,
            'duration', ma.duration
          ))
          FROM message_attachments ma
          WHERE ma.message_id = m.id
        ) AS attachments,
        (
          SELECT json_agg(json_build_object(
            'user_id', mr.user_id,
            'emoji', mr.emoji
          ))
          FROM message_reactions mr
          WHERE mr.message_id = m.id
        ) AS reactions,
        (
          SELECT json_build_object(
            'id', rm.id,
            'text', rm.text,
            'sender_id', rm.sender_id,
            'sender_name', ru.name
          )
          FROM messages rm
          LEFT JOIN users ru ON rm.sender_id = ru.id
          WHERE rm.id = m.reply_to_message_id
        ) AS reply_to_message
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC
       LIMIT $2`,
      [conversationId, limit]
    );

    res.json({ success: true, messages: messagesResult.rows });
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
};

/**
 * Send Message (Text / Media / Shared Post / Place / Location)
 * POST /api/chat/conversations/:conversationId/messages
 */
exports.sendMessage = async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { 
    type = 'text', 
    text = '', 
    reply_to_message_id, 
    shared_entity_type, 
    shared_entity_id,
    latitude,
    longitude
  } = req.body;

  try {
    // Verify membership
    const memberCheck = await db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to post in this conversation.' });
    }

    let mediaUrl = null;
    let mediaType = type;

    // Handle File Upload if present
    if (req.file) {
      mediaUrl = await uploadToCloudinary(req.file.path, 'hidely/chat');
      const ext = req.file.path.split('.').last.toLowerCase();
      if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
        mediaType = 'video';
      } else {
        mediaType = 'image';
      }
    }

    // Insert Message
    const msgResult = await db.query(
      `INSERT INTO messages 
       (conversation_id, sender_id, type, text, reply_to_message_id, shared_entity_type, shared_entity_id, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        conversationId,
        userId,
        mediaType,
        text || '',
        reply_to_message_id ? parseInt(reply_to_message_id) : null,
        shared_entity_type || null,
        shared_entity_id || null,
        latitude ? parseFloat(latitude) : null,
        longitude ? parseFloat(longitude) : null
      ]
    );

    const message = msgResult.rows[0];

    // Insert Media Attachment if present
    if (mediaUrl) {
      const attResult = await db.query(
        `INSERT INTO message_attachments (message_id, type, url) VALUES ($1, $2, $3) RETURNING *`,
        [message.id, mediaType, mediaUrl]
      );
      message.attachments = [attResult.rows[0]];
    } else {
      message.attachments = [];
    }

    // Update conversation timestamp
    await db.query(
      'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP, last_message_id = $1 WHERE id = $2',
      [message.id, conversationId]
    );

    // Fetch Sender Info
    const senderResult = await db.query('SELECT name, username, profile_picture FROM users WHERE id = $1', [userId]);
    message.sender_name = senderResult.rows[0].name;
    message.sender_username = senderResult.rows[0].username;
    message.sender_profile_picture = senderResult.rows[0].profile_picture;
    message.reactions = [];

    // Emit Real-time Socket Event
    const io = getIo();
    if (io) {
      io.to(`conversation_${conversationId}`).emit('new_message', message);
    }

    // Trigger Push Notifications to conversation recipients (excluding sender)
    const membersResult = await db.query(
      'SELECT user_id, is_muted FROM conversation_members WHERE conversation_id = $1 AND user_id != $2',
      [conversationId, userId]
    );

    for (const row of membersResult.rows) {
      if (!row.is_muted) {
        await db.query(
          `INSERT INTO notifications (user_id, actor_id, type, text) VALUES ($1, $2, 'message', $3)`,
          [row.user_id, userId, text ? text.substring(0, 80) : 'Sent a media message']
        );
      }
    }

    res.status(201).json({ success: true, message });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message.' });
  }
};

/**
 * Toggle Reaction on Message
 * POST /api/chat/messages/:messageId/reactions
 */
exports.toggleReaction = async (req, res) => {
  const userId = req.user.id;
  const { messageId } = req.params;
  const { emoji } = req.body;

  if (!emoji) {
    return res.status(400).json({ error: 'Emoji is required.' });
  }

  try {
    const existing = await db.query(
      'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, userId, emoji]
    );

    if (existing.rows.length > 0) {
      await db.query('DELETE FROM message_reactions WHERE id = $1', [existing.rows[0].id]);
    } else {
      await db.query(
        'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [messageId, userId, emoji]
      );
    }

    const msgResult = await db.query('SELECT conversation_id FROM messages WHERE id = $1', [messageId]);
    if (msgResult.rows.length > 0) {
      const convId = msgResult.rows[0].conversation_id;
      const io = getIo();
      if (io) {
        io.to(`conversation_${convId}`).emit('message_reaction', { messageId, userId, emoji });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error toggling reaction:', err);
    res.status(500).json({ error: 'Failed to update reaction.' });
  }
};

/**
 * Mark Conversation as Read
 * PATCH /api/chat/conversations/:conversationId/read
 */
exports.markAsRead = async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const latestMsg = await db.query(
      'SELECT id FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1',
      [conversationId]
    );

    const lastId = latestMsg.rows.length > 0 ? latestMsg.rows[0].id : 0;

    await db.query(
      'UPDATE conversation_members SET last_read_message_id = $1 WHERE conversation_id = $2 AND user_id = $3',
      [lastId, conversationId, userId]
    );

    const io = getIo();
    if (io) {
      io.to(`conversation_${conversationId}`).emit('message_read', { conversationId, userId, lastReadMessageId: lastId });
    }

    res.json({ success: true, lastReadMessageId: lastId });
  } catch (err) {
    console.error('Error marking conversation as read:', err);
    res.status(500).json({ error: 'Failed to mark conversation as read.' });
  }
};

/**
 * Toggle Pin Conversation
 * PATCH /api/chat/conversations/:conversationId/pin
 */
exports.togglePin = async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const resPin = await db.query(
      `UPDATE conversation_members 
       SET is_pinned = NOT is_pinned 
       WHERE conversation_id = $1 AND user_id = $2 
       RETURNING is_pinned`,
      [conversationId, userId]
    );
    res.json({ success: true, isPinned: resPin.rows[0].is_pinned });
  } catch (err) {
    console.error('Error toggling pin:', err);
    res.status(500).json({ error: 'Failed to toggle pin state.' });
  }
};

/**
 * Toggle Mute Conversation
 * PATCH /api/chat/conversations/:conversationId/mute
 */
exports.toggleMute = async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const resMute = await db.query(
      `UPDATE conversation_members 
       SET is_muted = NOT is_muted 
       WHERE conversation_id = $1 AND user_id = $2 
       RETURNING is_muted`,
      [conversationId, userId]
    );
    res.json({ success: true, isMuted: resMute.rows[0].is_muted });
  } catch (err) {
    console.error('Error toggling mute:', err);
    res.status(500).json({ error: 'Failed to toggle mute state.' });
  }
};

/**
 * Toggle Archive Conversation
 * PATCH /api/chat/conversations/:conversationId/archive
 */
exports.toggleArchive = async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const resArc = await db.query(
      `UPDATE conversation_members 
       SET is_archived = NOT is_archived 
       WHERE conversation_id = $1 AND user_id = $2 
       RETURNING is_archived`,
      [conversationId, userId]
    );
    res.json({ success: true, isArchived: resArc.rows[0].is_archived });
  } catch (err) {
    console.error('Error toggling archive:', err);
    res.status(500).json({ error: 'Failed to toggle archive state.' });
  }
};
