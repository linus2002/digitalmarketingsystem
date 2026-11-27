import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { hmac } from "../lib/crypto.js";
import { one, q } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { deviceOf, isBot, trackingBase } from "../services/links.js";

// Tracked short links (/r/<code>): counts the click, then sends the person to the original address with its UTM tags.
// Public, no sign-in. Only an unguessable code is accepted, and the destination is always one stored by this system.
export const redirectRouter = Router();

// Generous: a popular post can send many people at once, but one address hammering a link isn't counted forever.
const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

/** Hosts of this system: links to its own inquiry form carry the code, so an inquiry can be traced to the post. */
const ownHosts = () =>
  new Set(
    [env.PUBLIC_BASE_URL, env.CLIENT_ORIGIN, trackingBase() ?? ""]
      .map((u) => {
        try {
          return new URL(u).host;
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );

redirectRouter.get("/:code", limiter, async (req, res) => {
  const code = String(req.params.code ?? "");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
  const link = /^[A-Za-z0-9]{5,12}$/.test(code) ? await one<{ id: number; target_url: string }>("SELECT id, target_url FROM short_links WHERE code=$1", [code]) : null;
  if (!link) {
    res.status(404).type("html").send('<!doctype html><meta charset="utf-8"><title>Link not found</title><p style="font-family:system-ui;padding:24px">This link doesn\'t exist or has expired.</p>');
    return;
  }
  let target = link.target_url;
  try {
    const u = new URL(target);
    if (ownHosts().has(u.host) && u.pathname.startsWith("/inquire")) {
      u.searchParams.set("ref", code);
      target = u.toString();
    }
  } catch {
    /* stored addresses are checked when the post is saved; send it as it is */
  }
  const ua = String(req.headers["user-agent"] ?? "");
  if (!isBot(ua)) {
    const day = new Date().toISOString().slice(0, 10);
    let referrer: string | null = null;
    try {
      referrer = req.headers.referer ? new URL(String(req.headers.referer)).host.slice(0, 120) : null;
    } catch {
      referrer = null;
    }
    // Counting never delays or blocks the redirect.
    void q("INSERT INTO link_clicks (link_id, visitor, device, referrer_host) VALUES ($1,$2,$3,$4)", [link.id, hmac(`${req.ip}|${ua}|${day}`), deviceOf(ua), referrer]).catch((err) =>
      log.warn("Couldn't count a link click", { error: errMsg(err) }),
    );
  }
  res.redirect(302, target);
});
