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
  ) {
    super(message);
  }
}

// Rate limits and temporary errors are worth retrying; permission and validation errors are not.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);

const base = () => `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

function appSecretProof(token: string): string | undefined {
  if (!env.META_APP_SECRET) return undefined;
  return crypto.createHmac("sha256", env.META_APP_SECRET).update(token).digest("hex");
}

export async function graph<T = unknown>(
  path: string,
  opts: { method?: "GET" | "POST" | "DELETE"; params?: Record<string, string | number | undefined>; body?: unknown; token: string },
): Promise<T> {
  const url = new URL(`${base()}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  url.searchParams.set("access_token", opts.token);
  const proof = appSecretProof(opts.token);
  if (proof) url.searchParams.set("appsecret_proof", proof);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MetaError(`Couldn't reach Facebook: ${(err as Error).message}`, undefined, undefined, true);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { message: string; code: number; error_subcode?: number; is_transient?: boolean } };
  if (!res.ok || data.error) {
    const e = data.error;
    const transient = !!e?.is_transient || (e ? TRANSIENT_CODES.has(e.code) : res.status >= 500);
    throw new MetaError(e?.message ?? `Facebook returned HTTP ${res.status}`, e?.code, e?.error_subcode, transient, data);
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

export async function publishToPage(post: { message: string; link?: string | null; imageUrl?: string | null }): Promise<{ id: string; raw: unknown }> {
  const page = await requirePage();
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

/** Verifies X-Hub-Signature-256 against the raw request body. */
export function verifyWebhookSignature(raw: Buffer, header: string | undefined): boolean {
  if (!env.META_APP_SECRET || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", env.META_APP_SECRET).update(raw).digest("hex");
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
