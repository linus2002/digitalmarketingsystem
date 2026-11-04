import { Router } from "express";
import { z } from "zod";
import { q } from "../lib/db.js";
import { parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { requirePerm } from "../middleware/auth.js";

export const reportsRouter = Router();

const range = z.object({
  from: z.string().date().default(() => new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)),
  to: z.string().date().default(() => new Date(Date.now() + 86400_000).toISOString().slice(0, 10)),
});

async function campaignRows(from: string, to: string) {
  return q(
    `SELECT c.id, c.name, c.status, c.start_date, c.end_date,
       count(p.id) FILTER (WHERE p.status='published')::int AS published,
       count(p.id) FILTER (WHERE p.status='failed')::int AS failed,
       COALESCE(sum(f.reach),0)::int AS reach, COALESCE(sum(f.impressions),0)::int AS impressions,
       COALESCE(sum(f.reactions),0)::int AS reactions, COALESCE(sum(f.comments),0)::int AS comments,
       COALESCE(sum(f.shares),0)::int AS shares, COALESCE(sum(f.clicks),0)::int AS clicks
     FROM campaigns c
     LEFT JOIN posts p ON p.campaign_id=c.id AND p.published_at >= $1 AND p.published_at < $2
     LEFT JOIN fb_page_posts f ON f.fb_post_id=p.fb_post_id
     GROUP BY c.id ORDER BY reach DESC, c.name`,
    [from, to],
  );
}

reportsRouter.get("/summary", requirePerm("reports.view"), async (req, res) => {
  const { from, to } = parse(range, req.query);
  const [totals] = await q(
    `SELECT count(*) FILTER (WHERE p.status='published')::int AS published,
            count(*) FILTER (WHERE p.status='failed')::int AS failed,
            COALESCE(sum(f.reach),0)::int AS reach, COALESCE(sum(f.impressions),0)::int AS impressions,
            COALESCE(sum(f.reactions + f.comments + f.shares),0)::int AS engagement, COALESCE(sum(f.shares),0)::int AS shares,
            COALESCE(sum(f.comments),0)::int AS comments
     FROM posts p LEFT JOIN fb_page_posts f ON f.fb_post_id=p.fb_post_id
     WHERE COALESCE(p.published_at, p.updated_at) >= $1 AND COALESCE(p.published_at, p.updated_at) < $2`,
    [from, to],
  );
  const [attempts] = await q(
    `SELECT count(*) FILTER (WHERE status IN ('success','dry_run'))::int AS ok, count(*) FILTER (WHERE status='retry_scheduled')::int AS retried,
            count(*) FILTER (WHERE status='error')::int AS errors
     FROM publish_logs WHERE created_at >= $1 AND created_at < $2`,
    [from, to],
  );
  const weekly = await q(
    `SELECT to_char(date_trunc('week', p.published_at), 'YYYY-MM-DD') AS week, count(*)::int AS posts,
            COALESCE(sum(f.reach),0)::int AS reach, COALESCE(sum(f.reactions + f.comments + f.shares),0)::int AS engagement
     FROM posts p LEFT JOIN fb_page_posts f ON f.fb_post_id=p.fb_post_id
     WHERE p.status='published' AND p.published_at >= $1 AND p.published_at < $2 GROUP BY 1 ORDER BY 1`,
    [from, to],
  );
  const leads = await q(
    `SELECT source, count(*)::int AS n, count(*) FILTER (WHERE needs_review)::int AS reviewed FROM leads WHERE created_at >= $1 AND created_at < $2 AND consent_given GROUP BY source`,
    [from, to],
  );
  res.json({ from, to, totals, attempts, weekly, campaigns: await campaignRows(from, to), leads });
});

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Guard against spreadsheet formula injection
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

reportsRouter.get("/campaigns.csv", requirePerm("reports.view"), async (req, res) => {
  const { from, to } = parse(range, req.query);
  const rows = await campaignRows(from, to);
  const cols = ["name", "status", "start_date", "end_date", "published", "failed", "reach", "impressions", "reactions", "comments", "shares", "clicks"];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c] instanceof Date ? (r[c] as Date).toISOString().slice(0, 10) : r[c])).join(","))].join("\r\n");
  await audit(req, "report.exported", "campaigns", null, { from, to });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="campaigns_${from}_${to}.csv"`);
  res.send(`﻿${csv}`);
});
