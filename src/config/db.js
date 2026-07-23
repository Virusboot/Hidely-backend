const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  user: !process.env.DATABASE_URL ? (process.env.DB_USER || 'postgres') : undefined,
  host: !process.env.DATABASE_URL ? (process.env.DB_HOST || 'localhost') : undefined,
  database: !process.env.DATABASE_URL ? (process.env.DB_DATABASE || 'hidely') : undefined,
  password: !process.env.DATABASE_URL ? (process.env.DB_PASSWORD || 'postgres') : undefined,
  port: !process.env.DATABASE_URL ? (process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432) : undefined,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

pool.on('connect', () => {
  console.log('Connected to the PostgreSQL database successfully.');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
