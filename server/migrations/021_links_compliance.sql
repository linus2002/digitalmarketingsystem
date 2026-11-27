-- 021: tracked links (short links with UTM tags, click counts) and the pharmaceutical team's compliance sign-off.

-- One short link per post, platform and original address. Made when the post is published.
CREATE TABLE IF NOT EXISTS short_links (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  -- Where the short link sends people: the original address with the UTM tags added.
  target_url   TEXT NOT NULL,
  post_id      INT REFERENCES posts(id) ON DELETE SET NULL,
  campaign_id  INT REFERENCES campaigns(id) ON DELETE SET NULL,
  platform     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS short_links_post_platform_url ON short_links (post_id, platform, original_url) WHERE post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS short_links_campaign_idx ON short_links (campaign_id);

-- Clicks by people (link-preview robots are not counted). "visitor" is a keyed hash of the IP address, browser and
-- day, only for counting unique visitors: it can't be turned back into an IP address.
CREATE TABLE IF NOT EXISTS link_clicks (
  id            BIGSERIAL PRIMARY KEY,
  link_id       INT NOT NULL REFERENCES short_links(id) ON DELETE CASCADE,
  clicked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  visitor       TEXT,
  device        TEXT,
  referrer_host TEXT
);
CREATE INDEX IF NOT EXISTS link_clicks_link_time_idx ON link_clicks (link_id, clicked_at);
CREATE INDEX IF NOT EXISTS link_clicks_time_idx ON link_clicks (clicked_at);

-- An inquiry sent from the website form after someone followed a tracked link.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS link_id INT REFERENCES short_links(id) ON DELETE SET NULL;

-- The pharmaceutical team's sign-off on wording the compliance check blocks: { by, byName, at, note, sig, issues }.
-- Valid only while the text is unchanged ("sig" is a fingerprint of the title, text, hashtags and link).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS compliance_signoff JSONB;
