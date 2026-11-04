import { Router, type Request } from "express";
import { z } from "zod";
import { one, q, tx, type Row } from "../lib/db.js";
import { badRequest, conflict, forbidden, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { requirePerm, userCan } from "../middleware/auth.js";
import { composeMessage } from "../services/publisher.js";

export const postsRouter = Router();

// draft → in_review → approved → scheduled → publishing → published
//            ↘ changes_requested → (edit) → in_review          ↘ failed → (retry) → scheduled
// Editing an approved or scheduled post sends it back to draft: what gets published is always what was approved.

const postBody = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(5000),
  hashtags: z.array(z.string().max(60)).max(30).default([]),
  image_url: z.string().url().max(1000).nullable().optional(),
  image_prompt: z.string().max(2000).nullable().optional(),
  link_url: z.string().url().max(1000).nullable().optional(),
  campaign_id: z.number().int().nullable().optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  ai_generated: z.boolean().optional(),
  source_topic: z.string().max(300).nullable().optional(),
});

async function load(id: number): Promise<Row> {
  const post = await one(
    `SELECT p.*, c.name AS campaign_name, cu.name AS created_by_name, au.name AS approved_by_name
     FROM posts p LEFT JOIN campaigns c ON c.id=p.campaign_id LEFT JOIN users cu ON cu.id=p.created_by LEFT JOIN users au ON au.id=p.approved_by
     WHERE p.id=$1`,
    [id],
  );
  if (!post) throw notFound("Post");
  return post;
}

async function review(postId: number, req: Request, decision: string, comment: string | null = null) {
  await q("INSERT INTO post_reviews (post_id, user_id, decision, comment) VALUES ($1,$2,$3,$4)", [postId, req.user!.id, decision, comment]);
}

function requireStatus(post: Row, allowed: string[], action: string) {
  if (!allowed.includes(post.status)) throw conflict(`A ${post.status.replace("_", " ")} post can't be ${action}.`);
}

postsRouter.get("/", requirePerm("posts.view"), async (req, res) => {
  const f = parse(
    z.object({
      status: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      campaignId: z.coerce.number().int().optional(),
      q: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
    req.query,
  );
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (f.status) add("p.status = ANY(?)", f.status.split(","));
  if (f.from) add("COALESCE(p.published_at, p.scheduled_at, p.created_at) >= ?", f.from);
  if (f.to) add("COALESCE(p.published_at, p.scheduled_at, p.created_at) < ?", f.to);
  if (f.campaignId) add("p.campaign_id = ?", f.campaignId);
  if (f.q) add("(p.title ILIKE ? OR p.message ILIKE ?)", `%${f.q}%`);
  params.push(f.limit);
  const posts = await q(
    `SELECT p.id, p.title, p.message, p.status, p.scheduled_at, p.published_at, p.next_attempt_at, p.attempts, p.last_error, p.campaign_id, p.image_url,
            p.hashtags, p.fb_post_id, p.ai_generated, p.created_at, p.updated_at, c.name AS campaign_name, u.name AS created_by_name
     FROM posts p LEFT JOIN campaigns c ON c.id=p.campaign_id LEFT JOIN users u ON u.id=p.created_by
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY COALESCE(p.scheduled_at, p.published_at, p.updated_at) DESC LIMIT $${params.length}`,
    params,
  );
  res.json({ posts });
});

postsRouter.get("/counts", requirePerm("posts.view"), async (_req, res) => {
  const rows = await q<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM posts GROUP BY status");
  res.json({ counts: Object.fromEntries(rows.map((r) => [r.status, r.n])) });
});

postsRouter.get("/:id", requirePerm("posts.view"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  const [reviews, logs, stats] = await Promise.all([
    q("SELECT r.*, u.name AS user_name FROM post_reviews r LEFT JOIN users u ON u.id=r.user_id WHERE post_id=$1 ORDER BY created_at DESC", [id]),
    q("SELECT * FROM publish_logs WHERE post_id=$1 ORDER BY created_at DESC LIMIT 50", [id]),
    post.fb_post_id ? one("SELECT * FROM fb_page_posts WHERE fb_post_id=$1", [post.fb_post_id]) : null,
  ]);
  res.json({ post, reviews, logs, stats, preview: composeMessage(post as { message: string; hashtags: string[] }) });
});

postsRouter.post("/", requirePerm("posts.edit"), async (req, res) => {
  const b = parse(postBody, req.body);
  const post = await one(
    `INSERT INTO posts (title, message, hashtags, image_url, image_prompt, link_url, campaign_id, scheduled_at, ai_generated, source_topic, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [b.title, b.message, b.hashtags, b.image_url ?? null, b.image_prompt ?? null, b.link_url ?? null, b.campaign_id ?? null, b.scheduled_at ?? null, b.ai_generated ?? false, b.source_topic ?? null, req.user!.id],
  );
  await audit(req, "post.created", "post", post!.id);
  res.status(201).json({ post: await load(post!.id) });
});

postsRouter.patch("/:id", requirePerm("posts.edit"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, ["draft", "changes_requested", "in_review", "approved", "scheduled", "failed"], "edited");
  const b = parse(postBody.partial(), req.body);
  const contentChanged = ["title", "message", "hashtags", "image_url", "link_url"].some(
    (k) => k in b && JSON.stringify((b as Row)[k] ?? null) !== JSON.stringify(post[k] ?? null),
  );
  const resetApproval = contentChanged && ["approved", "scheduled", "in_review", "failed"].includes(post.status);
  await q(
    `UPDATE posts SET title=COALESCE($2,title), message=COALESCE($3,message), hashtags=COALESCE($4,hashtags),
       image_url=CASE WHEN $11 THEN $5 ELSE image_url END, image_prompt=CASE WHEN $12 THEN $6 ELSE image_prompt END,
       link_url=CASE WHEN $13 THEN $7 ELSE link_url END, campaign_id=CASE WHEN $14 THEN $8 ELSE campaign_id END,
       scheduled_at=CASE WHEN $15 THEN $9 ELSE scheduled_at END,
       status=CASE WHEN $10 THEN 'draft' ELSE status END,
       approved_by=CASE WHEN $10 THEN NULL ELSE approved_by END, approved_at=CASE WHEN $10 THEN NULL ELSE approved_at END,
       next_attempt_at=CASE WHEN $10 THEN NULL ELSE next_attempt_at END, updated_at=now()
     WHERE id=$1`,
    [
      id,
      b.title ?? null,
      b.message ?? null,
      b.hashtags ?? null,
      b.image_url ?? null,
      b.image_prompt ?? null,
      b.link_url ?? null,
      b.campaign_id ?? null,
      b.scheduled_at ?? null,
      resetApproval,
      "image_url" in b,
      "image_prompt" in b,
      "link_url" in b,
      "campaign_id" in b,
      "scheduled_at" in b && !["scheduled"].includes(post.status),
    ],
  );
  if (resetApproval) await review(id, req, "comment", "Edited after review: needs approval again.");
  await audit(req, "post.updated", "post", id, { resetApproval });
  res.json({ post: await load(id), resetApproval });
});

postsRouter.delete("/:id", requirePerm("posts.edit"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, ["draft", "changes_requested", "cancelled", "failed"], "deleted");
  await q("DELETE FROM posts WHERE id=$1", [id]);
  await audit(req, "post.deleted", "post", id, { title: post.title });
  res.json({ ok: true });
});

postsRouter.post("/:id/submit", requirePerm("posts.edit"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, ["draft", "changes_requested"], "sent for review");
  const note = parse(z.object({ comment: z.string().max(1000).optional() }), req.body ?? {}).comment ?? null;
  await q("UPDATE posts SET status='in_review', updated_at=now() WHERE id=$1", [id]);
  await review(id, req, "submitted", note);
  await audit(req, "post.submitted", "post", id);
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/approve", requirePerm("posts.approve"), async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(z.object({ comment: z.string().max(1000).optional(), scheduleAt: z.string().datetime({ offset: true }).optional() }), req.body ?? {});
  const post = await load(id);
  requireStatus(post, ["in_review"], "approved");
  if (post.created_by === req.user!.id && req.user!.role !== "admin") throw forbidden("Someone other than the author needs to approve this post.");
  if (b.scheduleAt && !userCan(req, "posts.schedule")) throw forbidden("You can approve but not schedule.");
  if (b.scheduleAt && new Date(b.scheduleAt).getTime() < Date.now() - 60_000) throw badRequest("Pick a time in the future.");
  await tx(async (c) => {
    await q("UPDATE posts SET status='approved', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1", [id, req.user!.id], c);
    await q("INSERT INTO post_reviews (post_id, user_id, decision, comment) VALUES ($1,$2,'approved',$3)", [id, req.user!.id, b.comment ?? null], c);
    if (b.scheduleAt) {
      await q("UPDATE posts SET status='scheduled', scheduled_at=$2, next_attempt_at=$2, attempts=0, last_error=NULL WHERE id=$1", [id, b.scheduleAt], c);
      await q("INSERT INTO post_reviews (post_id, user_id, decision) VALUES ($1,$2,'scheduled')", [id, req.user!.id], c);
    }
  });
  await audit(req, "post.approved", "post", id, { scheduledAt: b.scheduleAt });
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/request-changes", requirePerm("posts.approve"), async (req, res) => {
  const id = intParam(req.params.id);
  const { comment } = parse(z.object({ comment: z.string().min(3, "Say what needs to change").max(1000) }), req.body);
  const post = await load(id);
  requireStatus(post, ["in_review"], "sent back");
  await q("UPDATE posts SET status='changes_requested', updated_at=now() WHERE id=$1", [id]);
  await review(id, req, "changes_requested", comment);
  await audit(req, "post.changes_requested", "post", id);
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/comment", requirePerm("posts.view"), async (req, res) => {
  const id = intParam(req.params.id);
  const { comment } = parse(z.object({ comment: z.string().min(1).max(1000) }), req.body);
  await load(id);
  await review(id, req, "comment", comment);
  res.json({ ok: true });
});

postsRouter.post("/:id/schedule", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const { scheduledAt } = parse(z.object({ scheduledAt: z.string().datetime({ offset: true }) }), req.body);
  const post = await load(id);
  requireStatus(post, ["approved", "scheduled"], "scheduled");
  if (!post.approved_by) throw conflict("This post needs approval before it can be scheduled.");
  if (new Date(scheduledAt).getTime() < Date.now() - 60_000) throw badRequest("Pick a time in the future.");
  await q("UPDATE posts SET status='scheduled', scheduled_at=$2, next_attempt_at=$2, attempts=0, last_error=NULL, updated_at=now() WHERE id=$1", [id, scheduledAt]);
  await review(id, req, "scheduled", new Date(scheduledAt).toISOString());
  await audit(req, "post.scheduled", "post", id, { scheduledAt });
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/publish-now", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, ["approved", "scheduled"], "published now");
  if (!post.approved_by) throw conflict("This post needs approval first.");
  await q("UPDATE posts SET status='scheduled', scheduled_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL, updated_at=now() WHERE id=$1", [id]);
  await review(id, req, "scheduled", "Publish now");
  await audit(req, "post.publish_now", "post", id);
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/unschedule", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, ["scheduled"], "unscheduled");
  await q("UPDATE posts SET status='approved', next_attempt_at=NULL, updated_at=now() WHERE id=$1", [id]);
  await review(id, req, "unscheduled");
  await audit(req, "post.unscheduled", "post", id);
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/retry", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, ["failed"], "retried");
  if (!post.approved_by) throw conflict("This post needs approval again before it can be retried.");
  await q("UPDATE posts SET status='scheduled', next_attempt_at=now(), attempts=0, last_error=NULL, updated_at=now() WHERE id=$1", [id]);
  await review(id, req, "scheduled", "Retry after failure");
  await audit(req, "post.retry", "post", id);
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/cancel", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, ["approved", "scheduled", "failed"], "cancelled");
  await q("UPDATE posts SET status='cancelled', next_attempt_at=NULL, updated_at=now() WHERE id=$1", [id]);
  await review(id, req, "cancelled");
  await audit(req, "post.cancelled", "post", id);
  res.json({ post: await load(id) });
});
