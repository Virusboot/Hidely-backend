-- Migration 002: Deferred Performance Indexes for Hidely Backend
-- Target Database: PostgreSQL
-- Idempotent: Uses CREATE INDEX IF NOT EXISTS for safety

-- 1. Post Likes index (for post deletion cascade and like counts)
CREATE INDEX IF NOT EXISTS idx_post_likes_post_id 
ON post_likes (post_id);

-- 2. Post Bookmarks index (for saved posts query with created_at ordering)
CREATE INDEX IF NOT EXISTS idx_post_bookmarks_user_created 
ON post_bookmarks (user_id, created_at DESC);

-- 3. OTP lookup index (for latest OTP query and cleanup by email)
CREATE INDEX IF NOT EXISTS idx_otps_email_created 
ON otps (email, created_at DESC);

-- 4. Places name lookup index (for master place auto-matching query)
CREATE INDEX IF NOT EXISTS idx_places_lower_name 
ON places (LOWER(name));

-- 5. Notifications unread index (for unread count queries)
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread 
ON notifications (user_id, is_read);
