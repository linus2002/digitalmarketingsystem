import { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "../lib/db.js";
import { conflict, forbidden, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { requirePerm } from "../middleware/auth.js";
import { CATEGORY_LABELS, INQUIRY_CATEGORIES } from "../services/guardrails.js";

export const templatesRouter = Router();

templatesRouter.get("/", requirePerm("templates.view"), async (req, res) => {
  const all = req.query.all === "1";
  const rows = await q(
    `SELECT t.*, cu.name AS created_by_name, au.name AS approved_by_name, eu.name AS updated_by_name FROM response_templates t
     LEFT JOIN users cu ON cu.id=t.created_by LEFT JOIN users au ON au.id=t.approved_by LEFT JOIN users eu ON eu.id=t.updated_by
     ${all ? "" : "WHERE t.status <> 'retired'"} ORDER BY (t.key IS NOT NULL), t.category, t.name`,
  );
  res.json({ templates: rows, categories: INQUIRY_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })) });
});

const body = z.object({ name: z.string().trim().min(1).max(120), category: z.enum(INQUIRY_CATEGORIES), body: z.string().trim().min(1).max(2000) });

templatesRouter.post("/", requirePerm("templates.manage"), async (req, res) => {
  const b = parse(body, req.body);
  const t = await one("INSERT INTO response_templates (name, category, body, status, created_by, updated_by) VALUES ($1,$2,$3,'draft',$4,$4) RETURNING *", [
    b.name,
    b.category,
    b.body,
    req.user!.id,
  ]);
  await audit(req, "template.created", "template", t!.id);
  res.status(201).json({ template: t });
});

/** A wording change returns the template to draft: only approved wording is ever sent. Renaming doesn't. */
templatesRouter.patch("/:id", requirePerm("templates.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(body.partial(), req.body);
  const before = await one("SELECT body, status FROM response_templates WHERE id=$1", [id]);
  if (!before) throw notFound("Template");
  if (before.status === "retired") throw conflict("This template is retired. Create a new one instead.");
  const bodyChanged = b.body !== undefined && b.body !== before.body;
  const t = await one(
    `UPDATE response_templates SET name=COALESCE($2,name), category=CASE WHEN key IS NULL THEN COALESCE($3,category) ELSE category END,
       body=COALESCE($4,body),
       -- keep the wording that was approved, so the assistant can go on using it until the edit is approved
       approved_body=CASE WHEN $5 AND status='approved' THEN body ELSE approved_body END,
       status=CASE WHEN $5 THEN 'draft' ELSE status END,
       approved_by=CASE WHEN $5 THEN NULL ELSE approved_by END,
       approved_at=CASE WHEN $5 THEN NULL ELSE approved_at END,
       updated_by=CASE WHEN $5 THEN $6 ELSE updated_by END,
       updated_at=now()
     WHERE id=$1 RETURNING *`,
    [id, b.name ?? null, b.category ?? null, b.body ?? null, bodyChanged, req.user!.id],
  );
  await audit(req, "template.updated", "template", id, { bodyChanged });
  res.json({ template: t, needsApproval: bodyChanged });
});

templatesRouter.post("/:id/approve", requirePerm("templates.approve"), async (req, res) => {
  const id = intParam(req.params.id);
  const current = await one("SELECT status, updated_by, created_by FROM response_templates WHERE id=$1", [id]);
  if (!current) throw notFound("Template");
  if (current.status === "retired") throw conflict("This template is retired, so it can't be approved.");
  if (current.status !== "draft") throw conflict("This template is already approved.");
  // Four eyes: whoever wrote the wording can't approve it.
  if ((current.updated_by ?? current.created_by) === req.user!.id) throw forbidden("You edited this wording, so someone else on the pharmaceutical team needs to approve it.");
  const t = await tx(async (c) => {
    const row = await one(
      `UPDATE response_templates SET status='approved', approved_by=$2, approved_at=now(), approved_body=body, updated_at=now()
       WHERE id=$1 AND status='draft' RETURNING *`,
      [id, req.user!.id],
      c,
    );
    if (!row) throw conflict("This template changed while you were approving it. Reload and try again.");
    await q("INSERT INTO response_template_versions (template_id, body, edited_by, approved_by) VALUES ($1,$2,$3,$4)", [id, row.body, row.updated_by ?? row.created_by, req.user!.id], c);
    return row;
  });
  await audit(req, "template.approved", "template", id);
  res.json({ template: t });
});

templatesRouter.post("/:id/retire", requirePerm("templates.approve"), async (req, res) => {
  const id = intParam(req.params.id);
  const t = await one("SELECT key FROM response_templates WHERE id=$1", [id]);
  if (!t) throw notFound("Template");
  if (t.key) throw conflict("The assistant needs this template. Edit it instead.");
  await q("UPDATE response_templates SET status='retired', updated_at=now() WHERE id=$1", [id]);
  await audit(req, "template.retired", "template", id);
  res.json({ ok: true });
});
