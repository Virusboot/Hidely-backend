require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

// Parse environment configured origins if present
const envOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

const defaultProdOrigins = [
  'https://hidely.app',
  'https://www.hidely.app',
  'https://admin.hidely.app',
  'https://hidely-backend.onrender.com',
];

const defaultDevOrigins = [
  'http://localhost:5050',
  'http://127.0.0.1:5050',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://10.0.2.2:5050',
  'http://10.0.2.2:3000',
];

const allowedOrigins = isProduction
  ? [...new Set([...envOrigins, ...defaultProdOrigins])]
  : [...new Set([...envOrigins, ...defaultProdOrigins, ...defaultDevOrigins])];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. Flutter mobile native app, curl, server-to-server)
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    const err = new Error(`CORS policy violation: origin ${origin} is not allowed.`);
err.status = 403;
return callback(err);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
};

function getSocketCorsConfig() {
  return {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      const err = new Error('CORS origin not allowed for socket connection');
err.status = 403;
return callback(err);
    },
    methods: ['GET', 'POST'],
    credentials: true,
  };
}

module.exports = {
  allowedOrigins,
  corsOptions,
  getSocketCorsConfig,
};
