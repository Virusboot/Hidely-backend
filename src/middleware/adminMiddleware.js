const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { JWT_SECRET } = require('../config/jwt');

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

    // Check if user has admin privileges and active token version in database
    let userRes;
    try {
      userRes = await db.query(
        'SELECT id, email, username, is_admin, COALESCE(token_version, 0) AS token_version FROM users WHERE id = $1',
        [decoded.id]
      );
    } catch (colErr) {
      if (colErr && colErr.code === '42703') {
        userRes = await db.query(
          'SELECT id, email, username, is_admin FROM users WHERE id = $1',
          [decoded.id]
        );
      } else {
        throw colErr;
      }
    }

    if (userRes.rows.length === 0) {
      return res.status(403).json({ error: 'User account not found.' });
    }

    const user = userRes.rows[0];
    const dbTokenVersion = Number(user.token_version || 0);
    if ((decoded.tv !== undefined && Number(decoded.tv) !== dbTokenVersion) ||
        (decoded.tv === undefined && dbTokenVersion > 0)) {
      return res.status(401).json({ error: 'Admin session revoked. Please sign in again.' });
    }

    // Strict Database RBAC: Require is_admin === true
    if (!user.is_admin) {
      return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }

    req.admin = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token is invalid or expired.' });
  }
};

module.exports = adminMiddleware;
