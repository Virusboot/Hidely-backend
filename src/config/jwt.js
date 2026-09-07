require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';
const rawSecret = process.env.JWT_SECRET;

if (isProduction && (!rawSecret || rawSecret.trim() === '')) {
  console.error('FATAL ERROR: JWT_SECRET environment variable is not defined in production environment.');
  process.exit(1);
}

// Centralized authoritative JWT secret for Express & Socket.IO
const JWT_SECRET = (rawSecret && rawSecret.trim() !== '') 
  ? rawSecret.trim() 
  : 'hidely_super_secret_jwt_key_2026';

module.exports = {
  JWT_SECRET,
};
