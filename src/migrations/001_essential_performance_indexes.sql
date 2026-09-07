-- Migration 001: Essential Performance Indexes for Hidely Backend
-- Target Database: PostgreSQL
-- Idempotent: Uses CREATE INDEX IF NOT EXISTS for safety

-- A. Followers lookup index
-- Optimizes: WHERE following_id = $1 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_user_follows_following_created 
ON user_follows (following_id, created_at DESC);

-- B. Feed sorting index
-- Optimizes: ORDER BY created_at DESC for global post feed
CREATE INDEX IF NOT EXISTS idx_posts_created_at 
ON posts (created_at DESC);

-- C. Creator/User posts lookup index
-- Optimizes: WHERE user_id = $1 ORDER BY created_at DESC for profile post feeds
CREATE INDEX IF NOT EXISTS idx_posts_user_created 
ON posts (user_id, created_at DESC);

-- D. Notifications feed index
-- Optimizes: WHERE user_id = $1 ORDER BY created_at DESC for notification feed
CREATE INDEX IF NOT EXISTS idx_notifications_user_created 
ON notifications (user_id, created_at DESC);

-- E. Post comments index
-- Optimizes: WHERE post_id = $1 ORDER BY created_at ASC for post comments list
CREATE INDEX IF NOT EXISTS idx_comments_post_created 
ON post_comments (post_id, created_at ASC);
