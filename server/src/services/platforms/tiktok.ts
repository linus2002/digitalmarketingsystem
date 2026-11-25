import { freshToken, http, PlatformError, sleep, type Connector, type Creds, type Ctx } from "./core.js";

// TikTok Content Posting API (direct post). Sign-in with TikTok (OAuth) gives the tokens.
// Until TikTok audits the app, posts can only be private ("Only me").

const API = "https://open.tiktokapis.com/v2";
const errorOf = (b: unknown) => {
  const d = b as { error?: { code?: string; message?: string } | string; error_description?: string };
  return typeof d?.error === "object" ? d.error.message || d.error.code : (d?.error_description ?? (typeof d?.error === "string" ? d.error : undefined));
};

/** TikTok answers 200 with error.code != "ok" for many failures. */
function ok<T extends { error?: { code?: string; message?: string } }>(d: T, what: string): T {
  if (d.error && d.error.code && d.error.code !== "ok") {
    const transient = d.error.code === "rate_limit_exceeded";
    throw new PlatformError(`TikTok couldn't ${what}: ${d.error.message || d.error.code}`, transient, false, d);
  }
  return d;
}

async function refresh(c: Creds) {
  const r = await http<{ access_token: string; expires_in: number; refresh_token?: string; error?: string; error_description?: string }>(`${API}/oauth/token/`, {
    form: { client_key: c.clientKey, client_secret: c.clientSecret, grant_type: "refresh_token", refresh_token: c.refreshToken },
    who: "TikTok",
    errorOf,
  });
  if (!r.data.access_token) throw new PlatformError(`TikTok sign-in expired: ${r.data.error_description ?? r.data.error ?? "reconnect in Settings → Social accounts"}`);
  return r.data;
}
const token = (ctx: Ctx) => freshToken(ctx, () => refresh(ctx.creds));
const auth = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json; charset=UTF-8" });

export const tiktok: Connector = {
  id: "tiktok",
  label: "TikTok",
  fields: [
    { key: "clientKey", label: "Client key" },
    { key: "clientSecret", label: "Client secret", secret: true },
    {
      key: "privacy",
      label: "Who can see new videos",
      optional: true,
      options: [
        { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
        { value: "FOLLOWER_OF_CREATOR", label: "Followers" },
        { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
        { value: "SELF_ONLY", label: "Only me" },
      ],
    },
  ],
  setupHelp:
    "In the TikTok for Developers portal, create an app with Login Kit and the Content Posting API (Direct Post), scopes user.info.basic, video.upload and video.publish, and add the redirect address shown below. Save the client key and secret, then press Connect. Until TikTok audits the app, videos are posted as private (Only me).",
  oauth: {
    authorizeUrl(c, redirectUri, state) {
      const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
      u.search = new URLSearchParams({ client_key: c.clientKey, scope: "user.info.basic,video.upload,video.publish", response_type: "code", redirect_uri: redirectUri, state }).toString();
      return u.toString();
    },
    async exchange(c, code, redirectUri) {
      const r = await http<{ access_token?: string; refresh_token?: string; expires_in?: number; open_id?: string; error_description?: string }>(`${API}/oauth/token/`, {
        form: { client_key: c.clientKey, client_secret: c.clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri },
        who: "TikTok",
        errorOf,
      });
      if (!r.data.access_token) throw new PlatformError(`TikTok sign-in failed: ${r.data.error_description ?? "no token returned"}`);
      return {
        accessToken: r.data.access_token,
        refreshToken: r.data.refresh_token ?? "",
        expiresAt: String(Date.now() + (r.data.expires_in ?? 86_400) * 1000),
        openId: r.data.open_id ?? "",
      };
    },
  },
  configured: (c) => !!(c.clientKey && c.clientSecret && c.accessToken),
  async check(ctx) {
    const t = await token(ctx);
    const r = await http<{ data?: { user?: { display_name?: string } }; error?: { code?: string; message?: string } }>(`${API}/user/info/?fields=display_name`, {
      headers: { Authorization: `Bearer ${t}` },
      who: "TikTok",
      errorOf,
    });
    return ok(r.data, "read the account").data?.user?.display_name ?? "TikTok account";
  },
  async publish(ctx, input) {
    const m = input.media;
    if (m?.kind !== "video") throw new PlatformError("TikTok needs a video.");
    const t = await token(ctx);

    // Which audiences this account may post to right now (unaudited apps: only "Only me").
    const info = ok(
      (
        await http<{ data?: { privacy_level_options?: string[] }; error?: { code?: string; message?: string } }>(`${API}/post/publish/creator_info/query/`, {
          method: "POST",
          headers: auth(t),
          json: {},
          who: "TikTok",
          errorOf,
        }).catch((e) => {
          if (e instanceof PlatformError && e.uncertain) throw new PlatformError(e.message.replace(/ It may have been posted.*$/, ""), true);
          throw e;
        })
      ).data,
      "check the account",
    );
    const options = info.data?.privacy_level_options ?? ["SELF_ONLY"];
    const wanted = ctx.creds.privacy || "PUBLIC_TO_EVERYONE";
    const privacy = options.includes(wanted) ? wanted : options.includes("SELF_ONLY") ? "SELF_ONLY" : options[0];

    const data = await m.read();
    const size = data.length;
    // One piece up to 64 MB; otherwise 10 MB pieces with the remainder added to the last one.
    const chunk = size <= 64 * 1024 * 1024 ? size : 10 * 1024 * 1024;
    const count = size <= chunk ? 1 : Math.floor(size / chunk);
    const init = ok(
      (
        await http<{ data?: { publish_id: string; upload_url: string }; error?: { code?: string; message?: string } }>(`${API}/post/publish/video/init/`, {
          method: "POST",
          headers: auth(t),
          json: {
            post_info: { title: input.text.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
            source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: count },
          },
          who: "TikTok",
          errorOf,
        })
      ).data,
      "start the upload",
    );
    const { publish_id, upload_url } = init.data!;
    for (let i = 0; i < count; i++) {
      const from = i * chunk;
      const to = i === count - 1 ? size - 1 : from + chunk - 1;
      await http(upload_url, {
        method: "PUT",
        headers: { "Content-Type": m.mime, "Content-Range": `bytes ${from}-${to}/${size}` },
        raw: data.subarray(from, to + 1),
        timeoutMs: 10 * 60_000,
        who: "TikTok",
      });
    }
    // TikTok processes and posts it. Wait a while for the final id; if it's still going, it will finish on its own.
    const deadline = Date.now() + 3 * 60_000;
    for (;;) {
      await sleep(6_000);
      const s = await http<{ data?: { status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }; error?: { code?: string; message?: string } }>(
        `${API}/post/publish/status/fetch/`,
        { method: "POST", headers: auth(t), json: { publish_id }, who: "TikTok", errorOf },
      ).catch(() => null);
      const st = s?.data.data;
      if (st?.status === "FAILED") throw new PlatformError(`TikTok couldn't post the video: ${st.fail_reason ?? "unknown reason"}`);
      if (st?.status === "PUBLISH_COMPLETE") {
        const id = st.publicaly_available_post_id?.[0];
        return { id: String(id ?? publish_id), url: id ? `https://www.tiktok.com/video/${id}` : null, raw: st };
      }
      if (Date.now() > deadline) return { id: publish_id, url: null, raw: { status: st?.status ?? "PROCESSING", note: "Still processing on TikTok" } };
    }
  },
};
