import { Router } from "express";
import { z } from "zod";
import { q } from "../lib/db.js";
import { parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { getMetaPage, getSetting } from "../lib/settings.js";
import { requirePerm } from "../middleware/auth.js";
import { syncAnalytics } from "../services/analyticsSync.js";
import { checkConnection } from "../services/meta.js";

export const analyticsRouter = Router();

// Several names per figure: Meta has renamed metrics across API versions, so we take the first one present.
const SERIES = {
  reach: ["page_total_media_view_unique", "page_impressions_unique"],
  impressions: ["page_media_view", "page_impressions"],
  engagement: ["page_post_engagements"],
  follows: ["page_follows", "page_daily_follows_unique"],
  views: ["page_views_total"],
};

analyticsRouter.get("/overview", requirePerm("analytics.view"), async (req, res) => {
  const { days } = parse(z.object({ days: z.coerce.number().int().min(7).max(90).default(28) }), req.query);
  const page = await getMetaPage();
  const lastSync = await getSetting("meta.lastSync", null);

  // Meta's daily end_time is the END of the day (midnight Pacific time, e.g. 08:00 UTC the next day),
  // so the day a value belongs to is the Pacific date just before end_time.
  const rows = await q<{ metric: string; day: string; value: number }>(
    `SELECT metric, to_char((end_time - interval '1 second') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS day, value FROM page_metrics
     WHERE period='day' AND end_time >= now() - ($1 || ' days')::interval ORDER BY end_time`,
    [String(days)],
  );
  const byMetric = new Map<string, { day: string; value: number }[]>();
  for (const r of rows) byMetric.set(r.metric, [...(byMetric.get(r.metric) ?? []), { day: r.day, value: r.value }]);

  const series: Record<string, { metric: string; points: { day: string; value: number }[]; total: number } | null> = {};
  for (const [key, names] of Object.entries(SERIES)) {
    const metric = names.find((n) => byMetric.has(n));
    const points = metric ? byMetric.get(metric)! : [];
    series[key] = metric ? { metric, points, total: points.reduce((s, p) => s + p.value, 0) } : null;
  }

  const postTotals = (
    await q(
      `SELECT count(*)::int AS posts, COALESCE(sum(reactions),0)::int AS reactions, COALESCE(sum(comments),0)::int AS comments,
              COALESCE(sum(shares),0)::int AS shares, COALESCE(sum(impressions),0)::int AS impressions, COALESCE(sum(reach),0)::int AS reach,
              COALESCE(sum(clicks),0)::int AS clicks
       FROM fb_page_posts WHERE created_time >= now() - ($1 || ' days')::interval`,
      [String(days)],
    )
  )[0];

  const topPosts = await q(
    `SELECT f.*, (f.reactions + f.comments + f.shares + COALESCE(f.clicks,0)) AS engagement,
            CASE WHEN COALESCE(f.reach,0) > 0 THEN round(100.0 * (f.reactions + f.comments + f.shares) / f.reach, 2) END AS engagement_rate,
            p.id AS post_id, p.title AS post_title, c.name AS campaign_name
     FROM fb_page_posts f LEFT JOIN posts p ON p.fb_post_id = f.fb_post_id LEFT JOIN campaigns c ON c.id = p.campaign_id
     WHERE f.created_time >= now() - ($1 || ' days')::interval
     ORDER BY engagement DESC LIMIT 10`,
    [String(days)],
  );

  res.json({ connected: page.source !== "none", pageId: page.pageId, pageName: page.pageName, lastSync, days, series, postTotals, topPosts });
});

analyticsRouter.get("/posts", requirePerm("analytics.view"), async (_req, res) => {
  const posts = await q(
    `SELECT f.*, (f.reactions + f.comments + f.shares + COALESCE(f.clicks,0)) AS engagement, p.id AS post_id, p.title AS post_title
     FROM fb_page_posts f LEFT JOIN posts p ON p.fb_post_id = f.fb_post_id ORDER BY f.created_time DESC LIMIT 100`,
  );
  res.json({ posts });
});

analyticsRouter.post("/sync", requirePerm("analytics.sync"), async (req, res) => {
  const result = await syncAnalytics();
  await audit(req, "analytics.synced", undefined, undefined, { ok: result.ok });
  res.json({ result });
});

analyticsRouter.get("/connection", requirePerm("analytics.view"), async (_req, res) => {
  const page = await getMetaPage();
  if (page.source === "none") return void res.json({ connected: false, reason: "No Page connected yet." });
  try {
    const info = await checkConnection();
    res.json({ connected: true, source: page.source, page: info });
  } catch (err) {
    res.json({ connected: false, source: page.source, reason: (err as Error).message });
  }
});
