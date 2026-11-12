const crypto = require('crypto');
const db = require('../config/db');
const { getIo, isUserOnline } = require('../socket');
const { uploadToCloudinary } = require('../config/cloudinary');
const { ensureUserBlocksTable, getBlockStatus } = require('../utils/blockHelper');

/**
 * Get User Inbox Conversations
 * GET /api/chat/conversations
 */
exports.getConversations = async (req, res) => {
  const userId = req.user.id;
  const { archived } = req.query;

  try {
    await ensureUserBlocksTable();
    const isArchivedParam = archived === 'true';

    const result = await db.query(
      `WITH target_conversations AS (
        SELECT 
          c.id,
          c.type,
          c.name,
          c.created_at,
          c.updated_at,
          cm.is_pinned,
          cm.is_muted,
          cm.is_archived,
          COALESCE(cm.last_read_message_id, 0) AS last_read_message_id
        FROM conversations c
        JOIN conversation_members cm ON c.id = cm.conversation_id
        WHERE cm.user_id = $1
          AND cm.is_archived = $2
          AND (
            c.type != 'DIRECT'
            OR NOT EXISTS (
              SELECT 1
              FROM conversation_members cm_other
              JOIN user_blocks ub ON (
                (ub.blocker_id = $1 AND ub.blocked_id = cm_other.user_id)
                OR (ub.blocker_id = cm_other.user_id AND ub.blocked_id = $1)
              )
              WHERE cm_other.conversation_id = c.id
                AND cm_other.user_id != $1
            )
          )
        ORDER BY cm.is_pinned DESC, c.updated_at DESC
      )
      SELECT 
        tc.id,
        tc.type,
        tc.name,
        tc.created_at,
        tc.updated_at,
        tc.is_pinned,
        tc.is_muted,
        tc.is_archived,
        tc.last_read_message_id,
        lm.last_message,
        COALESCE(unr.unread_count, 0)::int AS unread_count,
        part.participants
      FROM target_conversations tc
      LEFT JOIN LATERAL (
        SELECT json_build_object(
          'id', m.id,
          'text', m.text,
          'type', m.type,
          'sender_id', m.sender_id,
          'created_at', m.created_at
        ) AS last_message
        FROM messages m
        WHERE m.conversation_id = tc.id
          AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ) lm ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS unread_count
        FROM messages m
        WHERE m.conversation_id = tc.id
          AND m.id > tc.last_read_message_id
          AND m.deleted_at IS NULL
          AND m.sender_id != $1
      ) unr ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'id', u.id,
          'name', u.name,
          'username', u.username,
          'profile_picture', u.profile_picture,
          'is_verified', COALESCE(u.is_verified, false)
        )) AS participants
        FROM conversation_members cm2
        JOIN users u ON cm2.user_id = u.id
        WHERE cm2.conversation_id = tc.id AND cm2.user_id != $1
      ) part ON TRUE
      ORDER BY tc.is_pinned DESC, tc.updated_at DESC`,
      [userId, isArchivedParam]
    );

    const mapped = result.rows.map((conv) => {
      if (conv.participants && Array.isArray(conv.participants)) {
        conv.participants = conv.participants.map((p) => ({
          ...p,
          is_online: isUserOnline(p.id),
        }));
      } else {
        conv.participants = [];
      }
      conv.target_user = conv.type === 'DIRECT' && conv.participants.length > 0
        ? conv.participants[0]
        : null;
      return conv;
    });

    // Deduplicate DIRECT conversations per peer user without displacing new conversations below older ones
    const rankDirectConv = (conv) => {
      const hasMsg = conv.last_message ? 1 : 0;
      const pinned = conv.is_pinned ? 1 : 0;
      const ts = new Date(conv.last_message?.created_at || conv.updated_at || conv.created_at || 0).getTime();
      return { hasMsg, pinned, ts };
    };

    const conversations = [];
    const directPeerIndex = new Map();
    for (const conv of mapped) {
      if (conv.type === 'DIRECT') {
        const peer = conv.target_user;
        if (!peer || peer.id === undefined || peer.id === null) {
          continue;
        }
        const peerKey = String(peer.id);
        if (directPeerIndex.has(peerKey)) {
          const idx = directPeerIndex.get(peerKey);
          const existing = conversations[idx];
          const a = rankDirectConv(existing);
          const b = rankDirectConv(conv);
          const bWins =
            b.hasMsg > a.hasMsg ||
            (b.hasMsg === a.hasMsg && (b.pinned > a.pinned || (b.pinned === a.pinned && b.ts > a.ts)));
          const combinedUnread = (existing.unread_count || 0) + (conv.unread_count || 0);
          if (bWins) {
            conv.unread_count = combinedUnread;
            conversations[idx] = conv;
          } else {
            existing.unread_count = combinedUnread;
          }
          continue;
        }
        directPeerIndex.set(peerKey, conversations.length);
      }
      conversations.push(conv);
    }

    res.json({ success: true, conversations });
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
  const userId = parseInt(req.user.id, 10);
  const { targetUserId } = req.body;
  const targetId = parseInt(targetUserId, 10);

  if (!Number.isFinite(targetId) || targetId <= 0 || targetId === userId) {
    return res.status(400).json({ error: 'Valid target user ID is required.' });
  }

  let client;
  try {
    const blockStatus = await getBlockStatus(userId, targetId);
    if (blockStatus.blocked) {
      return res.status(403).json({
        error: 'Messaging is unavailable for this user.',
        blocked: true,
      });
    }

    // Target user check
    const targetUser = await db.query('SELECT name, username FROM users WHERE id = $1', [targetId]);
    if (targetUser.rows.length === 0) {
      return res.status(404).json({ error: 'Target user not found.' });
    }

    client = await db.pool.connect();
    await client.query('BEGIN');

    // Serialize direct chat creation per sorted user pair to prevent race-condition duplicates
    const lowId = Math.min(userId, targetId);
    const highId = Math.max(userId, targetId);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [lowId, highId]);

    const existing = await client.query(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members cm1 ON c.id = cm1.conversation_id
       JOIN conversation_members cm2 ON c.id = cm2.conversation_id
       WHERE c.type = 'DIRECT'
         AND cm1.user_id = $1
         AND cm2.user_id = $2
         AND (
           SELECT COUNT(*) FROM conversation_members cm_cnt WHERE cm_cnt.conversation_id = c.id
         ) = 2
       ORDER BY (
         c.last_message_id IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
         )
       ) DESC, c.updated_at DESC, c.id ASC
       LIMIT 1`,
      [userId, targetId]
    );

    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      client.release();
      client = null;
      return res.json({ success: true, conversationId: existing.rows[0].id, isNew: false });
    }

    // Create new direct conversation
    const newConv = await client.query(
      `INSERT INTO conversations (type, created_by) VALUES ('DIRECT', $1) RETURNING id`,
      [userId]
    );
    const convId = newConv.rows[0].id;

    // Add both members idempotently
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id)
       VALUES ($1, $2), ($1, $3)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [convId, userId, targetId]
    );

    await client.query('COMMIT');
    client.release();
    client = null;

    res.json({ success: true, conversationId: convId, isNew: true });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    console.error('Error creating direct conversation:', err);
    res.status(500).json({ error: 'Failed to create conversation.' });
  } finally {
    if (client) {
      client.release();
    }
  }
};

/**
 * Get Conversation Messages
 * GET /api/chat/conversations/:conversationId/messages
 */
exports.getMessages = async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const parsedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;

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
      `WITH target_messages AS (
        SELECT 
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
          m.deleted_at
        FROM messages m
        WHERE m.conversation_id = $1
          AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $2
      )
      SELECT 
        tm.id,
        tm.conversation_id,
        tm.sender_id,
        tm.type,
        tm.text,
        tm.reply_to_message_id,
        tm.shared_entity_type,
        tm.shared_entity_id,
        tm.latitude,
        tm.longitude,
        tm.created_at,
        tm.deleted_at,
        u.name AS sender_name,
        u.username AS sender_username,
        u.profile_picture AS sender_profile_picture,
        att.attachments,
        react.reactions,
        rep.reply_to_message
      FROM target_messages tm
      LEFT JOIN users u ON tm.sender_id = u.id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'id', ma.id,
          'type', ma.type,
          'url', ma.url,
          'thumbnail_url', ma.thumbnail_url,
          'duration', ma.duration
        )) AS attachments
        FROM message_attachments ma
        WHERE ma.message_id = tm.id
      ) att ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'user_id', mr.user_id,
          'emoji', mr.emoji
        )) AS reactions
        FROM message_reactions mr
        WHERE mr.message_id = tm.id
      ) react ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_build_object(
          'id', rm.id,
          'text', rm.text,
          'sender_id', rm.sender_id,
          'sender_name', COALESCE(ru.name, ru.username, 'User')
        ) AS reply_to_message
        FROM messages rm
        LEFT JOIN users ru ON rm.sender_id = ru.id
        WHERE rm.id = tm.reply_to_message_id
      ) rep ON TRUE
      ORDER BY tm.created_at ASC, tm.id ASC`,
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

  const cleanText = typeof text === 'string' ? text.trim() : String(text || '').trim();
  const hasGeo = latitude !== undefined && latitude !== null && longitude !== undefined && longitude !== null;
  if (!cleanText && !req.file && !shared_entity_id && !hasGeo) {
    return res.status(400).json({ error: 'Message content cannot be empty.' });
  }

  let client;
  try {
    await ensureUserBlocksTable();
    client = await db.pool.connect();

    // Verify membership
    const memberCheck = await client.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    if (memberCheck.rows.length === 0) {
      client.release();
      client = null;
      return res.status(403).json({ error: 'Not authorized to post in this conversation.' });
    }

    // Prevent messaging inside blocked DIRECT conversations
    const blockCheck = await client.query(
      `SELECT 1
       FROM conversations c
       JOIN conversation_members cm_other ON cm_other.conversation_id = c.id AND cm_other.user_id != $2
       JOIN user_blocks ub ON (
         (ub.blocker_id = $2 AND ub.blocked_id = cm_other.user_id)
         OR (ub.blocker_id = cm_other.user_id AND ub.blocked_id = $2)
       )
       WHERE c.id = $1 AND c.type = 'DIRECT'
       LIMIT 1`,
      [conversationId, userId]
    );
    if (blockCheck.rows.length > 0) {
      client.release();
      client = null;
      return res.status(403).json({ error: 'Messaging is unavailable for this conversation.', blocked: true });
    }

    let mediaUrl = null;
    let mediaType = type;

    // Handle File Upload if present (performed before transaction BEGIN)
    if (req.file) {
      try {
        mediaUrl = await uploadToCloudinary(req.file.path, 'hidely/chat');
      } catch (err) {
        console.warn('Cloudinary upload failed, falling back to local upload URL:', err.message);
        mediaUrl = `/uploads/${req.file.filename}`;
      }
      if (!mediaUrl) {
        mediaUrl = `/uploads/${req.file.filename}`;
      }

      const fileNameOrPath = req.file.originalname || req.file.filename || req.file.path;
      const parts = fileNameOrPath.split('.');
      const ext = parts[parts.length - 1].toLowerCase();
      if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
        mediaType = 'video';
      } else {
        mediaType = 'image';
      }
    }

    const parsedReplyId = reply_to_message_id ? parseInt(reply_to_message_id, 10) : null;
    const validReplyId = Number.isFinite(parsedReplyId) && parsedReplyId > 0 ? parsedReplyId : null;

    // Begin transaction for atomic writes
    await client.query('BEGIN');

    // Insert Message
    const msgResult = await client.query(
      `INSERT INTO messages 
       (conversation_id, sender_id, type, text, reply_to_message_id, shared_entity_type, shared_entity_id, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        conversationId,
        userId,
        mediaType,
        cleanText,
        validReplyId,
        shared_entity_type || null,
        shared_entity_id || null,
        latitude ? parseFloat(latitude) : null,
        longitude ? parseFloat(longitude) : null
      ]
    );

    const message = msgResult.rows[0];

    // Insert Media Attachment if present
    if (mediaUrl) {
      const attResult = await client.query(
        `INSERT INTO message_attachments (message_id, type, url) VALUES ($1, $2, $3) RETURNING *`,
        [message.id, mediaType, mediaUrl]
      );
      message.attachments = [attResult.rows[0]];
    } else {
      message.attachments = [];
    }

    // Update conversation timestamp & sender's last_read_message_id
    await client.query(
      'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP, last_message_id = $1 WHERE id = $2',
      [message.id, conversationId]
    );
    await client.query(
      'UPDATE conversation_members SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $1) WHERE conversation_id = $2 AND user_id = $3',
      [message.id, conversationId, userId]
    );

    // Insert notifications for all unmuted conversation members (excluding sender) using single set-based query
    const notificationText = cleanText ? cleanText.substring(0, 80) : 'Sent a media message';
    await client.query(
      `INSERT INTO notifications (user_id, actor_id, type, text)
       SELECT user_id, $1, 'message', $2
       FROM conversation_members
       WHERE conversation_id = $3 AND user_id != $1 AND (is_muted IS FALSE OR is_muted IS NULL)`,
      [userId, notificationText, conversationId]
    );

    // Fetch Sender Info, reply snippet & recipient members inside transaction
    const senderResult = await client.query('SELECT name, username, profile_picture FROM users WHERE id = $1', [userId]);
    message.sender_name = senderResult.rows[0] ? (senderResult.rows[0].name || senderResult.rows[0].username || '') : '';
    message.sender_username = senderResult.rows[0] ? senderResult.rows[0].username : '';
    message.sender_profile_picture = senderResult.rows[0] ? senderResult.rows[0].profile_picture : null;
    message.reactions = [];
    message.reply_to_message = null;

    if (validReplyId) {
      const repRes = await client.query(
        `SELECT rm.id, rm.text, rm.sender_id, COALESCE(ru.name, ru.username, 'User') AS sender_name
         FROM messages rm
         LEFT JOIN users ru ON rm.sender_id = ru.id
         WHERE rm.id = $1 AND rm.conversation_id = $2`,
        [validReplyId, conversationId]
      );
      if (repRes.rows.length > 0) {
        message.reply_to_message = repRes.rows[0];
      }
    }

    const membersResult = await client.query(
      'SELECT user_id, is_muted FROM conversation_members WHERE conversation_id = $1 AND user_id != $2',
      [conversationId, userId]
    );

    // Commit Transaction
    await client.query('COMMIT');
    client.release();
    client = null;

    // Emit Real-time Socket Event once per unique connected socket (no duplicate room delivery)
    const io = getIo();
    if (io) {
      let broadcast = io.to(`conversation_${conversationId}`);
      for (const row of membersResult.rows) {
        broadcast = broadcast.to(`user_${row.user_id}`);
      }
      broadcast.emit('new_message', message);
    }

    return res.status(201).json({ success: true, message });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback error in sendMessage:', rollbackErr.message);
      }
    }
    console.error('Error sending message:', err);
    return res.status(500).json({ error: 'Failed to send message.' });
  } finally {
    if (client) {
      client.release();
    }
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
    const msgResult = await db.query('SELECT conversation_id FROM messages WHERE id = $1', [messageId]);
    if (msgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found.' });
    }
    const convId = msgResult.rows[0].conversation_id;

    const memberCheck = await db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [convId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to react in this conversation.' });
    }

    const existing = await db.query(
      'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, userId, emoji]
    );

    let active;
    if (existing.rows.length > 0) {
      await db.query('DELETE FROM message_reactions WHERE id = $1', [existing.rows[0].id]);
      active = false;
    } else {
      await db.query(
        'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [messageId, userId, emoji]
      );
      active = true;
    }

    const io = getIo();
    if (io) {
      io.to(`conversation_${convId}`).emit('message_reaction', {
        messageId: parseInt(messageId, 10) || messageId,
        conversationId: convId,
        userId,
        emoji,
        active,
      });
    }

    res.json({ success: true, active });
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
    const memberCheck = await db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to access this conversation.' });
    }

    const latestMsg = await db.query(
      'SELECT id FROM messages WHERE conversation_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
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
    if (resPin.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
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
    if (resMute.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
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
    if (resArc.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
    res.json({ success: true, isArchived: resArc.rows[0].is_archived });
  } catch (err) {
    console.error('Error toggling archive:', err);
    res.status(500).json({ error: 'Failed to toggle archive state.' });
  }
};

/**
 * Get ICE / STUN / TURN Server Configuration for WebRTC Calls
 * GET /api/chat/ice-servers
 */
exports.getIceServers = async (req, res) => {
  try {
    const userId = req.user?.id || 'guest';
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
    ];

    const turnUrl = (process.env.TURN_URL || '').trim();
    const turnTlsUrl = (process.env.TURN_URL_TLS || '').trim();
    const turnSecret = (process.env.TURN_SECRET || '').trim();
    const staticUser = (process.env.TURN_USERNAME || '').trim();
    const staticCred = (process.env.TURN_CREDENTIAL || '').trim();

    if (turnUrl && (turnUrl.startsWith('turn:') || turnUrl.startsWith('turns:'))) {
      let username = staticUser;
      let credential = staticCred;

      if (turnSecret) {
        const ttlSeconds = 86400;
        const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
        username = `${expiry}:${userId}`;
        credential = crypto
          .createHmac('sha1', turnSecret)
          .update(username)
          .digest('base64');
      }

      if (username && credential) {
        iceServers.push({ urls: turnUrl, username, credential });
        if (!turnUrl.includes('?transport=')) {
          iceServers.push({ urls: `${turnUrl}?transport=tcp`, username, credential });
        }
        if (turnTlsUrl && turnTlsUrl.startsWith('turns:')) {
          iceServers.push({ urls: turnTlsUrl, username, credential });
        }
      }
    }

    return res.json({
      success: true,
      iceServers,
      ttlSeconds: 86400,
    });
  } catch (err) {
    console.error('[ChatController] Failed generating ICE server config');
    return res.status(500).json({ error: 'Failed to load ICE server configuration.' });
  }
};
