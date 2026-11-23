-- 007: platform (sessions and audit log paging)

-- Session version: every session token carries the value it was issued with. Bumping it (sign-out,
-- password change, admin password reset, turning the account off) ends all earlier sessions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

-- Audit log filtered by area (action prefix) and paged by date.
CREATE INDEX IF NOT EXISTS audit_logs_action_created_idx ON audit_logs (action text_pattern_ops, created_at DESC);
