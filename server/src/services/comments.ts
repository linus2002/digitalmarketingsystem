import { env } from "../config/env.js";
import { encrypt } from "../lib/crypto.js";
import { one, q, type Row } from "../lib/db.js";
import { HttpError, notFound } from "../lib/http.js";
import { errMsg, log } from "../lib/logger.js";
import { getMetaPage } from "../lib/settings.js";
import { classifyInquiry } from "./guardrails.js";
import { systemText } from "./leads.js";
import { graph, MetaError } from "./meta.js";
import { notify, usersWithPerm } from "./notifications.js";
import { getCreds } from "./platforms/core.js";

// Comments on the Facebook Page's posts and the linked Instagram account's posts, gathered in one inbox.
// Comments arrive by webhook (Page "feed", Instagram "comments") and by a regular check of recent posts, so the inbox
// also fills when the webhook isn't set up. The team can answer in public, answer privately (Meta's "private reply":
// one direct message per comment, within 7 days, which the person can answer to start the inquiry assistant),
// hide the comment, or mark it done.

export type CommentPlatform = "facebook" | "instagram";

export interface IncomingComment {
  platform: CommentPlatform;
  externalId: string;
  postId?: string | null;
  postUrl?: string | null;
  parentId?: string | null;
  authorId?: string | null;
  authorName?: string | null;
  text: string;
  at?: Date;
}

/** Questions and buying words. A hint for the team, not a decision: they see every comment. */
const INQUIRY_HINT =
  /\?|\b(price|prices|cost|how much|magkano|available|availability|in stock|stock|buy|order|ship|shipping|deliver\w*|send|dm|pm|inbox|contact|interested|need|want|where|do you (have|sell|ship)|can i (get|buy|order))\b/i;

export function looksLikeInquiry(text: string): boolean {
  const c = classifyInquiry(text);
  return INQUIRY_HINT.test(text) || c.matched.length > 0;
}

/** Our own account's id on each platform, so our own comments and replies are never put in the inbox. */
async function ownIds(): Promise<{ pageId: string; igId: string }> {
  const page = await getMetaPage();
  const ig = await getCreds("instagram").catch(() => ({}) as Record<string, string>);
  return { pageId: page.pageId ?? "", igId: ig.igUserId ?? "" };
}

/** Adds a comment (once; an edited comment updates its text). Returns true when it's new. */
export async function ingestComment(c: IncomingComment, opts: { notifyIfInquiry: boolean }): Promise<boolean> {
  const text = c.text.trim();
  if (!text) return false;
  const own = await ownIds();
  if (c.authorId && (c.authorId === own.pageId || c.authorId === own.igId)) return false;
  const cls = classifyInquiry(text);
  const inquiry = looksLikeInquiry(text);
  const at = c.at && !Number.isNaN(c.at.getTime()) ? c.at : new Date();
  const row = await one<{ id: number; inserted: boolean }>(
    `INSERT INTO social_comments (platform, external_id, post_external_id, post_url, parent_external_id, author_id, author_name_enc, body_enc,
       is_inquiry, needs_review, review_reasons, commented_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (platform, external_id) DO UPDATE SET body_enc=EXCLUDED.body_enc,
       is_inquiry = social_comments.is_inquiry OR EXCLUDED.is_inquiry,
       needs_review = social_comments.needs_review OR EXCLUDED.needs_review,
       review_reasons = ARRAY(SELECT DISTINCT unnest(social_comments.review_reasons || EXCLUDED.review_reasons)),
       post_url = COALESCE(social_comments.post_url, EXCLUDED.post_url)
     WHERE social_comments.body_enc IS DISTINCT FROM EXCLUDED.body_enc OR social_comments.post_url IS NULL
     RETURNING id, (xmax = 0) AS inserted`,
    [
      c.platform,
      c.externalId,
      c.postId ?? null,
      c.postUrl ?? null,
      c.parentId ?? null,
      c.authorId ?? null,
      c.authorName ? encrypt(c.authorName.slice(0, 200)) : null,
      encrypt(text.slice(0, 5000)),
      inquiry,
      cls.needsReview,
      cls.reviewReasons,
      at,
    ],
  );
  const isNew = !!row?.inserted;
  // Only fresh ones: the first check of old posts shouldn't flood everyone with notifications.
  if (isNew && inquiry && opts.notifyIfInquiry && Date.now() - at.getTime() < 2 * 86_400_000) {
    const who = await usersWithPerm("leads.reply");
    // No personal details in the notification: just where to look.
    await notify(who, {
      kind: "comment.inquiry",
      title: `A comment on ${c.platform === "instagram" ? "Instagram" : "Facebook"} looks like a question`,
      body: cls.needsReview ? "It mentions prescriptions, medical, regulatory or availability topics: the pharmaceutical team should answer." : "Answer it from the Comments inbox.",
      link: "/comments",
      level: cls.needsReview ? "warn" : "info",
    });
  }
  return isNew;
}

// ---------------------------------------------------------------- checking recent posts

interface FbComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id: string; name?: string };
  parent?: { id: string };
}
interface IgComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id: string; username?: string };
  replies?: { data?: IgComment[] };
}

let syncing: Promise<{ added: number; errors: string[] }> | null = null;

/** Reads the comments on the latest 25 posts on each platform. Safe to run often: known comments are skipped. */
export function syncComments(): Promise<{ added: number; errors: string[] }> {
  syncing ??= doSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function doSync() {
  const page = await getMetaPage();
  const errors: string[] = [];
  let added = 0;
  if (!page.pageId || !page.token) return { added, errors: ["No Facebook Page is connected."] };

  try {
    const r = await graph<{ data?: { id: string; permalink_url?: string; comments?: { data?: FbComment[] } }[] }>(`${page.pageId}/feed`, {
      token: page.token,
      params: { limit: 25, fields: "id,permalink_url,comments.filter(stream).order(reverse_chronological).limit(50){id,message,created_time,from,parent{id}}" },
    });
    for (const post of r.data ?? []) {
      for (const cm of post.comments?.data ?? []) {
        const isNew = await ingestComment(
          {
            platform: "facebook",
            externalId: cm.id,
            postId: post.id,
            postUrl: post.permalink_url ?? null,
            parentId: cm.parent?.id ?? null,
            authorId: cm.from?.id ?? null,
            authorName: cm.from?.name ?? null,
            text: cm.message ?? "",
            at: cm.created_time ? new Date(cm.created_time) : undefined,
          },
          { notifyIfInquiry: true },
        );
        if (isNew) added++;
      }
    }
  } catch (err) {
    errors.push(`Facebook: ${errMsg(err)}`);
  }

  const ig = await getCreds("instagram").catch(() => ({}) as Record<string, string>);
  if (ig.igUserId) {
    try {
      const token = ig.accessToken || page.token;
      const r = await graph<{ data?: { id: string; permalink?: string; comments?: { data?: IgComment[] } }[] }>(`${ig.igUserId}/media`, {
        token,
        params: { limit: 25, fields: "id,permalink,comments.limit(50){id,text,timestamp,username,from,replies{id,text,timestamp,username,from}}" },
      });
      for (const media of r.data ?? []) {
        for (const cm of media.comments?.data ?? []) {
          for (const [c, parent] of [[cm, null] as const, ...(cm.replies?.data ?? []).map((rep) => [rep, cm.id] as const)]) {
            const isNew = await ingestComment(
              {
                platform: "instagram",
                externalId: c.id,
                postId: media.id,
                postUrl: media.permalink ?? null,
                parentId: parent,
                authorId: c.from?.id ?? null,
                authorName: c.from?.username ?? c.username ?? null,
                text: c.text ?? "",
                at: c.timestamp ? new Date(c.timestamp) : undefined,
              },
              { notifyIfInquiry: true },
            );
            if (isNew) added++;
          }
        }
      }
    } catch (err) {
      errors.push(`Instagram: ${errMsg(err)}`);
    }
  }
  if (errors.length) log.warn("Comment check had problems", { errors });
  return { added, errors };
}

/** The Instagram post's address, for comments that came by webhook (which only gives the post's id). */
export async function instagramPermalink(mediaId: string): Promise<string | null> {
  try {
    const page = await getMetaPage();
    const ig = await getCreds("instagram");
    const token = ig.accessToken || page.token;
    if (!token) return null;
    return (await graph<{ permalink?: string }>(mediaId, { token, params: { fields: "permalink" } })).permalink ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- answering

export async function getComment(id: number): Promise<Row> {
  const row = await one("SELECT * FROM social_comments WHERE id=$1", [id]);
  if (!row) throw notFound("Comment");
  return row;
}

async function tokenFor(platform: CommentPlatform): Promise<{ pageId: string; token: string }> {
  const page = await getMetaPage();
  if (!page.pageId || !page.token) throw new HttpError(409, "No Facebook Page is connected. Add it in Settings → Facebook connection.");
  if (platform === "instagram") {
    const ig = await getCreds("instagram");
    return { pageId: page.pageId, token: ig.accessToken || page.token };
  }
  return { pageId: page.pageId, token: page.token };
}

/** Meta's refusal, shown to the person who pressed the button. */
const metaFail = (err: unknown) => (err instanceof MetaError ? new HttpError(502, err.message) : err instanceof Error ? err : new Error(String(err)));

const PRIVATE_REPLY_DAYS = 7;

/**
 * Sends the approved "private reply" message to the commenter's inbox. Meta allows one per comment, within 7 days.
 * When the person answers it, the inquiry assistant takes over (with the usual consent question).
 */
export async function privateReply(id: number, userId: number): Promise<{ dryRun: boolean; text: string }> {
  const c = await getComment(id);
  if (c.private_reply_at) throw new HttpError(409, "A private reply was already sent for this comment. Meta allows only one.");
  if (Date.now() - new Date(c.commented_at).getTime() > PRIVATE_REPLY_DAYS * 86_400_000)
    throw new HttpError(409, "This comment is more than 7 days old, so Meta won't allow a private reply. Answer in public instead.");
  const { text } = await systemText("comment.private_reply", null);
  if (!env.MESSENGER_DRY_RUN) {
    const { pageId, token } = await tokenFor(c.platform);
    try {
      await graph(`${pageId}/messages`, { method: "POST", token, body: { recipient: { comment_id: c.external_id }, message: { text: text.slice(0, 1000) } } });
    } catch (err) {
      await q("UPDATE social_comments SET error=$2 WHERE id=$1", [id, errMsg(err)]);
      throw metaFail(err);
    }
  }
  await q(
    "UPDATE social_comments SET private_reply_at=now(), status='replied', handled_by=$2, handled_at=now(), error=NULL WHERE id=$1",
    [id, userId],
  );
  return { dryRun: env.MESSENGER_DRY_RUN, text };
}

/** Answers under the comment, in public. */
export async function publicReply(id: number, text: string, userId: number): Promise<{ dryRun: boolean }> {
  const c = await getComment(id);
  const body = text.trim();
  if (!body) throw new HttpError(400, "Write a reply first.");
  if (!env.MESSENGER_DRY_RUN) {
    const { token } = await tokenFor(c.platform);
    try {
      // Facebook: a comment under the comment. Instagram: a reply to the comment.
      await graph(c.platform === "instagram" ? `${c.external_id}/replies` : `${c.external_id}/comments`, { method: "POST", token, body: { message: body.slice(0, 2000) } });
    } catch (err) {
      await q("UPDATE social_comments SET error=$2 WHERE id=$1", [id, errMsg(err)]);
      throw metaFail(err);
    }
  }
  await q("UPDATE social_comments SET public_reply_at=now(), status='replied', handled_by=$2, handled_at=now(), error=NULL WHERE id=$1", [id, userId]);
  return { dryRun: env.MESSENGER_DRY_RUN };
}

/** Hides the comment from everyone except the person who wrote it (and their friends, on Facebook). */
export async function hideComment(id: number, userId: number): Promise<{ dryRun: boolean }> {
  const c = await getComment(id);
  if (!env.MESSENGER_DRY_RUN) {
    const { token } = await tokenFor(c.platform);
    try {
      await graph(c.external_id, { method: "POST", token, body: c.platform === "instagram" ? { hide: true } : { is_hidden: true } });
    } catch (err) {
      await q("UPDATE social_comments SET error=$2 WHERE id=$1", [id, errMsg(err)]);
      throw metaFail(err);
    }
  }
  await q("UPDATE social_comments SET status='hidden', handled_by=$2, handled_at=now(), error=NULL WHERE id=$1", [id, userId]);
  return { dryRun: env.MESSENGER_DRY_RUN };
}

export async function setCommentStatus(id: number, status: "open" | "dismissed", userId: number) {
  await getComment(id);
  await q(
    "UPDATE social_comments SET status=$2, handled_by=CASE WHEN $2='open' THEN NULL ELSE $3 END, handled_at=CASE WHEN $2='open' THEN NULL ELSE now() END WHERE id=$1",
    [id, status, userId],
  );
}
