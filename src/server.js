const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const db = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const postRoutes = require('./routes/postRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const chatRoutes = require('./routes/chatRoutes');
const gamificationRoutes = require('./routes/gamificationRoutes');
const { initSocket } = require('./socket');

const app = express();
const server = http.createServer(app);
const io = initSocket(server);
const PORT = process.env.PORT || 5050;

// Middleware
app.use(cors());
app.use(express.json());

// Disable Cache Middleware
app.use((req, res, next) => {
  res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  res.header('Expires', '-1');
  res.header('Pragma', 'no-cache');
  next();
});

// Serve static uploads folder (profile pictures, posts pictures)
const fs = require('fs');
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));
app.use('/assets', express.static(path.join(__dirname, '../../assets')));

// Serve Web Admin Dashboard
const adminPublicDir = path.join(__dirname, '../public/admin');
if (!fs.existsSync(adminPublicDir)) {
  fs.mkdirSync(adminPublicDir, { recursive: true });
}
app.use('/admin', express.static(adminPublicDir));
app.get(/^\/admin/, (req, res) => {
  res.sendFile(path.join(adminPublicDir, 'index.html'));
});

// Serve Flutter Responsive Web Social App (Feeds, Posts, Map, Profile, Likes)
const flutterAppDir = path.join(__dirname, '../public/app');
if (!fs.existsSync(flutterAppDir)) {
  fs.mkdirSync(flutterAppDir, { recursive: true });
}
app.use('/app', express.static(flutterAppDir));
app.get(/^\/app/, (req, res) => {
  res.sendFile(path.join(flutterAppDir, 'index.html'));
});

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/gamification', gamificationRoutes);

// Serve Unified Hidely Web Platform at Root /
const websiteDir = path.join(__dirname, '../public/website');
const altWebsiteDir = path.join(__dirname, '../../web_site');

const activeWebDir = fs.existsSync(websiteDir) ? websiteDir : fs.existsSync(altWebsiteDir) ? altWebsiteDir : null;

if (activeWebDir) {
  app.use(express.static(activeWebDir));
  app.get('(.*)', (req, res, next) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/admin') || req.url.startsWith('/uploads')) {
      return next();
    }
    res.sendFile(path.join(activeWebDir, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.json({ message: 'Welcome to the Hidely API Backend & Admin System!', adminDashboard: '/admin' });
  });
}

// Start Server & Test Database Connection
const startServer = async () => {
  // Bind to PORT immediately so Render health checks succeed
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`-----------------------------------------------`);
    console.log(`Hidely backend server is running on port ${PORT}`);
    console.log(`-----------------------------------------------`);
  });

  try {
    console.log('Testing connection to PostgreSQL...');
    const dbTest = await db.query('SELECT NOW()');
    console.log(`PostgreSQL connection active. DB Server Time: ${dbTest.rows[0].now}`);

    // Ensure user ID 1 is mapped to hidely_official
    try {
      await db.query(`
        INSERT INTO users (name, email, password_hash, username, points, is_verified)
        VALUES ('Hidely Official', 'admin@hidely.com', '$2b$10$UnPK41UWhV/42uLshGepx.a3v0Jj.zOQW/vXz3W.H/fDqI4Vp.KzS', 'hidely_official', 12800, true)
        ON CONFLICT (email) DO UPDATE 
        SET is_admin = true, is_verified = true;
      `);
      console.log('Admin user mappings updated to hidely_official successfully.');
    } catch (dbErr) {
      console.error('Error updating admin user mappings:', dbErr.message);
    }
  } catch (error) {
    console.warn('PostgreSQL connection check warning:', error.message);
  }
};

startServer();
