import { Router, type Request } from "express";
import { z } from "zod";
import { encrypt, maskEmail, maskName, maskPhone, safeDecrypt } from "../lib/crypto.js";
import { one, q, tx, type Row } from "../lib/db.js";
import { conflict, forbidden, HttpError, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { env } from "../config/env.js";
import { fillTemplate, getConsent } from "../lib/settings.js";
import { requirePerm, userCan } from "../middleware/auth.js";
import { CATEGORY_LABELS, INQUIRY_CATEGORIES, redactContactData } from "../services/guardrails.js";
import { addActivity, autoAssign, deliver, isOptedOut, leadRef, messengerWindow, reclassifyLead, stripContact, templateVars } from "../services/leads.js";
import { anonymizeLead } from "../services/retention.js";
import { aiAllowedForInquiries, chatJson } from "../services/ai.js";

export const leadsRouter = Router();

/** Statuses staff can set by hand. awaiting_consent / collecting belong to the Messenger assistant only. */
const MANUAL_STATUSES = ["new", "in_progress", "waiting_customer", "closed", "opted_out"] as const;
const OPEN_STATUSES = ["new", "in_progress", "waiting_customer"];

/** Allowed manual moves. Nobody moves a person out of opted_out by hand: only the person can, by messaging again. */
const TRANSITIONS: Record<string, string[]> = {
  awaiting_consent: ["closed", "opted_out"],
  collecting: ["closed", "opted_out"],
  new: ["in_progress", "waiting_customer", "closed", "opted_out"],
  in_progress: ["new", "waiting_customer", "closed", "opted_out"],
  waiting_customer: ["in_progress", "closed", "opted_out"],
  closed: ["new", "in_progress", "opted_out"],
  opted_out: [],
};

/** Status options for this lead (its current status first), as the detail screen shows them. */
function statusOptions(lead: Row): string[] {
  if (lead.anonymized_at) return [lead.status];
  const next = (TRANSITIONS[lead.status] ?? []).filter((s) => lead.consent_given || !OPEN_STATUSES.includes(s));
  return [lead.status, ...next];
}

const STAFF_ROLES = ["pharma_team", "lead_agent", "admin"];
const MAX_THREAD = 300;

type P = (v: unknown) => string;
function paramList() {
  const list: unknown[] = [];
  const p: P = (v) => {
    list.push(v);
    return `$${list.length}`;
  };
  return { list, p };
}

/**
 * Who sees which inquiries. Never the assistant's pre-consent conversations.
 * The pharmaceutical team and admins (leads.view_all) see the rest. Inquiry agents see the inquiries assigned to
 * them, plus a claim queue: unassigned inquiries where the person agreed and no pharmaceutical review is needed.
 */
function scopeSql(req: Request, p: P): string {
  const base = "l.status NOT IN ('awaiting_consent','collecting')";
  // A deletion request has to be acted on even if it arrives while the assistant is asking for consent again.
  if (userCan(req, "leads.view_all")) return `(${base} OR l.category = 'privacy_request')`;
  const me = p(req.user!.id);
  return `${base} AND (l.assigned_to = ${me} OR (l.assigned_to IS NULL AND l.consent_given AND NOT l.needs_review))`;
}

async function loadLead(req: Request, id: number): Promise<Row> {
  const { list, p } = paramList();
  const s = scopeSql(req, p);
  const lead = await one(`SELECT l.*, u.name AS assigned_name, u.is_active AS assigned_active FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=${p(id)} AND ${s}`, list);
  if (!lead) throw notFound("Inquiry");
  return lead;
}

/** Contact details are shown in full only to the inquiry's owner and to people who can see all inquiries. */
const canReveal = (req: Request, lead: Row) => userCan(req, "leads.view_all") || (lead.assigned_to != null && lead.assigned_to === req.user!.id);

/** Masks emails and phone numbers inside free text the way the contact fields are masked. */
const maskText = (t: string) => redactContactData(t, { email: (v) => maskEmail(v) ?? "•••", phone: (v) => maskPhone(v) ?? "•••" });

/** Hides the person's name (full, and each part of it) inside free text. Sent replies have {{name}} already filled in. */
function maskNameIn(t: string, name: string | null): string {
  if (!name) return t;
  const parts = [name.trim(), ...name.split(/\s+/)].filter((x) => x.length >= 2).sort((a, b) => b.length - a.length);
  if (!parts.length) return t;
  const alts = parts.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:` + alts + String.raw`)(?![\p{L}\p{N}])`, "giu");
  return t.replace(re, "•••");
}

/** A message as this viewer may see it. Without reveal, contact details and the person's name are hidden in both directions. */
function messageBody(m: Row, reveal: boolean, name: string | null): { body: string | null; masked: boolean } {
  const body = safeDecrypt(m.body_enc);
  if (reveal || body == null) return { body, masked: false };
  const masked = maskNameIn(maskText(body), name);
  if (m.direction === "in" && m.contains_contact && masked === body) return { body: "[Contact details hidden]", masked: true };
  return { body: masked, masked: masked !== body };
}

/**
 * Without leads.view_all, people act only on inquiries assigned to them (claiming an unassigned one first),
 * so nobody replies to, opts out or edits a claim-queue inquiry they haven't taken.
 */
function assertOwner(req: Request, lead: Row) {
  if (userCan(req, "leads.view_all") || lead.assigned_to === req.user!.id) return;
  throw forbidden("Assign this inquiry to yourself first.");
}

function summarise(l: Row, reveal: boolean) {
  const name = safeDecrypt(l.name_enc);
  const email = safeDecrypt(l.email_enc);
  const phone = safeDecrypt(l.phone_enc);
  return {
    id: l.id,
    ref: leadRef(l.id),
    source: l.source,
    status: l.status,
    category: l.category,
    categoryLabel: CATEGORY_LABELS[l.category as keyof typeof CATEGORY_LABELS] ?? l.category,
    priority: l.priority,
    needs_review: l.needs_review,
    review_reasons: l.review_reasons,
    medicine_name: l.medicine_name,
    destination_country: l.destination_country,
    contact_preference: l.contact_preference,
    name: reveal ? name : maskName(name),
    email: reveal ? email : maskEmail(email),
    phone: reveal ? phone : maskPhone(phone),
    revealed: reveal,
    assigned_to: l.assigned_to,
    assigned_name: l.assigned_name,
    assigned_active: l.assigned_active ?? null,
    follow_up_at: l.follow_up_at,
    consent_given: l.consent_given,
    consent_at: l.consent_at,
    consent_version: l.consent_version,
    opted_out_at: l.opted_out_at,
    last_inbound_at: l.last_inbound_at,
    last_activity_at: l.last_activity_at,
    anonymized_at: l.anonymized_at,
    created_at: l.created_at,
    pending_reviews: l.pending_reviews ?? 0,
  };
}

const INT4_MAX = 2_147_483_647;

leadsRouter.get("/", requirePerm("leads.view"), async (req, res) => {
  const f = parse(
    z.object({
      view: z.enum(["all", "review", "mine", "unassigned", "followups", "closed"]).default("all"),
      category: z.string().max(60).optional(),
      q: z.string().max(100).optional(),
    }),
    req.query,
  );
  const { list, p } = paramList();
  const where = [scopeSql(req, p)];
  if (f.view === "review")
    where.push("(l.needs_review OR EXISTS (SELECT 1 FROM lead_messages m WHERE m.lead_id=l.id AND m.status='pending_review'))", "l.status <> 'closed'", "l.anonymized_at IS NULL");
  if (f.view === "mine") where.push(`l.assigned_to = ${p(req.user!.id)}`, "l.status NOT IN ('closed','opted_out')");
  if (f.view === "unassigned") where.push("l.assigned_to IS NULL", "l.status NOT IN ('closed','opted_out')");
  if (f.view === "followups") where.push("l.follow_up_at IS NOT NULL AND l.follow_up_at < now() + interval '1 day'", "l.status NOT IN ('closed','opted_out')");
  if (f.view === "closed") where.push("l.status IN ('closed','opted_out')");
  if (f.view === "all") where.push("l.anonymized_at IS NULL", "l.status NOT IN ('closed','opted_out')");
  if (f.category) where.push(`l.category = ${p(f.category)}`);
  if (f.q) {
    const term = p(`%${f.q}%`);
    const digits = f.q.match(/(\d+)\s*$/)?.[1];
    // Only treat the number as an inquiry id if it fits the id column (a long number would overflow it).
    const ref = digits && digits.length <= 10 && Number(digits) <= INT4_MAX ? Number(digits) : null;
    where.push(`(l.medicine_name ILIKE ${term} OR l.destination_country ILIKE ${term}${ref ? ` OR l.id = ${p(ref)}` : ""})`);
  }
  const rows = await q(
    `SELECT l.*, u.name AS assigned_name,
       (SELECT count(*) FROM lead_messages m WHERE m.lead_id=l.id AND m.status='pending_review')::int AS pending_reviews
     FROM leads l LEFT JOIN users u ON u.id=l.assigned_to
     WHERE ${where.join(" AND ")}
     ORDER BY l.needs_review DESC, CASE l.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, l.last_activity_at DESC
     LIMIT 300`,
    list,
  );
  res.json({ leads: rows.map((r) => summarise(r, false)) });
});

leadsRouter.get("/stats", requirePerm("leads.view"), async (req, res) => {
  const a = paramList();
  const [stats] = await q(
    `SELECT count(*) FILTER (WHERE status IN ('new','in_progress','waiting_customer'))::int AS open,
            count(*) FILTER (WHERE status='new')::int AS new,
            -- Same rows as the list views they link to (filter=review, filter=followups), so the numbers match.
            count(*) FILTER (WHERE (needs_review OR EXISTS (SELECT 1 FROM lead_messages m WHERE m.lead_id=l.id AND m.status='pending_review'))
                             AND status <> 'closed' AND anonymized_at IS NULL)::int AS needs_review,
            count(*) FILTER (WHERE assigned_to IS NULL AND status IN ('new','in_progress','waiting_customer'))::int AS unassigned,
            count(*) FILTER (WHERE follow_up_at IS NOT NULL AND follow_up_at < now() + interval '1 day' AND status NOT IN ('closed','opted_out'))::int AS followups,
            count(*) FILTER (WHERE follow_up_at < now() AND status NOT IN ('closed','opted_out'))::int AS overdue,
            count(*) FILTER (WHERE created_at > now() - interval '7 days' AND consent_given)::int AS this_week
     FROM leads l WHERE ${scopeSql(req, a.p)}`,
    a.list,
  );
  const b = paramList();
  const byCategory = await q(
    `SELECT category, count(*)::int AS n FROM leads l WHERE ${scopeSql(req, b.p)} AND status IN ('new','in_progress','waiting_customer') GROUP BY category ORDER BY n DESC`,
    b.list,
  );
  const c = paramList();
  const [pending] = await q(
    `SELECT count(*)::int AS n FROM lead_messages m JOIN leads l ON l.id=m.lead_id WHERE m.status='pending_review' AND ${scopeSql(req, c.p)}`,
    c.list,
  );
  res.json({
    stats: { ...stats, pending_replies: pending?.n ?? 0 },
    byCategory: byCategory.map((r) => ({ ...r, label: CATEGORY_LABELS[r.category as keyof typeof CATEGORY_LABELS] ?? r.category })),
    categories: INQUIRY_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
  });
});

leadsRouter.get("/:id", requirePerm("leads.view"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  const allowReveal = canReveal(req, lead);
  const reveal = req.query.reveal === "1";
  if (reveal && !allowReveal) throw forbidden("Only the inquiry's owner or the pharmaceutical team can see contact details. Assign it to yourself first.");
  const [messagesDesc, activitiesDesc, consents] = await Promise.all([
    q(
      `SELECT m.*, u.name AS sender_name, r.name AS reviewer_name FROM lead_messages m
       LEFT JOIN users u ON u.id=m.sender_user_id LEFT JOIN users r ON r.id=m.reviewed_by WHERE lead_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
      [id, MAX_THREAD + 1],
    ),
    q("SELECT a.*, u.name AS user_name FROM lead_activities a LEFT JOIN users u ON u.id=a.user_id WHERE lead_id=$1 ORDER BY a.created_at DESC, a.id DESC LIMIT $2", [id, MAX_THREAD + 1]),
    q("SELECT action, consent_version, channel, created_at FROM consent_records WHERE lead_id=$1 ORDER BY created_at", [id]),
  ]);
  if (reveal) await audit(req, "lead.contact_revealed", "lead", id);
  const messages = messagesDesc.slice(0, MAX_THREAD).reverse();
  const activities = activitiesDesc.slice(0, MAX_THREAD);
  const window = lead.source === "messenger" ? messengerWindow(lead, true) : null;
  const inquiry = safeDecrypt(lead.inquiry_enc);
  const name = safeDecrypt(lead.name_enc);
  res.json({
    lead: { ...summarise(lead, reveal), inquiry: inquiry && !reveal ? maskNameIn(maskText(inquiry), name) : inquiry },
    messages: messages.map(({ body_enc, ...m }) => ({ ...m, ...messageBody({ ...m, body_enc }, reveal, name) })),
    activities,
    consents,
    truncated: { messages: messagesDesc.length > MAX_THREAD, activities: activitiesDesc.length > MAX_THREAD },
    canReveal: allowReveal,
    statusOptions: statusOptions(lead),
    replyWindow: window,
    aiSuggestions: aiAllowedForInquiries(),
  });
});

const updateSchema = z.object({
  status: z.enum(MANUAL_STATUSES).optional(),
  category: z.enum(INQUIRY_CATEGORIES).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigned_to: z.number().int().nullable().optional(),
  follow_up_at: z.string().datetime({ offset: true }).nullable().optional(),
  medicine_name: z.string().max(120).nullable().optional(),
  destination_country: z.string().max(80).nullable().optional(),
  contact_preference: z.enum(["messenger", "email", "phone", "whatsapp"]).nullable().optional(),
  needs_review: z.boolean().optional(),
});

const sameValue = (k: string, v: unknown, cur: unknown) => {
  if (k === "follow_up_at") return (cur ? new Date(cur as string).getTime() : null) === (v ? new Date(v as string).getTime() : null);
  return JSON.stringify(v) === JSON.stringify(cur ?? null);
};

leadsRouter.patch("/:id", requirePerm("leads.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  const b = parse(updateSchema, req.body);
  if (lead.anonymized_at) throw conflict("This inquiry has been anonymised, so it can't be changed.");
  // Claiming an unassigned inquiry (and changing it in the same save) is allowed; anything else needs ownership.
  if (!(lead.assigned_to == null && b.assigned_to === req.user!.id)) assertOwner(req, lead);
  if (b.needs_review === false && !userCan(req, "leads.review")) throw forbidden("Only the pharmaceutical team can clear a review flag.");
  if (b.assigned_to !== undefined && b.assigned_to !== null && b.assigned_to !== lead.assigned_to) {
    if (b.assigned_to !== req.user!.id && !userCan(req, "leads.view_all")) throw forbidden("You can only assign inquiries to yourself.");
    const u = await one("SELECT id FROM users WHERE id=$1 AND is_active AND role = ANY($2)", [b.assigned_to, STAFF_ROLES]);
    if (!u) throw conflict("That person can't take inquiries (inactive, or not on the inquiry team).");
  }
  if (b.status !== undefined && b.status !== lead.status) {
    if (lead.status === "opted_out") throw conflict("This person opted out. Only they can restart the conversation, by messaging again.");
    if (!(TRANSITIONS[lead.status] ?? []).includes(b.status)) throw conflict(`An inquiry can't go from "${lead.status}" to "${b.status}".`);
    if (OPEN_STATUSES.includes(b.status) && !lead.consent_given) throw conflict("This person hasn't agreed to us keeping their details, so the inquiry can't be reopened.");
  }

  // Opting out also cancels any follow-up.
  if (b.status === "opted_out" && lead.status !== "opted_out") b.follow_up_at = null;

  const changes: string[] = [];
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || sameValue(k, v, lead[k])) continue;
    params.push(v);
    sets.push(`${k}=$${params.length}`);
    changes.push(k);
  }
  if (!sets.length) return void res.json({ ok: true, changed: [] });
  const statusChanged = changes.includes("status");
  if (statusChanged && b.status === "closed") sets.push("closed_at=now()");
  if (statusChanged && lead.status === "closed" && b.status !== "closed") sets.push("closed_at=NULL"); // reopened
  if (statusChanged && b.status === "opted_out") {
    sets.push("opted_out_at=now()", "bot_state=CASE WHEN source='messenger' THEN 'opted_out' ELSE bot_state END");
  }
  if (changes.includes("needs_review") && b.needs_review === false) sets.push("review_reasons='{}'");

  await tx(async (c) => {
    await q(`UPDATE leads SET ${sets.join(", ")}, last_activity_at=now(), updated_at=now() WHERE id=$1`, params, c);
    if (statusChanged && b.status === "opted_out") {
      await q("INSERT INTO consent_records (lead_id, action, consent_version, channel) VALUES ($1,'withdrawn',$2,'staff')", [id, lead.consent_version], c);
      // Drafts waiting for approval must never go out now.
      await q("UPDATE lead_messages SET status='blocked', error='The person opted out before this was approved.' WHERE lead_id=$1 AND status='pending_review'", [id], c);
      await addActivity(id, "consent", "Marked as opted out by staff: no more messages", req.user!.id, c);
    }
    for (const k of changes) {
      if (k === "status" && b.status === "opted_out") continue;
      let note = `${k.replace(/_/g, " ")} → ${String((b as Row)[k] ?? "none")}`;
      if (k === "status") note = lead.status === "closed" ? `Reopened (${b.status!.replace(/_/g, " ")})` : `Status → ${b.status!.replace(/_/g, " ")}`;
      if (k === "category") note = `Category → ${CATEGORY_LABELS[b.category!]}`;
      if (k === "assigned_to") note = b.assigned_to ? `Assigned to ${(await one("SELECT name FROM users WHERE id=$1", [b.assigned_to], c))?.name ?? "user"}` : "Unassigned";
      if (k === "needs_review") note = b.needs_review ? "Flagged for pharmaceutical review" : "Review completed";
      await addActivity(id, k === "assigned_to" ? "assign" : k === "needs_review" ? "review" : "update", note, req.user!.id, c);
    }
  });
  await audit(req, "lead.updated", "lead", id, { changes, ...(statusChanged ? { from: lead.status, to: b.status } : {}) });
  res.json({ ok: true, changed: changes });
});

leadsRouter.post("/:id/notes", requirePerm("leads.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  assertOwner(req, lead);
  if (lead.anonymized_at) throw conflict("This inquiry has been anonymised.");
  const { note } = parse(z.object({ note: z.string().trim().min(1).max(2000) }), req.body);
  await addActivity(id, "note", note, req.user!.id);
  await q("UPDATE leads SET last_activity_at=now() WHERE id=$1", [id]);
  res.status(201).json({ ok: true });
});

leadsRouter.post("/:id/messages", requirePerm("leads.reply"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  assertOwner(req, lead);
  const b = parse(z.object({ body: z.string().trim().min(1).max(2000), templateId: z.number().int().nullable().optional() }), req.body);
  if (lead.anonymized_at) throw conflict("This inquiry has been anonymised.");
  if (isOptedOut(lead)) throw conflict("This person opted out of messages.");

  // Sensitive inquiries: a reply from someone outside the pharmaceutical team waits for their approval.
  // Placeholders ({{name}}, {{business}}…) are kept as typed and filled in when it's approved and sent.
  if (lead.needs_review && !userCan(req, "leads.review")) {
    await q(
      `INSERT INTO lead_messages (lead_id, direction, sender_type, sender_user_id, body_enc, status, template_id) VALUES ($1,'out','agent',$2,$3,'pending_review',$4)`,
      [id, req.user!.id, encrypt(b.body), b.templateId ?? null],
    );
    await addActivity(id, "review", "Reply drafted, waiting for pharmaceutical team approval", req.user!.id);
    await audit(req, "lead.reply_queued", "lead", id);
    return void res.status(202).json({ status: "pending_review" });
  }
  const text = fillTemplate(b.body, templateVars(lead));
  const r = await deliver(lead, text, { senderType: "agent", userId: req.user!.id, templateId: b.templateId ?? null });
  if (r.status === "sent" || r.status === "logged") {
    await q("UPDATE leads SET status=CASE WHEN status='new' THEN 'in_progress' ELSE status END WHERE id=$1", [id]);
  }
  await audit(req, "lead.reply", "lead", id, { status: r.status });
  if (r.status === "blocked" || r.status === "failed") return void res.status(409).json({ status: r.status, error: r.error });
  res.status(201).json({ status: r.status });
});

leadsRouter.post("/:id/messages/:mid/approve", requirePerm("leads.review"), async (req, res) => {
  const id = intParam(req.params.id);
  const mid = intParam(req.params.mid, "message id");
  const lead = await loadLead(req, id);
  const b = parse(z.object({ body: z.string().trim().min(1).max(2000).optional() }), req.body ?? {});
  // Claim the draft first, so a double click or two reviewers can't send it twice.
  const msg = await one(
    "UPDATE lead_messages SET status='sending', reviewed_by=$3, reviewed_at=now() WHERE id=$1 AND lead_id=$2 AND status='pending_review' RETURNING *",
    [mid, id, req.user!.id],
  );
  if (!msg) throw conflict("This reply was already approved, sent or returned. Reload to see where it is.");
  const restore = (error: string | null) =>
    q("UPDATE lead_messages SET status='pending_review', reviewed_by=NULL, reviewed_at=NULL, error=$2 WHERE id=$1 AND status IN ('sending','failed')", [mid, error]);
  let r: Awaited<ReturnType<typeof deliver>>;
  try {
    const text = fillTemplate(b.body ?? safeDecrypt(msg.body_enc) ?? "", templateVars(lead));
    if (!text.trim()) throw conflict("This reply is empty.");
    await q("UPDATE lead_messages SET body_enc=$2 WHERE id=$1", [mid, encrypt(text)]);
    r = await deliver(lead, text, { senderType: "agent", userId: msg.sender_user_id, existingMessageId: mid });
  } catch (err) {
    await q("UPDATE lead_messages SET body_enc=$2 WHERE id=$1", [mid, msg.body_enc]).catch(() => undefined);
    await restore(null).catch(() => undefined);
    throw err;
  }
  // A temporary sending failure goes back to the review queue so it can be tried again; "blocked" stays blocked.
  if (r.status === "failed") await restore(r.error ?? "Sending failed");
  await addActivity(id, "review", r.status === "failed" ? "Approved reply failed to send; it's back in the review queue" : `Reply approved${b.body ? " with edits" : ""} (${r.status})`, req.user!.id);
  await audit(req, "lead.reply_approved", "lead", id, { messageId: mid, status: r.status });
  if (r.status === "blocked" || r.status === "failed") return void res.status(409).json({ status: r.status, error: r.error });
  if (r.status === "sent" || r.status === "logged") await q("UPDATE leads SET status=CASE WHEN status='new' THEN 'in_progress' ELSE status END WHERE id=$1", [id]);
  res.json({ status: r.status });
});

leadsRouter.post("/:id/messages/:mid/reject", requirePerm("leads.review"), async (req, res) => {
  const id = intParam(req.params.id);
  const mid = intParam(req.params.mid, "message id");
  await loadLead(req, id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(2).max(500) }), req.body);
  const r = await q("UPDATE lead_messages SET status='rejected', error=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1 AND lead_id=$2 AND status='pending_review' RETURNING id", [
    mid,
    id,
    reason,
    req.user!.id,
  ]);
  if (!r.length) throw conflict("This reply was already approved, sent or returned. Reload to see where it is.");
  await addActivity(id, "review", `Reply not approved: ${reason}`, req.user!.id);
  res.json({ ok: true });
});

/** AI suggests a reply built from approved templates. It's only a draft: a person edits and sends it. */
leadsRouter.post("/:id/suggest", requirePerm("leads.reply"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  assertOwner(req, lead);
  if (!aiAllowedForInquiries())
    throw new HttpError(403, "AI reply suggestions are off, so inquiry text isn't sent to the cloud AI. An administrator can turn them on with AI_FOR_INQUIRIES=true in .env.");
  const templates = await q("SELECT id, name, category, body FROM response_templates WHERE status='approved' AND key IS NULL ORDER BY category, name");
  const recent = await q<{ direction: string; body_enc: string | null }>(
    "SELECT direction, body_enc FROM lead_messages WHERE lead_id=$1 AND NOT contains_contact ORDER BY created_at DESC LIMIT 6",
    [id],
  );
  // No names, emails or phone numbers go to the AI: placeholders stay as placeholders.
  const vars: Record<string, string> = { ...templateVars(lead), name: "{{name}}" };
  const convo = recent
    .reverse()
    .map((m) => `${m.direction === "in" ? "Customer" : "Us"}: ${stripContact(safeDecrypt(m.body_enc) ?? "")}`)
    .join("\n");
  const out = await chatJson<{ template_id?: number; reply?: string; needs_pharmacist?: boolean; reason?: string }>({
    system:
      "You help a pharmaceutical distributor's support team draft replies. Use ONLY the approved templates below as the basis, filling in details. " +
      "Never give medical advice, doses, side-effect information, availability promises, prices or regulatory opinions that aren't in a template. " +
      "If the customer asks for any of those, set needs_pharmacist to true. Reply in JSON only.\n\nApproved templates:\n" +
      templates.map((t) => `#${t.id} [${t.category}] ${t.name}: ${fillTemplate(t.body, vars)}`).join("\n"),
    prompt: `Inquiry ${vars.ref}. Medicine: ${vars.medicine}. Country: ${vars.country}. Category: ${lead.category}.\nRecent conversation:\n${convo || "(none)"}\n\nReturn {"template_id":n,"reply":"...","needs_pharmacist":bool,"reason":"one line"}`,
    temperature: 0.2,
    effort: "low",
    timeoutMs: 90_000,
  });
  res.json({ suggestion: { templateId: out.template_id ?? null, reply: String(out.reply ?? ""), needsPharmacist: !!out.needs_pharmacist || lead.needs_review, reason: out.reason ?? "" } });
});

leadsRouter.post("/:id/reclassify", requirePerm("leads.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  assertOwner(req, await loadLead(req, id));
  res.json({ result: await reclassifyLead(id, true) });
});

/** Manual entry (phone or walk-in inquiries). The staff member confirms the person agreed. */
leadsRouter.post("/", requirePerm("leads.manage"), async (req, res) => {
  const b = parse(
    z
      .object({
        name: z.string().trim().max(120).optional(),
        email: z.string().trim().email("Enter a valid email").optional().or(z.literal("")),
        phone: z.string().trim().max(40).optional().or(z.literal("")),
        medicine_name: z.string().trim().min(1, "Enter the medicine").max(120),
        destination_country: z.string().trim().min(1, "Enter the country").max(80),
        contact_preference: z.enum(["email", "phone", "whatsapp"]),
        inquiry: z.string().trim().max(3000).optional(),
        consent_confirmed: z.literal(true, { errorMap: () => ({ message: "Confirm the person agreed to us keeping their details" }) }),
      })
      .superRefine((v, ctx) => {
        if (v.contact_preference === "email" && !v.email) ctx.addIssue({ code: "custom", path: ["email"], message: "Enter the email address to reply to" });
        if (v.contact_preference !== "email" && !(v.phone && v.phone.replace(/\D/g, "").length >= 7))
          ctx.addIssue({ code: "custom", path: ["phone"], message: "Enter the phone number, with the country code" });
      }),
    req.body,
  );
  // Keep only the contact detail for the chosen method.
  const email = b.contact_preference === "email" ? b.email?.toLowerCase() : undefined;
  const phone = b.contact_preference === "email" ? undefined : b.phone;
  const consent = await getConsent();
  const id = await tx(async (c) => {
    const row = await one(
      `INSERT INTO leads (source, name_enc, email_enc, phone_enc, inquiry_enc, medicine_name, destination_country, contact_preference, status, consent_given, consent_at, consent_version, created_at)
       VALUES ('manual',$1,$2,$3,$4,$5,$6,$7,'new',true,now(),$8, now()) RETURNING id`,
      [encrypt(b.name), encrypt(email), encrypt(phone), encrypt(b.inquiry), b.medicine_name, b.destination_country, b.contact_preference, consent.version],
      c,
    );
    await q("INSERT INTO consent_records (lead_id, action, consent_version, channel, text_shown) VALUES ($1,'granted',$2,'staff',$3)", [
      row!.id,
      consent.version,
      fillTemplate(consent.text, { business: env.BUSINESS_NAME }),
    ], c);
    await addActivity(row!.id, "created", "Entered by staff (consent confirmed verbally)", req.user!.id, c);
    return row!.id as number;
  });
  const cls = await reclassifyLead(id, true);
  // An inquiry agent who enters it handles it (otherwise it could be assigned to someone else and vanish from their
  // view); the pharmaceutical team and admins get the usual automatic assignment.
  const selfAssign = !cls?.needsReview && !userCan(req, "leads.view_all") && STAFF_ROLES.includes(req.user!.role);
  if (selfAssign) {
    const done = await q("UPDATE leads SET assigned_to=$2 WHERE id=$1 AND assigned_to IS NULL RETURNING id", [id, req.user!.id]);
    if (done.length) await addActivity(id, "assign", `Assigned to ${req.user!.name}`, req.user!.id);
  } else await autoAssign(id, !!cls?.needsReview);
  await audit(req, "lead.created", "lead", id);
  const after = await one<{ assigned_to: number | null }>("SELECT assigned_to FROM leads WHERE id=$1", [id]);
  // Tells the screen whether the person who entered it can open it (a review case goes to the pharmaceutical team).
  const visible = userCan(req, "leads.view_all") || after?.assigned_to === req.user!.id || (!after?.assigned_to && !cls?.needsReview);
  res.status(201).json({ id, ref: leadRef(id), visible });
});

leadsRouter.get("/:id/export", requirePerm("leads.export"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  const messages = await q("SELECT direction, sender_type, body_enc, status, created_at FROM lead_messages WHERE lead_id=$1 ORDER BY created_at", [id]);
  const consents = await q("SELECT action, consent_version, channel, created_at FROM consent_records WHERE lead_id=$1", [id]);
  await audit(req, "lead.exported", "lead", id);
  res.setHeader("Content-Disposition", `attachment; filename="${leadRef(id)}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    inquiry: { ...summarise(lead, true), inquiry: safeDecrypt(lead.inquiry_enc) },
    messages: messages.map(({ body_enc, ...m }) => ({ ...m, body: safeDecrypt(body_enc) })),
    consents,
  });
});

/** Fixed reasons only: free text typed here would outlive the personal data it's deleting. */
export const ANON_REASONS = {
  erasure_request: "Person asked for their details to be deleted",
  consent_withdrawn: "Person withdrew consent",
  entered_by_mistake: "Entered by mistake or a duplicate",
  other: "Other reason",
} as const;

/** Erasure request: removes personal data, keeps anonymous counts. */
leadsRouter.post("/:id/anonymize", requirePerm("leads.delete"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  if (lead.anonymized_at) throw conflict("This inquiry's personal data has already been removed.");
  const { reason } = parse(z.object({ reason: z.enum(Object.keys(ANON_REASONS) as [keyof typeof ANON_REASONS, ...(keyof typeof ANON_REASONS)[]]) }), req.body);
  await anonymizeLead(id, `Anonymised by staff: ${ANON_REASONS[reason]}`, req.user!.id);
  await audit(req, "lead.anonymized", "lead", id, { reason });
  res.json({ ok: true });
});
