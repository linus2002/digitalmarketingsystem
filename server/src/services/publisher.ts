import path from "node:path";
import { env } from "../config/env.js";
import { one, q, type Row } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { MetaError } from "./meta.js";
import { BOT_NAMES, notify } from "./notifications.js";
import { readMedia } from "./media.js";
import { toFacebookText } from "../lib/fbText.js";
import { captionFor, platformProblem } from "../lib/platformRules.js";
import { CONNECTORS, ctxFor, getCreds, PLATFORM_LABEL, PlatformError, publicMediaUrl, type PlatformId, type PublishMedia } from "./platforms/index.js";

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

async function logAttempt(postId: number, attempt: number, status: string, message: string, response: unknown, platform: PlatformId) {
  try {
    await q("INSERT INTO publish_logs (post_id, attempt, status, message, response, platform) VALUES ($1,$2,$3,$4,$5,$6)", [
      postId,
      attempt,
      status,
      message,
      response === undefined ? null : JSON.stringify(response),
      platform,
    ]);
  } catch (err) {
    log.error("Couldn't write publish log", { postId, error: errMsg(err) });
  }
}

/** Posts made before platforms existed (and by the bots) go to Facebook. */
export async function ensureTargets(postId: number) {
  await q("INSERT INTO post_targets (post_id, platform) SELECT $1, 'facebook' WHERE NOT EXISTS (SELECT 1 FROM post_targets WHERE post_id=$1)", [postId]);
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
const DOWNLOAD_MAX = 300 * 1024 * 1024;

/** The post's image or video, read at most once however many platforms need the bytes. */
export async function mediaFor(post: Row): Promise<PublishMedia | null> {
  let cache: Promise<Buffer> | null = null;
  const once = (load: () => Promise<Buffer>) => () => (cache ??= load());
  if (post.media_id) {
    const row = await one("SELECT * FROM media WHERE id=$1", [post.media_id]);
    if (!row) throw new PlatformError("The uploaded image or video is missing. Upload it again.");
    return {
      kind: row.kind,
      mime: row.mime,
      name: row.original_name || row.storage_name,
      uploaded: true,
      publicUrl: publicMediaUrl(row.storage_name),
      read: once(async () => (await readMedia(row.id)).data),
    };
  }
  const url: string | null = post.video_url || post.image_url || null;
  if (!url) return null;
  const pathname = new URL(url).pathname;
  const m: PublishMedia = {
    kind: post.video_url ? "video" : "image",
    mime: MIME_BY_EXT[path.extname(pathname).toLowerCase()] ?? (post.video_url ? "video/mp4" : "image/jpeg"),
    name: path.basename(pathname) || "media",
    uploaded: false,
    publicUrl: url,
    read: once(async () => {
      // Downloading never posts anything, so a failure here is safe to retry.
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000), redirect: "follow" });
      } catch (err) {
        throw new PlatformError(`Couldn't download the ${m.kind} from its link: ${(err as Error).message}`, true);
      }
      if (!res.ok) throw new PlatformError(`Couldn't download the ${m.kind} from its link (HTTP ${res.status}).`, res.status >= 500 || res.status === 429);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > DOWNLOAD_MAX) throw new PlatformError(`The ${m.kind} is too large (over 300 MB).`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > DOWNLOAD_MAX) throw new PlatformError(`The ${m.kind} is too large (over 300 MB).`);
      const type = res.headers.get("content-type")?.split(";")[0].trim();
      if (type && (type.startsWith("image/") || type.startsWith("video/"))) m.mime = type;
      return buf;
    }),
  };
  return m;
}

const classify = (err: unknown) => {
  const known = err instanceof MetaError || err instanceof PlatformError;
  return { transient: known ? err.transient && !err.uncertain : false, uncertain: known ? err.uncertain : false, raw: known ? err.raw : undefined };
};

const names = (ps: string[]) => ps.map((p) => PLATFORM_LABEL[p as PlatformId] ?? p).join(", ");

export async function publishOne(post: Row) {
  const attempt = (post.attempts as number) + 1;
  const fromBots = String(post.source_topic ?? "").startsWith("Bots:");
  await ensureTargets(post.id);
  const targets = await q<{ id: number; platform: PlatformId }>("SELECT id, platform FROM post_targets WHERE post_id=$1 AND status='pending' ORDER BY id", [post.id]);

  const baseText = toFacebookText(composeMessage(post as { message: string; hashtags: string[] }));
  const link: string | null = post.link_url ?? null;
  let media: PublishMedia | null = null;
  let mediaError: unknown = null;
  try {
    media = await mediaFor(post);
  } catch (err) {
    mediaError = err;
  }

  // 1. Each platform on its own: one failing never stops or repeats the others.
  for (const t of targets) {
    const label = PLATFORM_LABEL[t.platform];
    try {
      // Still ours? If the stale sweep (or another server) took the post, stop: never post it twice.
      // Long uploads: this also keeps the post fresh so the sweep doesn't take it.
      const still = await q("UPDATE posts SET updated_at=now() WHERE id=$1 AND status='publishing' RETURNING id", [post.id]);
      if (!still.length) {
        log.warn("Post is no longer being published by this run; stopping", { postId: post.id });
        return;
      }
      // Claim the platform only if it's still waiting, so two runs can't both post it.
      const claimed = await q("UPDATE post_targets SET status='publishing', attempts=attempts+1, updated_at=now() WHERE id=$1 AND status='pending' RETURNING id", [t.id]);
      if (!claimed.length) continue;
    } catch (err) {
      log.error("Couldn't mark a platform as publishing", { postId: post.id, platform: t.platform, error: errMsg(err) });
      continue;
    }

    let result: { id: string; url?: string | null; raw?: unknown };
    try {
      if (mediaError) throw mediaError;
      const problem = platformProblem(t.platform, { text: baseText, link, media: media && { kind: media.kind, mime: media.uploaded ? media.mime : null } });
      if (problem) throw new PlatformError(problem);
      if (env.PUBLISH_DRY_RUN) {
        result = { id: `dryrun_${t.platform}_${post.id}_${Date.now()}`, raw: { dryRun: true } };
      } else {
        const conn = CONNECTORS[t.platform];
        const creds = await getCreds(t.platform);
        if (!(await conn.configured(creds))) throw new PlatformError(`${label} isn't connected. Connect it in Settings → Social accounts, or take it off this post.`);
        result = await conn.publish(ctxFor(t.platform, creds), {
          title: post.title,
          text: captionFor(t.platform, baseText, link, !!media),
          link,
          hashtags: post.hashtags ?? [],
          media,
        });
      }
    } catch (err) {
      const { transient, uncertain, raw } = classify(err);
      const msg = errMsg(err);
      const canRetry = transient && attempt < (post.max_attempts as number);
      try {
        // "uncertain": it may be live already, so Try again leaves it alone until a person checks.
        await q("UPDATE post_targets SET status=$2, last_error=$3, uncertain=$4, updated_at=now() WHERE id=$1", [t.id, canRetry ? "pending" : "failed", msg, uncertain]);
      } catch (e) {
        log.error("Couldn't save a platform's failure", { postId: post.id, platform: t.platform, error: errMsg(e) });
      }
      const why = canRetry ? `(retrying in ${backoffMinutes(attempt)} min)` : uncertain ? "(not retried automatically)" : transient ? "(no retries left)" : "(not retryable)";
      await logAttempt(post.id, attempt, canRetry ? "retry_scheduled" : "error", `${label}: ${msg} ${why}`, raw, t.platform);
      log.warn("Publish attempt failed", { postId: post.id, platform: t.platform, attempt, transient, error: msg });
      continue;
    }

    // 2. It's live on this platform. A database error from here on must never lead to posting it again:
    // the target stays 'publishing' and the stale sweep marks it failed with "check before retrying".
    try {
      await q("UPDATE post_targets SET status='published', external_id=$2, external_url=$3, last_error=NULL, uncertain=false, published_at=now(), updated_at=now() WHERE id=$1", [
        t.id,
        result.id,
        result.url ?? null,
      ]);
      if (t.platform === "facebook") await q("UPDATE posts SET fb_post_id=$2 WHERE id=$1", [post.id, result.id]);
    } catch (err) {
      log.error("Posted but saving the result failed", { postId: post.id, platform: t.platform, id: result.id, error: errMsg(err) });
    }
    await logAttempt(post.id, attempt, env.PUBLISH_DRY_RUN ? "dry_run" : "success", env.PUBLISH_DRY_RUN ? `${label}: Test mode, not sent` : `${label}: published as ${result.id}`, result.raw, t.platform);
    log.info("Post published", { postId: post.id, platform: t.platform, id: result.id, attempt });
  }

  // 3. The post's overall status from its platforms.
  const all = await q<{ platform: string; status: string; last_error: string | null }>("SELECT platform, status, last_error FROM post_targets WHERE post_id=$1 ORDER BY id", [post.id]);
  const pending = all.filter((t) => t.status === "pending");
  const failed = all.filter((t) => t.status === "failed" || t.status === "publishing");
  const done = all.filter((t) => t.status === "published");
  const summary = [...pending, ...failed].map((t) => `${PLATFORM_LABEL[t.platform as PlatformId] ?? t.platform}: ${t.last_error ?? "interrupted"}`).join(" · ") || null;

  try {
    if (pending.length) {
      const wait = backoffMinutes(attempt);
      await q(
        `UPDATE posts SET status='scheduled', attempts=$2, last_error=$3, next_attempt_at=now() + ($4 || ' minutes')::interval, updated_at=now()
         WHERE id=$1 AND status='publishing'`,
        [post.id, attempt, summary, String(wait)],
      );
      return;
    }
    if (failed.length) {
      await q(`UPDATE posts SET status='failed', attempts=$2, last_error=$3, next_attempt_at=NULL, updated_at=now() WHERE id=$1 AND status='publishing'`, [post.id, attempt, summary]);
    } else {
      await q(
        `UPDATE posts SET status='published', published_at=now(), attempts=$2, last_error=NULL, next_attempt_at=NULL, updated_at=now() WHERE id=$1 AND status='publishing'`,
        [post.id, attempt],
      );
    }
  } catch (err) {
    log.error("Couldn't save the post's publishing result", { postId: post.id, error: errMsg(err) });
    return;
  }

  const where = names(done.map((t) => t.platform));
  if (failed.length) {
    const body = done.length
      ? `"${post.title}" went out on ${where}, but not on ${names(failed.map((t) => t.platform))}: ${summary}`
      : `"${post.title}" couldn't be published: ${summary}`;
    await notify([post.created_by, post.approved_by], {
      kind: "post.failed",
      bot: fromBots ? "posting" : null,
      level: "bad",
      title: fromBots ? BOT_NAMES.posting : done.length ? "A post partly failed" : "A post failed to publish",
      body,
      link: `/posts/${post.id}`,
    });
    await postingActivity("bad", body);
    return;
  }
  const testNote = env.PUBLISH_DRY_RUN ? " (Test mode: nothing was sent)" : "";
  await postingActivity("good", `Posted "${post.title}" on ${where}${testNote}.`);
  await notify([post.created_by, post.approved_by], {
    kind: "post.published",
    bot: fromBots ? "posting" : null,
    level: "good",
    title: fromBots ? BOT_NAMES.posting : "Post published",
    body: env.PUBLISH_DRY_RUN ? `"${post.title}" was marked published on ${where} (Test mode: nothing was sent).` : `"${post.title}" is live on ${where}.`,
    link: `/posts/${post.id}`,
  });
}

/** The Posting Bot's line in the bots' activity feed. Never throws: the post's outcome is already saved. */
async function postingActivity(level: "good" | "bad", message: string) {
  try {
    await q("INSERT INTO bot_activity (bot, level, message) VALUES ('posting',$1,$2)", [level, message.slice(0, 500)]);
  } catch (err) {
    log.warn("Couldn't write the Posting Bot's activity", { error: errMsg(err) });
  }
}

let running = false;

/** Claims due posts atomically (safe with several server instances) and publishes them. */
export async function publishDuePosts() {
  if (running) return;
  running = true;
  try {
    // A post left in 'publishing' means the server stopped mid-request. We can't know if the platform
    // received it, so it's marked failed for a person to check rather than risk a duplicate post.
    // (Long video uploads keep updated_at fresh while they run.)
    const stale = await q(
      `UPDATE posts SET status='failed', last_error='Publishing was interrupted. Check each platform before retrying, to avoid a duplicate.', uncertain=true, updated_at=now()
       WHERE status='publishing' AND updated_at < now() - interval '30 minutes' RETURNING id`,
    );
    if (stale.length)
      await q(
        `UPDATE post_targets SET status='failed', last_error='Interrupted while posting. Check this platform before retrying, to avoid a duplicate.', updated_at=now()
         WHERE status='publishing' AND post_id = ANY($1::int[])`,
        [stale.map((r) => r.id)],
      );
    const due = await q(
      `UPDATE posts SET status='publishing', updated_at=now()
       WHERE id IN (SELECT id FROM posts WHERE status='scheduled' AND approved_by IS NOT NULL AND next_attempt_at <= now()
                    ORDER BY next_attempt_at LIMIT 5 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
    );
    // Posts wait their turn in this batch: keep them all fresh so the stale sweep never takes one that is only queued.
    const ids = due.map((p) => p.id as number);
    for (const [i, post] of due.entries()) {
      await q("UPDATE posts SET updated_at=now() WHERE id = ANY($1::int[]) AND status='publishing'", [ids.slice(i)]);
      await publishOne(post);
    }
  } catch (err) {
    log.error("Publisher tick failed", { error: errMsg(err) });
  } finally {
    running = false;
  }
}

export async function nextDue() {
  return one("SELECT min(next_attempt_at) AS at FROM posts WHERE status='scheduled'");
}
