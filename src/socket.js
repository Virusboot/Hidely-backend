const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('./config/db');
const { JWT_SECRET } = require('./config/jwt');
const { getSocketCorsConfig } = require('./config/corsConfig');
const { verifyActiveSession } = require('./middleware/authMiddleware');
const { getBlockStatus } = require('./utils/blockHelper');

let io = null;
const onlineUsers = new Map(); // String(userId) -> Set<socketId>
const activeCallRooms = new Map(); // String(callId) -> { callId, callType, callerId, targetUserId, conversationId, participants: Map<String(userId), socketId> }

function resolvePeerIdsFromRoom(room, senderKey, explicitTargetId) {
  const targets = new Set();
  if (explicitTargetId !== undefined && explicitTargetId !== null && String(explicitTargetId).trim() !== '') {
    const tid = String(explicitTargetId).trim();
    if (tid !== senderKey) targets.add(tid);
  }
  if (room) {
    if (room.callerId && room.callerId !== senderKey) targets.add(room.callerId);
    if (room.targetUserId && room.targetUserId !== senderKey) targets.add(room.targetUserId);
    for (const pid of room.participants.keys()) {
      if (pid !== senderKey) targets.add(pid);
    }
  }
  return Array.from(targets);
}

function initSocket(server) {
  io = socketIo(server, {
    cors: getSocketCorsConfig(),
  });

  // Socket Authentication Middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token || (socket.handshake.headers?.authorization ? socket.handshake.headers.authorization.split(' ')[1] : null);
      if (!token) {
        return next(new Error('Authentication token missing'));
      }
      const decoded = jwt.verify(token, JWT_SECRET);
      const sessionCheck = await verifyActiveSession(decoded);
      if (!sessionCheck.valid) {
        return next(new Error(sessionCheck.reason || 'Session revoked'));
      }
      socket.userId = decoded.id;
      next();
    } catch (err) {
      next(new Error('Invalid or expired authentication token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    const userKey = String(userId);
    console.log(`[Socket.IO] User connected: ${userId} (socket ${socket.id})`);

    let userSockets = onlineUsers.get(userKey);
    const wasOffline = !userSockets || userSockets.size === 0;
    if (!userSockets) {
      userSockets = new Set();
      onlineUsers.set(userKey, userSockets);
    }
    userSockets.add(socket.id);

    socket.join(`user_${userKey}`);
    if (wasOffline) {
      io.emit('presence_update', { userId: userKey, status: 'online' });
    }

    // Join conversation room
    socket.on('join_conversation', async (data) => {
      const conversationId = parseInt(data?.conversationId, 10);
      if (!Number.isFinite(conversationId) || conversationId <= 0) return;

      // Verify membership
      try {
        const memberCheck = await db.query(
          'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
          [conversationId, userId]
        );
        if (memberCheck.rows.length > 0) {
          socket.join(`conversation_${conversationId}`);
          console.log(`[Socket.IO] User ${userId} joined room conversation_${conversationId}`);
        }
      } catch (err) {
        console.error('[Socket.IO] Error verifying conversation membership:', err);
      }
    });

    // Leave conversation room
    socket.on('leave_conversation', (data) => {
      const conversationId = parseInt(data?.conversationId, 10);
      if (Number.isFinite(conversationId) && conversationId > 0) {
        socket.leave(`conversation_${conversationId}`);
      }
    });

    // Typing Indicators
    socket.on('typing_start', (data) => {
      const conversationId = parseInt(data?.conversationId, 10);
      if (Number.isFinite(conversationId) && conversationId > 0) {
        socket.to(`conversation_${conversationId}`).emit('typing_status', {
          conversationId,
          userId,
          isTyping: true,
        });
      }
    });

    socket.on('typing_stop', (data) => {
      const conversationId = parseInt(data?.conversationId, 10);
      if (Number.isFinite(conversationId) && conversationId > 0) {
        socket.to(`conversation_${conversationId}`).emit('typing_status', {
          conversationId,
          userId,
          isTyping: false,
        });
      }
    });

    // =========================================================================
    // WebRTC 1-on-1 Voice & Video Call Signaling (OurSpace-ported architecture)
    // =========================================================================
    socket.activeCallIds = new Set();

    socket.on('call_invite', async (data) => {
      try {
        const payload = data && typeof data === 'object' ? data : {};
        const callId = String(payload.callId || '').trim();
        if (!callId) return;

        let targetId = payload.targetUserId !== undefined && payload.targetUserId !== null
          ? String(payload.targetUserId).trim()
          : '';
        const convIdInt = parseInt(payload.conversationId, 10);

        // Resolve peer from conversation_members if targetUserId not supplied
        if (!targetId && Number.isFinite(convIdInt) && convIdInt > 0) {
          const peerRes = await db.query(
            `SELECT cm_other.user_id
             FROM conversation_members cm_self
             JOIN conversation_members cm_other
               ON cm_other.conversation_id = cm_self.conversation_id
              AND cm_other.user_id != $2
             WHERE cm_self.conversation_id = $1
               AND cm_self.user_id = $2
             LIMIT 1`,
            [convIdInt, userId]
          );
          if (peerRes.rows.length > 0) {
            targetId = String(peerRes.rows[0].user_id);
          }
        }

        if (!targetId || targetId === userKey) {
          socket.emit('call_failed', {
            callId,
            reason: 'invalid_target',
            message: 'Unable to locate recipient for call.',
          });
          return;
        }

        // Enforce block rules on calls
        const blockStatus = await getBlockStatus(userId, targetId);
        if (blockStatus.blocked) {
          socket.emit('call_failed', {
            callId,
            reason: 'blocked',
            targetUserId: targetId,
            message: 'Calling is unavailable for this user.',
          });
          return;
        }

        if (!isUserOnline(targetId)) {
          socket.emit('call_failed', {
            callId,
            reason: 'offline',
            targetUserId: targetId,
            message: 'User is currently offline or unreachable.',
          });
          return;
        }

        let callerName = payload.callerName || '';
        let callerUsername = payload.callerUsername || '';
        let callerAvatar = payload.callerAvatar || '';
        try {
          const callerRes = await db.query(
            'SELECT name, username, profile_picture FROM users WHERE id = $1',
            [userId]
          );
          if (callerRes.rows.length > 0) {
            callerName = callerRes.rows[0].name || callerRes.rows[0].username || callerName;
            callerUsername = callerRes.rows[0].username || callerUsername;
            callerAvatar = callerRes.rows[0].profile_picture || callerAvatar;
          }
        } catch (_) {}

        const room = {
          callId,
          callType: payload.callType === 'video' ? 'video' : 'audio',
          callerId: userKey,
          targetUserId: targetId,
          conversationId: Number.isFinite(convIdInt) && convIdInt > 0 ? convIdInt : null,
          participants: new Map([[userKey, socket.id]]),
        };
        activeCallRooms.set(callId, room);
        socket.activeCallIds.add(callId);

        io.to(`user_${targetId}`).emit('call_invite', {
          callId,
          callType: room.callType,
          conversationId: room.conversationId,
          senderId: userKey,
          callerName: callerName || callerUsername || 'Hidely User',
          callerUsername: callerUsername || callerName || 'user',
          callerAvatar: callerAvatar || '',
        });
      } catch (err) {
        console.error('[Socket.IO] call_invite error:', err.message);
      }
    });

    socket.on('call_ringing', (data) => {
      const payload = data && typeof data === 'object' ? data : {};
      const callId = String(payload.callId || '').trim();
      if (!callId) return;
      const room = activeCallRooms.get(callId);
      const targets = resolvePeerIdsFromRoom(room, userKey, payload.targetId);
      for (const tid of targets) {
        io.to(`user_${tid}`).emit('call_ringing', {
          callId,
          senderId: userKey,
        });
      }
    });

    socket.on('call_accept', (data) => {
      const payload = data && typeof data === 'object' ? data : {};
      const callId = String(payload.callId || '').trim();
      if (!callId) return;
      const room = activeCallRooms.get(callId);
      if (room) {
        room.participants.set(userKey, socket.id);
        socket.activeCallIds.add(callId);
      }
      const targets = resolvePeerIdsFromRoom(room, userKey, payload.targetId);
      for (const tid of targets) {
        io.to(`user_${tid}`).emit('call_accept', {
          callId,
          senderId: userKey,
        });
      }
    });

    socket.on('call_join', (data) => {
      const payload = data && typeof data === 'object' ? data : {};
      const callId = String(payload.callId || '').trim();
      if (!callId) return;
      let room = activeCallRooms.get(callId);
      if (!room) {
        room = {
          callId,
          callType: payload.callType === 'video' ? 'video' : 'audio',
          callerId: userKey,
          targetUserId: payload.targetId ? String(payload.targetId) : '',
          conversationId: payload.conversationId || null,
          participants: new Map(),
        };
        activeCallRooms.set(callId, room);
      }

      const existing = Array.from(room.participants.keys()).filter((id) => id !== userKey);
      room.participants.set(userKey, socket.id);
      socket.activeCallIds.add(callId);

      socket.emit('call_joined_ack', {
        callId,
        assignedParticipantId: userKey,
        existingParticipants: existing,
      });

      const targets = resolvePeerIdsFromRoom(room, userKey, payload.targetId);
      for (const tid of targets) {
        io.to(`user_${tid}`).emit('participant_joined', {
          callId,
          participantId: userKey,
          nickname: payload.nickname || '',
        });
      }
    });

    for (const signalEvent of ['call_offer', 'call_answer', 'ice_candidate', 'media_toggle']) {
      socket.on(signalEvent, (data) => {
        const payload = data && typeof data === 'object' ? data : {};
        const callId = String(payload.callId || '').trim();
        if (!callId) return;
        const room = activeCallRooms.get(callId);
        const targets = resolvePeerIdsFromRoom(room, userKey, payload.targetId);
        const outbound = {
          ...payload,
          callId,
          senderId: userKey,
        };
        for (const tid of targets) {
          io.to(`user_${tid}`).emit(signalEvent, outbound);
        }
      });
    }

    socket.on('call_busy', (data) => {
      const payload = data && typeof data === 'object' ? data : {};
      const callId = String(payload.callId || '').trim();
      if (!callId) return;
      const room = activeCallRooms.get(callId);
      const targets = resolvePeerIdsFromRoom(room, userKey, payload.targetId);
      for (const tid of targets) {
        io.to(`user_${tid}`).emit('call_busy', {
          callId,
          senderId: userKey,
          reason: 'busy',
        });
      }
      activeCallRooms.delete(callId);
    });

    for (const endEvent of ['call_hangup', 'call_decline', 'call_reject']) {
      socket.on(endEvent, (data) => {
        const payload = data && typeof data === 'object' ? data : {};
        const callId = String(payload.callId || '').trim();
        if (!callId) return;
        const room = activeCallRooms.get(callId);
        const targets = resolvePeerIdsFromRoom(room, userKey, payload.targetId);
        const reason = endEvent === 'call_decline' || endEvent === 'call_reject'
          ? 'declined'
          : (payload.reason || 'ended');
        for (const tid of targets) {
          io.to(`user_${tid}`).emit('call_ended', {
            callId,
            senderId: userKey,
            reason,
          });
        }
        socket.activeCallIds.delete(callId);
        activeCallRooms.delete(callId);
      });
    }

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`[Socket.IO] User disconnected: ${userId} (socket ${socket.id})`);
      const sockets = onlineUsers.get(userKey);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userKey);
          io.emit('presence_update', { userId: userKey, status: 'offline' });
          // Terminate active call rooms owned/joined by this user if fully offline
          for (const callId of socket.activeCallIds) {
            const room = activeCallRooms.get(callId);
            if (room) {
              const targets = resolvePeerIdsFromRoom(room, userKey, null);
              for (const tid of targets) {
                io.to(`user_${tid}`).emit('call_ended', {
                  callId,
                  senderId: userKey,
                  reason: 'disconnected',
                });
              }
              activeCallRooms.delete(callId);
            }
          }
        }
      }
      socket.activeCallIds.clear();
    });
  });

  return io;
}

function getIo() {
  return io;
}

function isUserOnline(userId) {
  if (userId === null || userId === undefined) return false;
  const sockets = onlineUsers.get(String(userId));
  return Boolean(sockets && sockets.size > 0);
}

module.exports = {
  initSocket,
  getIo,
  isUserOnline,
};
