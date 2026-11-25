-- 016: the weekly performance digest. One per week (Monday to Sunday, Philippine time).
-- The numbers are worked out by code (stats); the AI only writes the explanation (summary).

CREATE TABLE IF NOT EXISTS digests (
  id          SERIAL PRIMARY KEY,
  week_start  DATE NOT NULL UNIQUE,
  week_end    DATE NOT NULL,
  stats       JSONB NOT NULL,
  summary     JSONB NOT NULL,
  written_by  TEXT NOT NULL,          -- the AI model, or 'rules' when the AI wasn't available
  ai_error    TEXT,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
