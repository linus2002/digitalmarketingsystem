import { env } from "../config/env.js";
import { errMsg, log } from "../lib/logger.js";
import { getMetaPage, getSetting } from "../lib/settings.js";
import { syncAnalytics } from "./analyticsSync.js";
import { publishDuePosts } from "./publisher.js";
import { reviewTeamPosts } from "./teamReview.js";
import { runRetention } from "./retention.js";
import { warmUp } from "./ai.js";
import { syncComments } from "./comments.js";
import { maybeWeeklyDigest } from "./digest.js";
import { isRefreshing, isSummarising, refreshTrends } from "./trends.js";
import { one, q } from "../lib/db.js";

const timers: NodeJS.Timeout[] = [];
// One-off startup runs, kept so stopJobs can cancel them if the app shuts down early.
const startupTimers: NodeJS.Timeout[] = [];
const later = (fn: () => unknown, ms: number) => {
  const t = setTimeout(() => {
    const i = startupTimers.indexOf(t);
    if (i >= 0) startupTimers.splice(i, 1);
    fn();
  }, ms);
  startupTimers.push(t);
};

async function maybeSyncAnalytics() {
  if (!env.ANALYTICS_SYNC_HOURS) return;
  const page = await getMetaPage();
  if (!page.token) return;
  const last = await getSetting<{ at?: string } | null>("meta.lastSync", null);
  if (last?.at && Date.now() - new Date(last.at).getTime() < env.ANALYTICS_SYNC_HOURS * 3_600_000) return;
  await syncAnalytics();
}

/**
 * A reply left in "sending" means the server stopped while it was being sent. It goes back to the review queue with a
 * note, so a person checks Messenger (it may have arrived) before sending it again; it's never re-sent on its own.
 */
async function releaseStuckReplies() {
  const rows = await q(
    `UPDATE lead_messages SET status='pending_review', reviewed_by=NULL, reviewed_at=NULL,
       error='Sending was interrupted. Check the conversation in Messenger before sending it again; it may have arrived.'
     WHERE status='sending' AND reviewed_at < now() - interval '5 minutes' RETURNING id`,
  );
  if (rows.length) log.warn("Replies stuck in sending were returned to the review queue", { count: rows.length });
}

/** New comments on recent posts, every 10 minutes (also catches what the webhook missed, or all of it without one). */
async function maybeSyncComments() {
  const page = await getMetaPage();
  if (!page.pageId || !page.token) return;
  await syncComments();
}

async function maybeRunRetention() {
  const last = await getSetting<{ at?: string } | null>("retention.lastRun", null);
  if (last?.at && Date.now() - new Date(last.at).getTime() < 24 * 3_600_000) return;
  await runRetention();
}

async function maybeRefreshTrends() {
  if (!env.TRENDS_AUTO_REFRESH_MINUTES || isSummarising() || isRefreshing()) return;
  const last = await one<{ created_at: Date }>("SELECT created_at FROM trend_snapshots ORDER BY created_at DESC LIMIT 1");
  if (last && Date.now() - new Date(last.created_at).getTime() < env.TRENDS_AUTO_REFRESH_MINUTES * 60_000) return;
  await refreshTrends(null, { useAi: true });
  // Automatic scans add up: keep 30 days of history.
  await q("DELETE FROM trend_snapshots WHERE created_at < now() - interval '30 days'");
}

export function startJobs() {
  if (!env.SCHEDULER_ENABLED) {
    log.info("Background jobs are off (SCHEDULER_ENABLED=false)");
    return;
  }
  const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch((err) => log.error(`${name} failed`, { error: errMsg(err) }));
  timers.push(setInterval(safe("publisher", publishDuePosts), env.SCHEDULER_INTERVAL_SECONDS * 1000));
  // The Editor and Checker Bots look at new or changed team posts.
  timers.push(setInterval(safe("team post checks", reviewTeamPosts), 15_000));
  timers.push(setInterval(safe("analytics", maybeSyncAnalytics), 15 * 60_000));
  timers.push(setInterval(safe("retention", maybeRunRetention), 60 * 60_000));
  timers.push(setInterval(safe("weekly digest", maybeWeeklyDigest), 15 * 60_000));
  later(safe("weekly digest", maybeWeeklyDigest), 60_000);
  later(safe("publisher", publishDuePosts), 3000);
  later(safe("retention", maybeRunRetention), 20_000);
  timers.push(setInterval(safe("comments", maybeSyncComments), 10 * 60_000));
  later(safe("comments", maybeSyncComments), 40_000);
  timers.push(setInterval(safe("stuck replies", releaseStuckReplies), 5 * 60_000));
  later(safe("stuck replies", releaseStuckReplies), 25_000);
  later(safe("team post checks", reviewTeamPosts), 8000);
  if (env.TRENDS_AUTO_REFRESH_MINUTES) {
    timers.push(setInterval(safe("trends", maybeRefreshTrends), 60_000));
    later(safe("trends", maybeRefreshTrends), 30_000);
  }
  // Load the local AI model in the background so the first generation doesn't wait for it.
  later(safe("ai warm-up", warmUp), 5_000);
  log.info("Background jobs started", { publishEverySeconds: env.SCHEDULER_INTERVAL_SECONDS, dryRun: env.PUBLISH_DRY_RUN, trendsEveryMinutes: env.TRENDS_AUTO_REFRESH_MINUTES });
}

export function stopJobs() {
  timers.forEach(clearInterval);
  timers.length = 0;
  startupTimers.forEach(clearTimeout);
  startupTimers.length = 0;
}
