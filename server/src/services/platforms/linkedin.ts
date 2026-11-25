import { http, PlatformError, type Connector, type Creds } from "./core.js";

// LinkedIn Posts API. Sign-in with LinkedIn (OAuth). Posting as a person needs the "Share on LinkedIn" product;
// posting as a company page needs LinkedIn's approval for the Community Management API.
// LinkedIn tokens last 60 days; after that, press Connect again.

const errorOf = (b: unknown) => {
  const d = b as { message?: string; error_description?: string; error?: string };
  return d?.message ?? d?.error_description ?? d?.error;
};

/** LinkedIn's API is versioned by month and each version lasts about a year; two months back is always live. */
function apiVersion(c: Creds) {
  if (/^\d{6}$/.test(c.apiVersion ?? "")) return c.apiVersion;
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 2);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function headers(c: Creds) {
  if (!c.accessToken) throw new PlatformError("LinkedIn isn't connected. Press Connect in Settings → Social accounts.");
  if (c.expiresAt && Number(c.expiresAt) < Date.now()) throw new PlatformError("The LinkedIn sign-in has expired (they last 60 days). Press Connect again in Settings → Social accounts.");
  return { Authorization: `Bearer ${c.accessToken}`, "LinkedIn-Version": apiVersion(c)!, "X-Restli-Protocol-Version": "2.0.0" };
}

const author = (c: Creds) => c.authorUrn || c.personUrn;

/** LinkedIn's "little text": reserved characters need a backslash; hashtags use their own template. */
function littleText(s: string) {
  const escape = (t: string) => t.replace(/[\\|{}@[\]()<>#*_~]/g, (ch) => `\\${ch}`);
  // Links are only escaped: a "#section" inside a URL must stay part of the link, not become a hashtag.
  // In the rest, a # at the start or after a space begins a hashtag.
  return s
    .split(/(https?:\/\/\S+)/)
    .map((part, i) => (i % 2 ? escape(part) : escape(part).replace(/(^|\s)\\#([\p{L}\p{N}_]+)/gu, "$1{hashtag|\\#|$2}")))
    .join("");
}

/** Uploading media doesn't post anything, so failures there are safe to retry. */
const uploadStep = <T>(p: Promise<T>) =>
  p.catch((e) => {
    if (e instanceof PlatformError && e.uncertain) throw new PlatformError(e.message.replace(/ It may have been posted.*$/, ""), true, false, e.raw);
    throw e;
  });

export const linkedin: Connector = {
  id: "linkedin",
  label: "LinkedIn",
  fields: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
    {
      key: "authorUrn",
      label: "Company page (optional)",
      optional: true,
      help: "Post as a company page: urn:li:organization:12345 (needs LinkedIn's Community Management API approval). Leave empty to post as the person who connects.",
    },
  ],
  setupHelp:
    "In the LinkedIn Developer portal, create an app, add the products \"Sign In with LinkedIn using OpenID Connect\" and \"Share on LinkedIn\" (and the Community Management API to post as a company page), and add the redirect address shown below. Save the client ID and secret, then press Connect. LinkedIn sign-ins last 60 days.",
  oauth: {
    authorizeUrl(c, redirectUri, state) {
      const scopes = ["openid", "profile", "w_member_social"];
      if (c.authorUrn?.startsWith("urn:li:organization:")) scopes.push("w_organization_social");
      const u = new URL("https://www.linkedin.com/oauth/v2/authorization");
      u.search = new URLSearchParams({ response_type: "code", client_id: c.clientId, redirect_uri: redirectUri, state, scope: scopes.join(" ") }).toString();
      return u.toString();
    },
    async exchange(c, code, redirectUri) {
      const r = await http<{ access_token: string; expires_in: number; refresh_token?: string }>("https://www.linkedin.com/oauth/v2/accessToken", {
        form: { grant_type: "authorization_code", code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri },
        who: "LinkedIn",
        errorOf,
      });
      const me = await http<{ sub: string; name?: string }>("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${r.data.access_token}` },
        who: "LinkedIn",
        errorOf,
      });
      return {
        accessToken: r.data.access_token,
        expiresAt: String(Date.now() + r.data.expires_in * 1000),
        personUrn: `urn:li:person:${me.data.sub}`,
        personName: me.data.name ?? "",
      };
    },
  },
  configured: (c) => !!(c.accessToken && author(c)),
  async check(ctx) {
    const c = ctx.creds;
    const me = await http<{ name?: string }>("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: headers(c).Authorization }, who: "LinkedIn", errorOf });
    return c.authorUrn ? `${c.authorUrn} (via ${me.data.name ?? "you"})` : (me.data.name ?? "LinkedIn member");
  },
  async publish(ctx, input) {
    const c = ctx.creds;
    const h = headers(c);
    const owner = author(c);
    if (!owner) throw new PlatformError("LinkedIn isn't connected. Press Connect in Settings → Social accounts.");
    let content: unknown;
    const m = input.media;
    if (m?.kind === "image") {
      const init = await uploadStep(
        http<{ value: { uploadUrl: string; image: string } }>("https://api.linkedin.com/rest/images?action=initializeUpload", {
          method: "POST",
          headers: h,
          json: { initializeUploadRequest: { owner } },
          who: "LinkedIn",
          errorOf,
        }),
      );
      await uploadStep(http(init.data.value.uploadUrl, { method: "PUT", headers: { Authorization: h.Authorization }, raw: await m.read(), timeoutMs: 120_000, who: "LinkedIn" }));
      content = { media: { id: init.data.value.image } };
    } else if (m?.kind === "video") {
      const data = await m.read();
      const init = await uploadStep(
        http<{ value: { video: string; uploadToken?: string; uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[] } }>(
          "https://api.linkedin.com/rest/videos?action=initializeUpload",
          { method: "POST", headers: h, json: { initializeUploadRequest: { owner, fileSizeBytes: data.length, uploadCaptions: false, uploadThumbnail: false } }, who: "LinkedIn", errorOf },
        ),
      );
      const etags: string[] = [];
      for (const part of init.data.value.uploadInstructions) {
        const r = await uploadStep(
          http(part.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, raw: data.subarray(part.firstByte, part.lastByte + 1), timeoutMs: 10 * 60_000, who: "LinkedIn" }),
        );
        etags.push((r.headers.get("etag") ?? "").replace(/"/g, ""));
      }
      await uploadStep(
        http("https://api.linkedin.com/rest/videos?action=finalizeUpload", {
          method: "POST",
          headers: h,
          json: { finalizeUploadRequest: { video: init.data.value.video, uploadToken: init.data.value.uploadToken ?? "", uploadedPartIds: etags } },
          who: "LinkedIn",
          errorOf,
        }),
      );
      content = { media: { id: init.data.value.video, title: input.title.slice(0, 200) } };
    } else if (input.link) {
      content = { article: { source: input.link, title: input.title.slice(0, 200) } };
    }
    const r = await http("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: h,
      json: {
        author: owner,
        commentary: littleText(input.text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        ...(content ? { content } : {}),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      },
      who: "LinkedIn",
      errorOf,
    });
    const id = r.headers.get("x-restli-id") ?? r.headers.get("x-linkedin-id") ?? "";
    // It's posted either way; without an id there's just no link to it.
    return { id: id || "posted (no id returned)", url: id ? `https://www.linkedin.com/feed/update/${id}` : null, raw: { id } };
  },
};
