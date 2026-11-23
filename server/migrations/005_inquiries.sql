-- 005: inquiry fixes: reply claiming ('sending'), contact-data messages, template approval history, indexes

-- A pending reply is claimed with status 'sending' while it goes out, so approving twice can't send twice.
ALTER TABLE lead_messages DROP CONSTRAINT IF EXISTS lead_messages_status_check;
ALTER TABLE lead_messages ADD CONSTRAINT lead_messages_status_check
  CHECK (status IN ('received','pending_review','sending','sent','logged','failed','blocked','rejected'));

-- Messages that are (or contain) the person's email/phone, typed when the assistant asked for it.
-- They're masked like the contact fields unless the viewer may reveal contact details.
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS contains_contact BOOLEAN NOT NULL DEFAULT false;

-- Templates: who last changed the wording (they can't approve their own edit), and the last approved wording,
-- which the assistant keeps using while an edit waits for approval.
ALTER TABLE response_templates ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE response_templates ADD COLUMN IF NOT EXISTS approved_body TEXT;
UPDATE response_templates SET approved_body = body WHERE status = 'approved' AND approved_body IS NULL;

CREATE TABLE IF NOT EXISTS response_template_versions (
  id           BIGSERIAL PRIMARY KEY,
  template_id  INT NOT NULL REFERENCES response_templates(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  edited_by    INT REFERENCES users(id) ON DELETE SET NULL,
  approved_by  INT REFERENCES users(id) ON DELETE SET NULL,
  approved_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS response_template_versions_tpl_idx ON response_template_versions (template_id, approved_at DESC);

-- Indexes for the inquiry list, review badge, retention and consent lookups
CREATE INDEX IF NOT EXISTS lead_messages_pending_idx ON lead_messages (lead_id) WHERE status = 'pending_review';
CREATE INDEX IF NOT EXISTS leads_last_activity_idx ON leads (last_activity_at);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at);
CREATE INDEX IF NOT EXISTS consent_records_lead_idx ON consent_records (lead_id);
