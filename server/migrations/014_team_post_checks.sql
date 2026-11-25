-- 014: the bots also check posts the team writes by hand (not only posts from a bot batch).
-- The Editor Bot scores the text against the standards; the Checker Bot looks for problems. The result is kept on
-- the post with a fingerprint of what was checked, so a post is checked again whenever its content or time changes.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS bot_checked_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS bot_check_sig TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS bot_issues JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS bot_standards JSONB NOT NULL DEFAULT '[]'::jsonb;
