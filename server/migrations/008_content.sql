-- 008: AI content, trends and settings.
-- Indexes for the studio history (per user, newest first) and the Trends page (latest snapshot, history list).
CREATE INDEX IF NOT EXISTS ai_generations_user_created_idx ON ai_generations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trend_snapshots_created_idx ON trend_snapshots (created_at DESC);

-- Feeds must be public http(s) addresses. Switch off any saved source that isn't, so the scanner stops reading it
-- (an administrator or brand manager can fix the address in Settings > Trend sources and switch it back on).
UPDATE trend_sources
   SET enabled = false
 WHERE enabled
   AND url IS NOT NULL
   AND url !~* '^https?://';
