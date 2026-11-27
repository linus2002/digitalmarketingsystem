import { Router } from "express";
import { z } from "zod";
import { one, q } from "../lib/db.js";
import { badRequest, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { errMsg, log } from "../lib/logger.js";
import { requirePerm } from "../middleware/auth.js";
import { aiRateLimit } from "../middleware/aiLimit.js";
import { createDigest, lastWeekStart, mondayOf, writingWeeks } from "../services/digest.js";
import { trackingProblem } from "../services/links.js";

export const reportsRouter = Router();

// ---------------------------------------------------------------- weekly digest

reportsRouter.get("/digests", requirePerm("reports.view"), async (_req, res) => {
  const rows = await q(
    "SELECT id, week_start, week_end, summary->>'headline' AS headline, written_by, created_at, updated_at FROM digests ORDER BY week_start DESC LIMIT 52",
  );
  res.json({ digests: rows, writing: writingWeeks(), lastWeek: lastWeekStart() });
});

reportsRouter.get("/digests/:id", requirePerm("reports.view"), async (req, res) => {
  const row = await one("SELECT * FROM digests WHERE id=$1", [intParam(req.params.id)]);
  if (!row) throw notFound("Digest");
  res.json({ digest: row, writing: writingWeeks() });
});

/** Writes (or rewrites) a week's digest in the background: a local AI model can take a few minutes. */
// Writing replaces what the team was notified about and uses the AI: managers only (the same people who can
// refresh analytics), a few times an hour, and only for the last year.
reportsRouter.post("/digests", requirePerm("analytics.sync"), aiRateLimit(6, 60), async (req, res) => {
  const { week } = parse(z.object({ week: z.string().date().optional() }), req.body ?? {});
  const start = mondayOf(week ?? lastWeekStart());
  if (start > lastWeekStart()) throw badRequest("That week isn't over yet. Digests cover full weeks, Monday to Sunday.");
  const yearAgo = new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10);
  if (start < yearAgo) throw badRequest("Digests can be written for the last 12 months.");
  if (writingWeeks().includes(start)) return void res.status(202).json({ week: start, started: false });
  void createDigest(start, req.user!.id, { notifyTeam: false }).catch((err) => log.error("Weekly digest failed", { week: start, error: errMsg(err) }));
  await audit(req, "report.digest_written", "digest", start);
  res.status(202).json({ week: start, started: true });
});

// Dates are Philippine calendar days; "to" is inclusive (the whole day).
const PH_MS = 8 * 3_600_000;
const phDay = (offsetDays = 0) => new Date(Date.now() + PH_MS + offsetDays * 86400_000).toISOString().slice(0, 10);
const optDate = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().date().optional());
const rangeSchema = z.object({ from: optDate, to: optDate });

function parseRange(query: unknown): { from: string; to: string } {
  const r = parse(rangeSchema, query);
  const to = r.to ?? phDay();
  const from = r.from ?? phDay(-30);
  if (from > to) throw badRequest("from: The start date can't be after the end date.");
  return { from, to };
}

// SQL fragments: $1 = from date, $2 = to date (inclusive), both Philippine days.
const START = `(($1::date)::timestamp AT TIME ZONE 'Asia/Manila')`;
const END = `((($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Manila')`;

async function campaignRows(from: string, to: string) {
  return q(
    `SELECT c.id, c.name, c.status, c.start_date, c.end_date,
       count(p.id) FILTER (WHERE p.status='published')::int AS published,
       count(p.id) FILTER (WHERE p.status='failed')::int AS failed,
       COALESCE(sum(f.reach),0)::int AS reach, COALESCE(sum(f.impressions),0)::int AS impressions,
       COALESCE(sum(f.reactions),0)::int AS reactions, COALESCE(sum(f.comments),0)::int AS comments,
       COALESCE(sum(f.shares),0)::int AS shares, COALESCE(sum(f.clicks),0)::int AS clicks,
       (SELECT count(*)::int FROM link_clicks lc JOIN short_links sl ON sl.id=lc.link_id
        WHERE sl.campaign_id=c.id AND lc.clicked_at >= ${START} AND lc.clicked_at < ${END}) AS link_clicks,
       (SELECT count(*)::int FROM leads ld JOIN short_links sl ON sl.id=ld.link_id
        WHERE sl.campaign_id=c.id AND ld.created_at >= ${START} AND ld.created_at < ${END} AND ld.consent_given) AS inquiries
     FROM campaigns c
     LEFT JOIN posts p ON p.campaign_id=c.id AND p.published_at >= ${START} AND p.published_at < ${END}
     LEFT JOIN fb_page_posts f ON f.fb_post_id=p.fb_post_id
     GROUP BY c.id ORDER BY reach DESC, c.name`,
    [from, to],
  );
}

reportsRouter.get("/summary", requirePerm("reports.view"), async (req, res) => {
  const { from, to } = parseRange(req.query);
  const [totals] = await q(
    `SELECT count(*) FILTER (WHERE p.status='published')::int AS published,
            count(*) FILTER (WHERE p.status='failed')::int AS failed,
            COALESCE(sum(f.reach),0)::int AS reach, COALESCE(sum(f.impressions),0)::int AS impressions,
            COALESCE(sum(f.reactions + f.comments + f.shares),0)::int AS engagement, COALESCE(sum(f.shares),0)::int AS shares,
            COALESCE(sum(f.comments),0)::int AS comments
     FROM posts p LEFT JOIN fb_page_posts f ON f.fb_post_id=p.fb_post_id
     WHERE COALESCE(p.published_at, p.updated_at) >= ${START} AND COALESCE(p.published_at, p.updated_at) < ${END}`,
    [from, to],
  );
  const [attempts] = await q(
    `SELECT count(*) FILTER (WHERE status IN ('success','dry_run'))::int AS ok, count(*) FILTER (WHERE status='retry_scheduled')::int AS retried,
            count(*) FILTER (WHERE status='error')::int AS errors
     FROM publish_logs WHERE created_at >= ${START} AND created_at < ${END}`,
    [from, to],
  );
  const weekly = await q(
    `SELECT to_char(date_trunc('week', p.published_at AT TIME ZONE 'Asia/Manila'), 'YYYY-MM-DD') AS week, count(*)::int AS posts,
            COALESCE(sum(f.reach),0)::int AS reach, COALESCE(sum(f.reactions + f.comments + f.shares),0)::int AS engagement
     FROM posts p LEFT JOIN fb_page_posts f ON f.fb_post_id=p.fb_post_id
     WHERE p.status='published' AND p.published_at >= ${START} AND p.published_at < ${END} GROUP BY 1 ORDER BY 1`,
    [from, to],
  );
  const leads = await q(
    `SELECT source, count(*)::int AS n, count(*) FILTER (WHERE needs_review)::int AS reviewed FROM leads WHERE created_at >= ${START} AND created_at < ${END} AND consent_given GROUP BY source`,
    [from, to],
  );
  res.json({ from, to, totals, attempts, weekly, campaigns: await campaignRows(from, to), leads });
});

/** Clicks on the tracked links in published posts, and the website inquiries they led to. */
reportsRouter.get("/links", requirePerm("reports.view"), async (req, res) => {
  const { from, to } = parseRange(req.query);
  const IN_RANGE = `c.clicked_at >= ${START} AND c.clicked_at < ${END}`;
  const [[totals], [leads], platforms, daily, posts] = await Promise.all([
    q(`SELECT count(*)::int AS clicks, count(DISTINCT c.visitor)::int AS visitors, count(DISTINCT c.link_id)::int AS links FROM link_clicks c WHERE ${IN_RANGE}`, [from, to]),
    q(`SELECT count(*)::int AS n FROM leads WHERE link_id IS NOT NULL AND consent_given AND created_at >= ${START} AND created_at < ${END}`, [from, to]),
    q(
      `SELECT l.platform, count(*)::int AS clicks, count(DISTINCT c.visitor)::int AS visitors
       FROM link_clicks c JOIN short_links l ON l.id=c.link_id WHERE ${IN_RANGE} GROUP BY l.platform ORDER BY clicks DESC`,
      [from, to],
    ),
    q(
      `SELECT to_char(c.clicked_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS day, count(*)::int AS clicks
       FROM link_clicks c WHERE ${IN_RANGE} GROUP BY 1 ORDER BY 1`,
      [from, to],
    ),
    q(
      `SELECT p.id, p.title, p.published_at, cp.name AS campaign_name, f.reach,
              count(c.id)::int AS clicks, count(DISTINCT c.visitor)::int AS visitors,
              (SELECT count(*)::int FROM leads ld JOIN short_links s2 ON s2.id=ld.link_id
               WHERE s2.post_id=p.id AND ld.consent_given AND ld.created_at >= ${START} AND ld.created_at < ${END}) AS inquiries
       FROM link_clicks c JOIN short_links l ON l.id=c.link_id JOIN posts p ON p.id=l.post_id
       LEFT JOIN campaigns cp ON cp.id=p.campaign_id LEFT JOIN fb_page_posts f ON f.fb_post_id=p.fb_post_id
       WHERE ${IN_RANGE} GROUP BY p.id, cp.name, f.reach ORDER BY clicks DESC LIMIT 15`,
      [from, to],
    ),
  ]);
  res.json({ from, to, totals: { ...totals, inquiries: leads.n }, platforms, daily, posts, trackingProblem: trackingProblem() });
});

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Guard against spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

reportsRouter.get("/campaigns.csv", requirePerm("reports.view"), async (req, res) => {
  const { from, to } = parseRange(req.query);
  const rows = await campaignRows(from, to);
  const cols = ["name", "status", "start_date", "end_date", "published", "failed", "reach", "impressions", "reactions", "comments", "shares", "clicks", "link_clicks", "inquiries"];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c] instanceof Date ? (r[c] as Date).toISOString().slice(0, 10) : r[c])).join(","))].join("\r\n");
  await audit(req, "report.exported", "campaigns", null, { from, to });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="campaigns_${from}_${to}.csv"`);
  res.send(`﻿${csv}`);
});
