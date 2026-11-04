import { Router, type Request } from "express";
import { z } from "zod";
import { encrypt, maskEmail, maskName, maskPhone, safeDecrypt } from "../lib/crypto.js";
import { one, q, tx, type Row } from "../lib/db.js";
import { badRequest, conflict, forbidden, HttpError, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { fillTemplate, getConsent } from "../lib/settings.js";
import { requirePerm, userCan } from "../middleware/auth.js";
import { CATEGORY_LABELS, INQUIRY_CATEGORIES } from "../services/guardrails.js";
import { addActivity, autoAssign, deliver, leadRef, messengerWindow, reclassifyLead, templateVars } from "../services/leads.js";
import { anonymizeLead } from "../services/retention.js";
import { aiAllowedForInquiries, chatJson } from "../services/ai.js";

export const leadsRouter = Router();

const STATUSES = ["awaiting_consent", "collecting", "new", "in_progress", "waiting_customer", "closed", "opted_out"] as const;

/** Inquiry agents see their own and unassigned inquiries; the pharmaceutical team and admins see all. */
function scope(req: Request): { sql: string; params: unknown[] } {
  if (userCan(req, "leads.view_all")) return { sql: "TRUE", params: [] };
  return { sql: "(l.assigned_to = $1 OR l.assigned_to IS NULL)", params: [req.user!.id] };
}

async function loadLead(req: Request, id: number): Promise<Row> {
  const s = scope(req);
  const lead = await one(
    `SELECT l.*, u.name AS assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=$${s.params.length + 1} AND ${s.sql}`,
    [...s.params, id],
  );
  if (!lead) throw notFound("Inquiry");
  return lead;
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
    assigned_to: l.assigned_to,
    assigned_name: l.assigned_name,
    follow_up_at: l.follow_up_at,
    consent_given: l.consent_given,
    consent_at: l.consent_at,
    consent_version: l.consent_version,
    last_inbound_at: l.last_inbound_at,
    last_activity_at: l.last_activity_at,
    anonymized_at: l.anonymized_at,
    created_at: l.created_at,
    pending_reviews: l.pending_reviews ?? 0,
  };
}

leadsRouter.get("/", requirePerm("leads.view"), async (req, res) => {
  const f = parse(
    z.object({
      view: z.enum(["all", "review", "mine", "unassigned", "followups", "closed"]).default("all"),
      category: z.string().optional(),
      q: z.string().max(100).optional(),
    }),
    req.query,
  );
  const s = scope(req);
  const params = [...s.params];
  const where = [s.sql, "l.status NOT IN ('awaiting_consent','collecting')"];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.view === "review") where.push("(l.needs_review OR EXISTS (SELECT 1 FROM lead_messages m WHERE m.lead_id=l.id AND m.status='pending_review'))", "l.status <> 'closed'");
  if (f.view === "mine") where.push(`l.assigned_to = ${p(req.user!.id)}`, "l.status NOT IN ('closed','opted_out')");
  if (f.view === "unassigned") where.push("l.assigned_to IS NULL", "l.status NOT IN ('closed','opted_out')");
  if (f.view === "followups") where.push("l.follow_up_at IS NOT NULL AND l.follow_up_at < now() + interval '1 day'", "l.status NOT IN ('closed','opted_out')");
  if (f.view === "closed") where.push("l.status IN ('closed','opted_out')");
  if (f.view === "all") where.push("l.anonymized_at IS NULL");
  if (f.category) where.push(`l.category = ${p(f.category)}`);
  if (f.q) {
    const term = p(`%${f.q}%`);
    const ref = f.q.match(/(\d+)\s*$/)?.[1];
    where.push(`(l.medicine_name ILIKE ${term} OR l.destination_country ILIKE ${term}${ref ? ` OR l.id = ${p(Number(ref))}` : ""})`);
  }
  const rows = await q(
    `SELECT l.*, u.name AS assigned_name,
       (SELECT count(*) FROM lead_messages m WHERE m.lead_id=l.id AND m.status='pending_review')::int AS pending_reviews
     FROM leads l LEFT JOIN users u ON u.id=l.assigned_to
     WHERE ${where.join(" AND ")}
     ORDER BY l.needs_review DESC, CASE l.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, l.last_activity_at DESC
     LIMIT 300`,
    params,
  );
  res.json({ leads: rows.map((r) => summarise(r, false)) });
});

leadsRouter.get("/stats", requirePerm("leads.view"), async (req, res) => {
  const s = scope(req);
  const [stats] = await q(
    `SELECT count(*) FILTER (WHERE status IN ('new','in_progress','waiting_customer'))::int AS open,
            count(*) FILTER (WHERE status='new')::int AS new,
            count(*) FILTER (WHERE needs_review AND status NOT IN ('closed','opted_out'))::int AS needs_review,
            count(*) FILTER (WHERE assigned_to IS NULL AND status IN ('new','in_progress'))::int AS unassigned,
            count(*) FILTER (WHERE follow_up_at < now() AND status IN ('new','in_progress','waiting_customer'))::int AS overdue,
            count(*) FILTER (WHERE created_at > now() - interval '7 days' AND consent_given)::int AS this_week
     FROM leads l WHERE ${s.sql}`,
    s.params,
  );
  const byCategory = await q(
    `SELECT category, count(*)::int AS n FROM leads l WHERE ${s.sql} AND status IN ('new','in_progress','waiting_customer') GROUP BY category ORDER BY n DESC`,
    s.params,
  );
  const [pending] = await q(
    `SELECT count(*)::int AS n FROM lead_messages m JOIN leads l ON l.id=m.lead_id WHERE m.status='pending_review' AND ${s.sql}`,
    s.params,
  );
  res.json({ stats: { ...stats, pending_replies: pending?.n ?? 0 }, byCategory, categories: INQUIRY_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })) });
});

leadsRouter.get("/:id", requirePerm("leads.view"), async (req, res) => {
  const id = intParam(req.params.id);
  const reveal = req.query.reveal === "1";
  const lead = await loadLead(req, id);
  const [messages, activities, consents] = await Promise.all([
    q(
      `SELECT m.*, u.name AS sender_name, r.name AS reviewer_name FROM lead_messages m
       LEFT JOIN users u ON u.id=m.sender_user_id LEFT JOIN users r ON r.id=m.reviewed_by WHERE lead_id=$1 ORDER BY m.created_at, m.id`,
      [id],
    ),
    q("SELECT a.*, u.name AS user_name FROM lead_activities a LEFT JOIN users u ON u.id=a.user_id WHERE lead_id=$1 ORDER BY created_at DESC", [id]),
    q("SELECT action, consent_version, channel, created_at FROM consent_records WHERE lead_id=$1 ORDER BY created_at", [id]),
  ]);
  if (reveal) await audit(req, "lead.contact_revealed", "lead", id);
  const window = lead.source === "messenger" ? messengerWindow(lead, true) : null;
  res.json({
    lead: { ...summarise(lead, reveal), inquiry: safeDecrypt(lead.inquiry_enc) },
    messages: messages.map(({ body_enc, ...m }) => ({ ...m, body: safeDecrypt(body_enc) })),
    activities,
    consents,
    replyWindow: window,
    aiSuggestions: aiAllowedForInquiries(),
  });
});

const updateSchema = z.object({
  status: z.enum(STATUSES).optional(),
  category: z.enum(INQUIRY_CATEGORIES).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigned_to: z.number().int().nullable().optional(),
  follow_up_at: z.string().datetime({ offset: true }).nullable().optional(),
  medicine_name: z.string().max(120).nullable().optional(),
  destination_country: z.string().max(80).nullable().optional(),
  contact_preference: z.enum(["messenger", "email", "phone", "whatsapp"]).nullable().optional(),
  needs_review: z.boolean().optional(),
});

leadsRouter.patch("/:id", requirePerm("leads.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  const b = parse(updateSchema, req.body);
  if (b.needs_review === false && !userCan(req, "leads.review")) throw forbidden("Only the pharmaceutical team can clear a review flag.");
  if (b.assigned_to !== undefined && b.assigned_to !== null && b.assigned_to !== req.user!.id && !userCan(req, "leads.view_all"))
    throw forbidden("You can only assign inquiries to yourself.");
  const changes: string[] = [];
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || JSON.stringify(v) === JSON.stringify(lead[k] instanceof Date ? (lead[k] as Date).toISOString() : lead[k])) continue;
    params.push(v);
    sets.push(`${k}=$${params.length}`);
    changes.push(k);
  }
  if (!sets.length) return void res.json({ ok: true, changed: [] });
  if (b.status === "closed") sets.push("closed_at=now()");
  if (b.needs_review === false) sets.push("review_reasons='{}'");
  await q(`UPDATE leads SET ${sets.join(", ")}, last_activity_at=now(), updated_at=now() WHERE id=$1`, params);
  for (const k of changes) {
    let note = `${k.replace(/_/g, " ")} → ${String((b as Row)[k] ?? "none")}`;
    if (k === "assigned_to") note = b.assigned_to ? `Assigned to ${(await one("SELECT name FROM users WHERE id=$1", [b.assigned_to]))?.name ?? "user"}` : "Unassigned";
    if (k === "needs_review") note = b.needs_review ? "Flagged for pharmaceutical review" : "Review completed";
    await addActivity(id, k === "assigned_to" ? "assign" : k === "needs_review" ? "review" : "update", note, req.user!.id);
  }
  await audit(req, "lead.updated", "lead", id, { changes });
  res.json({ ok: true, changed: changes });
});

leadsRouter.post("/:id/notes", requirePerm("leads.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  await loadLead(req, id);
  const { note } = parse(z.object({ note: z.string().min(1).max(2000) }), req.body);
  await addActivity(id, "note", note, req.user!.id);
  await q("UPDATE leads SET last_activity_at=now() WHERE id=$1", [id]);
  res.status(201).json({ ok: true });
});

leadsRouter.post("/:id/messages", requirePerm("leads.reply"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  const b = parse(z.object({ body: z.string().min(1).max(2000), templateId: z.number().int().nullable().optional() }), req.body);
  if (lead.anonymized_at) throw conflict("This inquiry has been anonymised.");
  if (lead.status === "opted_out") throw conflict("This person opted out of messages.");

  // Sensitive inquiries: a reply from someone outside the pharmaceutical team waits for their approval.
  if (lead.needs_review && !userCan(req, "leads.review")) {
    await q(
      `INSERT INTO lead_messages (lead_id, direction, sender_type, sender_user_id, body_enc, status, template_id) VALUES ($1,'out','agent',$2,$3,'pending_review',$4)`,
      [id, req.user!.id, encrypt(b.body), b.templateId ?? null],
    );
    await addActivity(id, "review", "Reply drafted, waiting for pharmaceutical team approval", req.user!.id);
    await audit(req, "lead.reply_queued", "lead", id);
    return void res.status(202).json({ status: "pending_review" });
  }
  const r = await deliver(lead, b.body, { senderType: "agent", userId: req.user!.id, templateId: b.templateId ?? null });
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
  const b = parse(z.object({ body: z.string().min(1).max(2000).optional() }), req.body ?? {});
  const msg = await one("SELECT * FROM lead_messages WHERE id=$1 AND lead_id=$2 AND status='pending_review'", [mid, id]);
  if (!msg) throw notFound("Pending reply");
  const text = b.body ?? safeDecrypt(msg.body_enc) ?? "";
  await q("UPDATE lead_messages SET body_enc=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$1", [mid, encrypt(text), req.user!.id]);
  const r = await deliver(lead, text, { senderType: "agent", userId: msg.sender_user_id, existingMessageId: mid });
  await addActivity(id, "review", `Reply approved${b.body ? " with edits" : ""} (${r.status})`, req.user!.id);
  await audit(req, "lead.reply_approved", "lead", id, { messageId: mid, status: r.status });
  if (r.status === "blocked" || r.status === "failed") return void res.status(409).json({ status: r.status, error: r.error });
  res.json({ status: r.status });
});

leadsRouter.post("/:id/messages/:mid/reject", requirePerm("leads.review"), async (req, res) => {
  const id = intParam(req.params.id);
  const mid = intParam(req.params.mid, "message id");
  await loadLead(req, id);
  const { reason } = parse(z.object({ reason: z.string().min(2).max(500) }), req.body);
  const r = await q("UPDATE lead_messages SET status='rejected', error=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1 AND lead_id=$2 AND status='pending_review' RETURNING id", [
    mid,
    id,
    reason,
    req.user!.id,
  ]);
  if (!r.length) throw notFound("Pending reply");
  await addActivity(id, "review", `Reply not approved: ${reason}`, req.user!.id);
  res.json({ ok: true });
});

/** AI suggests a reply built from approved templates. It's only a draft: a person edits and sends it. */
leadsRouter.post("/:id/suggest", requirePerm("leads.reply"), async (req, res) => {
  const id = intParam(req.params.id);
  const lead = await loadLead(req, id);
  if (!aiAllowedForInquiries())
    throw new HttpError(403, "AI reply suggestions are off, so inquiry text isn't sent to the cloud AI. An administrator can turn them on with AI_FOR_INQUIRIES=true in .env.");
  const templates = await q("SELECT id, name, category, body FROM response_templates WHERE status='approved' AND key IS NULL ORDER BY category, name");
  const recent = await q<{ direction: string; body_enc: string | null }>("SELECT direction, body_enc FROM lead_messages WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 6", [id]);
  const vars = templateVars(lead);
  const convo = recent
    .reverse()
    .map((m) => `${m.direction === "in" ? "Customer" : "Us"}: ${safeDecrypt(m.body_enc) ?? ""}`)
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
  await loadLead(req, id);
  res.json({ result: await reclassifyLead(id, true) });
});

/** Manual entry (phone or walk-in inquiries). The staff member confirms the person agreed. */
leadsRouter.post("/", requirePerm("leads.manage"), async (req, res) => {
  const b = parse(
    z.object({
      name: z.string().max(120).optional(),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().max(40).optional(),
      medicine_name: z.string().min(1).max(120),
      destination_country: z.string().min(1).max(80),
      contact_preference: z.enum(["email", "phone", "whatsapp"]),
      inquiry: z.string().max(3000).optional(),
      consent_confirmed: z.literal(true, { errorMap: () => ({ message: "Confirm the person agreed to us keeping their details" }) }),
    }),
    req.body,
  );
  if (!b.email && !b.phone) throw badRequest("Add an email or phone number so the team can reply.");
  const consent = await getConsent();
  const id = await tx(async (c) => {
    const row = await one(
      `INSERT INTO leads (source, name_enc, email_enc, phone_enc, inquiry_enc, medicine_name, destination_country, contact_preference, status, consent_given, consent_at, consent_version, created_at)
       VALUES ('manual',$1,$2,$3,$4,$5,$6,$7,'new',true,now(),$8, now()) RETURNING id`,
      [encrypt(b.name), encrypt(b.email?.toLowerCase()), encrypt(b.phone), encrypt(b.inquiry), b.medicine_name, b.destination_country, b.contact_preference, consent.version],
      c,
    );
    await q("INSERT INTO consent_records (lead_id, action, consent_version, channel, text_shown) VALUES ($1,'granted',$2,'staff',$3)", [row!.id, consent.version, consent.text], c);
    await addActivity(row!.id, "created", "Entered by staff (consent confirmed verbally)", req.user!.id, c);
    return row!.id as number;
  });
  const cls = await reclassifyLead(id, true);
  await autoAssign(id, !!cls?.needsReview);
  await audit(req, "lead.created", "lead", id);
  res.status(201).json({ id, ref: leadRef(id) });
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

/** Erasure request: removes personal data, keeps anonymous counts. */
leadsRouter.post("/:id/anonymize", requirePerm("leads.delete"), async (req, res) => {
  const id = intParam(req.params.id);
  await loadLead(req, id);
  const { reason } = parse(z.object({ reason: z.string().min(3).max(300) }), req.body);
  await anonymizeLead(id, `Anonymised by staff: ${reason}`, req.user!.id);
  await audit(req, "lead.anonymized", "lead", id, { reason });
  res.json({ ok: true });
});
