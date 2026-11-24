import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import {
  getBrand,
  getConsent,
  getMetaPage,
  getRetention,
  getSetting,
  saveMetaPage,
  setSetting,
} from "../lib/settings.js";
import { requirePerm } from "../middleware/auth.js";
import { graph } from "../services/meta.js";
import { previewRetention, runRetention } from "../services/retention.js";
import { aiStatus } from "../services/ai.js";

export const settingsRouter = Router();

settingsRouter.get("/brand", async (_req, res) => {
  res.json({ brand: await getBrand() });
});

// Brand guidelines can be changed by brand managers (marketing managers) as well as administrators.
settingsRouter.put("/brand", requirePerm("settings.brand"), async (req, res) => {
  const list = z.array(z.string().max(200)).max(50);
  const b = parse(
    z.object({
      name: z.string().min(1).max(100),
      voice: z.string().max(1000),
      audience: z.string().max(1000),
      language: z.string().max(60),
      doList: list,
      dontList: list,
      bannedPhrases: list,
      requiredDisclaimer: z.string().max(400),
      alwaysHashtags: list,
    }),
    req.body,
  );
  await setSetting("brand", b, req.user!.id);
  await audit(req, "settings.brand_updated", "settings", "brand");
  res.json({ brand: b });
});

settingsRouter.get("/retention", requirePerm("settings.manage"), async (_req, res) => {
  res.json({ retention: await getRetention(), lastRun: await getSetting("retention.lastRun", null) });
});

/** What a run would remove with the given (or saved) day limits, for the confirmation before Save or Run now. */
settingsRouter.get("/retention/preview", requirePerm("settings.manage"), async (req, res) => {
  const saved = await getRetention();
  const b = parse(
    z.object({
      leadDays: z.coerce.number().int().min(30).max(3650).default(saved.leadDays),
      unconsentedDays: z.coerce.number().int().min(1).max(90).default(saved.unconsentedDays),
    }),
    req.query,
  );
  res.json({ preview: await previewRetention(b) });
});

settingsRouter.put("/retention", requirePerm("settings.manage"), async (req, res) => {
  const b = parse(
    z.object({
      leadDays: z.number().int().min(30).max(3650),
      unconsentedDays: z.number().int().min(1).max(90),
      auditDays: z.number().int().min(90).max(3650),
      aiLogDays: z.number().int().min(7).max(3650),
    }),
    req.body,
  );
  await setSetting("retention", b, req.user!.id);
  await audit(req, "settings.retention_updated", "settings", "retention", b);
  res.json({ retention: b });
});

settingsRouter.post("/retention/run", requirePerm("settings.manage"), async (req, res) => {
  const result = await runRetention();
  await audit(req, "retention.run_manually", "settings", "retention", result);
  res.json({ result });
});

settingsRouter.get("/consent", requirePerm("settings.manage"), async (_req, res) => {
  res.json({ consent: await getConsent() });
});

settingsRouter.put("/consent", requirePerm("settings.manage"), async (req, res) => {
  const b = parse(z.object({ version: z.string().min(1).max(40), text: z.string().min(20).max(2000) }), req.body);
  await setSetting("consent", b, req.user!.id);
  await audit(req, "settings.consent_updated", "settings", "consent", { version: b.version });
  res.json({ consent: b });
});

settingsRouter.get("/meta", requirePerm("settings.manage"), async (_req, res) => {
  const page = await getMetaPage();
  res.json({
    pageId: page.pageId,
    pageName: page.pageName,
    source: page.source,
    hasToken: !!page.token,
    tokenSource: page.tokenSource,
    graphVersion: env.META_GRAPH_VERSION,
    webhookConfigured: !!env.META_APP_SECRET && !!env.META_VERIFY_TOKEN,
    humanAgentTag: env.META_ENABLE_HUMAN_AGENT_TAG,
    publishDryRun: env.PUBLISH_DRY_RUN,
    messengerDryRun: env.MESSENGER_DRY_RUN,
    lastSync: await getSetting("meta.lastSync", null),
  });
});

/** Saves the Page ID and Page access token (encrypted) after checking them against the Graph API. */
settingsRouter.put("/meta", requirePerm("settings.manage"), async (req, res) => {
  const b = parse(z.object({ pageId: z.string().regex(/^\d{5,25}$/, "A Page ID is a long number"), token: z.string().min(20).max(1000).optional() }), req.body);
  // Without a new token, the one already in use (saved here or from .env) is checked against the new Page ID,
  // and getMetaPage then uses the saved Page ID with that token.
  const token = b.token ?? (await getMetaPage()).token;
  if (!token) return void res.status(400).json({ error: "Add the Page access token." });
  let name: string | undefined;
  try {
    const info = await graph<{ id: string; name: string }>(b.pageId, { token, params: { fields: "id,name" } });
    name = info.name;
  } catch (err) {
    return void res.status(400).json({ error: `Facebook didn't accept these details: ${(err as Error).message}` });
  }
  await saveMetaPage(b.pageId, b.token ?? null, name, req.user!.id);
  await audit(req, "settings.meta_connected", "settings", "meta.page", { pageId: b.pageId });
  res.json({ ok: true, pageName: name });
});

settingsRouter.get("/system", requirePerm("settings.manage"), async (_req, res) => {
  res.json({
    ai: await aiStatus(),
    scheduler: { enabled: env.SCHEDULER_ENABLED, intervalSeconds: env.SCHEDULER_INTERVAL_SECONDS },
    node: process.version,
    env: env.NODE_ENV,
  });
});
