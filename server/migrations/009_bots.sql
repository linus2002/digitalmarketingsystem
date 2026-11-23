-- 009: AI bots hardening
--   * run state lives in the database (not in one server's memory): survives restarts, works across instances, can be cancelled
--   * bot_items.handed_off_at: an item stays "handed off" even if its post is later deleted (post_id becomes NULL)
--   * bot_activity keeps its history when a batch is deleted (FK ON DELETE SET NULL + a copy of the batch name)
-- Written to be safe to run more than once.

ALTER TABLE bot_batches ADD COLUMN IF NOT EXISTS run_state        JSONB;
ALTER TABLE bot_batches ADD COLUMN IF NOT EXISTS run_started_at   TIMESTAMPTZ;
ALTER TABLE bot_batches ADD COLUMN IF NOT EXISTS run_heartbeat_at TIMESTAMPTZ;
ALTER TABLE bot_batches ADD COLUMN IF NOT EXISTS run_cancel       BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE bot_items ADD COLUMN IF NOT EXISTS handed_off_at TIMESTAMPTZ;
UPDATE bot_items SET handed_off_at = updated_at WHERE post_id IS NOT NULL AND handed_off_at IS NULL;

-- Planned (not yet handed off) items by time, for the calendar's "Planned by bots".
CREATE INDEX IF NOT EXISTS bot_items_planned_idx ON bot_items (scheduled_at) WHERE post_id IS NULL AND handed_off_at IS NULL;

ALTER TABLE bot_activity ADD COLUMN IF NOT EXISTS batch_name TEXT;
UPDATE bot_activity a SET batch_name = b.name FROM bot_batches b WHERE b.id = a.batch_id AND a.batch_name IS NULL;

ALTER TABLE bot_activity DROP CONSTRAINT IF EXISTS bot_activity_batch_id_fkey;
ALTER TABLE bot_activity ADD CONSTRAINT bot_activity_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES bot_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bot_activity_batch_idx ON bot_activity (batch_id);
