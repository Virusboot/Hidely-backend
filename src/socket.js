const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('./config/db');

let io = null;
const onlineUsers = new Map(); // userId -> socketId

function initSocket(server) {
  io = socketIo(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Socket Authentication Middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token || (socket.handshake.headers?.authorization ? socket.handshake.headers.authorization.split(' ')[1] : null);
      if (!token) {
        return next(new Error('Authentication token missing'));
      }
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'hidely_secret_key_2026');
      socket.userId = decoded.id;
      next();
    } catch (err) {
      next(new Error('Invalid or expired authentication token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`[Socket.IO] User connected: ${userId} (socket ${socket.id})`);
    
    onlineUsers.set(String(userId), socket.id);
    onlineUsers.set(parseInt(userId), socket.id);
    socket.join(`user_${userId}`);
    io.emit('presence_update', { userId: String(userId), status: 'online' });

    // Join conversation room
    socket.on('join_conversation', async (data) => {
      const conversationId = data.conversationId;
      if (!conversationId) return;

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
      if (data.conversationId) {
        socket.leave(`conversation_${data.conversationId}`);
      }
    });

    // Typing Indicators
    socket.on('typing_start', (data) => {
      if (data.conversationId) {
        socket.to(`conversation_${data.conversationId}`).emit('typing_status', {
          conversationId: data.conversationId,
          userId,
          isTyping: true,
        });
      }
    });

    socket.on('typing_stop', (data) => {
      if (data.conversationId) {
        socket.to(`conversation_${data.conversationId}`).emit('typing_status', {
          conversationId: data.conversationId,
          userId,
          isTyping: false,
        });
      }
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`[Socket.IO] User disconnected: ${userId}`);
      onlineUsers.delete(String(userId));
      onlineUsers.delete(parseInt(userId));
      io.emit('presence_update', { userId: String(userId), status: 'offline' });
    });
  });

  return io;
}

function getIo() {
  return io;
}

function isUserOnline(userId) {
  if (!userId) return false;
  return onlineUsers.has(String(userId)) || onlineUsers.has(parseInt(userId));
}

module.exports = {
  initSocket,
  getIo,
  isUserOnline,
};
