import { Router } from "express";
import { z } from "zod";
import { q } from "../lib/db.js";
import { parse } from "../lib/http.js";
import { requirePerm } from "../middleware/auth.js";

export const logsRouter = Router();

logsRouter.get("/publishing", requirePerm("logs.view"), async (req, res) => {
  const f = parse(z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
  const logs = await q(
    `SELECT l.*, p.title AS post_title FROM publish_logs l LEFT JOIN posts p ON p.id=l.post_id
     WHERE ($1::text IS NULL OR l.status = ANY(string_to_array($1, ','))) ORDER BY l.created_at DESC LIMIT $2`,
    [f.status ?? null, f.limit],
  );
  res.json({ logs });
});

logsRouter.get("/audit", requirePerm("audit.view"), async (req, res) => {
  const f = parse(z.object({ action: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
  const logs = await q(
    `SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
     WHERE ($1::text IS NULL OR a.action LIKE $1 || '%') ORDER BY a.created_at DESC LIMIT $2`,
    [f.action ?? null, f.limit],
  );
  res.json({ logs });
});
