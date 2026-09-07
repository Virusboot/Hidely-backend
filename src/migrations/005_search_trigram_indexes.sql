-- Migration 005: Search Trigram Indexes for Hidely Backend
-- Target Database: PostgreSQL
-- Idempotent: Uses CREATE EXTENSION IF NOT EXISTS and CREATE INDEX IF NOT EXISTS for safety

-- 1. Enable pg_trgm extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Users trigram search index (username, name)
CREATE INDEX IF NOT EXISTS idx_users_trgm_search
ON users USING gin (username gin_trgm_ops, name gin_trgm_ops);

-- 3. Posts trigram search index (caption, location, category)
CREATE INDEX IF NOT EXISTS idx_posts_trgm_search
ON posts USING gin (caption gin_trgm_ops, location gin_trgm_ops, category gin_trgm_ops);
