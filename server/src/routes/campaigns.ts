import { Router } from "express";
import { z } from "zod";
import { one, q } from "../lib/db.js";
import { badRequest, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { requirePerm } from "../middleware/auth.js";

export const campaignsRouter = Router();

const body = z.object({
  name: z.string().min(1).max(150),
  objective: z.string().max(300).nullable().optional(),
  description: z.string().max(3000).nullable().optional(),
  start_date: z.string().date().nullable().optional(),
  end_date: z.string().date().nullable().optional(),
  status: z.enum(["planned", "active", "completed", "archived"]).optional(),
});

export const CAMPAIGN_STATS_SQL = `
  SELECT c.*,
    count(p.id)::int AS posts_total,
    count(p.id) FILTER (WHERE p.status='published')::int AS posts_published,
    count(p.id) FILTER (WHERE p.status='scheduled')::int AS posts_scheduled,
    count(p.id) FILTER (WHERE p.status='failed')::int AS posts_failed,
    COALESCE(sum(f.reach),0)::int AS reach,
    COALESCE(sum(f.impressions),0)::int AS impressions,
    COALESCE(sum(f.reactions),0)::int AS reactions,
    COALESCE(sum(f.comments),0)::int AS comments,
    COALESCE(sum(f.shares),0)::int AS shares,
    COALESCE(sum(f.clicks),0)::int AS clicks
  FROM campaigns c
  LEFT JOIN posts p ON p.campaign_id = c.id
  LEFT JOIN fb_page_posts f ON f.fb_post_id = p.fb_post_id`;

campaignsRouter.get("/", requirePerm("posts.view"), async (_req, res) => {
  res.json({ campaigns: await q(`${CAMPAIGN_STATS_SQL} GROUP BY c.id ORDER BY c.status='archived', c.start_date DESC NULLS LAST, c.id DESC`) });
});

campaignsRouter.get("/:id", requirePerm("posts.view"), async (req, res) => {
  const id = intParam(req.params.id);
  const campaign = await one(`${CAMPAIGN_STATS_SQL} WHERE c.id=$1 GROUP BY c.id`, [id]);
  if (!campaign) throw notFound("Campaign");
  const posts = await q(
    `SELECT p.id, p.title, p.status, p.scheduled_at, p.published_at, f.reach, f.impressions, f.reactions, f.comments, f.shares, f.clicks, f.permalink_url
     FROM posts p LEFT JOIN fb_page_posts f ON f.fb_post_id = p.fb_post_id WHERE p.campaign_id=$1
     ORDER BY COALESCE(p.published_at, p.scheduled_at, p.created_at) DESC`,
    [id],
  );
  res.json({ campaign, posts });
});

campaignsRouter.post("/", requirePerm("campaigns.manage"), async (req, res) => {
  const b = parse(body, req.body);
  if (b.start_date && b.end_date && b.end_date < b.start_date) throw badRequest("end_date: The end date can't be before the start date.");
  const c = await one(
    "INSERT INTO campaigns (name, objective, description, start_date, end_date, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [b.name, b.objective ?? null, b.description ?? null, b.start_date ?? null, b.end_date ?? null, b.status ?? "planned", req.user!.id],
  );
  await audit(req, "campaign.created", "campaign", c!.id);
  res.status(201).json({ campaign: c });
});

campaignsRouter.patch("/:id", requirePerm("campaigns.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(body.partial(), req.body);
  const current = await one<{ start_date: string | null; end_date: string | null }>("SELECT start_date, end_date FROM campaigns WHERE id=$1", [id]);
  if (!current) throw notFound("Campaign");
  const start = "start_date" in b ? (b.start_date ?? null) : current.start_date;
  const end = "end_date" in b ? (b.end_date ?? null) : current.end_date;
  if (start && end && end < start) throw badRequest("end_date: The end date can't be before the start date.");
  // "key in body" so a field sent as null is cleared, while a field left out is kept.
  const c = await one(
    `UPDATE campaigns SET name=COALESCE($2,name),
       objective=CASE WHEN $8 THEN $3 ELSE objective END,
       description=CASE WHEN $9 THEN $4 ELSE description END,
       start_date=CASE WHEN $10 THEN $5::date ELSE start_date END,
       end_date=CASE WHEN $11 THEN $6::date ELSE end_date END,
       status=COALESCE($7,status), updated_at=now() WHERE id=$1 RETURNING *`,
    [
      id,
      b.name ?? null,
      b.objective ?? null,
      b.description ?? null,
      b.start_date ?? null,
      b.end_date ?? null,
      b.status ?? null,
      "objective" in b,
      "description" in b,
      "start_date" in b,
      "end_date" in b,
    ],
  );
  if (!c) throw notFound("Campaign");
  await audit(req, "campaign.updated", "campaign", id);
  res.json({ campaign: c });
});
