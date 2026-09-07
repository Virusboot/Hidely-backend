const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { JWT_SECRET } = require('../config/jwt');

/**
 * Admin Login
 */
const loginAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const inputClean = email.toLowerCase().trim();

    // Database lookup for admin user (must have is_admin = true)
    const userRes = await db.query(
      'SELECT * FROM users WHERE (email = $1 OR username = $1) AND is_admin = true',
      [inputClean]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    const user = userRes.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username, isAdmin: true },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      message: 'Admin login successful',
      token,
      admin: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
      },
    });
  } catch (error) {
    console.error('Admin Login Error:', error);
    return res.status(500).json({ error: 'Internal server error during admin login.' });
  }
};

/**
 * Get Dashboard Overview Statistics
 */
const getDashboardStats = async (req, res) => {
  try {
    const usersCountRes = await db.query('SELECT COUNT(*) FROM users');
    const postsCountRes = await db.query('SELECT COUNT(*) FROM posts');
    const placesCountRes = await db.query('SELECT COUNT(*) FROM places');
    const likesCountRes = await db.query('SELECT COUNT(*) FROM post_likes');
    const commentsCountRes = await db.query('SELECT COUNT(*) FROM post_comments');
    const verifiedUsersRes = await db.query('SELECT COUNT(*) FROM users WHERE is_verified = true');

    const totalUsers = parseInt(usersCountRes.rows[0].count) || 0;
    const totalPosts = parseInt(postsCountRes.rows[0].count) || 0;
    const totalPlaces = parseInt(placesCountRes.rows[0].count) || 0;
    const totalLikes = parseInt(likesCountRes.rows[0].count) || 0;
    const totalComments = parseInt(commentsCountRes.rows[0].count) || 0;
    const verifiedCreators = parseInt(verifiedUsersRes.rows[0].count) || 0;

    // Recent activity posts
    const recentPostsRes = await db.query(
      `SELECT p.id, p.caption, p.image_url, p.created_at, u.name as author_name, u.username as author_username
       FROM posts p
       JOIN users u ON p.user_id = u.id
       ORDER BY p.created_at DESC
       LIMIT 5`
    );

    return res.json({
      stats: {
        totalUsers,
        totalPosts,
        totalPlaces,
        totalLikes,
        totalComments,
        verifiedCreators,
        systemHealth: 'Online',
        serverTime: new Date().toISOString(),
      },
      recentPosts: recentPostsRes.rows,
    });
  } catch (error) {
    console.error('Dashboard Stats Error:', error);
    return res.status(500).json({ error: 'Failed to fetch dashboard stats.' });
  }
};

/**
 * Get All Users with Search & Filtering
 */
const getUsers = async (req, res) => {
  try {
    const { query, role } = req.query;
    let sql = `SELECT id, name, username, email, is_verified, COALESCE(is_admin, false) as is_admin, points, profile_picture, created_at FROM users WHERE 1=1`;
    const params = [];

    if (query) {
      params.push(`%${query.trim()}%`);
      sql += ` AND (name ILIKE $${params.length} OR username ILIKE $${params.length} OR email ILIKE $${params.length})`;
    }

    if (role === 'admin') {
      sql += ` AND is_admin = true`;
    } else if (role === 'verified') {
      sql += ` AND is_verified = true`;
    }

    sql += ` ORDER BY points DESC, created_at DESC LIMIT 100`;

    const result = await db.query(sql, params);
    return res.json({ users: result.rows });
  } catch (error) {
    console.error('Get Users Error:', error);
    return res.status(500).json({ error: 'Failed to fetch users list.' });
  }
};

/**
 * Update User Role / Verified Status / Points
 */
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { is_verified, is_admin, points, bio } = req.body;

    const updates = [];
    const params = [];

    if (is_verified !== undefined) {
      params.push(is_verified);
      updates.push(`is_verified = $${params.length}`);
    }

    if (is_admin !== undefined) {
      params.push(is_admin);
      updates.push(`is_admin = $${params.length}`);
    }

    if (points !== undefined) {
      params.push(parseInt(points));
      updates.push(`points = $${params.length}`);
    }

    if (bio !== undefined) {
      params.push(bio);
      updates.push(`bio = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields provided for update.' });
    }

    params.push(id);
    const sql = `UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${params.length} RETURNING id, name, username, email, is_verified, is_admin, points`;

    const result = await db.query(sql, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.json({ message: 'User updated successfully', user: result.rows[0] });
  } catch (error) {
    console.error('Update User Error:', error);
    return res.status(500).json({ error: 'Failed to update user.' });
  }
};

/**
 * Delete / Ban User
 */
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING id, name', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    return res.json({ message: 'User deleted successfully', deletedUser: result.rows[0] });
  } catch (error) {
    console.error('Delete User Error:', error);
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
};

/**
 * Get Curated Places
 */
const getPlaces = async (req, res) => {
  try {
    const { query, category } = req.query;
    let sql = `SELECT * FROM places WHERE 1=1`;
    const params = [];

    if (query) {
      params.push(`%${query.trim()}%`);
      sql += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`;
    }

    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }

    sql += ` ORDER BY is_featured DESC, id DESC LIMIT 100`;

    const result = await db.query(sql, params);
    return res.json({ places: result.rows });
  } catch (error) {
    console.error('Get Places Error:', error);
    return res.status(500).json({ error: 'Failed to fetch places list.' });
  }
};

/**
 * Add New Curated Place
 */
const createPlace = async (req, res) => {
  try {
    const { name, description, category, latitude, longitude, rating, is_featured } = req.body;

    if (!name || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Place name, latitude, and longitude are required.' });
    }

    let image_url = '';
    if (req.file) {
      image_url = `uploads/${req.file.filename}`;
    } else if (req.body.image_url) {
      image_url = req.body.image_url;
    }

    const result = await db.query(
      `INSERT INTO places (name, description, category, latitude, longitude, rating, image_url, is_featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name,
        description || '',
        category || 'Attraction',
        parseFloat(latitude),
        parseFloat(longitude),
        rating ? parseFloat(rating) : 4.8,
        image_url,
        is_featured === 'true' || is_featured === true,
      ]
    );

    return res.status(201).json({ message: 'Hidden place created successfully', place: result.rows[0] });
  } catch (error) {
    console.error('Create Place Error:', error);
    return res.status(500).json({ error: 'Failed to create new place.' });
  }
};

/**
 * Edit / Update Place
 */
const updatePlace = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, category, latitude, longitude, rating, is_featured } = req.body;

    let image_url = req.body.image_url;
    if (req.file) {
      image_url = `uploads/${req.file.filename}`;
    }

    const updates = [];
    const params = [];

    if (name) { params.push(name); updates.push(`name = $${params.length}`); }
    if (description !== undefined) { params.push(description); updates.push(`description = $${params.length}`); }
    if (category) { params.push(category); updates.push(`category = $${params.length}`); }
    if (latitude !== undefined) { params.push(parseFloat(latitude)); updates.push(`latitude = $${params.length}`); }
    if (longitude !== undefined) { params.push(parseFloat(longitude)); updates.push(`longitude = $${params.length}`); }
    if (rating !== undefined) { params.push(parseFloat(rating)); updates.push(`rating = $${params.length}`); }
    if (image_url) { params.push(image_url); updates.push(`image_url = $${params.length}`); }
    if (is_featured !== undefined) {
      params.push(is_featured === 'true' || is_featured === true);
      updates.push(`is_featured = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields provided for update.' });
    }

    params.push(id);
    const sql = `UPDATE places SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${params.length} RETURNING *`;

    const result = await db.query(sql, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Place not found.' });
    }

    return res.json({ message: 'Place updated successfully', place: result.rows[0] });
  } catch (error) {
    console.error('Update Place Error:', error);
    return res.status(500).json({ error: 'Failed to update place.' });
  }
};

/**
 * Delete Place
 */
const deletePlace = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM places WHERE id = $1 RETURNING id, name', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Place not found.' });
    }
    return res.json({ message: 'Place deleted successfully', deletedPlace: result.rows[0] });
  } catch (error) {
    console.error('Delete Place Error:', error);
    return res.status(500).json({ error: 'Failed to delete place.' });
  }
};

/**
 * Get Posts for Moderation
 */
const getPosts = async (req, res) => {
  try {
    const { query } = req.query;
    let sql = `SELECT p.id, p.caption, p.image_url, p.location, p.category, p.likes_count, COALESCE(p.status, 'approved') as status, p.created_at, u.name as author_name, u.username as author_username
               FROM posts p
               JOIN users u ON p.user_id = u.id
               WHERE 1=1`;
    const params = [];

    if (query) {
      params.push(`%${query.trim()}%`);
      sql += ` AND (p.caption ILIKE $${params.length} OR p.location ILIKE $${params.length} OR u.name ILIKE $${params.length})`;
    }

    sql += ` ORDER BY p.id DESC LIMIT 100`;

    const result = await db.query(sql, params);
    return res.json({ posts: result.rows });
  } catch (error) {
    console.error('Get Posts Error:', error);
    return res.status(500).json({ error: 'Failed to fetch posts.' });
  }
};

/**
 * Delete / Moderate Post
 */
const deletePost = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM posts WHERE id = $1 RETURNING id, caption', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    return res.json({ message: 'Post deleted successfully', deletedPost: result.rows[0] });
  } catch (error) {
    console.error('Delete Post Error:', error);
    return res.status(500).json({ error: 'Failed to delete post.' });
  }
};

/**
 * Broadcast System Notification to Users
 */
const broadcastNotification = async (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Notification message text is required.' });
    }

    const adminId = req.admin ? req.admin.id : 1;
    const notificationType = type || 'system_announcement';

    // Insert broadcast notification for all users using a single set-based PostgreSQL statement
    const insertRes = await db.query(
      `INSERT INTO notifications (user_id, actor_id, type, text, is_read)
       SELECT id, $1, $2, $3, false
       FROM users
       RETURNING id`,
      [adminId, notificationType, text.trim()]
    );

    return res.json({ message: `Broadcast sent to ${insertRes.rows.length} users successfully.` });
  } catch (error) {
    console.error('Broadcast Notification Error:', error);
    return res.status(500).json({ error: 'Failed to broadcast notification.' });
  }
};

/**
 * Get current reward configuration & daily maximum caps
 * GET /api/admin/rewards/config
 */
exports.getRewardConfig = (req, res) => {
  const rewardService = require('../services/rewardService');
  return res.json({
    success: true,
    config: rewardService.getRewardConfig(),
  });
};

/**
 * Update reward configuration & daily maximum caps
 * PUT /api/admin/rewards/config
 */
exports.updateRewardConfig = (req, res) => {
  const rewardService = require('../services/rewardService');
  const success = rewardService.updateRewardConfig(req.body);
  if (success) {
    return res.json({
      success: true,
      message: 'Reward configuration and maximum caps updated successfully.',
      config: rewardService.getRewardConfig(),
    });
  }
  return res.status(400).json({ success: false, error: 'Invalid configuration payload.' });
};

module.exports = {
  loginAdmin,
  getDashboardStats,
  getUsers,
  updateUser,
  deleteUser,
  getPlaces,
  createPlace,
  updatePlace,
  deletePlace,
  getPosts,
  deletePost,
  broadcastNotification,
  getRewardConfig: exports.getRewardConfig,
  updateRewardConfig: exports.updateRewardConfig,
};
