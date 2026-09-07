-- Migration 003: Schema Consolidation for Hidely Backend
-- Captures all Place Identity, Direct Messaging & Gamification schema operations previously executed on application startup

-- 1. Ensure posts table columns for Place Identity & GPS camera capture metadata exist
ALTER TABLE posts 
ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS location_accuracy_meters DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS location_source VARCHAR(50),
ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS canonical_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS normalized_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS landmark_type VARCHAR(100),
ADD COLUMN IF NOT EXISTS city VARCHAR(100),
ADD COLUMN IF NOT EXISTS state VARCHAR(100),
ADD COLUMN IF NOT EXISTS country VARCHAR(100),
ADD COLUMN IF NOT EXISTS ai_confidence DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS place_id INTEGER;

-- 2. Direct Messaging & Conversations Tables
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  type VARCHAR(20) DEFAULT 'DIRECT',
  name VARCHAR(255),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_message_id INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_read_message_id INTEGER DEFAULT 0,
  is_muted BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  is_pinned BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type VARCHAR(30) DEFAULT 'text',
  text TEXT,
  reply_to_message_id INTEGER,
  shared_entity_type VARCHAR(50),
  shared_entity_id VARCHAR(255),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  type VARCHAR(20) DEFAULT 'image',
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  duration DOUBLE PRECISION,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(20) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members (user_id);

-- 3. Gamification & Points Architecture
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS total_points INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS current_level INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS current_rank INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS explorer_score DOUBLE PRECISION DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_points_updated_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS featured_badge_id INTEGER;

CREATE TABLE IF NOT EXISTS point_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(60) NOT NULL,
  points INTEGER NOT NULL,
  reference_type VARCHAR(50),
  reference_id VARCHAR(255),
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_point_event UNIQUE (user_id, event_type, reference_type, reference_id)
);

CREATE TABLE IF NOT EXISTS badges (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  category VARCHAR(50) DEFAULT 'general',
  icon VARCHAR(255),
  rarity VARCHAR(30) DEFAULT 'COMMON',
  tier INTEGER DEFAULT 1,
  requirements_json JSONB,
  reward_points INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_badges (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  badge_id INTEGER REFERENCES badges(id) ON DELETE CASCADE,
  earned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  progress_snapshot JSONB,
  is_featured BOOLEAN DEFAULT FALSE,
  CONSTRAINT unique_user_badge UNIQUE (user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS achievements (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  category VARCHAR(50) DEFAULT 'exploration',
  target_value INTEGER NOT NULL,
  reward_points INTEGER DEFAULT 0,
  badge_id INTEGER REFERENCES badges(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS user_achievements (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  achievement_id INTEGER REFERENCES achievements(id) ON DELETE CASCADE,
  progress INTEGER DEFAULT 0,
  is_completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT unique_user_achievement UNIQUE (user_id, achievement_id)
);

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id SERIAL PRIMARY KEY,
  period VARCHAR(20) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  points INTEGER NOT NULL,
  explorer_score DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_point_tx_user ON point_transactions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_points ON users (total_points DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snap ON leaderboard_snapshots (period, created_at DESC);

-- 4. Seed Badges
INSERT INTO badges (name, slug, description, category, icon, rarity, tier, sort_order) VALUES
('New Explorer', 'new_explorer', 'Welcome to Hidely! Started the exploration journey.', 'level', 'compass', 'COMMON', 1, 1),
('Wanderer', 'wanderer', 'Earned 200+ exploration points.', 'level', 'boot', 'COMMON', 2, 2),
('Pathfinder', 'pathfinder', 'Earned 500+ exploration points.', 'level', 'map', 'UNCOMMON', 3, 3),
('Explorer', 'explorer', 'Earned 1,000+ exploration points.', 'level', 'globe', 'UNCOMMON', 4, 4),
('Trail Seeker', 'trail_seeker', 'Earned 2,000+ exploration points.', 'level', 'tent', 'RARE', 5, 5),
('Adventure Scout', 'adventure_scout', 'Earned 4,000+ exploration points.', 'level', 'mountain', 'RARE', 6, 6),
('Hidden Hunter', 'hidden_hunter', 'Earned 7,500+ exploration points.', 'level', 'search', 'EPIC', 7, 7),
('Elite Explorer', 'elite_explorer', 'Earned 15,000+ exploration points.', 'level', 'diamond', 'EPIC', 8, 8),
('Legendary Explorer', 'legendary_explorer', 'Earned 30,000+ exploration points.', 'level', 'crown', 'LEGENDARY', 9, 9),
('Hidely Legend', 'hidely_legend', 'Achieved 60,000+ exploration points.', 'level', 'trophy', 'LEGENDARY', 10, 10),
('First Discovery', 'first_discovery', 'Discovered your first genuine Hidden Place.', 'discovery', 'sparkles', 'UNCOMMON', 1, 11),
('Precision Explorer', 'precision_explorer', 'Captured 5 posts with high GPS accuracy (<= 20m).', 'location', 'target', 'RARE', 1, 12),
('Top Visual Contributor', 'top_visual_contributor', 'Created 10 high quality community posts.', 'content', 'camera', 'RARE', 1, 13),
('Hidely Pioneer', 'hidely_pioneer', 'Verified 5 Master Hidden Places.', 'prestige', 'shield', 'LEGENDARY', 1, 14)
ON CONFLICT (slug) DO NOTHING;
