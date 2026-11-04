import { q, tx, type Db } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { getRetention, setSetting } from "../lib/settings.js";

/** Removes personal data from one lead while keeping anonymous counts for reporting. */
export async function anonymizeLead(leadId: number, reason: string, userId: number | null, db?: Db) {
  const run = async (c: Db) => {
    await q(
      `UPDATE leads SET name_enc=NULL, email_enc=NULL, phone_enc=NULL, inquiry_enc=NULL, psid=NULL, medicine_name=NULL,
         bot_state=NULL, follow_up_at=NULL, status=CASE WHEN status='opted_out' THEN 'opted_out' ELSE 'closed' END,
         closed_at=COALESCE(closed_at, now()), anonymized_at=now(), updated_at=now() WHERE id=$1`,
      [leadId],
      c,
    );
    await q("UPDATE lead_messages SET body_enc=NULL WHERE lead_id=$1", [leadId], c);
    await q("UPDATE lead_activities SET note=NULL WHERE lead_id=$1 AND type='note'", [leadId], c);
    await q("INSERT INTO lead_activities (lead_id, user_id, type, note) VALUES ($1,$2,'retention',$3)", [leadId, userId, reason], c);
  };
  if (db) await run(db);
  else await tx(run);
}

export async function runRetention() {
  const r = await getRetention();
  const summary = { at: new Date().toISOString(), anonymized: 0, deletedUnconsented: 0, auditDeleted: 0, aiLogsDeleted: 0, error: undefined as string | undefined };
  try {
    const stale = await q<{ id: number }>(
      `SELECT id FROM leads WHERE anonymized_at IS NULL AND status IN ('closed','opted_out')
       AND last_activity_at < now() - ($1 || ' days')::interval`,
      [String(r.leadDays)],
    );
    for (const l of stale) {
      await anonymizeLead(l.id, `Retention policy: no activity for ${r.leadDays} days`, null);
      summary.anonymized++;
    }
    const del = await q(
      `DELETE FROM leads WHERE consent_given=false AND status IN ('awaiting_consent','closed')
       AND created_at < now() - ($1 || ' days')::interval RETURNING id`,
      [String(r.unconsentedDays)],
    );
    summary.deletedUnconsented = del.length;
    summary.auditDeleted = (await q("DELETE FROM audit_logs WHERE created_at < now() - ($1 || ' days')::interval RETURNING id", [String(r.auditDays)])).length;
    summary.aiLogsDeleted = (await q("DELETE FROM ai_generations WHERE created_at < now() - ($1 || ' days')::interval RETURNING id", [String(r.aiLogDays)])).length;
  } catch (err) {
    summary.error = errMsg(err);
    log.error("Retention run failed", { error: summary.error });
  }
  await setSetting("retention.lastRun", summary, null);
  log.info("Retention run", summary);
  return summary;
}
