-- 004: AI bots (caption, style, scheduler, checker, posting) and video posts

ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_url TEXT;

-- A batch is a set of posts the bots work on together: captions, times, checks, then hand-off.
CREATE TABLE bot_batches (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  schedule       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- Scheduler Bot rules for this batch
  campaign_id    INT REFERENCES campaigns(id) ON DELETE SET NULL,
  checked_at     TIMESTAMPTZ,
  handed_off_at  TIMESTAMPTZ,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bot_items (
  id             SERIAL PRIMARY KEY,
  batch_id       INT NOT NULL REFERENCES bot_batches(id) ON DELETE CASCADE,
  position       INT NOT NULL DEFAULT 0,
  title          TEXT NOT NULL DEFAULT '',
  brief          TEXT NOT NULL DEFAULT '',             -- what the post/video is about, or its transcript
  media_type     TEXT NOT NULL DEFAULT 'none' CHECK (media_type IN ('none','image','video')),
  media_url      TEXT,
  caption        TEXT,
  keywords       TEXT[] NOT NULL DEFAULT '{}',
  hashtags       TEXT[] NOT NULL DEFAULT '{}',
  caption_error  TEXT,
  scheduled_at   TIMESTAMPTZ,
  time_locked    BOOLEAN NOT NULL DEFAULT false,       -- set by a person; the Scheduler Bot keeps it
  issues         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- Checker Bot findings: [{level, text}]
  post_id        INT REFERENCES posts(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bot_items_batch_idx ON bot_items (batch_id, position);

CREATE TABLE bot_activity (
  id          BIGSERIAL PRIMARY KEY,
  bot         TEXT NOT NULL CHECK (bot IN ('caption','style','scheduler','checker','posting')),
  batch_id    INT REFERENCES bot_batches(id) ON DELETE CASCADE,
  level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','good','warn','bad')),
  message     TEXT NOT NULL,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bot_activity_created_idx ON bot_activity (created_at DESC);
