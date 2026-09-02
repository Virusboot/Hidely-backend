const jwt = require('jsonwebtoken');
const db = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'hidely_super_secret_jwt_key_2026';

const adminMiddleware = async (req, res, next) => {
  const authHeader = req.header('Authorization');

  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization token provided.' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Authorization header format must be Bearer <token>' });
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    // Check if user has admin privileges in database
    const userRes = await db.query('SELECT id, email, username, is_admin FROM users WHERE id = $1', [decoded.id]);
    
    if (userRes.rows.length === 0) {
      return res.status(403).json({ error: 'User account not found.' });
    }

    const user = userRes.rows[0];
    
    // Check if user is admin or if email is default admin
    if (!user.is_admin && user.email !== 'admin@hidely.com' && user.username !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }

    req.admin = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token is invalid or expired.' });
  }
};

module.exports = adminMiddleware;
