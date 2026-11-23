import { createHash } from "node:crypto";
import { Router } from "express";
import { env } from "../config/env.js";
import { errMsg, log } from "../lib/logger.js";
import { getMetaPage } from "../lib/settings.js";
import { verifyWebhookSignature } from "../services/meta.js";
import { handleInbound, type InboundEvent } from "../services/bot.js";

// Messenger webhook. Mounted with express.raw() so the signature can be checked against the exact bytes.
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

  let body: { object?: string; entry?: { id?: string; messaging?: MessagingEvent[] }[] };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (body.object !== "page") return;
  void (async () => {
    const page = await getMetaPage();
    if (!page.pageId && !env.MESSENGER_DRY_RUN) {
      log.warn("Ignored Messenger webhook: no Facebook Page is connected");
      return;
    }
    const events: InboundEvent[] = [];
    for (const entry of body.entry ?? []) {
      // Only events for our own Page (the app may be subscribed to others).
      if (page.pageId && entry.id !== page.pageId) {
        log.warn("Ignored webhook entry for another Page", { entryId: entry.id });
        continue;
      }
      for (const ev of entry.messaging ?? []) {
        if (!ev.sender?.id || ev.message?.is_echo) continue;
        if (page.pageId && ev.recipient?.id && ev.recipient.id !== page.pageId) continue;
        const text = ev.message?.text ?? ev.postback?.title ?? "";
        const payload = ev.message?.quick_reply?.payload ?? ev.postback?.payload ?? null;
        if (!text && !payload && !ev.message?.attachments) continue;
        events.push({ psid: ev.sender.id, mid: eventId(ev, ev.sender.id), text, payload, timestamp: ev.timestamp ?? Date.now() });
      }
    }
    // In order: handleInbound also queues per person, so one person's messages are never handled in parallel.
    events.sort((a, b) => a.timestamp - b.timestamp);
    for (const e of events) await handleInbound(e);
  })().catch((err) => log.error("Messenger webhook processing failed", { error: errMsg(err) }));
});
