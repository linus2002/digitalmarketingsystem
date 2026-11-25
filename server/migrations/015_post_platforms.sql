-- 015: posts can go to several social platforms. Each platform a post goes to is a "target"
-- with its own status, so one failing (say, TikTok) never blocks or repeats the others.

CREATE TABLE IF NOT EXISTS post_targets (
  id            SERIAL PRIMARY KEY,
  post_id       INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK (platform IN ('facebook','instagram','twitter','youtube','tiktok','linkedin')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','publishing','published','failed')),
  external_id   TEXT,
  external_url  TEXT,
  last_error    TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  published_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, platform)
);
CREATE INDEX IF NOT EXISTS post_targets_post_idx ON post_targets (post_id);

-- Every existing post was a Facebook post.
INSERT INTO post_targets (post_id, platform, status, external_id, last_error, published_at)
SELECT id, 'facebook',
       CASE status WHEN 'published' THEN 'published' WHEN 'failed' THEN 'failed' ELSE 'pending' END,
       fb_post_id, CASE WHEN status = 'failed' THEN last_error END, published_at
FROM posts
ON CONFLICT (post_id, platform) DO NOTHING;

ALTER TABLE publish_logs ADD COLUMN IF NOT EXISTS platform TEXT;
UPDATE publish_logs SET platform = 'facebook' WHERE platform IS NULL;
