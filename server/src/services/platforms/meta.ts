import { getMetaPage } from "../../lib/settings.js";
import { checkConnection, graph, MetaError, publishToPage } from "../meta.js";
import { errMsg } from "../../lib/logger.js";
import { PlatformError, publicMediaUrl, sleep, type Connector } from "./core.js";

// Facebook keeps its own section in Settings (Facebook connection); this wraps it as a connector.
export const facebook: Connector = {
  id: "facebook",
  label: "Facebook",
  fields: [],
  setupHelp: "Set up in Settings → Facebook connection.",
  async configured() {
    const p = await getMetaPage();
    return !!(p.pageId && p.token);
  },
  async check() {
    const r = await checkConnection();
    return r.name;
  },
  async publish(_ctx, input) {
    const m = input.media;
    // Uploaded files are sent as files; links are downloaded by Facebook itself.
    const file = m && (m.uploaded || !m.publicUrl) ? { kind: m.kind, data: await m.read(), mime: m.mime, name: m.name } : null;
    const r = await publishToPage({
      message: input.text,
      link: input.link,
      imageUrl: !file && m?.kind === "image" ? m.publicUrl : null,
      videoUrl: !file && m?.kind === "video" ? m.publicUrl : null,
      file,
    });
    return { id: r.id, url: `https://www.facebook.com/${r.id}`, raw: r.raw };
  },
};

// Instagram professional account linked to the same Facebook Page. Uses the Page token unless another is given.
// Instagram downloads the image/video from a public https address (it can't take an upload from us).
async function igAuth(creds: Record<string, string>) {
  const page = await getMetaPage();
  const token = creds.accessToken || page.token;
  if (!creds.igUserId) throw new PlatformError("No Instagram account is set. Press \"Find from Facebook Page\" in Settings → Social accounts.");
  if (!token) throw new PlatformError("No token for Instagram. Connect the Facebook Page first.");
  return { igId: creds.igUserId, token };
}

/** The Instagram account linked to the connected Facebook Page. */
export async function findInstagramAccount(): Promise<{ id: string; username: string } | null> {
  const page = await getMetaPage();
  if (!page.pageId || !page.token) throw new PlatformError("Connect the Facebook Page first (Settings → Facebook connection).");
  const r = await graph<{ instagram_business_account?: { id: string; username?: string } }>(page.pageId, {
    token: page.token,
    params: { fields: "instagram_business_account{id,username}" },
  });
  const ig = r.instagram_business_account;
  return ig ? { id: ig.id, username: ig.username ?? ig.id } : null;
}

export const instagram: Connector = {
  id: "instagram",
  label: "Instagram",
  fields: [
    { key: "igUserId", label: "Instagram account ID", help: "Filled in by \"Find from Facebook Page\"." },
    { key: "accessToken", label: "Access token", secret: true, optional: true, help: "Leave empty to use the Facebook Page token." },
  ],
  setupHelp:
    "Make the Instagram account a Business or Creator account and link it to the Facebook Page. The Meta app needs the instagram_basic and instagram_content_publish permissions, plus instagram_manage_messages and instagram_manage_comments for direct messages and the Comments inbox. Uploaded files must be reachable on the internet: set PUBLIC_BASE_URL to this system's https address.",
  async configured(creds) {
    if (!creds.igUserId) return false;
    return !!(creds.accessToken || (await getMetaPage()).token);
  },
  async check(ctx) {
    const { igId, token } = await igAuth(ctx.creds);
    const r = await graph<{ username: string }>(igId, { token, params: { fields: "username" } });
    return `@${r.username}`;
  },
  async publish(ctx, input) {
    const { igId, token } = await igAuth(ctx.creds);
    const m = input.media;
    if (!m) throw new PlatformError("Instagram needs an image or a video.");
    if (!m.publicUrl)
      throw new PlatformError("Instagram downloads the file from a public web address. Set PUBLIC_BASE_URL to this system's https address, or use an image/video link instead of an upload.");
    // Uploaded images go as the converted JPG copy (right shape and size); links and videos as they are.
    let fileUrl = m.publicUrl;
    if (m.uploaded && m.kind === "image" && m.instagramReady) {
      try {
        fileUrl = publicMediaUrl(await m.instagramReady()) ?? fileUrl;
      } catch (err) {
        throw new PlatformError(errMsg(err));
      }
    }
    const container = await graph<{ id: string }>(`${igId}/media`, {
      method: "POST",
      token,
      body: m.kind === "video" ? { media_type: "REELS", video_url: fileUrl, caption: input.text, share_to_feed: true } : { image_url: fileUrl, caption: input.text },
      timeoutMs: 60_000,
    });
    // Instagram processes the file before it can be published (videos can take minutes).
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const s = await graph<{ status_code?: string; status?: string }>(container.id, { token, params: { fields: "status_code,status" } });
      if (s.status_code === "FINISHED" || (!s.status_code && m.kind === "image")) break;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new PlatformError(`Instagram couldn't process the ${m.kind}: ${s.status ?? s.status_code}`);
      if (Date.now() > deadline) throw new PlatformError(`Instagram is still processing the ${m.kind} after 10 minutes. Try again later.`, true);
      await sleep(m.kind === "video" ? 8_000 : 2_000);
    }
    let published: { id: string };
    try {
      published = await graph<{ id: string }>(`${igId}/media_publish`, { method: "POST", token, body: { creation_id: container.id }, timeoutMs: 60_000 });
    } catch (err) {
      if (err instanceof MetaError) throw new PlatformError(err.message, err.transient && !err.uncertain, err.uncertain, err.raw);
      throw err;
    }
    let url: string | null = null;
    try {
      url = (await graph<{ permalink?: string }>(published.id, { token, params: { fields: "permalink" } })).permalink ?? null;
    } catch {
      /* the post is live; the link is a nice-to-have */
    }
    return { id: published.id, url, raw: published };
  },
};
