-- 002: AI summaries for trend scans now run in the background; track their progress.
ALTER TABLE trend_snapshots
  ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'off' CHECK (ai_status IN ('off','pending','done','failed'));
UPDATE trend_snapshots SET ai_status = CASE WHEN ai_enriched THEN 'done' ELSE 'off' END;
