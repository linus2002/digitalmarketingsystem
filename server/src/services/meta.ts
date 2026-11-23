import crypto from "node:crypto";
import { env } from "../config/env.js";
import { getMetaPage } from "../lib/settings.js";

// Thin client for the Meta Graph API. Only uses endpoints covered by the permissions
// pages_manage_posts, pages_read_engagement, read_insights and pages_messaging.

export class MetaError extends Error {
  constructor(
    message: string,
    public code?: number,
    public subcode?: number,
    public transient = false,
    public raw?: unknown,
    /** True when the request may have reached Facebook (timeout / dropped connection after sending). */
    public uncertain = false,
  ) {
    super(message);
  }
}

// Rate limits and temporary errors are worth retrying; permission and validation errors are not.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);

// Network errors that happen before anything is sent (DNS, refused/unreachable connection, connect timeout).
// Anything else (read timeout, reset, socket closed) may happen after Facebook received the request.
const PRE_SEND_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

const GRAPH_HOST = "https://graph.facebook.com";
const VIDEO_HOST = "https://graph-video.facebook.com";

function appSecretProof(token: string): string | undefined {
  if (!env.META_APP_SECRET) return undefined;
  return crypto.createHmac("sha256", env.META_APP_SECRET).update(token).digest("hex");
}

function networkErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string; cause?: { code?: string } } };
  return e?.cause?.code ?? e?.cause?.cause?.code ?? e?.code;
}

export async function graph<T = unknown>(
  path: string,
  opts: {
    method?: "GET" | "POST" | "DELETE";
    params?: Record<string, string | number | undefined>;
    body?: unknown;
    /** Multipart form (file uploads). Takes the place of body. */
    form?: FormData;
    token: string;
    host?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const method = opts.method ?? "GET";
  const url = new URL(`${opts.host ?? GRAPH_HOST}/${env.META_GRAPH_VERSION}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  // The token goes in a header so it doesn't end up in proxy/access logs; the proof is not secret.
  const proof = appSecretProof(opts.token);
  if (proof) url.searchParams.set("appsecret_proof", proof);
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
  if (opts.body && !opts.form) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    const code = networkErrorCode(err);
    const preSend = !!code && PRE_SEND_CODES.has(code);
    // Reads are always safe to repeat. A write that may have been received must not be repeated
    // automatically, or the Page could get the same post twice.
    if (method === "GET" || preSend) {
      throw new MetaError(`Couldn't reach Facebook: ${(err as Error).message}`, undefined, undefined, true);
    }
    throw new MetaError(
      `No answer from Facebook (${(err as Error).name === "TimeoutError" ? "timed out" : (code ?? (err as Error).message)}). It may have been posted anyway. Check the Page before retrying, to avoid a duplicate.`,
      undefined,
      undefined,
      false,
      undefined,
      true,
    );
  }
  let data: { error?: { message: string; code: number; error_subcode?: number; is_transient?: boolean } };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    if (res.ok && method !== "GET") {
      throw new MetaError("Facebook's answer was cut off. It may have been posted anyway. Check the Page before retrying, to avoid a duplicate.", undefined, undefined, false, undefined, true);
    }
    data = {};
  }
  if (!res.ok || data.error) {
    const e = data.error;
    let transient = !!e?.is_transient || (e ? TRANSIENT_CODES.has(e.code) : res.status >= 500);
    let uncertain = false;
    // A bare 5xx on a write (no Graph error body) doesn't tell us whether the post was created.
    if (!e && res.status >= 500 && method !== "GET") {
      transient = false;
      uncertain = true;
    }
    let msg = e?.message ?? `Facebook returned HTTP ${res.status}`;
    // Code 190 = the access token is no longer valid (expired, password changed, access removed). Say what to do.
    if (e?.code === 190) {
      msg =
        e.error_subcode === 463
          ? "The Facebook Page token has expired. Get a new one and paste it in Settings → Facebook connection."
          : e.error_subcode === 460
            ? "The Facebook Page token stopped working because the Facebook password was changed. Get a new token and paste it in Settings → Facebook connection."
            : "The Facebook Page token isn't valid any more. Get a new one and paste it in Settings → Facebook connection.";
    }
    throw new MetaError(uncertain ? `${msg}. It may have been posted anyway. Check the Page before retrying, to avoid a duplicate.` : msg, e?.code, e?.error_subcode, transient, data, uncertain);
  }
  return data as T;
}

export async function requirePage() {
  const page = await getMetaPage();
  if (!page.pageId || !page.token) throw new MetaError("No Facebook Page is connected. Add it in Settings > Facebook connection.");
  return page;
}

export async function checkConnection() {
  const page = await requirePage();
  return graph<{ id: string; name: string; followers_count?: number; fan_count?: number; link?: string }>(page.pageId, {
    token: page.token,
    params: { fields: "id,name,followers_count,fan_count,link" },
  });
}

export interface MediaFile {
  kind: "image" | "video";
  data: Buffer;
  mime: string;
  name: string;
}

/** Looks up the Page post id of an uploaded video (analytics are keyed by it). Never throws: the video is already posted. */
async function videoPostId(pageId: string, token: string, videoId: string): Promise<string | undefined> {
  try {
    const v = await graph<{ id: string; post_id?: string }>(videoId, { token, params: { fields: "post_id" } });
    return v.post_id ? (v.post_id.includes("_") ? v.post_id : `${pageId}_${v.post_id}`) : undefined;
  } catch {
    return undefined;
  }
}

export async function publishToPage(post: {
  message: string;
  link?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  /** An uploaded file: sent to Facebook directly, so it doesn't have to be on a public website. */
  file?: MediaFile | null;
}): Promise<{ id: string; raw: unknown }> {
  const page = await requirePage();
  if (post.file) {
    const form = new FormData();
    form.append("source", new Blob([new Uint8Array(post.file.data)], { type: post.file.mime }), post.file.name);
    form.append("published", "true");
    if (post.file.kind === "image") {
      form.append("caption", post.message);
      const r = await graph<{ id: string; post_id?: string }>(`${page.pageId}/photos`, { method: "POST", token: page.token, form, timeoutMs: 120_000 });
      return { id: r.post_id ?? r.id, raw: r };
    }
    form.append("description", post.message);
    const r = await graph<{ id: string }>(`${page.pageId}/videos`, { method: "POST", token: page.token, host: VIDEO_HOST, form, timeoutMs: 300_000 });
    const postId = await videoPostId(page.pageId, page.token, r.id);
    return { id: postId ?? r.id, raw: { ...r, post_id: postId ?? null } };
  }
  if (post.videoUrl) {
    // Facebook downloads the video from this public URL itself. Uploads go to the video host.
    const r = await graph<{ id: string }>(`${page.pageId}/videos`, {
      method: "POST",
      token: page.token,
      host: VIDEO_HOST,
      timeoutMs: 120_000,
      body: { file_url: post.videoUrl, description: post.message, published: true },
    });
    // /videos returns the video id; analytics are keyed by the Page post id, so look it up.
    // The video is already posted at this point: never throw from here.
    let postId: string | undefined;
    try {
      const v = await graph<{ id: string; post_id?: string }>(r.id, { token: page.token, params: { fields: "post_id" } });
      postId = v.post_id;
    } catch {
      /* fall back to the video id */
    }
    return { id: postId ? (postId.includes("_") ? postId : `${page.pageId}_${postId}`) : r.id, raw: { ...r, post_id: postId ?? null } };
  }
  if (post.imageUrl) {
    const r = await graph<{ id: string; post_id?: string }>(`${page.pageId}/photos`, {
      method: "POST",
      token: page.token,
      body: { url: post.imageUrl, caption: post.message, published: true },
    });
    return { id: r.post_id ?? r.id, raw: r };
  }
  const r = await graph<{ id: string }>(`${page.pageId}/feed`, {
    method: "POST",
    token: page.token,
    body: { message: post.message, link: post.link || undefined },
  });
  return { id: r.id, raw: r };
}

export interface GraphPost {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
  shares?: { count: number };
  comments?: { summary?: { total_count: number } };
  reactions?: { summary?: { total_count: number } };
}

export async function listPagePosts(limit = 50): Promise<GraphPost[]> {
  const page = await requirePage();
  const r = await graph<{ data: GraphPost[] }>(`${page.pageId}/posts`, {
    token: page.token,
    params: {
      limit,
      fields: "id,message,created_time,permalink_url,shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)",
    },
  });
  return r.data ?? [];
}

interface InsightRow {
  name: string;
  period: string;
  values: { value: number | Record<string, number>; end_time?: string }[];
}

/** Requests each metric separately so one renamed/deprecated metric doesn't fail the rest. */
export async function objectInsights(
  objectId: string,
  metrics: string[],
  params: Record<string, string | number | undefined> = {},
): Promise<{ rows: InsightRow[]; errors: { metric: string; error: string }[] }> {
  const page = await requirePage();
  const rows: InsightRow[] = [];
  const errors: { metric: string; error: string }[] = [];
  for (const metric of metrics) {
    try {
      const r = await graph<{ data: InsightRow[] }>(`${objectId}/insights`, { token: page.token, params: { metric, ...params } });
      rows.push(...(r.data ?? []));
    } catch (err) {
      errors.push({ metric, error: (err as Error).message });
    }
  }
  return { rows, errors };
}

export interface SendResult {
  messageId: string | null;
  dryRun: boolean;
}

export async function sendMessengerText(
  psid: string,
  text: string,
  opts: { messagingType: "RESPONSE" | "MESSAGE_TAG"; tag?: "HUMAN_AGENT"; quickReplies?: { title: string; payload: string }[] },
): Promise<SendResult> {
  if (env.MESSENGER_DRY_RUN) return { messageId: `dry_${Date.now()}`, dryRun: true };
  const page = await requirePage();
  const r = await graph<{ message_id: string }>(`${page.pageId}/messages`, {
    method: "POST",
    token: page.token,
    body: {
      recipient: { id: psid },
      messaging_type: opts.messagingType,
      tag: opts.tag,
      message: {
        text: text.slice(0, 2000),
        quick_replies: opts.quickReplies?.map((q) => ({ content_type: "text", title: q.title.slice(0, 20), payload: q.payload })),
      },
    },
  });
  return { messageId: r.message_id ?? null, dryRun: false };
}

/** Verifies X-Hub-Signature-256 against the raw request body. Malformed headers return false. */
export function verifyWebhookSignature(raw: Buffer, header: string | undefined): boolean {
  if (!env.META_APP_SECRET || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const given = header.slice(7).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(given)) return false;
  const expected = crypto.createHmac("sha256", env.META_APP_SECRET).update(raw).digest();
  const givenBuf = Buffer.from(given, "hex");
  return givenBuf.length === expected.length && crypto.timingSafeEqual(givenBuf, expected);
}
