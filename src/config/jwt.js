require('dotenv').config();

const rawSecret = process.env.JWT_SECRET;

if (!rawSecret || rawSecret.trim() === '') {
  console.error('FATAL CONFIGURATION ERROR: JWT_SECRET environment variable is missing or empty!');
  throw new Error('FATAL CONFIGURATION ERROR: JWT_SECRET environment variable is missing or empty!');
}

// Centralized authoritative JWT secret for Express & Socket.IO
const JWT_SECRET = rawSecret.trim();

module.exports = {
  JWT_SECRET,
};
