-- Migration 004: Security Hardening, Account Deletion, Consent & UGC Moderation
-- Idempotent migration for DPDP Act 2023, IT Rules 2021, Play Store & App Store compliance

ALTER TABLE users
ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS accepted_terms_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS is_adult_confirmed BOOLEAN DEFAULT TRUE;

ALTER TABLE otps
ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS content_reports (
    id SERIAL PRIMARY KEY,
    reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_type VARCHAR(30) NOT NULL,
    target_id INTEGER,
    reported_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_name VARCHAR(255) DEFAULT '',
    reason VARCHAR(80) NOT NULL,
    details TEXT DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    admin_note TEXT DEFAULT '',
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_reports_reporter ON content_reports (reporter_id, created_at DESC);

