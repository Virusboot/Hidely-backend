-- Migration 004: Chat Performance Indexes

CREATE INDEX IF NOT EXISTS idx_msg_attachments_msg_id
ON message_attachments (message_id);
