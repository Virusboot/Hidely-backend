const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { JWT_SECRET } = require('../config/jwt');

async function verifyActiveSession(decoded) {
  if (!decoded || !decoded.id) {
    return { valid: false, reason: 'Invalid token payload.' };
  }

  let userRes;
  try {
    userRes = await db.query(
      'SELECT id, COALESCE(token_version, 0) AS token_version FROM users WHERE id = $1',
      [decoded.id]
    );
  } catch (err) {
    // Graceful fallback if legacy DB schema has not yet applied token_version migration
    if (err && err.code === '42703') {
      userRes = await db.query('SELECT id FROM users WHERE id = $1', [decoded.id]);
    } else {
      throw err;
    }
  }

  if (!userRes || userRes.rows.length === 0) {
    return { valid: false, reason: 'Account no longer exists.' };
  }

  const dbTokenVersion = Number(userRes.rows[0].token_version || 0);
  if (decoded.tv !== undefined && Number(decoded.tv) !== dbTokenVersion) {
    return { valid: false, reason: 'Session has been revoked. Please sign in again.' };
  }
  if (decoded.tv === undefined && dbTokenVersion > 0) {
    return { valid: false, reason: 'Session invalidated after security update. Please sign in again.' };
  }

  return { valid: true };
}

const authStrict = async (req, res, next) => {
  // Get token from header
  const authHeader = req.header('Authorization');

  if (!authHeader) {
    return res.status(401).json({ error: 'No token, authorization denied.' });
  }

  // Token format: Bearer <token>
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Token format is invalid.' });
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const sessionCheck = await verifyActiveSession(decoded);
    if (!sessionCheck.valid) {
      return res.status(401).json({ error: sessionCheck.reason });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token is invalid or expired.' });
  }
};

const authOptional = async (req, res, next) => {
  const authHeader = req.header('Authorization');

  if (!authHeader) {
    req.user = { id: null };
    return next();
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    req.user = { id: null };
    return next();
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const sessionCheck = await verifyActiveSession(decoded);
    req.user = sessionCheck.valid ? decoded : { id: null };
  } catch (error) {
    req.user = { id: null };
  }
  next();
};

module.exports = authStrict;
module.exports.authStrict = authStrict;
module.exports.verifyToken = authStrict;
module.exports.authOptional = authOptional;
module.exports.optional = authOptional;
module.exports.optionalToken = authOptional;
module.exports.verifyActiveSession = verifyActiveSession;
