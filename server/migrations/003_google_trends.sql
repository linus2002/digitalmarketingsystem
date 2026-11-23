-- 003: Google Trends "Trending now" as a trend source, and live Google trends on each snapshot.
ALTER TABLE trend_sources DROP CONSTRAINT IF EXISTS trend_sources_kind_check;
ALTER TABLE trend_sources ADD CONSTRAINT trend_sources_kind_check CHECK (kind IN ('rss','pubmed','newsapi','google_trends'));

-- scanned: trending searches read; checked: terms the AI has already sorted (health or not);
-- items: the health-related ones, with their overview and post idea.
ALTER TABLE trend_snapshots
  ADD COLUMN google JSONB NOT NULL DEFAULT '{"scanned":0,"checked":[],"items":[]}'::jsonb;

-- Existing installs get the Philippines feed. New installs get it from the seed (which only runs on an empty table).
INSERT INTO trend_sources (name, kind, query, enabled)
SELECT 'Google Trends: Philippines', 'google_trends', 'PH', true
WHERE EXISTS (SELECT 1 FROM trend_sources) AND NOT EXISTS (SELECT 1 FROM trend_sources WHERE kind = 'google_trends');
