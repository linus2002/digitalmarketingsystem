import { Router } from "express";
import { z } from "zod";
import { one, q } from "../lib/db.js";
import { conflict, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { requirePerm } from "../middleware/auth.js";

export const templatesRouter = Router();

templatesRouter.get("/", requirePerm("templates.view"), async (req, res) => {
  const all = req.query.all === "1";
  const rows = await q(
    `SELECT t.*, cu.name AS created_by_name, au.name AS approved_by_name FROM response_templates t
     LEFT JOIN users cu ON cu.id=t.created_by LEFT JOIN users au ON au.id=t.approved_by
     ${all ? "" : "WHERE t.status <> 'retired'"} ORDER BY (t.key IS NOT NULL), t.category, t.name`,
  );
  res.json({ templates: rows });
});

const body = z.object({ name: z.string().min(1).max(120), category: z.string().min(1).max(60), body: z.string().min(1).max(2000) });

templatesRouter.post("/", requirePerm("templates.manage"), async (req, res) => {
  const b = parse(body, req.body);
  const t = await one("INSERT INTO response_templates (name, category, body, status, created_by) VALUES ($1,$2,$3,'draft',$4) RETURNING *", [b.name, b.category, b.body, req.user!.id]);
  await audit(req, "template.created", "template", t!.id);
  res.status(201).json({ template: t });
});

/** Any edit returns the template to draft: only approved wording is ever sent. */
templatesRouter.patch("/:id", requirePerm("templates.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(body.partial(), req.body);
  const t = await one(
    `UPDATE response_templates SET name=COALESCE($2,name), category=CASE WHEN key IS NULL THEN COALESCE($3,category) ELSE category END,
       body=COALESCE($4,body), status=CASE WHEN $4 IS NOT NULL AND $4 <> body THEN 'draft' ELSE status END,
       approved_by=CASE WHEN $4 IS NOT NULL AND $4 <> body THEN NULL ELSE approved_by END,
       approved_at=CASE WHEN $4 IS NOT NULL AND $4 <> body THEN NULL ELSE approved_at END, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [id, b.name ?? null, b.category ?? null, b.body ?? null],
  );
  if (!t) throw notFound("Template");
  await audit(req, "template.updated", "template", id);
  res.json({ template: t });
});

templatesRouter.post("/:id/approve", requirePerm("templates.approve"), async (req, res) => {
  const id = intParam(req.params.id);
  const t = await one("UPDATE response_templates SET status='approved', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [id, req.user!.id]);
  if (!t) throw notFound("Template");
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
