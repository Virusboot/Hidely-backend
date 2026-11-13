const http = require('http');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
require('dotenv').config();

const db = require('./config/db');
const { corsOptions } = require('./config/corsConfig');
const securityHeaders = require('./middleware/securityHeaders');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const postRoutes = require('./routes/postRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const chatRoutes = require('./routes/chatRoutes');
const gamificationRoutes = require('./routes/gamificationRoutes');
const mapRoutes = require('./routes/mapRoutes');
const reportRoutes = require('./routes/reportRoutes');
const { initSocket } = require('./socket');

const app = express();
app.disable('x-powered-by'); // Disable Express identification in production
const server = http.createServer(app);
const io = initSocket(server);
const PORT = process.env.PORT || 5050;

// Production Startup Environment & Configuration Safety Check
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET) {
    console.error('FATAL PRODUCTION ERROR: JWT_SECRET environment variable is missing!');
  }
  if (!process.env.DATABASE_URL) {
    console.error('FATAL PRODUCTION ERROR: DATABASE_URL environment variable is missing!');
  }
}

// Security Headers, CORS, & HTTP Compression Middleware
app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(compression());

// Body Parsing & Request Size Limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static Asset Cache Options (1 day = 86400s)
const staticCacheOptions = {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
};

// Serve static uploads folder (profile pictures, posts pictures)
const fs = require('fs');
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir, staticCacheOptions));
app.use('/assets', express.static(path.join(__dirname, '../../assets'), staticCacheOptions));

// Serve Web Admin Dashboard
const adminPublicDir = path.join(__dirname, '../public/admin');
if (!fs.existsSync(adminPublicDir)) {
  fs.mkdirSync(adminPublicDir, { recursive: true });
}
app.use('/admin', express.static(adminPublicDir, staticCacheOptions));
app.get(/^\/admin/, (req, res) => {
  res.sendFile(path.join(adminPublicDir, 'index.html'));
});

// Serve Flutter Responsive Web Social App (Feeds, Posts, Map, Profile, Likes)
const flutterAppDir = path.join(__dirname, '../public/app');
if (!fs.existsSync(flutterAppDir)) {
  fs.mkdirSync(flutterAppDir, { recursive: true });
}
app.use('/app', express.static(flutterAppDir, staticCacheOptions));
app.get(/^\/app/, (req, res) => {
  res.sendFile(path.join(flutterAppDir, 'index.html'));
});

// Disable Cache Middleware for API requests
app.use('/api', (req, res, next) => {
  res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  res.header('Expires', '-1');
  res.header('Pragma', 'no-cache');
  next();
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
app.use('/api/map', mapRoutes);
app.use('/api/reports', reportRoutes);

// Public Legal & Google Play Policy Pages (Data Deletion URL, Privacy Policy, Terms, Child Safety)
app.get('/delete-account', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Delete Your Hidely Account &amp; Data</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1c0d5a; margin: 0; padding: 24px; }
    .card { max-width: 520px; margin: 32px auto; background: #fff; border-radius: 16px; padding: 28px; box-shadow: 0 8px 30px rgba(28, 13, 90, 0.08); }
    h1 { margin-top: 0; font-size: 22px; }
    p { font-size: 14px; line-height: 1.55; color: #475569; }
    label { display: block; margin: 14px 0 6px; font-weight: 600; font-size: 13px; }
    input { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 14px; }
    button { margin-top: 18px; width: 100%; padding: 13px; background: #dc2626; color: #fff; border: 0; border-radius: 12px; font-weight: 700; font-size: 15px; cursor: pointer; }
    .msg { margin-top: 14px; padding: 12px; border-radius: 10px; font-size: 13px; display: none; }
    .msg.ok { display: block; background: #ecfdf5; color: #065f46; }
    .msg.err { display: block; background: #fef2f2; color: #991b1b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Permanent Account &amp; Data Deletion — Hidely</h1>
    <p>Enter your registered email address and password below to permanently erase your Hidely profile, posts, photos/videos, comments, messages, and location records. This action cannot be undone.</p>
    <form id="delForm">
      <label for="email">Registered Email</label>
      <input id="email" type="email" required placeholder="you@example.com" />
      <label for="password">Password</label>
      <input id="password" type="password" required placeholder="Current password" />
      <label for="confirm">Type <strong>DELETE</strong> to confirm</label>
      <input id="confirm" type="text" required placeholder="DELETE" />
      <button type="submit">Permanently Delete Account</button>
    </form>
    <div id="statusMsg" class="msg"></div>
    <p style="margin-top:20px;font-size:12px;">Need assistance? Contact Privacy Support at <strong>support@hidely.app</strong> or Grievance Officer at <strong>grievance@hidely.app</strong>.</p>
  </div>
  <script>
    document.getElementById('delForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var msgEl = document.getElementById('statusMsg');
      msgEl.className = 'msg';
      msgEl.textContent = '';
      var email = document.getElementById('email').value.trim();
      var password = document.getElementById('password').value;
      var confirmText = document.getElementById('confirm').value.trim();
      if (confirmText !== 'DELETE') {
        msgEl.className = 'msg err';
        msgEl.textContent = 'Please type DELETE in the confirmation box.';
        return;
      }
      try {
        var res = await fetch('/api/users/web-delete-account', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password: password, confirm: 'DELETE' })
        });
        var data = await res.json();
        if (res.ok) {
          msgEl.className = 'msg ok';
          msgEl.textContent = data.message || 'Account permanently deleted.';
          document.getElementById('delForm').reset();
        } else {
          msgEl.className = 'msg err';
          msgEl.textContent = data.error || 'Unable to delete account.';
        }
      } catch (err) {
        msgEl.className = 'msg err';
        msgEl.textContent = 'Network error. Please try again.';
      }
    });
  </script>
</body>
</html>`);
});

app.get('/privacy-policy', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hidely Privacy Policy</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#1e293b;line-height:1.6}h1,h2{color:#1c0d5a}</style></head>
<body>
<h1>Hidely Privacy Policy</h1>
<p><strong>Effective Date:</strong> July 16, 2026</p>
<p>Hidely respects your privacy and processes personal data in accordance with the Digital Personal Data Protection Act, 2023 (India), Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021, and app store platform requirements.</p>
<h2>1. Data We Collect</h2>
<p>Account information (name, username, email address, hashed password), user-generated posts/comments/messages, media metadata, and foreground GPS coordinates solely with your permission.</p>
<h2>2. Service Providers &amp; SDKs</h2>
<p>We process data through infrastructure providers strictly to operate app features: Render/PostgreSQL (backend &amp; database hosting), Cloudinary (media storage), Google Maps / OpenStreetMap Nominatim &amp; Photon (location discovery &amp; geocoding), encrypted peer-to-peer WebRTC (user-initiated voice/video calls), Resend/SMTP (transactional OTP emails), and optional Gemini AI place verification. We do not sell user data or serve behavioral third-party ads.</p>
<h2>3. Data Rights &amp; Account Deletion</h2>
<p>You may download your personal data in-app under Settings &amp; Privacy &rarr; Download My Data, or permanently delete your account inside the app or online at <a href="/delete-account">/delete-account</a>.</p>
<h2>4. Child Safety (Zero Tolerance CSAE)</h2>
<p>Hidely strictly prohibits Child Sexual Abuse and Exploitation (CSAE). Accounts must be 18+ years old. See <a href="/child-safety">/child-safety</a>.</p>
<h2>5. Grievance Officer (IT Rules 2021)</h2>
<p>Grievance Officer: <strong>grievance@hidely.app</strong> | General Support: <strong>support@hidely.app</strong>. Complaints are acknowledged within 24 hours and resolved within 15 days (24 hours for urgent safety/CSAE takedowns).</p>
</body></html>`);
});

app.get('/terms', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hidely Terms of Service</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#1e293b;line-height:1.6}h1,h2{color:#1c0d5a}</style></head>
<body>
<h1>Hidely Terms of Service</h1>
<p><strong>Effective Date:</strong> July 16, 2026</p>
<h2>1. Eligibility</h2>
<p>You must be at least 18 years old to register or use Hidely.</p>
<h2>2. Community Conduct &amp; Zero Tolerance Moderation</h2>
<p>Users may not upload illegal, abusive, defamatory, sexually explicit, or Child Sexual Abuse and Exploitation (CSAE) content. Violating content and accounts are removed within 24 hours.</p>
<h2>3. Non-Monetary Explorer Points &amp; Preview Features</h2>
<p>In-app XP, levels, and badges are non-monetary recognition metrics with zero cash, wallet, or INR redemption value. Directory previews marked Coming Soon do not process live financial transactions or bookings.</p>
<h2>4. Grievance &amp; Legal Contact</h2>
<p>Support: support@hidely.app | Grievance Officer: grievance@hidely.app</p>
</body></html>`);
});

app.get('/child-safety', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hidely Child Safety Standards</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#1e293b;line-height:1.6}h1,h2{color:#1c0d5a}</style></head>
<body>
<h1>Hidely Child Safety &amp; CSAE Zero-Tolerance Policy</h1>
<p>Hidely enforces a strict zero-tolerance policy against Child Sexual Abuse Material (CSAM) and Child Sexual Exploitation and Abuse (CSAE). All Hidely accounts require 18+ age confirmation.</p>
<h2>In-App Reporting &amp; Rapid Takedown</h2>
<p>Any user can report content or profiles under "Child Safety / CSAE" using the report option on every post, reel, and profile. Reported accounts and content are queued immediately for urgent safety review and removed within 24 hours, with reporting to relevant legal authorities (e.g., NCMEC / Indian cybercrime authorities) where required by law.</p>
<h2>Safety Contact</h2>
<p>Dedicated Child Safety / Grievance Contact: <strong>grievance@hidely.app</strong></p>
</body></html>`);
});

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

// Global Express Error Handling Middleware (Safe production messages)
app.use((err, req, res, next) => {
  const isProduction = process.env.NODE_ENV === 'production';
  console.error(`[Express Error Handler] ${req.method} ${req.url}:`, err.message || err);

  const statusCode = err.status || err.statusCode || (res.statusCode >= 400 ? res.statusCode : 500);
  const message = isProduction
    ? (statusCode === 429 ? err.message : 'An error occurred while processing your request.')
    : (err.message || 'Internal Server Error');

  return res.status(statusCode).json({
    error: message,
    ...(isProduction ? {} : { details: err.stack }),
  });
});

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

    // Auto-verify and apply schema migrations
    try {
      console.log('[Schema] Checking database schema & columns...');
      await db.query(`
        ALTER TABLE posts 
        ADD COLUMN IF NOT EXISTS duplicate_cluster_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS location_accuracy_meters DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS location_source VARCHAR(50),
        ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS canonical_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS normalized_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS landmark_type VARCHAR(100),
        ADD COLUMN IF NOT EXISTS city VARCHAR(100),
        ADD COLUMN IF NOT EXISTS state VARCHAR(100),
        ADD COLUMN IF NOT EXISTS country VARCHAR(100),
        ADD COLUMN IF NOT EXISTS ai_confidence DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS place_id INTEGER,
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'approved';

        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS total_points INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS current_level INTEGER DEFAULT 1,
        ADD COLUMN IF NOT EXISTS current_rank INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS explorer_score DOUBLE PRECISION DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_points_updated_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS featured_badge_id INTEGER,
        ADD COLUMN IF NOT EXISTS allow_tags_from VARCHAR(20) DEFAULT 'everyone',
        ADD COLUMN IF NOT EXISTS allow_mentions_from VARCHAR(20) DEFAULT 'everyone',
        ADD COLUMN IF NOT EXISTS manually_approve_tags BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS accepted_terms_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS is_adult_confirmed BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMP WITH TIME ZONE;

        ALTER TABLE otps
        ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;

        CREATE TABLE IF NOT EXISTS content_reports (
          id SERIAL PRIMARY KEY,
          reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          target_type VARCHAR(30) NOT NULL,
          target_id INTEGER,
          reported_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          target_name VARCHAR(255) DEFAULT '',
          reason VARCHAR(80) NOT NULL,
          details TEXT DEFAULT '',
          status VARCHAR(30) NOT NULL DEFAULT 'pending',
          admin_note TEXT DEFAULT '',
          reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports (status, created_at DESC);

        CREATE TABLE IF NOT EXISTS user_blocks (
          blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (blocker_id, blocked_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks (blocker_id);
        CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks (blocked_id);

        CREATE TABLE IF NOT EXISTS post_tags (
          id SERIAL PRIMARY KEY,
          post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          tagged_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tagged_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'approved',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (post_id, tagged_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_post_tags_tagged_user ON post_tags (tagged_user_id, status);
        CREATE INDEX IF NOT EXISTS idx_post_tags_post_id ON post_tags (post_id, status);
      `);
      console.log('[Schema] All required database tables & columns verified.');
    } catch (schemaErr) {
      console.error('[Schema] Migration verification notice:', schemaErr.message);
    }

    // In non-production environments, ensure default dev seed mapping exists
    if (process.env.NODE_ENV !== 'production') {
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
    }
  } catch (error) {
    console.warn('PostgreSQL connection check warning:', error.message);
  }
};

// Graceful Shutdown Handler & Signal Listeners
let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Graceful Shutdown] Received ${signal}. Starting shutdown sequence...`);

  // Set 10-second bounded timeout to prevent process hanging
  const shutdownTimeout = setTimeout(() => {
    console.error('[Graceful Shutdown] Bounded shutdown timeout reached (10s). Terminating process.');
    process.exit(1);
  }, 10000);

  if (shutdownTimeout.unref) {
    shutdownTimeout.unref();
  }

  try {
    // 1. Stop accepting new HTTP connections
    await new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          console.error('[Graceful Shutdown] Error closing HTTP server:', err.message);
        } else {
          console.log('[Graceful Shutdown] HTTP server closed successfully.');
        }
        resolve();
      });
    });

    // 2. Drain and close PostgreSQL database pool
    if (db.pool && typeof db.pool.end === 'function') {
      try {
        await db.pool.end();
        console.log('[Graceful Shutdown] PostgreSQL pool drained and closed successfully.');
      } catch (dbErr) {
        console.error('[Graceful Shutdown] Error closing PostgreSQL pool:', dbErr.message);
      }
    }

    console.log('[Graceful Shutdown] Clean shutdown complete. Exiting.');
    process.exit(0);
  } catch (err) {
    console.error('[Graceful Shutdown] Critical error during shutdown:', err.message);
    process.exit(1);
  }
};

if (require.main === module) {
  if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.DATABASE_URL)) {
    console.error('FATAL PRODUCTION ERROR: Missing required JWT_SECRET or DATABASE_URL. Aborting startup.');
    process.exit(1);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  startServer();
}

module.exports = { app, server, startServer };
