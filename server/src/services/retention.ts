import { q, tx, type Db } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { getRetention, setSetting } from "../lib/settings.js";

/**
 * Removes personal data from one lead while keeping anonymous counts for reporting.
 * `reason` must be fixed wording (never free text typed by staff): it's kept after the personal data is gone.
 */
export async function anonymizeLead(leadId: number, reason: string, userId: number | null, db?: Db) {
  const run = async (c: Db) => {
    await q(
      `UPDATE leads SET name_enc=NULL, email_enc=NULL, phone_enc=NULL, inquiry_enc=NULL, psid=NULL, medicine_name=NULL,
         bot_state=NULL, follow_up_at=NULL, status=CASE WHEN status='opted_out' THEN 'opted_out' ELSE 'closed' END,
         closed_at=COALESCE(closed_at, now()), anonymized_at=now(), updated_at=now() WHERE id=$1`,
      [leadId],
      c,
    );
    // Message bodies, and error text (which holds the reviewer's reason when a reply wasn't approved)
    await q("UPDATE lead_messages SET body_enc=NULL, error=NULL WHERE lead_id=$1", [leadId], c);
    // Replies still waiting for review (or mid-send) are stopped: there is nobody to answer any more,
    // and approving one would store personal text again after it was erased.
    await q("UPDATE lead_messages SET status='blocked' WHERE lead_id=$1 AND status IN ('pending_review','sending')", [leadId], c);
    // Every activity note is free text that can hold personal details (notes, "medicine name → …" updates, review reasons)
    await q("UPDATE lead_activities SET note=NULL WHERE lead_id=$1", [leadId], c);
    await q("INSERT INTO lead_activities (lead_id, user_id, type, note) VALUES ($1,$2,'retention',$3)", [leadId, userId, reason], c);
  };
  if (db) await run(db);
  else await tx(run);
}

// Shared by the run and its preview, so the confirmation counts exactly what a run would remove.
/** People who never agreed (including those who opted out before agreeing): the whole conversation is deleted. */
const UNCONSENTED_SQL = `consent_given=false AND status IN ('awaiting_consent','collecting','closed','opted_out')
  AND last_activity_at < now() - ($1 || ' days')::interval`;
/** Everyone else, after a period without activity, whatever the status (open ones included). */
const STALE_SQL = `anonymized_at IS NULL
  AND status IN ('awaiting_consent','collecting','new','in_progress','waiting_customer','closed','opted_out')
  AND NOT (consent_given=false AND status IN ('awaiting_consent','collecting','closed','opted_out'))
  AND last_activity_at < now() - ($1 || ' days')::interval`;

/** How many inquiries a retention run with these settings would delete and anonymise right now (changes nothing). */
export async function previewRetention(r: { leadDays: number; unconsentedDays: number }) {
  const [del, anon] = await Promise.all([
    q<{ n: number }>(`SELECT count(*)::int AS n FROM leads WHERE ${UNCONSENTED_SQL}`, [String(r.unconsentedDays)]),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM leads WHERE ${STALE_SQL}`, [String(r.leadDays)]),
  ]);
  return { deleteUnconsented: del[0].n, anonymize: anon[0].n };
}

export async function runRetention() {
  const r = await getRetention();
  const summary = {
    at: new Date().toISOString(),
    anonymized: 0,
    deletedUnconsented: 0,
    commentsDeleted: 0,
    auditDeleted: 0,
    aiLogsDeleted: 0,
    botActivityDeleted: 0,
    error: undefined as string | undefined,
  };
  try {
    const del = await q(`DELETE FROM leads WHERE ${UNCONSENTED_SQL} RETURNING id`, [String(r.unconsentedDays)]);
    summary.deletedUnconsented = del.length;

    // So an inquiry nobody closed doesn't keep personal data forever.
    const stale = await q<{ id: number }>(`SELECT id FROM leads WHERE ${STALE_SQL}`, [String(r.leadDays)]);
    for (const l of stale) {
      await anonymizeLead(l.id, `Retention policy: no activity for ${r.leadDays} days`, null);
      summary.anonymized++;
    }
    // Comments hold names and personal text too: kept as long as inquiries are.
    summary.commentsDeleted = (await q("DELETE FROM social_comments WHERE commented_at < now() - ($1 || ' days')::interval RETURNING id", [String(r.leadDays)])).length;
    summary.auditDeleted =(await q("DELETE FROM audit_logs WHERE created_at < now() - ($1 || ' days')::interval RETURNING id", [String(r.auditDays)])).length;
    summary.aiLogsDeleted = (await q("DELETE FROM ai_generations WHERE created_at < now() - ($1 || ' days')::interval RETURNING id", [String(r.aiLogDays)])).length;
    summary.botActivityDeleted = (await q("DELETE FROM bot_activity WHERE created_at < now() - ($1 || ' days')::interval RETURNING id", [String(r.aiLogDays)])).length;
  } catch (err) {
    summary.error = errMsg(err);
    log.error("Retention run failed", { error: summary.error });
  }
  await setSetting("retention.lastRun", summary, null);
  log.info("Retention run", summary);
  return summary;
}
