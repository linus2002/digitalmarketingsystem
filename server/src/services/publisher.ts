import { env } from "../config/env.js";
import { one, q, type Row } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { MetaError, publishToPage } from "./meta.js";

/** Minutes to wait before retry n (1-based): 1, 2, 4, 8, 16 … capped at 60. */
export const backoffMinutes = (attempt: number) => Math.min(60, 2 ** Math.max(0, attempt - 1));

export function composeMessage(post: { message: string; hashtags: string[] }): string {
  const tags = (post.hashtags ?? []).map((h) => (h.startsWith("#") ? h : `#${h}`)).filter((h) => !post.message.includes(h));
  return tags.length ? `${post.message.trim()}\n\n${tags.join(" ")}` : post.message.trim();
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
  try {
    let fbId: string;
    let raw: unknown;
    if (env.PUBLISH_DRY_RUN) {
      fbId = `dryrun_${post.id}_${Date.now()}`;
      raw = { dryRun: true };
    } else {
      ({ id: fbId, raw } = await publishToPage({ message: composeMessage(post as { message: string; hashtags: string[] }), link: post.link_url, imageUrl: post.image_url }));
    }
    await q(
      `UPDATE posts SET status='published', fb_post_id=$2, published_at=now(), attempts=$3, last_error=NULL, next_attempt_at=NULL, updated_at=now() WHERE id=$1`,
      [post.id, fbId, attempt],
    );
    await logAttempt(post.id, attempt, env.PUBLISH_DRY_RUN ? "dry_run" : "success", env.PUBLISH_DRY_RUN ? "Dry run: not sent to Facebook" : `Published as ${fbId}`, raw);
    log.info("Post published", { postId: post.id, fbId, attempt });
  } catch (err) {
    const transient = err instanceof MetaError ? err.transient : true;
    const msg = errMsg(err);
    const canRetry = transient && attempt < (post.max_attempts as number);
    if (canRetry) {
      const wait = backoffMinutes(attempt);
      await q(
        `UPDATE posts SET status='scheduled', attempts=$2, last_error=$3, next_attempt_at=now() + ($4 || ' minutes')::interval, updated_at=now() WHERE id=$1`,
        [post.id, attempt, msg, String(wait)],
      );
      await logAttempt(post.id, attempt, "retry_scheduled", `${msg} (retrying in ${wait} min)`, err instanceof MetaError ? err.raw : undefined);
    } else {
      await q(`UPDATE posts SET status='failed', attempts=$2, last_error=$3, next_attempt_at=NULL, updated_at=now() WHERE id=$1`, [post.id, attempt, msg]);
      await logAttempt(post.id, attempt, "error", transient ? `${msg} (no retries left)` : `${msg} (not retryable)`, err instanceof MetaError ? err.raw : undefined);
    }
    log.warn("Publish attempt failed", { postId: post.id, attempt, transient, error: msg });
  }
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
