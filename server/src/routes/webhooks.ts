import { Router } from "express";
import { env } from "../config/env.js";
import { log } from "../lib/logger.js";
import { verifyWebhookSignature } from "../services/meta.js";
import { handleInbound } from "../services/bot.js";

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

metaWebhookRouter.post("/", (req, res) => {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, req.header("x-hub-signature-256"))) {
    log.warn("Rejected webhook with a bad or missing signature");
    res.sendStatus(401);
    return;
  }
  // Answer quickly; Meta retries if we take too long.
  res.sendStatus(200);

  let body: { object?: string; entry?: { messaging?: MessagingEvent[] }[] };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (body.object !== "page") return;
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      if (!ev.sender?.id || ev.message?.is_echo) continue;
      const text = ev.message?.text ?? ev.postback?.title ?? "";
      const payload = ev.message?.quick_reply?.payload ?? ev.postback?.payload ?? null;
      if (!text && !payload && !ev.message?.attachments) continue;
      void handleInbound({ psid: ev.sender.id, mid: ev.message?.mid ?? ev.postback?.mid ?? null, text, payload, timestamp: ev.timestamp ?? Date.now() });
    }
  }
});
