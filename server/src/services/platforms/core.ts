import { env } from "../../config/env.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { getSetting, setSetting } from "../../lib/settings.js";

// Shared pieces for the social platform connectors (Facebook, Instagram, X, YouTube, TikTok, LinkedIn).

export const PLATFORM_IDS = ["facebook", "instagram", "twitter", "youtube", "tiktok", "linkedin"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];
export const PLATFORM_LABEL: Record<PlatformId, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  twitter: "X (Twitter)",
  youtube: "YouTube",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
};

/** Same meaning as MetaError's flags: transient = worth retrying; uncertain = may have been posted, never repeat automatically. */
export class PlatformError extends Error {
  constructor(
    message: string,
    public transient = false,
    public uncertain = false,
    public raw?: unknown,
  ) {
    super(message);
  }
}

export interface PublishMedia {
  kind: "image" | "video";
  mime: string;
  name: string;
  /** True for a file uploaded to this system (false for an image/video link). */
  uploaded: boolean;
  /** A public https address the platform can download the file from, when there is one. */
  publicUrl: string | null;
  read(): Promise<Buffer>;
}

export interface PublishInput {
  title: string;
  /** Caption with hashtags and **bold** already applied (no link). */
  text: string;
  link: string | null;
  hashtags: string[];
  media: PublishMedia | null;
}

export interface PublishResult {
  id: string;
  url?: string | null;
  raw?: unknown;
}

export type Creds = Record<string, string>;

export interface Ctx {
  creds: Creds;
  /** Stores refreshed tokens (merged into the saved credentials). */
  save(patch: Creds): Promise<void>;
}

export interface FieldDef {
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface Connector {
  id: PlatformId;
  label: string;
  /** What an admin types in Settings. Tokens that come from "Connect" are not listed. */
  fields: FieldDef[];
  /** Where to get the keys, shown in Settings. */
  setupHelp: string;
  /** Sign-in with the platform (OAuth). The admin saves the app keys first, then presses Connect. */
  oauth?: {
    authorizeUrl(creds: Creds, redirectUri: string, state: string): string;
    exchange(creds: Creds, code: string, redirectUri: string): Promise<Creds>;
  };
  configured(creds: Creds): Promise<boolean> | boolean;
  /** Checks the connection; returns the account name to show. */
  check(ctx: Ctx): Promise<string>;
  publish(ctx: Ctx, input: PublishInput): Promise<PublishResult>;
}

// ---------------------------------------------------------------- default platforms for new posts

/** The platforms a new post starts with (set by an admin in Settings → Social accounts). Facebook if never set. */
export async function getDefaultPlatforms(): Promise<PlatformId[]> {
  const v = await getSetting<unknown>("platforms.defaults", null);
  const list = Array.isArray(v) ? PLATFORM_IDS.filter((p) => v.includes(p)) : [];
  return list.length ? list : ["facebook"];
}
export async function saveDefaultPlatforms(list: PlatformId[], userId: number) {
  await setSetting("platforms.defaults", PLATFORM_IDS.filter((p) => list.includes(p)), userId);
}

// ---------------------------------------------------------------- stored credentials (encrypted)

interface Stored {
  enc: string | null;
  account?: string;
  connectedAt?: string;
}

export async function getStored(id: PlatformId): Promise<Stored | null> {
  return getSetting<Stored | null>(`platform.${id}`, null);
}

export async function getCreds(id: PlatformId): Promise<Creds> {
  const s = await getStored(id);
  if (!s?.enc) return {};
  try {
    return JSON.parse(decrypt(s.enc) ?? "{}") as Creds;
  } catch {
    return {};
  }
}

/** Merges into what's saved. An empty string removes a value; undefined keeps it. */
export async function saveCreds(id: PlatformId, patch: Record<string, string | undefined>, userId: number | null, account?: string | null) {
  const s = await getStored(id);
  const creds = await getCreds(id);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === "") delete creds[k];
    else creds[k] = v;
  }
  await setSetting(
    `platform.${id}`,
    {
      enc: Object.keys(creds).length ? encrypt(JSON.stringify(creds)) : null,
      account: account === null ? undefined : (account ?? s?.account),
      connectedAt: account ? new Date().toISOString() : s?.connectedAt,
    },
    userId,
  );
}

export async function clearCreds(id: PlatformId, userId: number) {
  await setSetting(`platform.${id}`, { enc: null }, userId);
}

export function ctxFor(id: PlatformId, creds: Creds): Ctx {
  return {
    creds,
    async save(patch) {
      Object.assign(creds, patch);
      await saveCreds(id, patch, null);
    },
  };
}

// ---------------------------------------------------------------- addresses

const base = () => (env.PUBLIC_BASE_URL || env.CLIENT_ORIGIN).replace(/\/+$/, "");
export const redirectUri = (id: PlatformId) => `${base()}/api/oauth/${id}/callback`;
/** Public address of an uploaded file, only when PUBLIC_BASE_URL is a real https site the platforms can reach. */
export function publicMediaUrl(storageName: string): string | null {
  if (!/^https:\/\//i.test(env.PUBLIC_BASE_URL)) return null;
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/public/media/${encodeURIComponent(storageName)}`;
}

// ---------------------------------------------------------------- HTTP

const PRE_SEND_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const netCode = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string; cause?: { code?: string } } };
  return e?.cause?.code ?? e?.cause?.cause?.code ?? e?.code;
};

export interface HttpOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  multipart?: FormData;
  raw?: Buffer;
  timeoutMs?: number;
  /** Name used in error messages, e.g. "TikTok". */
  who: string;
  /** Pulls a readable message out of an error body. */
  errorOf?: (body: unknown) => string | undefined;
}

/**
 * fetch() with the same retry rules as the Facebook client: network errors before sending and 429/5xx on reads are
 * transient; a write that may have reached the platform is "uncertain" and is never repeated automatically.
 */
export async function http<T = unknown>(url: string, o: HttpOpts): Promise<{ data: T; headers: Headers; status: number }> {
  const method = o.method ?? (o.json || o.form || o.multipart || o.raw ? "POST" : "GET");
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = JSON.stringify(o.json);
  } else if (o.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(o.form).toString();
  } else if (o.multipart) body = o.multipart;
  else if (o.raw) body = new Uint8Array(o.raw);

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  } catch (err) {
    const code = netCode(err);
    if (method === "GET" || (code && PRE_SEND_CODES.has(code))) throw new PlatformError(`Couldn't reach ${o.who}: ${(err as Error).message}`, true);
    throw new PlatformError(
      `No answer from ${o.who} (${(err as Error).name === "TimeoutError" ? "timed out" : (code ?? (err as Error).message)}). It may have been posted anyway. Check ${o.who} before retrying, to avoid a duplicate.`,
      false,
      true,
    );
  }
  const text = await res.text().catch(() => "");
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = o.errorOf?.(data) ?? (typeof data === "object" && data ? JSON.stringify(data).slice(0, 300) : String(text).slice(0, 300));
    const transient = res.status === 429 || (res.status >= 500 && method === "GET");
    // A 5xx on a write doesn't say whether it went through.
    const uncertain = res.status >= 500 && method !== "GET";
    const hint = res.status === 401 ? ` Reconnect ${o.who} in Settings → Social accounts.` : "";
    throw new PlatformError(
      `${o.who} said: ${msg || `HTTP ${res.status}`}${hint}${uncertain ? ` It may have been posted anyway. Check ${o.who} before retrying.` : ""}`,
      transient,
      uncertain,
      data,
    );
  }
  return { data: data as T, headers: res.headers, status: res.status };
}

/** Refreshes an OAuth access token when it's missing or about to expire. */
export async function freshToken(
  ctx: Ctx,
  refresh: () => Promise<{ access_token: string; expires_in?: number; refresh_token?: string }>,
): Promise<string> {
  const exp = Number(ctx.creds.expiresAt ?? 0);
  if (ctx.creds.accessToken && (!exp || exp - Date.now() > 120_000)) return ctx.creds.accessToken;
  if (!ctx.creds.refreshToken) {
    if (ctx.creds.accessToken) return ctx.creds.accessToken;
    throw new PlatformError("Not connected. Press Connect in Settings → Social accounts.");
  }
  const t = await refresh();
  await ctx.save({
    accessToken: t.access_token,
    expiresAt: String(Date.now() + (t.expires_in ?? 3600) * 1000),
    ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
  });
  return t.access_token;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
