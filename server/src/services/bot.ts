import { env } from "../config/env.js";
import { encrypt } from "../lib/crypto.js";
import { one, q, tx, type Row } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { fillTemplate, getConsent } from "../lib/settings.js";
import { DELETE_REQUEST, HUMAN_REQUEST, NO, OPT_OUT, YES } from "./guardrails.js";
import { addActivity, autoAssign, deliver, isOptedOut, reclassifyLead, systemText } from "./leads.js";

// A deterministic, template-only assistant for Messenger and Instagram direct messages. It only answers people who
// message the Page or its linked Instagram account,
// only asks for the medicine, the destination country and a contact preference, and never gives
// medical, prescription, regulatory or availability answers: those go to the pharmaceutical team.

/** The chat apps the assistant answers in. Both go through the Facebook Page (Instagram via the linked account). */
export type ChatChannel = "messenger" | "instagram";
export const CHAT_CHANNELS: readonly string[] = ["messenger", "instagram"];

export interface InboundEvent {
  channel: ChatChannel;
  /** The person's id in that app (Messenger PSID or Instagram-scoped id). */
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
/** "Reply here" is offered as the app they're writing in. */
const contactReplies = (channel: string) => [
  channel === "instagram" ? { title: "Instagram", payload: "CONTACT_INSTAGRAM" } : { title: "Messenger", payload: "CONTACT_MESSENGER" },
  { title: "Email", payload: "CONTACT_EMAIL" },
  { title: "Phone call", payload: "CONTACT_PHONE" },
  { title: "WhatsApp", payload: "CONTACT_WHATSAPP" },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s().-]{7,20}$/;

async function say(lead: Row, key: string, quickReplies?: { title: string; payload: string }[], opts: { systemAck?: boolean } = {}) {
  const { text, templateId } = await systemText(key, lead);
  return deliver(lead, text, { senderType: "bot", templateId, quickReplies, systemAck: opts.systemAck });
}

async function setState(leadId: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  await q(`UPDATE leads SET ${sets}, updated_at=now() WHERE id=$1`, [leadId, ...keys.map((k) => fields[k])]);
}

const reload = (id: number) => one("SELECT * FROM leads WHERE id=$1", [id]) as Promise<Row>;

// Events from one person are handled strictly one after another, in arrival order, so two quick messages can't
// both create a conversation or overwrite each other's step. (This queue is per server process; the upsert below
// also keeps the first-message race safe if more than one process ever handles webhooks.)
const queues = new Map<string, Promise<void>>();

export function handleInbound(ev: InboundEvent): Promise<void> {
  const key = `${ev.channel}:${ev.psid}`;
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      await processInbound(ev);
    } catch (err) {
      log.error("Messenger event failed", { error: errMsg(err) });
    }
  });
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

class Duplicate extends Error {}

async function processInbound(ev: InboundEvent) {
  const text = ev.text.trim();
  const at = new Date(ev.timestamp || Date.now());

  // Find or start the conversation, and store the message (deduplicated by Meta's message id).
  let stored: { lead: Row; isNew: boolean; messageId: number };
  try {
    stored = await tx(async (c) => {
      const lead = await one(
        `INSERT INTO leads (source, psid, status, bot_state, last_inbound_at, last_activity_at)
         VALUES ($3,$1,'awaiting_consent','consent',$2,$2)
         ON CONFLICT (source, psid) DO UPDATE SET last_inbound_at=GREATEST(leads.last_inbound_at, EXCLUDED.last_inbound_at),
           last_activity_at=GREATEST(leads.last_activity_at, EXCLUDED.last_activity_at), updated_at=now()
         RETURNING *, (xmax = 0) AS inserted`,
        [ev.psid, at, ev.channel],
        c,
      );
      const ins = await q<{ id: number }>(
        `INSERT INTO lead_messages (lead_id, direction, sender_type, body_enc, status, meta_mid, created_at)
         VALUES ($1,'in','customer',$2,'received',$3,$4) ON CONFLICT (meta_mid) DO NOTHING RETURNING id`,
        [lead!.id, encrypt(text || (ev.payload ? `[${ev.payload}]` : "[attachment]")), ev.mid, at],
        c,
      );
      if (!ins.length) throw new Duplicate(); // a Meta retry: roll back and ignore
      const { inserted, ...row } = lead!;
      return { lead: row, isNew: !!inserted, messageId: ins[0].id };
    });
  } catch (err) {
    if (err instanceof Duplicate) return;
    throw err;
  }
  const { lead, isNew, messageId } = stored;
  const fresh = lead;

  // Words that work at any point. Their confirmations are allowed out even though the person has opted out.
  if (OPT_OUT.test(text)) {
    await setState(lead.id, { status: "opted_out", opted_out_at: new Date(), bot_state: "opted_out", follow_up_at: null });
    await q("INSERT INTO consent_records (lead_id, action, consent_version, channel) VALUES ($1,'withdrawn',$2,$3)", [lead.id, fresh.consent_version, lead.source]);
    // Replies waiting for approval must never go out now.
    await q("UPDATE lead_messages SET status='blocked', error='The person opted out before this was approved.' WHERE lead_id=$1 AND status='pending_review'", [lead.id]);
    await addActivity(lead.id, "consent", "Opted out of messages (STOP)");
    await say(await reload(lead.id), "bot.optout", undefined, { systemAck: true });
    return;
  }
  if (DELETE_REQUEST.test(text)) {
    await setState(lead.id, { needs_review: true, review_reasons: [...new Set([...(fresh.review_reasons as string[]), "Deletion request"])], priority: "high", category: "privacy_request" });
    await addActivity(lead.id, "privacy", "Asked for their details to be deleted");
    await say(await reload(lead.id), "bot.delete_ack", undefined, { systemAck: true });
    return;
  }
  if (isOptedOut(fresh)) {
    // They messaged again after opting out: treat it as starting over, with consent asked again. The earlier consent
    // was withdrawn, so it no longer counts until they agree again.
    await setState(lead.id, { status: "awaiting_consent", bot_state: "consent", opted_out_at: null, consent_given: false, consent_at: null });
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
      await q("INSERT INTO consent_records (lead_id, action, consent_version, channel, text_shown) VALUES ($1,'granted',$2,$4,$3)", [
        lead.id,
        consent.version,
        fillTemplate(consent.text, { business: env.BUSINESS_NAME }),
        lead.source,
      ]);
      await addActivity(lead.id, "consent", `Consent given (version ${consent.version})`);
      await say(await reload(lead.id), "bot.ask_medicine");
    } else if (payload === "CONSENT_NO" || (!payload && NO.test(text))) {
      await q("INSERT INTO consent_records (lead_id, action, consent_version, channel) VALUES ($1,'declined',$2,$3)", [lead.id, consent.version, lead.source]);
      // Keep nothing they wrote; the empty record is deleted by the retention job.
      await q("UPDATE lead_messages SET body_enc=NULL WHERE lead_id=$1", [lead.id]);
      await setState(lead.id, { status: "closed", bot_state: "declined", closed_at: new Date(), consent_given: false, consent_at: null });
      await say(await reload(lead.id), "bot.declined");
    } else {
      await say(fresh, "bot.consent_reask", CONSENT_REPLIES);
    }
    return;
  }

  if (state === "declined") {
    // A new message after declining: ask again (it's a new conversation from their side).
    await setState(lead.id, { status: "awaiting_consent", bot_state: "consent", closed_at: null, consent_given: false, consent_at: null });
    await say(await reload(lead.id), "bot.consent", CONSENT_REPLIES);
    return;
  }

  if (HUMAN_REQUEST.test(text) && state !== "handed_off") {
    await setState(lead.id, { needs_review: true, priority: "high", review_reasons: [...new Set([...(fresh.review_reasons as string[]), "Asked for a person"])] });
    await addActivity(lead.id, "review", "Asked to speak to a person");
  }

  switch (state) {
    case "ask_medicine":
      if (!text) return void (await say(fresh, "bot.ask_medicine"));
      await setState(lead.id, { medicine_name: text.slice(0, 120), bot_state: "ask_country" });
      return void (await say(await reload(lead.id), "bot.ask_country"));
    case "ask_country":
      if (!text) return void (await say(fresh, "bot.ask_country"));
      await setState(lead.id, { destination_country: text.slice(0, 80), bot_state: "ask_contact" });
      return void (await say(await reload(lead.id), "bot.ask_contact", contactReplies(lead.source)));
    case "ask_contact": {
      let choice =
        payload.replace("CONTACT_", "").toLowerCase() ||
        (/mail/i.test(text) ? "email" : /whats/i.test(text) ? "whatsapp" : /phone|call/i.test(text) ? "phone" : /messenger|insta|here|chat|\bdm\b/i.test(text) ? "chat" : "");
      // "Reply here", in whichever app they're writing in, is stored as that app.
      if (choice === "chat" || CHAT_CHANNELS.includes(choice)) choice = lead.source;
      if (!["messenger", "instagram", "email", "phone", "whatsapp"].includes(choice)) return void (await say(fresh, "bot.ask_contact", contactReplies(lead.source)));
      const inChat = CHAT_CHANNELS.includes(choice);
      await setState(lead.id, { contact_preference: choice, bot_state: choice === "email" ? "ask_email" : inChat ? "complete" : "ask_phone" });
      if (choice === "email") return void (await say(fresh, "bot.ask_email"));
      if (!inChat) return void (await say(fresh, "bot.ask_phone"));
      return complete(lead.id);
    }
    case "ask_email":
      // Whatever they typed here is (or tries to be) their email: keep it masked like the contact fields.
      await q("UPDATE lead_messages SET contains_contact=true WHERE id=$1", [messageId]);
      if (!EMAIL.test(text)) return void (await say(fresh, "bot.invalid_email"));
      await setState(lead.id, { email_enc: encrypt(text.toLowerCase()), bot_state: "complete" });
      return complete(lead.id);
    case "ask_phone":
      await q("UPDATE lead_messages SET contains_contact=true WHERE id=$1", [messageId]);
      if (!PHONE.test(text)) return void (await say(fresh, "bot.invalid_phone"));
      await setState(lead.id, { phone_enc: encrypt(text), bot_state: "complete" });
      return complete(lead.id);
    default: {
      // Conversation already handed to the team: record the message, re-check for review topics,
      // and acknowledge at most once every 12 hours so we don't chatter.
      await reclassifyLead(lead.id, true);
      if (fresh.status === "closed" || fresh.status === "waiting_customer") await setState(lead.id, { status: "in_progress", closed_at: null });
      if (HUMAN_REQUEST.test(text)) return void (await say(fresh, "bot.human"));
      const last = fresh.last_bot_ack_at ? new Date(fresh.last_bot_ack_at).getTime() : 0;
      if (Date.now() - last > 12 * 3_600_000) {
        await setState(lead.id, { last_bot_ack_at: new Date() });
        return void (await say(fresh, "bot.ack"));
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
