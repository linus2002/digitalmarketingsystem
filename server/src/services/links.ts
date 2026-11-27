import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { one, q, type Row } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { getSetting } from "../lib/settings.js";
import type { PlatformId } from "./platforms/index.js";

// Tracked links: when a post is published, each web address in it becomes a short link on this system
// (https://<PUBLIC_BASE_URL>/r/<code>) that adds UTM tags and counts the click before sending the person on.
// One short link per post, platform and address, so the same post gets the same links when a publish is retried.

export interface TrackingSettings {
  /** Replace links in published posts with tracked short links. */
  enabled: boolean;
  /** Add utm_source / utm_medium / utm_campaign / utm_content to the address people land on. */
  utm: boolean;
}
export const DEFAULT_TRACKING: TrackingSettings = { enabled: true, utm: true };
export const getTracking = () => getSetting<TrackingSettings>("tracking.links", DEFAULT_TRACKING);

// Links in these captions can't be clicked, so there's nothing to track.
const UNCLICKABLE: PlatformId[] = ["instagram", "tiktok"];

/**
 * Where short links live: PUBLIC_BASE_URL when it's a real https site people can open. In Test mode the app's own
 * address is used, so the links can be tried from this computer. Otherwise null: links are published as they are.
 */
export function trackingBase(): string | null {
  if (/^https:\/\//i.test(env.PUBLIC_BASE_URL)) return env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (env.PUBLISH_DRY_RUN) return (env.PUBLIC_BASE_URL || env.CLIENT_ORIGIN).replace(/\/+$/, "");
  return null;
}
/** Why links aren't tracked right now (shown in Settings), or null when they are. */
export function trackingProblem(): string | null {
  if (trackingBase()) return null;
  return "Set PUBLIC_BASE_URL in .env to this system's https address. Short links must open from anywhere on the internet.";
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 60);

/** The original address with UTM tags added (tags already in the address are kept as they are). */
export function withUtm(url: string, tags: { source: string; campaign: string; content: string }): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const set = (k: string, v: string) => {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  };
  set("utm_source", tags.source);
  set("utm_medium", "social");
  set("utm_campaign", tags.campaign);
  set("utm_content", tags.content);
  return u.toString();
}

const CODE_CHARS = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode(len = 7) {
  const bytes = randomBytes(len);
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

/** The short link for this post, platform and address, made the first time it's needed. */
async function shortLink(base: string, url: string, post: Row, platform: PlatformId, campaignName: string | null, utm: boolean): Promise<string> {
  const existing = await one<{ code: string }>("SELECT code FROM short_links WHERE post_id=$1 AND platform=$2 AND original_url=$3", [post.id, platform, url]);
  if (existing) return `${base}/r/${existing.code}`;
  const target = utm
    ? withUtm(url, { source: platform, campaign: campaignName ? slug(campaignName) || `campaign-${post.campaign_id}` : "always-on", content: `post-${post.id}` })
    : url;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const row = await one<{ code: string }>(
      `INSERT INTO short_links (code, original_url, target_url, post_id, campaign_id, platform) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING RETURNING code`,
      [code, url, target, post.id, post.campaign_id ?? null, platform],
    );
    if (row) return `${base}/r/${row.code}`;
    // A clash: either the code was taken (try another) or another run made this link a moment ago (use it).
    const made = await one<{ code: string }>("SELECT code FROM short_links WHERE post_id=$1 AND platform=$2 AND original_url=$3", [post.id, platform, url]);
    if (made) return `${base}/r/${made.code}`;
  }
  throw new Error("Couldn't make a unique short link code.");
}

// Web addresses in a caption. A trailing full stop, comma or bracket is punctuation, not part of the address.
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const trimUrl = (u: string) => u.replace(/[.,;:!?)\]}]+$/, "");

/**
 * The caption and link with every web address swapped for its tracked short link. Never throws: if tracking is off
 * or anything goes wrong, the post goes out with its original links (a missing click count beats a failed post).
 */
export async function trackLinks(post: Row, platform: PlatformId, text: string, link: string | null): Promise<{ text: string; link: string | null }> {
  try {
    const base = trackingBase();
    if (!base || UNCLICKABLE.includes(platform)) return { text, link };
    const settings = await getTracking();
    if (!settings.enabled) return { text, link };
    const campaign = post.campaign_id ? ((await one<{ name: string }>("SELECT name FROM campaigns WHERE id=$1", [post.campaign_id]))?.name ?? null) : null;
    const skip = (u: string) => u.startsWith(`${base}/r/`) || u.startsWith(`${base}/api/public/media/`);
    const cache = new Map<string, string>();
    const short = async (u: string) => {
      if (skip(u)) return u;
      if (!cache.has(u)) cache.set(u, await shortLink(base, u, post, platform, campaign, settings.utm));
      return cache.get(u)!;
    };
    let out = "";
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      const url = trimUrl(m[0]);
      out += text.slice(last, m.index) + (await short(url));
      last = m.index! + url.length;
    }
    out += text.slice(last);
    return { text: out, link: link ? await short(link) : null };
  } catch (err) {
    log.warn("Couldn't make tracked links; publishing the original links", { postId: post.id, platform, error: errMsg(err) });
    return { text, link };
  }
}

/** The post's tracked links with their clicks, for the post page. */
export async function linksForPost(postId: number) {
  const base = trackingBase() ?? (env.PUBLIC_BASE_URL || env.CLIENT_ORIGIN).replace(/\/+$/, "");
  const rows = await q<{ code: string; platform: string; original_url: string; clicks: number; visitors: number; inquiries: number; last_click: string | null }>(
    `SELECT l.code, l.platform, l.original_url,
            count(c.id)::int AS clicks, count(DISTINCT c.visitor)::int AS visitors, max(c.clicked_at) AS last_click,
            (SELECT count(*)::int FROM leads ld WHERE ld.link_id = l.id) AS inquiries
     FROM short_links l LEFT JOIN link_clicks c ON c.link_id = l.id
     WHERE l.post_id = $1 GROUP BY l.id ORDER BY l.platform, l.id`,
    [postId],
  );
  return rows.map((r) => ({ ...r, short_url: `${base}/r/${r.code}` }));
}

// ---------------------------------------------------------------- clicks

// Link-preview robots and scripts open links too; they're not people.
const BOT_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|embedly|preview|whatsapp|telegram|discord|slack|skype|vkshare|pinterest|curl|wget|python|java\/|okhttp|go-http|axios|node-fetch|headless|lighthouse|monitor/i;
export const isBot = (ua: string | undefined) => !ua || BOT_UA.test(ua);
export const deviceOf = (ua: string) => (/ipad|tablet/i.test(ua) ? "tablet" : /mobi|android|iphone/i.test(ua) ? "mobile" : "desktop");
