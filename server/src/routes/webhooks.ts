import { createHash } from "node:crypto";
import { Router } from "express";
import { env } from "../config/env.js";
import { errMsg, log } from "../lib/logger.js";
import { getMetaPage } from "../lib/settings.js";
import { verifyWebhookSignature } from "../services/meta.js";
import { handleInbound, type ChatChannel, type InboundEvent } from "../services/bot.js";
import { ingestComment, instagramPermalink } from "../services/comments.js";
import { getCreds } from "../services/platforms/core.js";

// Meta webhook: Messenger and Instagram direct messages, and comments on the Page's and Instagram account's posts.
// Mounted with express.raw() so the signature can be checked against the exact bytes.
export const metaWebhookRouter = Router();

metaWebhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && env.META_VERIFY_TOKEN && token === env.META_VERIFY_TOKEN) {
    res.status(200).type("text/plain").send(String(challenge ?? ""));
    return;
  }
  res.sendStatus(403);
});

interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; quick_reply?: { payload: string }; attachments?: unknown[] };
  postback?: { mid?: string; title?: string; payload?: string };
}

/**
 * Postbacks don't always carry a message id. Meta retries a webhook delivery with the same sender, timestamp and
 * payload, so a hash of those gives a stable id that deduplicates retries.
 */
function eventId(ev: MessagingEvent, psid: string): string | null {
  const mid = ev.message?.mid ?? ev.postback?.mid;
  if (mid) return mid;
  if (!ev.postback) return null;
  const h = createHash("sha256")
    .update(`${psid}|${ev.timestamp ?? ""}|${ev.postback.payload ?? ""}|${ev.postback.title ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  return `pb_${h}`;
}

metaWebhookRouter.post("/", (req, res) => {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, req.header("x-hub-signature-256"))) {
    log.warn("Rejected webhook with a bad or missing signature");
    res.sendStatus(401);
    return;
  }
  // Answer quickly; Meta retries if we take too long.
  res.sendStatus(200);

  let body: { object?: string; entry?: { id?: string; messaging?: MessagingEvent[]; changes?: Change[] }[] };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  // "page": Messenger and Page comments. "instagram": Instagram direct messages and comments (the linked account).
  if (body.object !== "page" && body.object !== "instagram") return;
  const channel: ChatChannel = body.object === "instagram" ? "instagram" : "messenger";
  void (async () => {
    const page = await getMetaPage();
    if (!page.pageId && !env.MESSENGER_DRY_RUN) {
      log.warn("Ignored webhook: no Facebook Page is connected");
      return;
    }
    // Only events for our own Page or Instagram account (the app may be subscribed to others).
    const ownId = channel === "instagram" ? ((await getCreds("instagram")).igUserId ?? "") : page.pageId;
    const events: InboundEvent[] = [];
    for (const entry of body.entry ?? []) {
      if (ownId && entry.id !== ownId) {
        log.warn("Ignored webhook entry for another account", { object: body.object, entryId: entry.id });
        continue;
      }
      if (!ownId && channel === "instagram") {
        log.warn("Ignored Instagram webhook: no Instagram account is connected (Settings → Social accounts)");
        continue;
      }
      for (const ev of entry.messaging ?? []) {
        if (!ev.sender?.id || ev.message?.is_echo) continue;
        if (ownId && ev.recipient?.id && ev.recipient.id !== ownId) continue;
        if (ev.sender.id === ownId) continue;
        const text = ev.message?.text ?? ev.postback?.title ?? "";
        const payload = ev.message?.quick_reply?.payload ?? ev.postback?.payload ?? null;
        if (!text && !payload && !ev.message?.attachments) continue;
        events.push({ channel, psid: ev.sender.id, mid: eventId(ev, ev.sender.id), text, payload, timestamp: ev.timestamp ?? Date.now() });
      }
      for (const ch of entry.changes ?? []) {
        await handleCommentChange(channel, ch).catch((err) => log.error("Couldn't save a comment from the webhook", { object: body.object, error: errMsg(err) }));
      }
    }
    // In order: handleInbound also queues per person, so one person's messages are never handled in parallel.
    events.sort((a, b) => a.timestamp - b.timestamp);
    for (const e of events) await handleInbound(e);
  })().catch((err) => log.error("Webhook processing failed", { object: body.object, error: errMsg(err) }));
});

interface Change {
  field?: string;
  value?: {
    // Facebook Page "feed"
    item?: string;
    verb?: string;
    comment_id?: string;
    post_id?: string;
    parent_id?: string;
    message?: string;
    created_time?: number | string;
    from?: { id?: string; name?: string; username?: string };
    // Instagram "comments"
    id?: string;
    text?: string;
    media?: { id?: string };
  };
}

/** A new or edited comment on one of our posts: into the comments inbox. Likes, shares and removals are ignored. */
async function handleCommentChange(channel: ChatChannel, ch: Change) {
  const v = ch.value;
  if (!v) return;
  if (channel === "messenger" && ch.field === "feed" && v.item === "comment" && (v.verb === "add" || v.verb === "edited") && v.comment_id) {
    const t = typeof v.created_time === "number" ? new Date(v.created_time * 1000) : v.created_time ? new Date(v.created_time) : undefined;
    // The parent is the post itself for a top-level comment.
    const parent = v.parent_id && v.parent_id !== v.post_id ? v.parent_id : null;
    await ingestComment(
      {
        platform: "facebook",
        externalId: v.comment_id,
        postId: v.post_id ?? null,
        postUrl: v.post_id ? `https://www.facebook.com/${v.post_id}` : null,
        parentId: parent,
        authorId: v.from?.id ?? null,
        authorName: v.from?.name ?? null,
        text: v.message ?? "",
        at: t,
      },
      { notifyIfInquiry: true },
    );
  } else if (channel === "instagram" && ch.field === "comments" && v.id) {
    await ingestComment(
      {
        platform: "instagram",
        externalId: v.id,
        postId: v.media?.id ?? null,
        postUrl: v.media?.id ? await instagramPermalink(v.media.id) : null,
        parentId: v.parent_id ?? null,
        authorId: v.from?.id ?? null,
        authorName: v.from?.username ?? null,
        text: v.text ?? "",
      },
      { notifyIfInquiry: true },
    );
  }
}
