import crypto from "node:crypto";
import { http, PlatformError, type Connector, type Creds } from "./core.js";

// X (Twitter) API v2 with OAuth 1.0a user keys. All four keys come from the app's "Keys and tokens" page in the
// X developer portal (set the app's permissions to "Read and write" before generating the access token).
// Posting through the API needs a paid X API plan.

const API = "https://api.x.com/2";
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** OAuth 1.0a header. JSON and multipart bodies aren't part of the signature; query parameters are. */
function oauthHeader(c: Creds, method: string, url: string): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };
  const params = [...Object.entries(oauth), ...[...u.searchParams.entries()]].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const base = [method.toUpperCase(), enc(baseUrl), enc(params.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  const signature = crypto.createHmac("sha1", `${enc(c.apiSecret)}&${enc(c.accessSecret)}`).update(base).digest("base64");
  return "OAuth " + Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ");
}

const errorOf = (b: unknown) => {
  const d = b as { detail?: string; title?: string; errors?: { message?: string; detail?: string }[] };
  return d?.detail ?? d?.errors?.[0]?.message ?? d?.errors?.[0]?.detail ?? d?.title;
};

function need(c: Creds) {
  if (!c.apiKey || !c.apiSecret || !c.accessToken || !c.accessSecret) throw new PlatformError("X isn't connected. Add the four keys in Settings → Social accounts.");
}

export const twitter: Connector = {
  id: "twitter",
  label: "X (Twitter)",
  fields: [
    { key: "apiKey", label: "API key (consumer key)" },
    { key: "apiSecret", label: "API key secret", secret: true },
    { key: "accessToken", label: "Access token" },
    { key: "accessSecret", label: "Access token secret", secret: true },
  ],
  setupHelp:
    "In the X developer portal, create an app with Read and write permission, then generate the API key and the access token for the account that posts. Posting through the X API needs a paid plan.",
  configured: (c) => !!(c.apiKey && c.apiSecret && c.accessToken && c.accessSecret),
  async check(ctx) {
    need(ctx.creds);
    const url = `${API}/users/me`;
    const r = await http<{ data: { username: string } }>(url, { headers: { Authorization: oauthHeader(ctx.creds, "GET", url) }, who: "X", errorOf });
    return `@${r.data.data.username}`;
  },
  async publish(ctx, input) {
    need(ctx.creds);
    let mediaId: string | undefined;
    if (input.media) {
      if (input.media.kind === "video") throw new PlatformError("Videos on X aren't supported yet. Use an image, or no picture.");
      const form = new FormData();
      form.append("media", new Blob([new Uint8Array(await input.media.read())], { type: input.media.mime }), input.media.name);
      form.append("media_category", "tweet_image");
      const url = `${API}/media/upload`;
      // Uploading on its own doesn't post anything, so this step is safe to retry.
      const up = await http<{ data?: { id?: string }; media_id_string?: string }>(url, {
        method: "POST",
        headers: { Authorization: oauthHeader(ctx.creds, "POST", url) },
        multipart: form,
        timeoutMs: 120_000,
        who: "X",
        errorOf,
      }).catch((e) => {
        if (e instanceof PlatformError && e.uncertain) throw new PlatformError(e.message.replace(/ It may have been posted.*$/, ""), true, false, e.raw);
        throw e;
      });
      mediaId = up.data.data?.id ?? up.data.media_id_string;
      if (!mediaId) throw new PlatformError("X didn't return an id for the uploaded image.", false, false, up.data);
    }
    const url = `${API}/tweets`;
    const r = await http<{ data: { id: string } }>(url, {
      method: "POST",
      headers: { Authorization: oauthHeader(ctx.creds, "POST", url) },
      json: { text: input.text, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) },
      who: "X",
      errorOf,
    });
    return { id: r.data.data.id, url: `https://x.com/i/web/status/${r.data.data.id}`, raw: r.data };
  },
};
