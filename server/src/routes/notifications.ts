import { Router } from "express";
import { z } from "zod";
import { one, q } from "../lib/db.js";
import { badRequest, intParam, notFound, parse } from "../lib/http.js";
import { pruneNotifications } from "../services/notifications.js";

// Every signed-in user has their own notifications and notes; nobody can see anyone else's.

export const notificationsRouter = Router();

notificationsRouter.get("/", async (req, res) => {
  const { limit, after } = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), after: z.coerce.number().int().min(0).optional() }), req.query);
  const uid = req.user!.id;
  const [items, unread] = await Promise.all([
    q(
      `SELECT id, bot, kind, level, title, body, link, read_at, created_at FROM notifications
       WHERE user_id=$1 ${after !== undefined ? "AND id > $3" : ""} ORDER BY created_at DESC, id DESC LIMIT $2`,
      after !== undefined ? [uid, limit, after] : [uid, limit],
    ),
    one<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [uid]),
  ]);
  if (Math.random() < 0.02) void pruneNotifications();
  res.json({ items, unread: unread?.n ?? 0 });
});

notificationsRouter.post("/read-all", async (req, res) => {
  await q("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [req.user!.id]);
  res.json({ ok: true });
});

notificationsRouter.post("/:id/read", async (req, res) => {
  const id = intParam(req.params.id);
  const row = await one("UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id", [id, req.user!.id]);
  if (!row) throw notFound("Notification");
  res.json({ ok: true });
});

notificationsRouter.delete("/read", async (req, res) => {
  await q("DELETE FROM notifications WHERE user_id=$1 AND read_at IS NOT NULL", [req.user!.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- notes (personal to-dos)

export const notesRouter = Router();
const MAX_NOTES = 300;

const noteBody = z.object({
  text: z.string().trim().min(1, "Write something first").max(1000),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
});

notesRouter.get("/", async (req, res) => {
  const notes = await q(
    `SELECT id, text, done, due_at, done_at, created_at, updated_at FROM user_notes WHERE user_id=$1
     ORDER BY done, (due_at IS NULL), due_at, created_at DESC LIMIT ${MAX_NOTES}`,
    [req.user!.id],
  );
  res.json({ notes, open: notes.filter((n) => !n.done).length });
});

notesRouter.post("/", async (req, res) => {
  const b = parse(noteBody, req.body);
  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM user_notes WHERE user_id=$1", [req.user!.id]);
  if ((count?.n ?? 0) >= MAX_NOTES) throw badRequest(`You have ${MAX_NOTES} notes. Delete some finished ones first.`);
  const note = await one("INSERT INTO user_notes (user_id, text, due_at) VALUES ($1,$2,$3) RETURNING *", [req.user!.id, b.text, b.due_at ?? null]);
  res.status(201).json({ note });
});

notesRouter.patch("/:id", async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(noteBody.partial().extend({ done: z.boolean().optional() }), req.body);
  const note = await one(
    `UPDATE user_notes SET text=COALESCE($3,text), due_at=CASE WHEN $4 THEN $5::timestamptz ELSE due_at END,
       done=COALESCE($6,done), done_at=CASE WHEN $6 IS NULL THEN done_at WHEN $6 THEN COALESCE(done_at, now()) ELSE NULL END, updated_at=now()
     WHERE id=$1 AND user_id=$2 RETURNING *`,
    [id, req.user!.id, b.text ?? null, "due_at" in b, b.due_at ?? null, b.done ?? null],
  );
  if (!note) throw notFound("Note");
  res.json({ note });
});

notesRouter.delete("/:id", async (req, res) => {
  const id = intParam(req.params.id);
  const row = await one("DELETE FROM user_notes WHERE id=$1 AND user_id=$2 RETURNING id", [id, req.user!.id]);
  if (!row) throw notFound("Note");
  res.json({ ok: true });
});

notesRouter.delete("/", async (req, res) => {
  // "Clear finished"
  await q("DELETE FROM user_notes WHERE user_id=$1 AND done", [req.user!.id]);
  res.json({ ok: true });
});
