-- 001: core schema for marketing automation + inquiry assistant

CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin','marketing_manager','marketer','pharma_team','lead_agent','viewer')),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  failed_logins  INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Key/value settings. Secret values are stored AES-GCM encrypted by the app.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

-- ---------------- Marketing ----------------

CREATE TABLE campaigns (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  objective   TEXT,
  description TEXT,
  start_date  DATE,
  end_date    DATE,
  status      TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','archived')),
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id              SERIAL PRIMARY KEY,
  campaign_id     INT REFERENCES campaigns(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  hashtags        TEXT[] NOT NULL DEFAULT '{}',
  image_url       TEXT,
  image_prompt    TEXT,
  link_url        TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','in_review','changes_requested','approved','scheduled','publishing','published','failed','cancelled')),
  scheduled_at    TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 5,
  last_error      TEXT,
  published_at    TIMESTAMPTZ,
  fb_post_id      TEXT,
  ai_generated    BOOLEAN NOT NULL DEFAULT false,
  source_topic    TEXT,
  created_by      INT REFERENCES users(id) ON DELETE SET NULL,
  approved_by     INT REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX posts_due_idx ON posts (status, next_attempt_at);
CREATE INDEX posts_sched_idx ON posts (scheduled_at);

CREATE TABLE post_reviews (
  id          SERIAL PRIMARY KEY,
  post_id     INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('submitted','approved','changes_requested','comment','scheduled','unscheduled','cancelled')),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE publish_logs (
  id          BIGSERIAL PRIMARY KEY,
  post_id     INT REFERENCES posts(id) ON DELETE SET NULL,
  attempt     INT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('success','error','retry_scheduled','dry_run')),
  message     TEXT,
  response    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX publish_logs_created_idx ON publish_logs (created_at DESC);

-- Latest known stats per Facebook post (ours or published elsewhere on the Page)
CREATE TABLE fb_page_posts (
  fb_post_id     TEXT PRIMARY KEY,
  message        TEXT,
  permalink_url  TEXT,
  created_time   TIMESTAMPTZ,
  reactions      INT NOT NULL DEFAULT 0,
  comments       INT NOT NULL DEFAULT 0,
  shares         INT NOT NULL DEFAULT 0,
  impressions    INT,
  reach          INT,
  clicks         INT,
  insights       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fb_page_posts_created_idx ON fb_page_posts (created_time DESC);

CREATE TABLE page_metrics (
  metric      TEXT NOT NULL,
  period      TEXT NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,
  value       NUMERIC NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (metric, period, end_time)
);

CREATE TABLE trend_sources (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('rss','pubmed','newsapi')),
  url         TEXT,
  query       TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trend_snapshots (
  id              SERIAL PRIMARY KEY,
  topics          JSONB NOT NULL,
  items_scanned   INT NOT NULL DEFAULT 0,
  sources_ok      INT NOT NULL DEFAULT 0,
  source_errors   JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_enriched     BOOLEAN NOT NULL DEFAULT false,
  created_by      INT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_generations (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  input       JSONB NOT NULL,
  output      JSONB,
  model       TEXT,
  duration_ms INT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------- Inquiries / leads ----------------

CREATE TABLE response_templates (
  id           SERIAL PRIMARY KEY,
  key          TEXT UNIQUE,              -- set for templates the assistant uses automatically
  name         TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'general',
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  created_by   INT REFERENCES users(id) ON DELETE SET NULL,
  approved_by  INT REFERENCES users(id) ON DELETE SET NULL,
  approved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id                   SERIAL PRIMARY KEY,
  source               TEXT NOT NULL CHECK (source IN ('messenger','website','manual')),
  psid                 TEXT UNIQUE,         -- Messenger page-scoped ID of someone who messaged the Page
  name_enc             TEXT,
  email_enc            TEXT,
  phone_enc            TEXT,
  inquiry_enc          TEXT,
  contact_preference   TEXT CHECK (contact_preference IN ('messenger','email','phone','whatsapp')),
  medicine_name        TEXT,
  destination_country  TEXT,
  category             TEXT NOT NULL DEFAULT 'general',
  priority             TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status               TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('awaiting_consent','collecting','new','in_progress','waiting_customer','closed','opted_out')),
  needs_review         BOOLEAN NOT NULL DEFAULT false,
  review_reasons       TEXT[] NOT NULL DEFAULT '{}',
  assigned_to          INT REFERENCES users(id) ON DELETE SET NULL,
  follow_up_at         TIMESTAMPTZ,
  bot_state            TEXT,
  last_bot_ack_at      TIMESTAMPTZ,
  consent_given        BOOLEAN NOT NULL DEFAULT false,
  consent_at           TIMESTAMPTZ,
  consent_version      TEXT,
  opted_out_at         TIMESTAMPTZ,
  last_inbound_at      TIMESTAMPTZ,
  last_outbound_at     TIMESTAMPTZ,
  last_activity_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at            TIMESTAMPTZ,
  anonymized_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_status_idx ON leads (status);
CREATE INDEX leads_assigned_idx ON leads (assigned_to);
CREATE INDEX leads_followup_idx ON leads (follow_up_at);

CREATE TABLE lead_messages (
  id              BIGSERIAL PRIMARY KEY,
  lead_id         INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  sender_type     TEXT NOT NULL CHECK (sender_type IN ('customer','bot','agent','system')),
  sender_user_id  INT REFERENCES users(id) ON DELETE SET NULL,
  body_enc        TEXT,
  status          TEXT NOT NULL CHECK (status IN ('received','pending_review','sent','logged','failed','blocked','rejected')),
  template_id     INT REFERENCES response_templates(id) ON DELETE SET NULL,
  meta_mid        TEXT UNIQUE,
  error           TEXT,
  reviewed_by     INT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_messages_lead_idx ON lead_messages (lead_id, created_at);

CREATE TABLE lead_activities (
  id          BIGSERIAL PRIMARY KEY,
  lead_id     INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_activities_lead_idx ON lead_activities (lead_id, created_at);

-- Consent history is kept even after a lead is anonymised (lead_id set to NULL on delete)
CREATE TABLE consent_records (
  id               BIGSERIAL PRIMARY KEY,
  lead_id          INT REFERENCES leads(id) ON DELETE SET NULL,
  action           TEXT NOT NULL CHECK (action IN ('granted','declined','withdrawn')),
  consent_version  TEXT,
  channel          TEXT NOT NULL,
  text_shown       TEXT,
  ip_hash          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
