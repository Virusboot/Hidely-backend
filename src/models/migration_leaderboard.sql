-- Add points column to users table with a default of 7120 points
ALTER TABLE users ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 7120;

-- Insert seed users for the leaderboard
INSERT INTO users (name, email, password_hash, username, points, profile_picture, is_verified)
VALUES 
('Aura Queen', 'aura_queen@hidely.com', '$2b$10$UnPK41UWhV/42uLshGepx.a3v0Jj.zOQW/vXz3W.H/fDqI4Vp.KzS', 'Aura_Queen', 9500, 'assets/images/aura_queen_avatar.png', true),
('Marcus A', 'marcus_a@hidely.com', '$2b$10$UnPK41UWhV/42uLshGepx.a3v0Jj.zOQW/vXz3W.H/fDqI4Vp.KzS', 'Marcus_A', 9100, 'assets/images/marcus_avatar.png', true),
('Leo Vinci', 'leo_vinci@hidely.com', '$2b$10$UnPK41UWhV/42uLshGepx.a3v0Jj.zOQW/vXz3W.H/fDqI4Vp.KzS', 'Leo_Vinci', 8700, 'assets/images/leo_vinci_avatar.png', true),
('Elena Explorer', 'elena_explorer@hidely.com', '$2b$10$UnPK41UWhV/42uLshGepx.a3v0Jj.zOQW/vXz3W.H/fDqI4Vp.KzS', 'Elena_Explorer', 8200, 'assets/images/elena_avatar.png', true),
('Nomad Nate', 'nomad_nate@hidely.com', '$2b$10$UnPK41UWhV/42uLshGepx.a3v0Jj.zOQW/vXz3W.H/fDqI4Vp.KzS', 'Nomad_Nate', 7850, 'assets/images/nomad_nate_avatar.png', true),
('Jordan Pixels', 'jordan_pixels@hidely.com', '$2b$10$UnPK41UWhV/42uLshGepx.a3v0Jj.zOQW/vXz3W.H/fDqI4Vp.KzS', 'Jordan_Pixels', 6900, 'assets/images/jordan_avatar.png', true),
('Archi Tech', 'archi_tech@hidely.com', '$2b$10$UnPK41UWhV/42uLshGepx.a3v0Jj.zOQW/vXz3W.H/fDqI4Vp.KzS', 'Archi_Tech', 6540, 'assets/images/archi_tech_avatar.png', true)
ON CONFLICT (username) DO UPDATE SET points = EXCLUDED.points;
