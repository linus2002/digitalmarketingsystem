import { Router } from "express";
import { z } from "zod";
import { one, q } from "../lib/db.js";
import { badRequest, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { requirePerm } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { setSetting } from "../lib/settings.js";
import { AI_STEPS_TIMEOUT_MINUTES, getLiveSettings, isPublicFeedUrl, isSummarising, refreshTrends } from "../services/trends.js";

export const trendsRouter = Router();

trendsRouter.get("/", requirePerm("trends.view"), async (_req, res) => {
  // Summaries interrupted by a server restart would otherwise stay "pending" forever. While the AI is still
  // working nothing is touched; otherwise only snapshots older than the AI steps' combined time limit are failed.
  if (!isSummarising())
    await q("UPDATE trend_snapshots SET ai_status='failed' WHERE ai_status='pending' AND created_at < now() - make_interval(mins => $1)", [AI_STEPS_TIMEOUT_MINUTES]);
  const latest = await one(
    `SELECT s.*, u.name AS created_by_name FROM trend_snapshots s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.created_at DESC LIMIT 1`,
  );
  const history = await q("SELECT id, created_at, items_scanned, sources_ok FROM trend_snapshots ORDER BY created_at DESC LIMIT 10");
  res.json({ latest, history, autoRefreshMinutes: env.SCHEDULER_ENABLED ? env.TRENDS_AUTO_REFRESH_MINUTES : 0 });
});

// Live Google trends: whether each one is looked up with Ollama web search
trendsRouter.get("/live", requirePerm("trends.view"), async (_req, res) => {
  res.json({ ...(await getLiveSettings()), keySet: Boolean(env.OLLAMA_API_KEY), autoRefreshMinutes: env.SCHEDULER_ENABLED ? env.TRENDS_AUTO_REFRESH_MINUTES : 0 });
});

trendsRouter.put("/live", requirePerm("settings.brand"), async (req, res) => {
  const b = parse(z.object({ webSearch: z.boolean() }), req.body);
  await setSetting("trends.live", b, req.user!.id);
  await audit(req, "trends.live_settings", "setting", "trends.live", b);
  res.json(b);
});

trendsRouter.get("/snapshots/:id", requirePerm("trends.view"), async (req, res) => {
  const snap = await one("SELECT * FROM trend_snapshots WHERE id=$1", [intParam(req.params.id)]);
  if (!snap) throw notFound("Snapshot");
  res.json({ snapshot: snap });
});

trendsRouter.post("/refresh", requirePerm("trends.refresh"), async (req, res) => {
  const b = parse(z.object({ days: z.number().int().min(1).max(30).optional(), useAi: z.boolean().optional() }), req.body ?? {});
  const snap = await refreshTrends(req.user!.id, b);
  await audit(req, "trends.refreshed", "trend_snapshot", snap.id);
  res.json({ latest: snap });
});

// Sources (feeds and APIs) are managed in Settings (brand managers and administrators)
const sourceFields = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(["rss", "pubmed", "newsapi", "google_trends"]),
  url: z.string().url().max(1000).nullable().optional(),
  query: z.string().max(500).nullable().optional(),
  enabled: z.boolean().default(true),
});
// Google Trends takes a two-letter country code (PH, US, SG…) as its query.
const geoOk = (b: { kind?: string; query?: string | null }) => b.kind !== "google_trends" || /^[A-Z]{2}$/.test(b.query ?? "");
const geoMsg = { message: "For Google Trends, enter a two-letter country code such as PH", path: ["query"] };
const sourceSchema = sourceFields.refine(geoOk, geoMsg);

/** Feeds must be public http(s) addresses: never this server, the local AI or other machines on the private network. */
async function checkUrl(url: string | null | undefined) {
  if (!url) return;
  const why = await isPublicFeedUrl(url);
  if (why !== true) throw badRequest(`url: ${why}`);
}
const normaliseQuery = (body: Record<string, unknown> | undefined, kind: unknown) =>
  kind === "google_trends" && body?.query != null ? String(body.query).trim().toUpperCase() : body?.query;

trendsRouter.get("/sources", requirePerm("trends.view"), async (_req, res) => {
  res.json({ sources: await q("SELECT * FROM trend_sources ORDER BY id") });
});

trendsRouter.post("/sources", requirePerm("settings.brand"), async (req, res) => {
  const b = parse(sourceSchema, { ...req.body, query: req.body?.kind === "google_trends" ? String(req.body.query ?? "").trim().toUpperCase() : req.body?.query });
  if (b.kind === "rss" && !b.url) throw badRequest("url: Enter the feed's web address");
  await checkUrl(b.url);
  const row = await one("INSERT INTO trend_sources (name, kind, url, query, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING *", [b.name, b.kind, b.url ?? null, b.query ?? null, b.enabled]);
  await audit(req, "trends.source_added", "trend_source", row!.id, { name: b.name });
  res.status(201).json({ source: row });
});

trendsRouter.patch("/sources/:id", requirePerm("settings.brand"), async (req, res) => {
  const id = intParam(req.params.id);
  const current = await one<{ kind: string; query: string | null; url: string | null }>("SELECT kind, query, url FROM trend_sources WHERE id=$1", [id]);
  if (!current) throw notFound("Source");
  const kind = req.body?.kind ?? current.kind;
  const b = parse(sourceFields.partial(), { ...req.body, ...(req.body?.query !== undefined ? { query: normaliseQuery(req.body, kind) } : {}) });
  // The same rules as when adding: Google Trends needs a country code (checked against the resulting row), feeds need a public address.
  if (!geoOk({ kind, query: b.query ?? current.query })) throw badRequest(`query: ${geoMsg.message}`);
  // A new address is always checked; switching a source back on re-checks the saved one.
  await checkUrl(b.url ?? (b.enabled ? current.url : null));
  const row = await one(
    `UPDATE trend_sources SET name=COALESCE($2,name), kind=COALESCE($3,kind), url=COALESCE($4,url), query=COALESCE($5,query), enabled=COALESCE($6,enabled)
     WHERE id=$1 RETURNING *`,
    [id, b.name ?? null, b.kind ?? null, b.url ?? null, b.query ?? null, b.enabled ?? null],
  );
  if (!row) throw notFound("Source");
  await audit(req, "trends.source_updated", "trend_source", id, b);
  res.json({ source: row });
});

trendsRouter.delete("/sources/:id", requirePerm("settings.brand"), async (req, res) => {
  const id = intParam(req.params.id);
  await q("DELETE FROM trend_sources WHERE id=$1", [id]);
  await audit(req, "trends.source_removed", "trend_source", id);
  res.json({ ok: true });
});
