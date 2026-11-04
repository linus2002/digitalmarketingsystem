import { env } from "../config/env.js";
import { q } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { getMetaPage, setSetting } from "../lib/settings.js";
import { listPagePosts, objectInsights } from "./meta.js";

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Pulls recent Page posts, their insights and daily Page metrics into the database. */
export async function syncAnalytics(days = 28) {
  const started = new Date();
  const metricErrors = new Map<string, string>();
  let postsSynced = 0;
  let pointsSaved = 0;

  try {
    const posts = await listPagePosts(50);
    for (const p of posts) {
      const ins = await objectInsights(p.id, env.META_POST_METRICS, { period: "lifetime" });
      ins.errors.forEach((e) => metricErrors.set(`post:${e.metric}`, e.error));
      const values: Record<string, number> = {};
      for (const row of ins.rows) {
        const v = row.values?.[0]?.value;
        if (typeof v === "number") values[row.name] = v;
      }
      const impressions = num(values.post_media_view) ?? num(values.post_impressions);
      const reach = num(values.post_total_media_view_unique) ?? num(values.post_impressions_unique);
      await q(
        `INSERT INTO fb_page_posts (fb_post_id, message, permalink_url, created_time, reactions, comments, shares, impressions, reach, clicks, insights, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (fb_post_id) DO UPDATE SET message = EXCLUDED.message, permalink_url = EXCLUDED.permalink_url,
           reactions = EXCLUDED.reactions, comments = EXCLUDED.comments, shares = EXCLUDED.shares,
           impressions = COALESCE(EXCLUDED.impressions, fb_page_posts.impressions), reach = COALESCE(EXCLUDED.reach, fb_page_posts.reach),
           clicks = COALESCE(EXCLUDED.clicks, fb_page_posts.clicks), insights = EXCLUDED.insights, updated_at = now()`,
        [
          p.id,
          p.message ?? null,
          p.permalink_url ?? null,
          p.created_time,
          p.reactions?.summary?.total_count ?? 0,
          p.comments?.summary?.total_count ?? 0,
          p.shares?.count ?? 0,
          impressions,
          reach,
          num(values.post_clicks),
          JSON.stringify(values),
        ],
      );
      postsSynced++;
    }

    const page = await getMetaPage();
    const until = Math.floor(Date.now() / 1000);
    const since = until - days * 86400;
    const ins = await objectInsights(page.pageId, env.META_PAGE_METRICS, { period: "day", since, until });
    ins.errors.forEach((e) => metricErrors.set(`page:${e.metric}`, e.error));
    for (const row of ins.rows) {
      for (const v of row.values ?? []) {
        if (typeof v.value !== "number" || !v.end_time) continue;
        await q(
          `INSERT INTO page_metrics (metric, period, end_time, value) VALUES ($1,$2,$3,$4)
           ON CONFLICT (metric, period, end_time) DO UPDATE SET value = EXCLUDED.value, captured_at = now()`,
          [row.name, row.period, v.end_time, v.value],
        );
        pointsSaved++;
      }
    }

    const status = {
      ok: true,
      at: started.toISOString(),
      postsSynced,
      pointsSaved,
      skippedMetrics: [...metricErrors.entries()].map(([metric, error]) => ({ metric, error })),
    };
    await setSetting("meta.lastSync", status, null);
    return status;
  } catch (err) {
    const status = { ok: false, at: started.toISOString(), postsSynced, pointsSaved, error: errMsg(err), skippedMetrics: [] };
    await setSetting("meta.lastSync", status, null);
    log.warn("Analytics sync failed", { error: errMsg(err) });
    return status;
  }
}
