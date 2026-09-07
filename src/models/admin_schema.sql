-- Admin Schema Migration for Hidely Backend

-- 1. Add is_admin column to users table if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_admin') THEN
        ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Make sure seed admin user has is_admin = true
UPDATE users SET is_admin = TRUE WHERE email = 'admin@hidely.com';

-- 2. Create places table for curated hidden spots
CREATE TABLE IF NOT EXISTS places (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description TEXT DEFAULT '',
    category VARCHAR(100) DEFAULT 'Attraction',
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    rating DOUBLE PRECISION DEFAULT 4.8,
    image_url VARCHAR(255) DEFAULT '',
    is_featured BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Add status column to posts table if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='status') THEN
        ALTER TABLE posts ADD COLUMN status VARCHAR(20) DEFAULT 'approved';
    END IF;
END $$;
