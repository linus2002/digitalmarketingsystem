-- 011: uploaded images and videos for posts and bot batch items.
-- The files themselves are stored on disk (server/uploads/); this table keeps what they are and who added them.

CREATE TABLE IF NOT EXISTS media (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('image','video')),
  mime           TEXT NOT NULL,
  storage_name   TEXT NOT NULL UNIQUE,
  original_name  TEXT NOT NULL DEFAULT '',
  size_bytes     BIGINT NOT NULL,
  uploaded_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_id INT REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE bot_items ADD COLUMN IF NOT EXISTS media_id INT REFERENCES media(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS posts_media_idx ON posts (media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_items_media_idx ON bot_items (media_id) WHERE media_id IS NOT NULL;
