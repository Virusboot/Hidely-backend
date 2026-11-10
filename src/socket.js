const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('./config/db');
const { JWT_SECRET } = require('./config/jwt');
const { getSocketCorsConfig } = require('./config/corsConfig');

let io = null;
const onlineUsers = new Map(); // String(userId) -> Set<socketId>

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

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`[Socket.IO] User disconnected: ${userId} (socket ${socket.id})`);
      const sockets = onlineUsers.get(userKey);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userKey);
          io.emit('presence_update', { userId: userKey, status: 'offline' });
        }
      }
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
