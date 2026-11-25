-- 018: replies still waiting on inquiries that were already anonymised are stopped (they inflated the
-- "replies waiting" count, and approving one would store personal text again).
UPDATE lead_messages m SET status = 'blocked'
FROM leads l
WHERE l.id = m.lead_id AND l.anonymized_at IS NOT NULL AND m.status IN ('pending_review', 'sending');
