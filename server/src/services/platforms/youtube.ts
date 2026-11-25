import { freshToken, http, PlatformError, type Connector, type Creds, type Ctx } from "./core.js";

// YouTube Data API v3. Sign-in with Google (OAuth) gives a refresh token, so the connection keeps working.
// Until Google verifies the app, videos uploaded through the API are locked to private.

const errorOf = (b: unknown) => {
  const d = b as { error?: { message?: string } | string; error_description?: string };
  return typeof d?.error === "object" ? d.error.message : (d?.error_description ?? (typeof d?.error === "string" ? d.error : undefined));
};

async function refresh(c: Creds) {
  const r = await http<{ access_token: string; expires_in: number }>("https://oauth2.googleapis.com/token", {
    form: { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" },
    who: "Google",
    errorOf,
  }).catch((e) => {
    // A failed refresh never posts anything, so it's fine to try again later.
    if (e instanceof PlatformError) throw new PlatformError(e.message.replace(/ It may have been posted.*$/, ""), e.transient || e.uncertain, false, e.raw);
    throw e;
  });
  return r.data;
}
const token = (ctx: Ctx) => freshToken(ctx, () => refresh(ctx.creds));

export const youtube: Connector = {
  id: "youtube",
  label: "YouTube",
  fields: [
    { key: "clientId", label: "OAuth client ID" },
    { key: "clientSecret", label: "OAuth client secret", secret: true },
    {
      key: "privacy",
      label: "New videos are",
      optional: true,
      options: [
        { value: "public", label: "Public" },
        { value: "unlisted", label: "Unlisted" },
        { value: "private", label: "Private" },
      ],
    },
  ],
  setupHelp:
    "In Google Cloud Console, turn on the YouTube Data API v3 and create an OAuth client (type: Web application) with the redirect address shown below. Save the client ID and secret, then press Connect and sign in with the channel's Google account. Until Google verifies the app, uploaded videos stay private.",
  oauth: {
    authorizeUrl(c, redirectUri, state) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      }).toString();
      return u.toString();
    },
    async exchange(c, code, redirectUri) {
      const r = await http<{ access_token: string; refresh_token?: string; expires_in: number }>("https://oauth2.googleapis.com/token", {
        form: { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" },
        who: "Google",
        errorOf,
      });
      return {
        accessToken: r.data.access_token,
        expiresAt: String(Date.now() + r.data.expires_in * 1000),
        ...(r.data.refresh_token ? { refreshToken: r.data.refresh_token } : {}),
      };
    },
  },
  configured: (c) => !!(c.clientId && c.clientSecret && c.refreshToken),
  async check(ctx) {
    const t = await token(ctx);
    const r = await http<{ items?: { snippet: { title: string } }[] }>("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${t}` },
      who: "YouTube",
      errorOf,
    });
    const ch = r.data.items?.[0];
    if (!ch) throw new PlatformError("This Google account has no YouTube channel.");
    return ch.snippet.title;
  },
  async publish(ctx, input) {
    const m = input.media;
    if (m?.kind !== "video") throw new PlatformError("YouTube needs a video.");
    const t = await token(ctx);
    const data = await m.read();
    const clean = (s: string) => s.replace(/[<>]/g, "");
    const meta = {
      snippet: {
        title: clean(input.title).slice(0, 100) || "Video",
        description: clean(input.text).slice(0, 5000),
        tags: input.hashtags.map((h) => h.replace(/^#/, "")).filter(Boolean).slice(0, 15),
        categoryId: "22",
      },
      status: { privacyStatus: ctx.creds.privacy || "public", selfDeclaredMadeForKids: false },
    };
    // Resumable upload: first ask for an upload address (nothing is posted yet), then send the file.
    const start = await http("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "X-Upload-Content-Length": String(data.length), "X-Upload-Content-Type": m.mime },
      json: meta,
      who: "YouTube",
      errorOf,
    }).catch((e) => {
      if (e instanceof PlatformError && e.uncertain) throw new PlatformError(e.message.replace(/ It may have been posted.*$/, ""), true, false, e.raw);
      throw e;
    });
    const location = start.headers.get("location");
    if (!location) throw new PlatformError("YouTube didn't give an upload address.", true);
    const r = await http<{ id: string }>(location, {
      method: "PUT",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": m.mime },
      raw: data,
      timeoutMs: 15 * 60_000,
      who: "YouTube",
      errorOf,
    });
    return { id: r.data.id, url: `https://www.youtube.com/watch?v=${r.data.id}`, raw: r.data };
  },
};
