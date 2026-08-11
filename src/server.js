const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const db = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const postRoutes = require('./routes/postRoutes');
const notificationRoutes = require('./routes/notificationRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static uploads folder (profile pictures, posts pictures)
const fs = require('fs');
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));
app.use('/assets', express.static(path.join(__dirname, '../../assets')));

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

// Root Endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the Hidely API Backend!' });
});

// Start Server & Test Database Connection
const startServer = async () => {
  try {
    // Sanity check for database connection
    console.log('Testing connection to PostgreSQL...');
    const dbTest = await db.query('SELECT NOW()');
    console.log(`PostgreSQL connection active. DB Server Time: ${dbTest.rows[0].now}`);

    // Ensure user ID 1 is mapped to hidely_official
    try {
      await db.query(`
        INSERT INTO users (id, name, email, password, username, points, is_verified)
        VALUES (1, 'Hidely Official', 'admin@hidely.com', '$2b$10$UnPK41UWhV/42uLshGepx.a3v0Jj.zOQW/vXz3W.H/fDqI4Vp.KzS', 'hidely_official', 12800, true)
        ON CONFLICT (id) DO UPDATE 
        SET username = 'hidely_official', name = 'Hidely Official', email = 'admin@hidely.com';
      `);
      console.log('Admin user mappings updated to hidely_official successfully.');
    } catch (dbErr) {
      console.error('Error updating admin user mappings:', dbErr);
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`-----------------------------------------------`);
      console.log(`Hidely backend server is running on http://localhost:${PORT}`);
      console.log(`-----------------------------------------------`);
    });
  } catch (error) {
    console.error('CRITICAL: Database connection test failed. Server not started.', error);
    process.exit(1);
  }
};

startServer();
