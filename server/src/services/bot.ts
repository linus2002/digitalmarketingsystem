import { encrypt } from "../lib/crypto.js";
import { one, q, tx, type Row } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { getConsent } from "../lib/settings.js";
import { DELETE_REQUEST, HUMAN_REQUEST, NO, OPT_OUT, YES } from "./guardrails.js";
import { addActivity, autoAssign, deliver, reclassifyLead, systemText } from "./leads.js";

// A deterministic, template-only Messenger assistant. It only answers people who message the Page,
// only asks for the medicine, the destination country and a contact preference, and never gives
// medical, prescription, regulatory or availability answers: those go to the pharmaceutical team.

export interface InboundEvent {
  psid: string;
  mid: string | null;
  text: string;
  payload: string | null; // quick reply / postback payload
  timestamp: number;
}

const CONSENT_REPLIES = [
  { title: "I agree", payload: "CONSENT_YES" },
  { title: "No thanks", payload: "CONSENT_NO" },
];
const CONTACT_REPLIES = [
  { title: "Messenger", payload: "CONTACT_MESSENGER" },
  { title: "Email", payload: "CONTACT_EMAIL" },
  { title: "Phone call", payload: "CONTACT_PHONE" },
  { title: "WhatsApp", payload: "CONTACT_WHATSAPP" },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s().-]{7,20}$/;

async function say(lead: Row, key: string, quickReplies?: { title: string; payload: string }[]) {
  const { text, templateId } = await systemText(key, lead);
  return deliver(lead, text, { senderType: "bot", templateId, quickReplies });
}

async function setState(leadId: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  await q(`UPDATE leads SET ${sets}, updated_at=now() WHERE id=$1`, [leadId, ...keys.map((k) => fields[k])]);
}

const reload = (id: number) => one("SELECT * FROM leads WHERE id=$1", [id]) as Promise<Row>;

export async function handleInbound(ev: InboundEvent) {
  try {
    await processInbound(ev);
  } catch (err) {
    log.error("Messenger event failed", { error: errMsg(err) });
  }
}

async function processInbound(ev: InboundEvent) {
  const text = ev.text.trim();
  const at = new Date(ev.timestamp || Date.now());

  // Find or start the conversation, and store the message (deduplicated by Meta's message id).
  const { lead, isNew, duplicate } = await tx(async (c) => {
    let lead = await one("SELECT * FROM leads WHERE psid=$1 FOR UPDATE", [ev.psid], c);
    let isNew = false;
    if (!lead) {
      lead = await one(
        `INSERT INTO leads (source, psid, status, bot_state, last_inbound_at, last_activity_at) VALUES ('messenger',$1,'awaiting_consent','consent',$2,$2) RETURNING *`,
        [ev.psid, at],
        c,
      );
      isNew = true;
    }
    const ins = await q(
      `INSERT INTO lead_messages (lead_id, direction, sender_type, body_enc, status, meta_mid, created_at)
       VALUES ($1,'in','customer',$2,'received',$3,$4) ON CONFLICT (meta_mid) DO NOTHING RETURNING id`,
      [lead!.id, encrypt(text || (ev.payload ? `[${ev.payload}]` : "[attachment]")), ev.mid, at],
      c,
    );
    await q("UPDATE leads SET last_inbound_at=$2, last_activity_at=$2, updated_at=now() WHERE id=$1", [lead!.id, at], c);
    return { lead: lead!, isNew, duplicate: ins.length === 0 };
  });
  if (duplicate) return;
  const fresh = await reload(lead.id);

  // Words that work at any point
  if (OPT_OUT.test(text)) {
    await setState(lead.id, { status: "opted_out", opted_out_at: new Date(), bot_state: "opted_out", follow_up_at: null });
    await q("INSERT INTO consent_records (lead_id, action, consent_version, channel) VALUES ($1,'withdrawn',$2,'messenger')", [lead.id, fresh.consent_version]);
    await addActivity(lead.id, "consent", "Opted out of messages (STOP)");
    await say(await reload(lead.id), "bot.optout");
    return;
  }
  if (DELETE_REQUEST.test(text)) {
    await setState(lead.id, { needs_review: true, review_reasons: [...new Set([...(fresh.review_reasons as string[]), "Deletion request"])], priority: "high", category: "privacy_request" });
    await addActivity(lead.id, "privacy", "Asked for their details to be deleted");
    await say(fresh, "bot.delete_ack");
    return;
  }
  if (fresh.status === "opted_out") {
    // They messaged again after opting out: treat it as starting over, with consent asked again.
    await setState(lead.id, { status: "awaiting_consent", bot_state: "consent", opted_out_at: null });
    await say(await reload(lead.id), "bot.consent", CONSENT_REPLIES);
    return;
  }

  const state = fresh.bot_state as string | null;
  const payload = ev.payload ?? "";

  if (isNew || state === "consent") {
    if (isNew) {
      await say(fresh, "bot.consent", CONSENT_REPLIES);
      return;
    }
    const consent = await getConsent();
    if (payload === "CONSENT_YES" || (!payload && YES.test(text))) {
      await setState(lead.id, { consent_given: true, consent_at: new Date(), consent_version: consent.version, status: "collecting", bot_state: "ask_medicine" });
      await q("INSERT INTO consent_records (lead_id, action, consent_version, channel, text_shown) VALUES ($1,'granted',$2,'messenger',$3)", [lead.id, consent.version, consent.text]);
      await addActivity(lead.id, "consent", `Consent given (version ${consent.version})`);
      await say(await reload(lead.id), "bot.ask_medicine");
    } else if (payload === "CONSENT_NO" || (!payload && NO.test(text))) {
      await q("INSERT INTO consent_records (lead_id, action, consent_version, channel) VALUES ($1,'declined',$2,'messenger')", [lead.id, consent.version]);
      // Keep nothing they wrote; the empty record is deleted by the retention job.
      await q("UPDATE lead_messages SET body_enc=NULL WHERE lead_id=$1", [lead.id]);
      await setState(lead.id, { status: "closed", bot_state: "declined", closed_at: new Date() });
      await say(await reload(lead.id), "bot.declined");
    } else {
      await say(fresh, "bot.consent_reask", CONSENT_REPLIES);
    }
    return;
  }

  if (state === "declined") {
    // A new message after declining: ask again (it's a new conversation from their side).
    await setState(lead.id, { status: "awaiting_consent", bot_state: "consent", closed_at: null });
    await say(await reload(lead.id), "bot.consent", CONSENT_REPLIES);
    return;
  }

  if (HUMAN_REQUEST.test(text) && state !== "handed_off") {
    await setState(lead.id, { needs_review: true, priority: "high", review_reasons: [...new Set([...(fresh.review_reasons as string[]), "Asked for a person"])] });
    await addActivity(lead.id, "review", "Asked to speak to a person");
  }

  switch (state) {
    case "ask_medicine":
      if (!text) return say(fresh, "bot.ask_medicine");
      await setState(lead.id, { medicine_name: text.slice(0, 120), bot_state: "ask_country" });
      return say(await reload(lead.id), "bot.ask_country");
    case "ask_country":
      if (!text) return say(fresh, "bot.ask_country");
      await setState(lead.id, { destination_country: text.slice(0, 80), bot_state: "ask_contact" });
      return say(await reload(lead.id), "bot.ask_contact", CONTACT_REPLIES);
    case "ask_contact": {
      const choice =
        payload.replace("CONTACT_", "").toLowerCase() ||
        (/mail/i.test(text) ? "email" : /whats/i.test(text) ? "whatsapp" : /phone|call/i.test(text) ? "phone" : /messenger|here|chat/i.test(text) ? "messenger" : "");
      if (!["messenger", "email", "phone", "whatsapp"].includes(choice)) return say(fresh, "bot.ask_contact", CONTACT_REPLIES);
      await setState(lead.id, { contact_preference: choice, bot_state: choice === "email" ? "ask_email" : choice === "messenger" ? "complete" : "ask_phone" });
      if (choice === "email") return say(fresh, "bot.ask_email");
      if (choice !== "messenger") return say(fresh, "bot.ask_phone");
      return complete(lead.id);
    }
    case "ask_email":
      if (!EMAIL.test(text)) return say(fresh, "bot.invalid_email");
      await setState(lead.id, { email_enc: encrypt(text.toLowerCase()), bot_state: "complete" });
      return complete(lead.id);
    case "ask_phone":
      if (!PHONE.test(text)) return say(fresh, "bot.invalid_phone");
      await setState(lead.id, { phone_enc: encrypt(text), bot_state: "complete" });
      return complete(lead.id);
    default: {
      // Conversation already handed to the team: record the message, re-check for review topics,
      // and acknowledge at most once every 12 hours so we don't chatter.
      await reclassifyLead(lead.id, true);
      if (fresh.status === "closed" || fresh.status === "waiting_customer") await setState(lead.id, { status: "in_progress", closed_at: null });
      if (HUMAN_REQUEST.test(text)) return say(fresh, "bot.human");
      const last = fresh.last_bot_ack_at ? new Date(fresh.last_bot_ack_at).getTime() : 0;
      if (Date.now() - last > 12 * 3_600_000) {
        await setState(lead.id, { last_bot_ack_at: new Date() });
        return say(fresh, "bot.ack");
      }
    }
  }
}

async function complete(leadId: number) {
  const c = await reclassifyLead(leadId, true);
  await setState(leadId, { status: "new", bot_state: "handed_off", follow_up_at: new Date(Date.now() + 24 * 3_600_000) });
  const lead = await reload(leadId);
  await autoAssign(leadId, lead.needs_review);
  await addActivity(leadId, "created", `Inquiry details collected by the assistant${c?.reviewReasons.length ? `; needs review: ${c.reviewReasons.join(", ")}` : ""}`);
  await say(lead, lead.needs_review ? "bot.handoff_review" : "bot.handoff");
}
