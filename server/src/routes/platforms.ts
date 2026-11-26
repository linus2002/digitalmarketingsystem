import crypto from "node:crypto";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { one } from "../lib/db.js";
import { badRequest, parse } from "../lib/http.js";
import { errMsg, log } from "../lib/logger.js";
import { getSetting, setSetting } from "../lib/settings.js";
import { requirePerm } from "../middleware/auth.js";
import { UPLOAD_DIR } from "../services/media.js";
import {
  clearCreds,
  CONNECTORS,
  connectedPlatforms,
  ctxFor,
  findInstagramAccount,
  getCreds,
  getDefaultPlatforms,
  isPlatform,
  PLATFORM_IDS,
  platformSummaries,
  redirectUri,
  saveCreds,
  saveDefaultPlatforms,
  type PlatformId,
} from "../services/platforms/index.js";

// Social accounts: Settings → Social accounts, the post editor's platform list, sign-in callbacks
// and the public address platforms download uploaded media from.

export const platformsRouter = Router();

function platformParam(v: unknown): PlatformId {
  if (!isPlatform(v)) throw badRequest("Unknown platform.");
  return v;
}

/** Checks the connection and remembers the account name. Never throws: returns the problem instead. */
async function checkAndRemember(id: PlatformId, userId: number | null): Promise<{ account: string | null; error: string | null }> {
  const creds = await getCreds(id);
  if (!(await CONNECTORS[id].configured(creds))) return { account: null, error: null };
  try {
    const account = await CONNECTORS[id].check(ctxFor(id, creds));
    await saveCreds(id, {}, userId, account);
    return { account, error: null };
  } catch (err) {
    return { account: null, error: errMsg(err) };
  }
}

/** Which platforms posts can go to (the editor and calendar use this). */
/** The platforms new posts start with. Everyone who can see posts reads it (the editor ticks them for a new post). */
platformsRouter.get("/defaults", requirePerm("posts.view"), async (_req, res) => {
  res.json({ platforms: await getDefaultPlatforms() });
});

/** Admins choose them in Settings → Social accounts. At least one. */
platformsRouter.put("/defaults", requirePerm("settings.manage"), async (req, res) => {
  const { platforms } = parse(z.object({ platforms: z.array(z.enum(PLATFORM_IDS)).min(1, "Pick at least one platform.").max(PLATFORM_IDS.length) }), req.body);
  await saveDefaultPlatforms(platforms, req.user!.id);
  await audit(req, "settings.default_platforms", "settings", "platforms.defaults", { platforms });
  res.json({ platforms: await getDefaultPlatforms() });
});

platformsRouter.get("/connected", requirePerm("posts.view"), async (_req, res) => {
  res.json({ connected: await connectedPlatforms(), testMode: env.PUBLISH_DRY_RUN });
});

platformsRouter.get("/", requirePerm("settings.manage"), async (_req, res) => {
  res.json(await platformSummaries());
});

/** Saves app keys and settings. Empty secret fields keep what's saved; empty plain fields clear it. */
platformsRouter.put("/:platform", requirePerm("settings.manage"), async (req, res) => {
  const id = platformParam(req.params.platform);
  const { values } = parse(z.object({ values: z.record(z.string(), z.string().max(4000)) }), req.body);
  const fields = CONNECTORS[id].fields;
  const patch: Record<string, string | undefined> = {};
  for (const f of fields) {
    if (!(f.key in values)) continue;
    const v = values[f.key].trim();
    if (f.options && v && !f.options.some((o) => o.value === v)) throw badRequest(`${f.label}: pick one of the options.`);
    patch[f.key] = f.secret && !v ? undefined : v;
  }
  // New app keys mean a new sign-in.
  // (Each platform uses only one of the two key names: compare the one that was sent.)
  if (CONNECTORS[id].oauth) {
    const before = await getCreds(id);
    const changed = (["clientId", "clientKey"] as const).some((k) => patch[k] !== undefined && patch[k] !== "" && patch[k] !== before[k]);
    if (changed) Object.assign(patch, { accessToken: "", refreshToken: "", expiresAt: "", openId: "", personUrn: "", personName: "" });
  }
  await saveCreds(id, patch, req.user!.id, null);
  const check = await checkAndRemember(id, req.user!.id);
  await audit(req, "settings.platform_saved", "settings", `platform.${id}`, { fields: Object.keys(patch).filter((k) => patch[k] !== undefined) });
  res.json({ ok: true, ...check });
});

platformsRouter.post("/:platform/test", requirePerm("settings.manage"), async (req, res) => {
  const id = platformParam(req.params.platform);
  if (id === "facebook") throw badRequest("Facebook is checked in Settings → Facebook connection.");
  const r = await checkAndRemember(id, req.user!.id);
  if (!r.account && !r.error) throw badRequest(`${CONNECTORS[id].label} isn't set up yet.`);
  res.json(r);
});

platformsRouter.delete("/:platform", requirePerm("settings.manage"), async (req, res) => {
  const id = platformParam(req.params.platform);
  if (id === "facebook") throw badRequest("Facebook is managed in Settings → Facebook connection.");
  await clearCreds(id, req.user!.id);
  await audit(req, "settings.platform_disconnected", "settings", `platform.${id}`);
  res.json({ ok: true });
});

/** Instagram: finds the Instagram account linked to the connected Facebook Page. */
platformsRouter.post("/instagram/find", requirePerm("settings.manage"), async (req, res) => {
  let ig: { id: string; username: string } | null;
  try {
    ig = await findInstagramAccount();
  } catch (err) {
    throw badRequest(errMsg(err));
  }
  if (!ig) throw badRequest("No Instagram account is linked to the Facebook Page. Link a Business or Creator account to the Page in Meta Business Suite, then try again.");
  await saveCreds("instagram", { igUserId: ig.id }, req.user!.id, `@${ig.username}`);
  await audit(req, "settings.platform_saved", "settings", "platform.instagram", { igUserId: ig.id });
  res.json({ ok: true, account: `@${ig.username}` });
});

const PENDING_MINUTES = 15;

/** Starts "Connect": returns the platform's sign-in address. */
platformsRouter.post("/:platform/connect", requirePerm("settings.manage"), async (req, res) => {
  const id = platformParam(req.params.platform);
  const c = CONNECTORS[id];
  if (!c.oauth) throw badRequest(`${c.label} doesn't use Connect.`);
  const creds = await getCreds(id);
  const missing = c.fields.filter((f) => !f.optional && !creds[f.key]).map((f) => f.label);
  if (missing.length) throw badRequest(`Save these first: ${missing.join(", ")}.`);
  const state = crypto.randomBytes(24).toString("base64url");
  await setSetting(`oauth.pending.${id}`, { state, userId: req.user!.id, at: Date.now() }, req.user!.id);
  res.json({ url: c.oauth.authorizeUrl(creds, redirectUri(id), state), redirectUri: redirectUri(id) });
});

// ---------------------------------------------------------------- public (no sign-in)

/** Where Google, TikTok and LinkedIn send the browser back after sign-in. Checked against the one-time state. */
export const oauthCallbackRouter = Router();

oauthCallbackRouter.get("/:platform/callback", async (req, res) => {
  const back = (id: string, error?: string) =>
    res.redirect(`${env.CLIENT_ORIGIN.replace(/\/+$/, "")}/settings?tab=social&social=${encodeURIComponent(id)}${error ? `&error=${encodeURIComponent(error.slice(0, 300))}` : "&ok=1"}`);
  const id = req.params.platform;
  if (!isPlatform(id) || !CONNECTORS[id].oauth) return void res.status(404).send("Not found");
  const pending = await getSetting<{ state: string; userId: number; at: number } | null>(`oauth.pending.${id}`, null);
  const state = String(req.query.state ?? "");
  const valid =
    pending &&
    Date.now() - pending.at < PENDING_MINUTES * 60_000 &&
    state.length === pending.state.length &&
    crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state));
  if (!valid) return back(id, "The sign-in link expired or didn't match. Press Connect again.");
  await setSetting(`oauth.pending.${id}`, null, pending.userId); // one use only
  if (req.query.error) return back(id, String(req.query.error_description ?? req.query.error));
  const code = String(req.query.code ?? "");
  if (!code) return back(id, "No sign-in code came back.");
  try {
    const creds = await getCreds(id);
    const tokens = await CONNECTORS[id].oauth!.exchange(creds, code, redirectUri(id));
    await saveCreds(id, tokens, pending.userId);
    const check = await checkAndRemember(id, pending.userId);
    await audit(null, "settings.platform_connected", "settings", `platform.${id}`, { by: pending.userId, account: check.account });
    if (check.error) return back(id, `Signed in, but the check failed: ${check.error}`);
    back(id);
  } catch (err) {
    log.warn("Platform sign-in failed", { platform: id, error: errMsg(err) });
    back(id, errMsg(err));
  }
});

/**
 * Uploaded images and videos that Instagram and TikTok download when posting. The file name is a random UUID
 * (not guessable), and only files of posts that are scheduled, being published or published are served.
 */
export const publicMediaRouter = Router();

publicMediaRouter.get("/:name", async (req, res) => {
  const name = path.basename(String(req.params.name));
  if (!/^[0-9a-f-]{36}\.(jpg|png|gif|mp4|mov)$/i.test(name)) return void res.status(404).end();
  const row = await one(
    `SELECT m.mime FROM media m WHERE m.storage_name=$1
       AND EXISTS (SELECT 1 FROM posts p WHERE p.media_id = m.id AND p.status IN ('scheduled','publishing','published'))`,
    [name],
  );
  if (!row) return void res.status(404).end();
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(path.join(UPLOAD_DIR, name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

export { PLATFORM_IDS };
