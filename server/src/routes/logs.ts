import { Router } from "express";
import { z } from "zod";
import { q } from "../lib/db.js";
import { parse } from "../lib/http.js";
import { requirePerm } from "../middleware/auth.js";

export const logsRouter = Router();

logsRouter.get("/publishing", requirePerm("logs.view"), async (req, res) => {
  const f = parse(
    z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200), offset: z.coerce.number().int().min(0).default(0) }),
    req.query,
  );
  const rows = await q(
    `SELECT l.*, p.title AS post_title FROM publish_logs l LEFT JOIN posts p ON p.id=l.post_id
     WHERE ($1::text IS NULL OR l.status = ANY(string_to_array($1, ','))) ORDER BY l.created_at DESC, l.id DESC LIMIT $2 OFFSET $3`,
    [f.status || null, f.limit + 1, f.offset],
  );
  res.json({ logs: rows.slice(0, f.limit), hasMore: rows.length > f.limit, offset: f.offset });
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");

// Dates are whole days in Philippine time (the business's time zone); "to" is inclusive.
logsRouter.get("/audit", requirePerm("audit.view"), async (req, res) => {
  const f = parse(
    z.object({
      action: z.string().max(60).optional(),
      from: day.optional().or(z.literal("")),
      to: day.optional().or(z.literal("")),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    req.query,
  );
  const rows = await q(
    `SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
     WHERE ($1::text IS NULL OR a.action LIKE $1 || '%')
       AND ($2::date IS NULL OR a.created_at >= ($2::date)::timestamp AT TIME ZONE 'Asia/Manila')
       AND ($3::date IS NULL OR a.created_at < ($3::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')
     ORDER BY a.created_at DESC, a.id DESC LIMIT $4 OFFSET $5`,
    [f.action || null, f.from || null, f.to || null, f.limit + 1, f.offset],
  );
  res.json({ logs: rows.slice(0, f.limit), hasMore: rows.length > f.limit, offset: f.offset });
});
