import { Router } from "express";
import { z } from "zod";
import { one, q } from "../lib/db.js";
import { intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { requirePerm } from "../middleware/auth.js";
import { refreshTrends } from "../services/trends.js";

export const trendsRouter = Router();

trendsRouter.get("/", requirePerm("trends.view"), async (_req, res) => {
  // Summaries interrupted by a server restart would otherwise stay "pending" forever.
  await q("UPDATE trend_snapshots SET ai_status='failed' WHERE ai_status='pending' AND created_at < now() - interval '10 minutes'");
  const latest = await one(
    `SELECT s.*, u.name AS created_by_name FROM trend_snapshots s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.created_at DESC LIMIT 1`,
  );
  const history = await q("SELECT id, created_at, items_scanned, sources_ok FROM trend_snapshots ORDER BY created_at DESC LIMIT 10");
  res.json({ latest, history });
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

// Sources (feeds and APIs) are managed in Settings
const sourceSchema = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(["rss", "pubmed", "newsapi"]),
  url: z.string().url().nullable().optional(),
  query: z.string().max(500).nullable().optional(),
  enabled: z.boolean().default(true),
});

trendsRouter.get("/sources", requirePerm("trends.view"), async (_req, res) => {
  res.json({ sources: await q("SELECT * FROM trend_sources ORDER BY id") });
});

trendsRouter.post("/sources", requirePerm("settings.manage"), async (req, res) => {
  const b = parse(sourceSchema, req.body);
  const row = await one("INSERT INTO trend_sources (name, kind, url, query, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING *", [b.name, b.kind, b.url ?? null, b.query ?? null, b.enabled]);
  await audit(req, "trends.source_added", "trend_source", row!.id, { name: b.name });
  res.status(201).json({ source: row });
});

trendsRouter.patch("/sources/:id", requirePerm("settings.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(sourceSchema.partial(), req.body);
  const row = await one(
    `UPDATE trend_sources SET name=COALESCE($2,name), kind=COALESCE($3,kind), url=COALESCE($4,url), query=COALESCE($5,query), enabled=COALESCE($6,enabled)
     WHERE id=$1 RETURNING *`,
    [id, b.name ?? null, b.kind ?? null, b.url ?? null, b.query ?? null, b.enabled ?? null],
  );
  if (!row) throw notFound("Source");
  res.json({ source: row });
});

trendsRouter.delete("/sources/:id", requirePerm("settings.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  await q("DELETE FROM trend_sources WHERE id=$1", [id]);
  await audit(req, "trends.source_removed", "trend_source", id);
  res.json({ ok: true });
});
