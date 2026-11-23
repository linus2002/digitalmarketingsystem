import { env } from "../config/env.js";
import { encrypt, safeDecrypt } from "../lib/crypto.js";
import { one, q, type Db, pool, type Row } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { fillTemplate, getConsent } from "../lib/settings.js";
import { SYSTEM_TEMPLATES } from "../db/templates.js";
import { classifyInquiry, INQUIRY_CATEGORIES, type InquiryCategory, REVIEW_CATEGORIES, CATEGORY_LABELS, redactContactData } from "./guardrails.js";
import { sendMessengerText } from "./meta.js";
import { aiAllowedForInquiries, chatJson } from "./ai.js";

export const leadRef = (id: number) => `INQ-${String(id).padStart(6, "0")}`;

export async function addActivity(leadId: number, type: string, note: string | null, userId: number | null = null, db: Db = pool) {
  await q("INSERT INTO lead_activities (lead_id, user_id, type, note) VALUES ($1,$2,$3,$4)", [leadId, userId, type, note], db);
}

/**
 * Approved template text by key. While an edit is awaiting approval, the last approved wording from the database
 * is used; the built-in default is only a last resort (e.g. a template that was never approved).
 */
export async function systemText(key: string, lead: Row | null, extra: Record<string, string> = {}): Promise<{ text: string; templateId: number | null }> {
  const row = await one<{ id: number; body: string; status: string; approved_body: string | null }>(
    "SELECT id, body, status, approved_body FROM response_templates WHERE key=$1",
    [key],
  );
  const fallback = SYSTEM_TEMPLATES.find((t) => t.key === key)?.body ?? "";
  const approved = row ? (row.status === "approved" ? row.body : row.approved_body) : null;
  const body = approved ?? fallback;
  const consent = await getConsent();
  const vars = {
    business: env.BUSINESS_NAME,
    privacyUrl: env.PRIVACY_POLICY_URL,
    ref: lead ? leadRef(lead.id) : "",
    medicine: lead?.medicine_name || "your medicine",
    country: lead?.destination_country || "your country",
    ...extra,
  };
  const consentText = fillTemplate(consent.text, vars);
  return { text: fillTemplate(body, { ...vars, consentText }), templateId: approved != null && row ? row.id : null };
}

export function templateVars(lead: Row): Record<string, string> {
  return {
    business: env.BUSINESS_NAME,
    ref: leadRef(lead.id),
    medicine: lead.medicine_name || "the medicine",
    country: lead.destination_country || "your country",
    name: safeDecrypt(lead.name_enc)?.split(" ")[0] ?? "",
  };
}

/** Pharmacist team for review cases, inquiry agents otherwise; picks whoever has the fewest open inquiries. */
export async function autoAssign(leadId: number, needsReview: boolean, db: Db = pool): Promise<number | null> {
  const roles = needsReview ? ["pharma_team"] : ["lead_agent", "pharma_team"];
  const pick = await one<{ id: number; name: string }>(
    `SELECT u.id, u.name FROM users u
     LEFT JOIN leads l ON l.assigned_to = u.id AND l.status IN ('new','in_progress','waiting_customer')
     WHERE u.is_active AND u.role = ANY($1)
     GROUP BY u.id ORDER BY array_position($1, u.role), count(l.id), u.id LIMIT 1`,
    [roles],
    db,
  );
  if (!pick) return null;
  const changed = await q("UPDATE leads SET assigned_to=$2, updated_at=now() WHERE id=$1 AND assigned_to IS NULL RETURNING id", [leadId, pick.id], db);
  if (!changed.length) return null; // someone already owns it: nothing changed, nothing to log
  await addActivity(leadId, "assign", `Assigned automatically to ${pick.name}`, null, db);
  return pick.id;
}

/** Removes emails and phone numbers so contact details never reach the AI. */
export const stripContact = (text: string) => redactContactData(text);

/** Keyword rules first; the local AI may refine a "general" category and may add (never remove) review. */
export async function classify(text: string, useAi: boolean) {
  const c = classifyInquiry(text);
  // Inquiry text is health-related personal data: it only reaches the AI if aiAllowedForInquiries(),
  // and never with email addresses or phone numbers in it.
  const forAi = stripContact(text);
  if (useAi && aiAllowedForInquiries() && c.category === "general" && forAi.trim().length > 15) {
    try {
      const out = await chatJson<{ category?: string; needs_pharmacist?: boolean }>({
        system:
          "You sort incoming inquiries for a pharmaceutical distributor. Reply in JSON only. " +
          `Categories: ${INQUIRY_CATEGORIES.join(", ")}. needs_pharmacist is true for anything about prescriptions, ` +
          "doses, side effects, symptoms, treatment choices, regulations/import rules or whether a product is available.",
        prompt: `Inquiry: """${forAi.slice(0, 1500)}"""\nReturn {"category":"...","needs_pharmacist":true|false}`,
        temperature: 0,
        effort: "low",
        timeoutMs: 60_000,
      });
      if (out.category && (INQUIRY_CATEGORIES as readonly string[]).includes(out.category)) c.category = out.category as InquiryCategory;
      if (REVIEW_CATEGORIES.includes(c.category) && !c.reviewReasons.includes(CATEGORY_LABELS[c.category])) c.reviewReasons.push(CATEGORY_LABELS[c.category]);
      if (out.needs_pharmacist && !c.reviewReasons.length) c.reviewReasons.push("Flagged by AI for pharmacist review");
      c.needsReview = c.reviewReasons.length > 0;
    } catch (err) {
      log.debug("AI classification skipped", { error: errMsg(err) });
    }
  }
  return c;
}

/** Re-classifies a lead from all its inbound text, merging flags (review is sticky). */
export async function reclassifyLead(leadId: number, useAi = true) {
  const lead = await one("SELECT * FROM leads WHERE id=$1", [leadId]);
  if (!lead) return;
  // Skip the messages where the person typed their email/phone for the assistant.
  const msgs = await q<{ body_enc: string | null }>("SELECT body_enc FROM lead_messages WHERE lead_id=$1 AND direction='in' AND NOT contains_contact ORDER BY id", [leadId]);
  const text = [lead.medicine_name, safeDecrypt(lead.inquiry_enc), ...msgs.map((m) => safeDecrypt(m.body_enc))].filter(Boolean).join("\n");
  const c = await classify(text, useAi);
  const reasons = [...new Set([...(lead.review_reasons as string[]), ...c.reviewReasons])];
  const category = lead.category !== "general" && c.category === "general" ? lead.category : c.category;
  await q(
    `UPDATE leads SET category=$2, needs_review = needs_review OR $3, review_reasons=$4,
       priority = CASE WHEN $5='high' AND priority IN ('low','normal') THEN 'high' ELSE priority END, updated_at=now() WHERE id=$1`,
    [leadId, category, reasons.length > 0, reasons, c.priority],
  );
  if (category !== lead.category) await addActivity(leadId, "category", `Categorised as ${CATEGORY_LABELS[category as InquiryCategory] ?? category}`);
  return { ...c, needsReview: reasons.length > 0 || !!lead.needs_review, reviewReasons: reasons };
}

export const isOptedOut = (lead: Row) => lead.status === "opted_out" || !!lead.opted_out_at;

export type WindowCheck = { ok: true; messagingType: "RESPONSE" | "MESSAGE_TAG"; tag?: "HUMAN_AGENT" } | { ok: false; reason: string };

/**
 * Meta's standard messaging window: reply within 24h of the person's last message; HUMAN_AGENT tag (7 days) only if approved.
 * `systemAck` is only for the assistant's confirmation of a STOP/DELETE request, which must still go out.
 */
export function messengerWindow(lead: Row, byHuman: boolean, systemAck = false): WindowCheck {
  if (isOptedOut(lead) && !systemAck) return { ok: false, reason: "This person opted out of messages." };
  if (!lead.psid) return { ok: false, reason: "This inquiry has no Messenger conversation." };
  if (!lead.last_inbound_at) return { ok: false, reason: "We can only reply after the person messages the Page." };
  const hours = (Date.now() - new Date(lead.last_inbound_at).getTime()) / 3_600_000;
  if (hours < 24) return { ok: true, messagingType: "RESPONSE" };
  if (byHuman && env.META_ENABLE_HUMAN_AGENT_TAG && hours < 24 * 7) return { ok: true, messagingType: "MESSAGE_TAG", tag: "HUMAN_AGENT" };
  return {
    ok: false,
    reason: env.META_ENABLE_HUMAN_AGENT_TAG
      ? "More than 7 days since their last message. Contact them by their preferred method instead."
      : "More than 24 hours since their last message, so Messenger won't allow a reply. Use their preferred contact method instead.",
  };
}

/** Sends (Messenger) or logs (website/manual) an outbound message and records it. */
export async function deliver(
  lead: Row,
  text: string,
  opts: {
    senderType: "bot" | "agent";
    userId?: number | null;
    templateId?: number | null;
    quickReplies?: { title: string; payload: string }[];
    existingMessageId?: number;
    /** The assistant's acknowledgement of STOP/DELETE: allowed even though the person opted out. */
    systemAck?: boolean;
  },
): Promise<{ status: "sent" | "logged" | "blocked" | "failed"; error?: string }> {
  const save = async (status: string, error: string | null, mid: string | null) => {
    if (opts.existingMessageId) {
      await q(`UPDATE lead_messages SET status=$2, error=$3, meta_mid=$4, sent_at=CASE WHEN $2 IN ('sent','logged') THEN now() END WHERE id=$1`, [
        opts.existingMessageId,
        status,
        error,
        mid,
      ]);
    } else {
      await q(
        `INSERT INTO lead_messages (lead_id, direction, sender_type, sender_user_id, body_enc, status, template_id, meta_mid, error, sent_at)
         VALUES ($1,'out',$2,$3,$4,$5,$6,$7,$8, CASE WHEN $5 IN ('sent','logged') THEN now() END)`,
        [lead.id, opts.senderType, opts.userId ?? null, encrypt(text), status, opts.templateId ?? null, mid, error],
      );
    }
  };

  // Nothing goes to someone who opted out, whatever the channel (except the STOP/DELETE confirmation itself).
  if (isOptedOut(lead) && !opts.systemAck) {
    const reason = "This person opted out of messages.";
    await save("blocked", reason, null);
    return { status: "blocked", error: reason };
  }

  if (lead.source !== "messenger") {
    // Website/manual inquiries: the team replies by email/phone outside this system; we keep the record.
    await save("logged", null, null);
    await q("UPDATE leads SET last_outbound_at=now(), last_activity_at=now(), updated_at=now() WHERE id=$1", [lead.id]);
    return { status: "logged" };
  }
  const w = messengerWindow(lead, opts.senderType === "agent", !!opts.systemAck);
  if (!w.ok) {
    await save("blocked", w.reason, null);
    return { status: "blocked", error: w.reason };
  }
  try {
    const r = await sendMessengerText(lead.psid, text, { messagingType: w.messagingType, tag: w.tag, quickReplies: opts.quickReplies });
    await save("sent", null, r.messageId);
    await q("UPDATE leads SET last_outbound_at=now(), last_activity_at=now(), updated_at=now() WHERE id=$1", [lead.id]);
    return { status: "sent" };
  } catch (err) {
    await save("failed", errMsg(err), null);
    log.warn("Messenger send failed", { leadId: lead.id, error: errMsg(err) });
    return { status: "failed", error: errMsg(err) };
  }
}
