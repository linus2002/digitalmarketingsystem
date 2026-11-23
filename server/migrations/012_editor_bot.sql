-- 012: the Editor Bot. It checks captions against the creator's own standards and revises them;
-- every revision is kept (before/after) and waits for a person to accept it, unless auto-revise is on.

ALTER TABLE bot_activity DROP CONSTRAINT IF EXISTS bot_activity_bot_check;
ALTER TABLE bot_activity ADD CONSTRAINT bot_activity_bot_check CHECK (bot IN ('caption','style','scheduler','checker','posting','editor'));

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_bot_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_bot_check CHECK (bot IS NULL OR bot IN ('caption','style','scheduler','checker','posting','editor'));

CREATE TABLE IF NOT EXISTS content_revisions (
  id              SERIAL PRIMARY KEY,
  post_id         INT REFERENCES posts(id) ON DELETE CASCADE,
  bot_item_id     INT REFERENCES bot_items(id) ON DELETE CASCADE,
  before_text     TEXT NOT NULL,
  after_text      TEXT NOT NULL,
  feedback        TEXT,
  results_before  JSONB NOT NULL DEFAULT '[]'::jsonb,
  results_after   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','auto')),
  created_by      INT REFERENCES users(id) ON DELETE SET NULL,
  decided_by      INT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS content_revisions_post_idx ON content_revisions (post_id, created_at DESC) WHERE post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_revisions_item_idx ON content_revisions (bot_item_id, created_at DESC) WHERE bot_item_id IS NOT NULL;
