import { env } from "../config/env.js";
import { one, q, type Row } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { MetaError, publishToPage } from "./meta.js";
import { BOT_NAMES, notify } from "./notifications.js";

/** Minutes to wait before retry n (1-based): 1, 2, 4, 8, 16 … capped at 60. */
export const backoffMinutes = (attempt: number) => Math.min(60, 2 ** Math.max(0, attempt - 1));

export function composeMessage(post: { message: string; hashtags: string[] }): string {
  const message = (post.message ?? "").trim();
  // Whole-tag match: "#GetMeds" is not already present just because the message contains "#GetMedsPH".
  const present = new Set((message.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()));
  const tags: string[] = [];
  for (const raw of post.hashtags ?? []) {
    const h = raw.trim();
    if (!h) continue;
    const tag = h.startsWith("#") ? h : `#${h}`;
    const key = tag.toLowerCase();
    if (present.has(key)) continue;
    present.add(key);
    tags.push(tag);
  }
  return tags.length ? `${message}\n\n${tags.join(" ")}` : message;
}

async function logAttempt(postId: number, attempt: number, status: string, message: string, response?: unknown) {
  await q("INSERT INTO publish_logs (post_id, attempt, status, message, response) VALUES ($1,$2,$3,$4,$5)", [
    postId,
    attempt,
    status,
    message,
    response === undefined ? null : JSON.stringify(response),
  ]);
}

export async function publishOne(post: Row) {
  const attempt = (post.attempts as number) + 1;

  // 1. Talk to Facebook. Only this step's errors decide retry vs failure.
  let fbId: string;
  let raw: unknown;
  try {
    if (env.PUBLISH_DRY_RUN) {
      fbId = `dryrun_${post.id}_${Date.now()}`;
      raw = { dryRun: true };
    } else {
      ({ id: fbId, raw } = await publishToPage({ message: composeMessage(post as { message: string; hashtags: string[] }), link: post.link_url, imageUrl: post.image_url, videoUrl: post.video_url }));
    }
  } catch (err) {
    // Unknown errors (not from the Graph client) might have happened after sending: don't retry them.
    const transient = err instanceof MetaError ? err.transient && !err.uncertain : false;
    const msg = errMsg(err);
    const canRetry = transient && attempt < (post.max_attempts as number);
    if (canRetry) {
      const wait = backoffMinutes(attempt);
      await q(
        `UPDATE posts SET status='scheduled', attempts=$2, last_error=$3, next_attempt_at=now() + ($4 || ' minutes')::interval, updated_at=now()
         WHERE id=$1 AND status='publishing'`,
        [post.id, attempt, msg, String(wait)],
      );
      await logAttempt(post.id, attempt, "retry_scheduled", `${msg} (retrying in ${wait} min)`, err instanceof MetaError ? err.raw : undefined);
    } else {
      await q(`UPDATE posts SET status='failed', attempts=$2, last_error=$3, next_attempt_at=NULL, updated_at=now() WHERE id=$1 AND status='publishing'`, [post.id, attempt, msg]);
      const why = err instanceof MetaError && err.uncertain ? "(not retried automatically)" : transient ? "(no retries left)" : "(not retryable)";
      await logAttempt(post.id, attempt, "error", `${msg} ${why}`, err instanceof MetaError ? err.raw : undefined);
      const fromBots = String(post.source_topic ?? "").startsWith("Bots:");
      await notify([post.created_by, post.approved_by], {
        kind: "post.failed",
        bot: fromBots ? "posting" : null,
        level: "bad",
        title: fromBots ? BOT_NAMES.posting : "A post failed to publish",
        body: `"${post.title}" couldn't be published: ${msg}`,
        link: `/posts/${post.id}`,
      });
    }
    log.warn("Publish attempt failed", { postId: post.id, attempt, transient, error: msg });
    return;
  }

  // 2. It's on Facebook now. A database error from here on must never lead to publishing again.
  try {
    await q(
      `UPDATE posts SET status='published', fb_post_id=$2, published_at=now(), attempts=$3, last_error=NULL, next_attempt_at=NULL, updated_at=now()
       WHERE id=$1 AND status='publishing'`,
      [post.id, fbId, attempt],
    );
  } catch (err) {
    // Leave it in 'publishing': the stale-publishing sweep marks it failed with "check the Page", never retried.
    log.error("Post was published but saving the result failed", { postId: post.id, fbId, error: errMsg(err) });
  }
  try {
    await logAttempt(post.id, attempt, env.PUBLISH_DRY_RUN ? "dry_run" : "success", env.PUBLISH_DRY_RUN ? "Test mode: not sent to Facebook" : `Published as ${fbId}`, raw);
  } catch (err) {
    log.error("Couldn't write publish log", { postId: post.id, error: errMsg(err) });
  }
  log.info("Post published", { postId: post.id, fbId, attempt });
  const fromBots = String(post.source_topic ?? "").startsWith("Bots:");
  await notify([post.created_by, post.approved_by], {
    kind: "post.published",
    bot: fromBots ? "posting" : null,
    level: "good",
    title: fromBots ? BOT_NAMES.posting : "Post published",
    body: env.PUBLISH_DRY_RUN ? `"${post.title}" was marked published (Test mode: not sent to Facebook).` : `"${post.title}" is live on your Facebook Page.`,
    link: `/posts/${post.id}`,
  });
}

let running = false;

/** Claims due posts atomically (safe with several server instances) and publishes them. */
export async function publishDuePosts() {
  if (running) return;
  running = true;
  try {
    // A post left in 'publishing' means the server stopped mid-request. We can't know if Facebook
    // received it, so it's marked failed for a person to check rather than risk a duplicate post.
    await q(
      `UPDATE posts SET status='failed', last_error='Publishing was interrupted. Check the Page before retrying, to avoid a duplicate.', updated_at=now()
       WHERE status='publishing' AND updated_at < now() - interval '10 minutes'`,
    );
    const due = await q(
      `UPDATE posts SET status='publishing', updated_at=now()
       WHERE id IN (SELECT id FROM posts WHERE status='scheduled' AND approved_by IS NOT NULL AND next_attempt_at <= now()
                    ORDER BY next_attempt_at LIMIT 5 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
    );
    for (const post of due) await publishOne(post);
  } catch (err) {
    log.error("Publisher tick failed", { error: errMsg(err) });
  } finally {
    running = false;
  }
}

export async function nextDue() {
  return one("SELECT min(next_attempt_at) AS at FROM posts WHERE status='scheduled'");
}
