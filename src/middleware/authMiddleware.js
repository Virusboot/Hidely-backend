const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'hidely_super_secret_jwt_key_2026';

const authStrict = (req, res, next) => {
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
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token is invalid or expired.' });
  }
};

const authOptional = (req, res, next) => {
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
    req.user = decoded;
  } catch (error) {
    req.user = { id: null };
  }
  next();
};

module.exports = authStrict;
module.exports.optional = authOptional;

