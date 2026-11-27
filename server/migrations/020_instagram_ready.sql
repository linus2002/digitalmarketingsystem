-- 020: Instagram-ready images, Instagram DMs for the inquiry assistant, and the comments inbox.

-- An uploaded image converted for Instagram (JPG, allowed shape, max 1440 px wide). Made once, when first needed.
ALTER TABLE media ADD COLUMN IF NOT EXISTS ig_storage_name TEXT UNIQUE;

-- Instagram direct messages go through the same assistant as Messenger.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_source_check CHECK (source IN ('messenger','instagram','website','manual'));
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_contact_preference_check;
ALTER TABLE leads ADD CONSTRAINT leads_contact_preference_check CHECK (contact_preference IN ('messenger','instagram','email','phone','whatsapp'));
-- Messenger and Instagram ids are separate number ranges: a person is unique per channel, not across them.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_psid_key;
CREATE UNIQUE INDEX IF NOT EXISTS leads_source_psid_key ON leads (source, psid);

-- Comments on the Facebook Page's and the Instagram account's posts.
CREATE TABLE IF NOT EXISTS social_comments (
  id              BIGSERIAL PRIMARY KEY,
  platform        TEXT NOT NULL CHECK (platform IN ('facebook','instagram')),
  external_id     TEXT NOT NULL,
  post_external_id TEXT,
  post_url        TEXT,
  parent_external_id TEXT,
  author_id       TEXT,
  author_name_enc TEXT,
  body_enc        TEXT,
  is_inquiry      BOOLEAN NOT NULL DEFAULT false,
  needs_review    BOOLEAN NOT NULL DEFAULT false,
  review_reasons  TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','replied','hidden','dismissed')),
  private_reply_at TIMESTAMPTZ,
  public_reply_at TIMESTAMPTZ,
  handled_by      INT REFERENCES users(id) ON DELETE SET NULL,
  handled_at      TIMESTAMPTZ,
  error           TEXT,
  commented_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS social_comments_open_idx ON social_comments (status, is_inquiry, commented_at DESC);
CREATE INDEX IF NOT EXISTS social_comments_time_idx ON social_comments (commented_at DESC);

-- The message sent by "Reply privately". Approved like the assistant's other wording; edits need approval again.
INSERT INTO response_templates (key, name, category, body, status, approved_at)
VALUES ('comment.private_reply', 'Comments: private reply', 'system',
  'Hi, thanks for your comment on our post. To keep your details private, we''ll continue here. Reply to this message and our assistant will take down your inquiry for the {{business}} team.',
  'approved', now())
ON CONFLICT (key) DO NOTHING;
