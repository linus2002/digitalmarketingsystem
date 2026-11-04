import { env } from "../config/env.js";
import { errMsg, log } from "../lib/logger.js";
import { getMetaPage, getSetting } from "../lib/settings.js";
import { syncAnalytics } from "./analyticsSync.js";
import { publishDuePosts } from "./publisher.js";
import { runRetention } from "./retention.js";
import { warmUp } from "./ai.js";

const timers: NodeJS.Timeout[] = [];

async function maybeSyncAnalytics() {
  if (!env.ANALYTICS_SYNC_HOURS) return;
  const page = await getMetaPage();
  if (!page.token) return;
  const last = await getSetting<{ at?: string } | null>("meta.lastSync", null);
  if (last?.at && Date.now() - new Date(last.at).getTime() < env.ANALYTICS_SYNC_HOURS * 3_600_000) return;
  await syncAnalytics();
}

async function maybeRunRetention() {
  const last = await getSetting<{ at?: string } | null>("retention.lastRun", null);
  if (last?.at && Date.now() - new Date(last.at).getTime() < 24 * 3_600_000) return;
  await runRetention();
}

export function startJobs() {
  if (!env.SCHEDULER_ENABLED) {
    log.info("Background jobs are off (SCHEDULER_ENABLED=false)");
    return;
  }
  const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch((err) => log.error(`${name} failed`, { error: errMsg(err) }));
  timers.push(setInterval(safe("publisher", publishDuePosts), env.SCHEDULER_INTERVAL_SECONDS * 1000));
  timers.push(setInterval(safe("analytics", maybeSyncAnalytics), 15 * 60_000));
  timers.push(setInterval(safe("retention", maybeRunRetention), 60 * 60_000));
  setTimeout(safe("publisher", publishDuePosts), 3000);
  setTimeout(safe("retention", maybeRunRetention), 20_000);
  // Load the local AI model in the background so the first generation doesn't wait for it.
  setTimeout(safe("ai warm-up", warmUp), 5_000);
  log.info("Background jobs started", { publishEverySeconds: env.SCHEDULER_INTERVAL_SECONDS, dryRun: env.PUBLISH_DRY_RUN });
}

export function stopJobs() {
  timers.forEach(clearInterval);
}
