const fs = require('fs');
const path = require('path');
const db = require('../config/db');

async function runMigrations() {
  console.log('--- Starting Hidely Database Migrations ---');
  const client = await db.pool.connect();
  try {
    // 1. Ensure schema_migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        version VARCHAR(255) UNIQUE NOT NULL,
        filename VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Fetch already applied migrations
    const appliedRes = await client.query('SELECT version FROM schema_migrations;');
    const appliedVersions = new Set(appliedRes.rows.map(row => row.version));

    // 3. Read migration files in deterministic alphabetical order
    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace('.sql', '');

      if (appliedVersions.has(version)) {
        console.log(`[SKIP] Migration already applied: ${file}`);
        continue;
      }

      console.log(`[APPLYING] Migration: ${file}`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      // Execute migration safely within a transaction
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2);',
        [version, file]
      );
      await client.query('COMMIT');
      console.log(`[SUCCESS] Applied migration: ${file}`);
    }

    console.log('--- Database Migrations Completed Successfully ---');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('--- MIGRATION FAILED ---');
    console.error('Error:', error.message || error);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

if (require.main === module) {
  runMigrations();
}

module.exports = runMigrations;
