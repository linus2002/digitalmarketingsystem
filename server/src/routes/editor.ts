import { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "../lib/db.js";
import { badRequest, conflict, HttpError, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { getBrand } from "../lib/settings.js";
import { requirePerm } from "../middleware/auth.js";
import { aiStatus } from "../services/ai.js";
import { activity, assertNotRunning } from "../services/bots.js";
import { DEFAULT_STANDARDS, evaluate, getStandards, revise, saveStandards } from "../services/editor.js";

// The Editor Bot: the creator's standards, checking a caption against them, and revisions (before/after)
// that wait for a person to accept or reject them.

export const editorRouter = Router();
const view = requirePerm("content.generate");

editorRouter.get("/standards", view, async (_req, res) => {
  res.json({ standards: await getStandards(), defaults: DEFAULT_STANDARDS });
});

const list = (max: number) => z.array(z.string().trim().min(1).max(200)).max(max);

editorRouter.put("/standards", requirePerm("settings.brand"), async (req, res) => {
  const s = parse(
    z
      .object({
        minWords: z.number().int().min(5).max(1000),
        maxWords: z.number().int().min(10).max(1000),
        maxEmojis: z.number().int().min(0).max(30),
        requireHook: z.boolean(),
        requireCta: z.boolean(),
        mustInclude: list(20),
        mustAvoid: list(50),
        language: z.enum(["", "English", "Filipino", "Taglish"]),
        tone: z.string().trim().max(300),
        customRules: list(15),
        autoRevise: z.boolean(),
        maxTries: z.number().int().min(1).max(3),
      })
      .refine((v) => v.maxWords >= v.minWords, { message: "The maximum length must be at least the minimum.", path: ["maxWords"] }),
    req.body,
  );
  await saveStandards(s, req.user!.id);
  await activity("editor", `Standards updated: ${s.minWords}–${s.maxWords} words, up to ${s.maxEmojis} emojis${s.requireHook ? ", hook" : ""}${s.requireCta ? ", call to action" : ""}${s.autoRevise ? ", auto-revise on" : ""}.`, { userId: req.user!.id });
  await audit(req, "bots.standards_updated", "settings", "bots.standards");
  res.json({ standards: s });
});

/** How a caption scores against the standards (no AI, instant). */
editorRouter.post("/check", view, async (req, res) => {
  const { text } = parse(z.object({ text: z.string().max(10_000) }), req.body);
  const [s, brand] = await Promise.all([getStandards(), getBrand()]);
  res.json({ results: evaluate(text, s, brand) });
});

/** Revises a caption and saves the suggestion (pending) for a person to accept or reject. */
editorRouter.post("/revise", view, async (req, res) => {
  const b = parse(
    z.object({
      text: z.string().trim().min(1, "There's no text to revise yet.").max(10_000),
      feedback: z.string().trim().max(600).nullable().optional(),
      post_id: z.number().int().positive().nullable().optional(),
      item_id: z.number().int().positive().nullable().optional(),
    }),
    req.body,
  );
  const ai = await aiStatus();
  if (!ai.ready) throw new HttpError(503, req.user!.role === "admin" ? `${ai.label} isn't ready: ${ai.problem ?? ""}`.trim() : "The AI isn't running, so the Editor Bot can't revise. Ask your administrator to start the AI.");
  if (b.post_id && !(await one("SELECT id FROM posts WHERE id=$1", [b.post_id]))) throw notFound("Post");
  if (b.item_id) {
    const item = await one("SELECT batch_id, post_id, handed_off_at FROM bot_items WHERE id=$1", [b.item_id]);
    if (!item) throw notFound("Post in this batch");
    if (item.post_id || item.handed_off_at) throw conflict("This post was already handed off. Revise it in Post approvals.");
  }
  const abort = new AbortController();
  req.on("close", () => !res.writableEnded && abort.abort());
  // A second pass only happens if the first one still misses a rule.
  const r = await revise(b.text, { feedback: b.feedback, signal: abort.signal, tries: 2 });
  const rev = await one(
    `INSERT INTO content_revisions (post_id, bot_item_id, before_text, after_text, feedback, results_before, results_after, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, before_text, after_text, results_before, results_after, status, created_at`,
    [b.post_id ?? null, b.item_id ?? null, b.text, r.text, b.feedback ?? null, JSON.stringify(r.before), JSON.stringify(r.after), req.user!.id],
  );
  res.status(201).json({ revision: rev });
});

/**
 * Accept or reject a suggestion. Accepting one for a bot batch item applies it here (the caption hasn't been approved
 * yet); for a real post the editor puts the text in the form, so saving goes through the normal approval rules.
 */
editorRouter.post("/revisions/:id/decide", view, async (req, res) => {
  const id = intParam(req.params.id);
  const { accepted } = parse(z.object({ accepted: z.boolean() }), req.body);
  const rev = await one("SELECT * FROM content_revisions WHERE id=$1", [id]);
  if (!rev) throw notFound("Revision");
  if (rev.status !== "pending") throw conflict("This revision was already decided.");
  if (accepted && rev.bot_item_id) {
    const item = await one("SELECT batch_id, caption, post_id, handed_off_at FROM bot_items WHERE id=$1", [rev.bot_item_id]);
    if (!item) throw notFound("Post in this batch");
    if (item.post_id || item.handed_off_at) throw conflict("This post was already handed off.");
    await assertNotRunning(item.batch_id);
    if ((item.caption ?? "").trim() !== String(rev.before_text).trim()) throw conflict("The caption changed since this revision was made. Ask the Editor Bot to revise it again.");
    await tx(async (c) => {
      await q("UPDATE bot_items SET caption=$2, issues='[]'::jsonb, updated_at=now() WHERE id=$1", [rev.bot_item_id, rev.after_text], c);
      await q("UPDATE bot_batches SET checked_at=NULL, updated_at=now() WHERE id=$1", [item.batch_id], c);
    });
  }
  const row = await one(
    "UPDATE content_revisions SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='pending' RETURNING id, status, after_text",
    [id, accepted ? "accepted" : "rejected", req.user!.id],
  );
  if (!row) throw conflict("This revision was already decided.");
  res.json({ revision: row });
});

/** Revision history for a post or a bot batch item (newest first). */
editorRouter.get("/revisions", view, async (req, res) => {
  const f = parse(z.object({ post_id: z.coerce.number().int().positive().optional(), item_id: z.coerce.number().int().positive().optional() }), req.query);
  if (!f.post_id && !f.item_id) throw badRequest("Say which post.");
  const rows = await q(
    `SELECT r.id, r.before_text, r.after_text, r.feedback, r.results_before, r.results_after, r.status, r.created_at, r.decided_at, u.name AS created_by_name
     FROM content_revisions r LEFT JOIN users u ON u.id = r.created_by
     WHERE ${f.post_id ? "r.post_id=$1" : "r.bot_item_id=$1"} ORDER BY r.id DESC LIMIT 30`,
    [f.post_id ?? f.item_id],
  );
  res.json({ revisions: rows });
});
