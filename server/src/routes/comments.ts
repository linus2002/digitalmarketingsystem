import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { safeDecrypt } from "../lib/crypto.js";
import { one, q } from "../lib/db.js";
import { forbidden, intParam, parse } from "../lib/http.js";
import { requirePerm, userCan } from "../middleware/auth.js";
import { getComment, hideComment, privateReply, publicReply, setCommentStatus, syncComments } from "../services/comments.js";

// Comments inbox: comments on the Facebook Page's and Instagram account's posts.
// Seen by the inquiry team (leads.view); answered by people who can reply to inquiries (leads.reply).
// Comments the keyword rules flag for the pharmaceutical team can only be answered in public by them (leads.review).

export const commentsRouter = Router();

const listSchema = z.object({
  show: z.enum(["inquiries", "open", "review", "done", "all"]).default("inquiries"),
  platform: z.enum(["facebook", "instagram", "all"]).default("all"),
});

commentsRouter.get("/", requirePerm("leads.view"), async (req, res) => {
  const f = parse(listSchema, req.query);
  const where: string[] = [];
  if (f.show === "inquiries") where.push("c.status='open' AND c.is_inquiry");
  if (f.show === "open") where.push("c.status='open'");
  if (f.show === "review") where.push("c.status='open' AND c.needs_review");
  if (f.show === "done") where.push("c.status<>'open'");
  const params: unknown[] = [];
  if (f.platform !== "all") {
    params.push(f.platform);
    where.push(`c.platform=$${params.length}`);
  }
  const rows = await q(
    `SELECT c.*, u.name AS handled_by_name FROM social_comments c LEFT JOIN users u ON u.id=c.handled_by
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.commented_at DESC LIMIT 200`,
    params,
  );
  const counts = await one<{ inquiries: number; open: number; review: number }>(
    `SELECT count(*) FILTER (WHERE status='open' AND is_inquiry)::int AS inquiries, count(*) FILTER (WHERE status='open')::int AS open,
       count(*) FILTER (WHERE status='open' AND needs_review)::int AS review FROM social_comments`,
  );
  const last = await one<{ at: Date | null }>("SELECT max(created_at) AS at FROM social_comments");
  res.json({
    comments: rows.map(({ body_enc, author_name_enc, author_id: _a, ...c }) => ({
      ...c,
      text: safeDecrypt(body_enc) ?? "",
      author: safeDecrypt(author_name_enc),
    })),
    counts,
    lastReceivedAt: last?.at ?? null,
    testMode: env.MESSENGER_DRY_RUN,
    canReply: userCan(req, "leads.reply"),
    canReview: userCan(req, "leads.review"),
  });
});

commentsRouter.post("/sync", requirePerm("leads.view"), async (_req, res) => {
  res.json(await syncComments());
});

/** Comments flagged for the pharmaceutical team: only they answer those in public. */
async function assertCanAnswerPublicly(req: Parameters<typeof userCan>[0], id: number) {
  const c = await getComment(id);
  if (c.needs_review && !userCan(req, "leads.review"))
    throw forbidden("This comment mentions prescriptions, medical, regulatory or availability topics, so the pharmaceutical team answers it. You can still reply privately.");
}

commentsRouter.post("/:id/private-reply", requirePerm("leads.reply"), async (req, res) => {
  const id = intParam(req.params.id);
  const r = await privateReply(id, req.user!.id);
  await audit(req, "comment.private_reply", "comment", id, { dryRun: r.dryRun });
  res.json(r);
});

commentsRouter.post("/:id/reply", requirePerm("leads.reply"), async (req, res) => {
  const id = intParam(req.params.id);
  const { text } = parse(z.object({ text: z.string().trim().min(1, "Write a reply first.").max(2000) }), req.body);
  await assertCanAnswerPublicly(req, id);
  const r = await publicReply(id, text, req.user!.id);
  await audit(req, "comment.public_reply", "comment", id, { dryRun: r.dryRun });
  res.json(r);
});

commentsRouter.post("/:id/hide", requirePerm("leads.reply"), async (req, res) => {
  const id = intParam(req.params.id);
  const r = await hideComment(id, req.user!.id);
  await audit(req, "comment.hidden", "comment", id, { dryRun: r.dryRun });
  res.json(r);
});

commentsRouter.post("/:id/status", requirePerm("leads.reply"), async (req, res) => {
  const id = intParam(req.params.id);
  const { status } = parse(z.object({ status: z.enum(["open", "dismissed"]) }), req.body);
  await setCommentStatus(id, status, req.user!.id);
  await audit(req, status === "open" ? "comment.reopened" : "comment.dismissed", "comment", id);
  res.json({ ok: true });
});
