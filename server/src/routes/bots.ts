import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { one, q, tx } from "../lib/db.js";
import { badRequest, conflict, forbidden, HttpError, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { setSetting } from "../lib/settings.js";
import { requirePerm } from "../middleware/auth.js";
import { aiStatus } from "../services/ai.js";
import {
  activity,
  anyRuns,
  assertNotRunning,
  cancelRun,
  checkBatch,
  clearStaleRuns,
  DEFAULT_SCHEDULE,
  getRules,
  getStyle,
  handOff,
  loadBatch,
  plannedItems,
  postOutcomes,
  runState,
  scheduleBatch,
  scheduleOf,
  startRun,
  STYLE_MAX_CHARS,
  STYLE_MAX_SAMPLES,
  trainStyle,
  withRun,
  writeCaption,
} from "../services/bots.js";
import { isTimeZone } from "../services/bots.js";
import { teamOverview } from "../services/teamReview.js";
import { batchPlatforms, PLATFORM_IDS } from "../services/platforms/index.js";

export const botsRouter = Router();

const view = requirePerm("content.generate");
const edit = requirePerm("content.generate", "posts.edit");
// Team rules and the trained style apply to everyone's captions, so only brand owners change them.
const brand = requirePerm("settings.brand");

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, like 09:00");

/** Limits for adding posts (well under the 1 MB request limit). */
const BRIEF_MAX = 3000;
const ITEMS_MAX = 100;

// ---------------------------------------------------------------- overview (the office)

const BATCH_LIST_SQL = `SELECT b.id, b.name, b.created_at, b.updated_at, b.checked_at, b.handed_off_at, b.run_state, b.run_cancel,
              count(i.id)::int AS items,
              count(i.id) FILTER (WHERE coalesce(i.caption,'') <> '')::int AS captioned,
              count(i.id) FILTER (WHERE i.scheduled_at IS NOT NULL)::int AS timed,
              count(i.id) FILTER (WHERE i.post_id IS NOT NULL OR i.handed_off_at IS NOT NULL)::int AS handed,
              count(i.id) FILTER (WHERE i.post_id IS NULL AND i.handed_off_at IS NULL AND i.issues @> '[{"level":"bad"}]')::int AS blocked
       FROM bot_batches b LEFT JOIN bot_items i ON i.batch_id=b.id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const batchRow = ({ run_state, run_cancel, ...b }: any) => ({
  ...b,
  run: run_state ? { step: run_state.step, message: run_state.message, done: run_state.done, total: run_state.total, startedAt: run_state.startedAt, ...(run_cancel ? { cancelling: true } : {}) } : null,
});

botsRouter.get("/overview", view, async (req, res) => {
  await clearStaleRuns();
  const [ai, rules, style, batches, recent, outcomes, running] = await Promise.all([
    aiStatus(),
    getRules(),
    getStyle(),
    q(`${BATCH_LIST_SQL} GROUP BY b.id ORDER BY b.updated_at DESC LIMIT 50`),
    q(
      `SELECT a.id, a.bot, a.batch_id, a.level, a.message, a.created_at, COALESCE(b.name, a.batch_name) AS batch_name
       FROM bot_activity a LEFT JOIN bot_batches b ON b.id=a.batch_id ORDER BY a.created_at DESC LIMIT 40`,
    ),
    postOutcomes(),
    anyRuns(),
  ]);
  const admin = req.user!.role === "admin";
  res.json({
    // Fix instructions (.env, commands) are for administrators only.
    ai: admin ? ai : { ...ai, problem: ai.ready ? undefined : "The AI isn't running.", fix: ai.ready ? undefined : "Ask your administrator to start the AI." },
    rules,
    style: { trained: !!style.profile, profile: style.profile, sampleCount: style.samples.length, trainedAt: style.trainedAt },
    batches: batches.map(batchRow),
    running,
    activity: recent,
    outcomes,
    dryRun: env.PUBLISH_DRY_RUN,
    canScheduleDirectly: admin,
  });
});

/** The team's posts the bots are watching, and what they're doing right now (polled by the bots page). */
botsRouter.get("/team", requirePerm("posts.view"), async (_req, res) => {
  res.json(await teamOverview());
});

/** Planned by bots: items with a time that haven't been handed off yet (shown on the calendar). */
botsRouter.get("/planned", requirePerm("posts.view"), async (req, res) => {
  const { from, to } = parse(z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }), req.query);
  const f = new Date(from);
  const t = new Date(to);
  if (t <= f) throw badRequest("to must be after from.");
  if (t.getTime() - f.getTime() > 400 * 86_400_000) throw badRequest("Ask for at most 400 days at a time.");
  res.json({ items: await plannedItems(f, t) });
});

// ---------------------------------------------------------------- Caption Bot rules ("Team rules")

botsRouter.put("/rules", brand, async (req, res) => {
  const rules = parse(
    z.object({
      keywordCount: z.number().int().min(1).max(20),
      hashtags: z.boolean(),
      language: z.enum(["English", "Filipino", "Taglish"]),
      words: z.number().int().min(30).max(400),
      addDisclaimer: z.boolean(),
    }),
    req.body,
  );
  await setSetting("bots.rules", rules, req.user!.id);
  await activity("caption", `Team rules updated: ${rules.keywordCount} keywords, ${rules.hashtags ? "with" : "no"} hashtags, ${rules.language}, about ${rules.words} words${rules.addDisclaimer ? "" : ", no automatic disclaimer"}.`, { userId: req.user!.id });
  await audit(req, "bots.rules_updated", "settings", "bots.rules", rules);
  res.json({ rules });
});

// ---------------------------------------------------------------- Style Bot

botsRouter.post("/style/train", brand, async (req, res) => {
  const { samples } = parse(
    z.object({
      samples: z
        .array(z.string().max(STYLE_MAX_CHARS, `Each caption can be up to ${STYLE_MAX_CHARS} characters.`))
        .min(1)
        .max(STYLE_MAX_SAMPLES, `Send up to ${STYLE_MAX_SAMPLES} captions at a time.`),
    }),
    req.body,
  );
  const style = await trainStyle(samples, req.user!.id);
  await audit(req, "bots.style_trained", "settings", "bots.style", { samples: style.samples.length });
  res.json({ style: { trained: true, profile: style.profile, sampleCount: style.samples.length, trainedAt: style.trainedAt } });
});

botsRouter.delete("/style", brand, async (req, res) => {
  await setSetting("bots.style", { profile: "", samples: [], trainedAt: null }, req.user!.id);
  await activity("style", "Forgot the trained style. Captions follow the brand voice only.", { userId: req.user!.id });
  await audit(req, "bots.style_forgotten", "settings", "bots.style");
  res.json({ ok: true });
});

// ---------------------------------------------------------------- batches

/** Every batch (the overview only lists the newest 50), optionally filtered by name. */
botsRouter.get("/batches", view, async (req, res) => {
  const { search } = parse(z.object({ search: z.string().trim().max(120).optional() }), req.query);
  const rows = await q(`${BATCH_LIST_SQL} WHERE ($1::text IS NULL OR b.name ILIKE '%' || $1 || '%') GROUP BY b.id ORDER BY b.updated_at DESC LIMIT 500`, [search || null]);
  res.json({ batches: rows.map(batchRow) });
});

botsRouter.post("/batches", edit, async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(120), campaign_id: z.number().int().nullable().optional() }), req.body);
  const row = await one<{ id: number }>("INSERT INTO bot_batches (name, campaign_id, schedule, created_by) VALUES ($1,$2,$3,$4) RETURNING id", [
    b.name,
    b.campaign_id ?? null,
    JSON.stringify(DEFAULT_SCHEDULE),
    req.user!.id,
  ]);
  await audit(req, "bots.batch_created", "bot_batch", row!.id);
  res.status(201).json(await loadBatch(row!.id));
});

botsRouter.get("/batches/:id", view, async (req, res) => {
  const id = intParam(req.params.id);
  const data = await loadBatch(id);
  res.json({ ...data, schedule: scheduleOf(data.batch), run: await runState(id), ...(await batchPlatforms(data.batch)) });
});

const scheduleBody = z.object({
  days: z.enum(["daily", "weekdays", "mwf", "custom"]),
  customDays: z.array(z.number().int().min(0).max(6)).max(7),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  mode: z.enum(["smart", "auto", "times"]),
  times: z.array(hhmm).min(1).max(20),
  windowStart: hhmm,
  windowEnd: hhmm,
  perDay: z.number().int().min(1).max(100),
  minGapMinutes: z.number().int().min(0).max(24 * 60),
  /** Clock the days and times are read in (an IANA name like Asia/Manila). Older batches don't have it. */
  timeZone: z
    .string()
    .max(64)
    .refine((tz) => isTimeZone(tz), "Pick a time zone from the list.")
    .optional(),
});

botsRouter.patch("/batches/:id", edit, async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      campaign_id: z.number().int().nullable().optional(),
      schedule: scheduleBody.optional(),
      // The platforms this batch's posts go to; null goes back to the default platforms.
      platforms: z.array(z.enum(PLATFORM_IDS)).min(1, "Pick at least one platform.").max(PLATFORM_IDS.length).nullable().optional(),
    }),
    req.body,
  );
  if (b.schedule?.days === "custom" && !b.schedule.customDays.length) throw badRequest("Pick at least one day.");
  if (b.schedule && b.schedule.windowEnd < b.schedule.windowStart) throw badRequest("The posting window has to end after it starts.");
  await loadBatch(id);
  if (b.schedule || "platforms" in b) await assertNotRunning(id);
  // New platforms make the last check out of date (which posts skip which platform changes).
  await q(
    `UPDATE bot_batches SET name=COALESCE($2,name), campaign_id=CASE WHEN $3 THEN $4 ELSE campaign_id END, schedule=COALESCE($5,schedule),
       platforms=CASE WHEN $6 THEN $7::text[] ELSE platforms END, checked_at=CASE WHEN $6 THEN NULL ELSE checked_at END, updated_at=now() WHERE id=$1`,
    [id, b.name ?? null, "campaign_id" in b, b.campaign_id ?? null, b.schedule ? JSON.stringify(b.schedule) : null, "platforms" in b, b.platforms ?? null],
  );
  if ("platforms" in b) await audit(req, "bots.batch_platforms", "bot_batch", id, { platforms: b.platforms ?? "defaults" });
  const data = await loadBatch(id);
  res.json({ ...data, schedule: scheduleOf(data.batch), run: await runState(id), ...(await batchPlatforms(data.batch)) });
});

botsRouter.delete("/batches/:id", edit, async (req, res) => {
  const id = intParam(req.params.id);
  const { batch } = await loadBatch(id);
  await assertNotRunning(id);
  // Posts already handed off stay in Posts and approvals; only the batch goes (its activity history stays).
  // The run check is repeated in the DELETE itself so a run that starts meanwhile isn't pulled from under the bots.
  const gone = await one(
    `DELETE FROM bot_batches WHERE id=$1 AND (run_state IS NULL OR run_heartbeat_at IS NULL OR run_heartbeat_at < now() - interval '3 minutes') RETURNING id`,
    [id],
  );
  if (!gone) throw conflict("The bots are working on this batch. Wait for them to finish, or cancel the run.");
  await audit(req, "bots.batch_deleted", "bot_batch", id, { name: batch.name });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- items

const itemBody = z.object({
  title: z.string().max(200).optional(),
  brief: z.string().max(BRIEF_MAX, `Keep what it's about under ${BRIEF_MAX.toLocaleString("en")} characters.`),
  media_type: z.enum(["none", "image", "video"]).default("none"),
  media_url: z.string().trim().max(1000).nullable().optional(),
  /** An uploaded image or video (POST /api/media). Takes the place of media_url. */
  media_id: z.number().int().positive().nullable().optional(),
});

/** The kind of an uploaded file, or 400 if it doesn't exist. */
async function uploadedKind(id: number): Promise<"image" | "video"> {
  const m = await one<{ kind: "image" | "video" }>("SELECT kind FROM media WHERE id=$1", [id]);
  if (!m) throw badRequest("That uploaded file wasn't found. Upload it again.");
  return m.kind;
}

botsRouter.post("/batches/:id/items", edit, async (req, res) => {
  const id = intParam(req.params.id);
  await assertNotRunning(id);
  const { items } = parse(z.object({ items: z.array(itemBody).min(1).max(ITEMS_MAX, `Add up to ${ITEMS_MAX} posts at a time.`) }), req.body);
  await loadBatch(id);
  const start = (await one<{ n: number }>("SELECT coalesce(max(position), 0)::int AS n FROM bot_items WHERE batch_id=$1", [id]))!.n;
  const count = (await one<{ n: number }>("SELECT count(*)::int AS n FROM bot_items WHERE batch_id=$1", [id]))!.n;
  if (count + items.length > 200) throw badRequest("A batch can hold up to 200 posts. Start a new batch for the rest.");
  await tx(async (c) => {
    for (const [i, it] of items.entries()) {
      if (!it.brief.trim() && !it.media_url && !it.media_id) throw badRequest(`Post ${i + 1}: say what it's about.`);
      const uploaded = it.media_id ? await uploadedKind(it.media_id) : null;
      await q("INSERT INTO bot_items (batch_id, position, title, brief, media_type, media_url, media_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
        id,
        start + i + 1,
        it.title?.trim() ?? "",
        it.brief.trim(),
        uploaded ?? (it.media_url ? it.media_type : "none"),
        uploaded ? null : it.media_url || null,
        it.media_id ?? null,
      ], c);
    }
    // New posts haven't been checked yet.
    await q("UPDATE bot_batches SET checked_at=NULL, updated_at=now() WHERE id=$1", [id], c);
  });
  res.status(201).json(await loadBatch(id));
});

async function loadItem(id: number) {
  const item = await one("SELECT * FROM bot_items WHERE id=$1", [id]);
  if (!item) throw notFound("Post in this batch");
  return item;
}

const handedOffMsg = "This post was already handed off. Edit it in Posts and approvals.";

botsRouter.patch("/items/:id", edit, async (req, res) => {
  const id = intParam(req.params.id);
  const item = await loadItem(id);
  await assertNotRunning(item.batch_id);
  if (item.post_id || item.handed_off_at) throw conflict(handedOffMsg);
  const b = parse(
    itemBody.partial().extend({
      caption: z.string().max(5000).nullable().optional(),
      keywords: z.array(z.string().max(80)).max(30).optional(),
      hashtags: z.array(z.string().max(60)).max(30).optional(),
      scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
      time_locked: z.boolean().optional(),
    }),
    req.body,
  );
  // An uploaded file replaces any link, and sets the media type from the file itself.
  if (b.media_id) {
    b.media_type = await uploadedKind(b.media_id);
    b.media_url = null;
  }
  const set: string[] = [];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    params.push(k === "media_url" ? v || null : v);
    set.push(`${k}=$${params.length}`);
  }
  // A person setting the time keeps it; clearing the time lets the Scheduler Bot pick again.
  if ("scheduled_at" in b && !("time_locked" in b)) set.push(b.scheduled_at ? "time_locked=true" : "time_locked=false");
  if (set.length) {
    await tx(async (c) => {
      // The last check no longer applies to the edited post: clear its findings and the batch's "checked" mark.
      const row = await one(
        `UPDATE bot_items SET ${set.join(", ")}, issues='[]'::jsonb, updated_at=now() WHERE id=$1 AND post_id IS NULL AND handed_off_at IS NULL RETURNING id`,
        params,
        c,
      );
      if (!row) throw conflict(handedOffMsg);
      await q("UPDATE bot_batches SET checked_at=NULL, updated_at=now() WHERE id=$1", [item.batch_id], c);
    });
  }
  res.json({ item: await loadItem(id) });
});

botsRouter.delete("/items/:id", edit, async (req, res) => {
  const id = intParam(req.params.id);
  const item = await loadItem(id);
  await assertNotRunning(item.batch_id);
  await q("DELETE FROM bot_items WHERE id=$1", [id]);
  res.json({ ok: true });
});

botsRouter.post("/batches/:id/reorder", edit, async (req, res) => {
  const id = intParam(req.params.id);
  await assertNotRunning(id);
  const { ids } = parse(z.object({ ids: z.array(z.number().int()).max(200) }), req.body);
  await tx(async (c) => {
    for (const [i, itemId] of ids.entries()) await q("UPDATE bot_items SET position=$3 WHERE id=$1 AND batch_id=$2", [itemId, id, i + 1], c);
  });
  res.json(await loadBatch(id));
});

/** Rewrites one caption straight away (used from the post's edit window). */
botsRouter.post("/items/:id/caption", edit, async (req, res) => {
  const id = intParam(req.params.id);
  const item = await loadItem(id);
  await assertNotRunning(item.batch_id);
  if (item.post_id || item.handed_off_at) throw conflict("This post was already handed off.");
  await assertAiReady(req.user!.role);
  const c = await writeCaption(item);
  await tx(async (db) => {
    await q(
      `UPDATE bot_items SET caption=$2, keywords=$3, hashtags=$4, title=CASE WHEN title='' THEN $5 ELSE title END, caption_error=NULL, issues='[]'::jsonb, updated_at=now()
       WHERE id=$1 AND post_id IS NULL AND handed_off_at IS NULL`,
      [id, c.caption, c.keywords, c.hashtags, c.title],
      db,
    );
    await q("UPDATE bot_batches SET checked_at=NULL, updated_at=now() WHERE id=$1", [item.batch_id], db);
  });
  await activity("caption", `Rewrote the caption for "${(item.title || c.title).slice(0, 60)}".`, { batchId: item.batch_id, level: "good", userId: req.user!.id });
  res.json({ item: await loadItem(id) });
});

// ---------------------------------------------------------------- the bots at work

async function assertAiReady(role: string) {
  const ai = await aiStatus();
  if (ai.ready) return;
  // Only administrators can fix it, so only they see the technical details.
  if (role === "admin") throw new HttpError(503, `${ai.label} isn't ready: ${ai.problem} ${ai.fix ?? ""}`.trim());
  throw new HttpError(503, "The AI isn't running, so the Caption Bot can't write. Ask your administrator to start the AI.");
}

botsRouter.post("/batches/:id/run", edit, async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(
    z.object({ steps: z.array(z.enum(["caption", "edit", "schedule", "check"])).min(1).default(["caption", "edit", "schedule", "check"]), recaption: z.boolean().default(false) }),
    req.body ?? {},
  );
  const { items } = await loadBatch(id);
  if (!items.some((i) => !i.post_id && !i.handed_off_at)) throw badRequest("Add some posts to the batch first.");
  if (b.steps.includes("caption") || b.steps.includes("edit")) await assertAiReady(req.user!.role);
  const order = (["caption", "edit", "schedule", "check"] as const).filter((s) => b.steps.includes(s));
  const run = await startRun(id, req.user!.id, { steps: [...order], recaption: b.recaption });
  res.status(202).json({ run });
});

botsRouter.post("/batches/:id/cancel", edit, async (req, res) => {
  const id = intParam(req.params.id);
  await loadBatch(id);
  const cancelled = await cancelRun(id, req.user!.id);
  res.json({ cancelled, run: await runState(id) });
});

botsRouter.post("/batches/:id/schedule", edit, async (req, res) => {
  const id = intParam(req.params.id);
  const r = await withRun(id, "schedule", req.user!.id, "Picking dates and times", async () => {
    const s = await scheduleBatch(id, req.user!.id);
    await checkBatch(id, req.user!.id);
    return s;
  });
  res.json({ ...r, ...(await loadBatch(id)) });
});

botsRouter.post("/batches/:id/check", edit, async (req, res) => {
  const id = intParam(req.params.id);
  const r = await withRun(id, "check", req.user!.id, "Checking every post", () => checkBatch(id, req.user!.id));
  res.json({ ...r, ...(await loadBatch(id)) });
});

botsRouter.post("/batches/:id/handoff", edit, async (req, res) => {
  const id = intParam(req.params.id);
  const { mode } = parse(z.object({ mode: z.enum(["review", "schedule"]).default("review") }), req.body ?? {});
  // Posts normally need someone other than the author to approve them; only an administrator may skip that.
  if (mode === "schedule" && req.user!.role !== "admin") throw forbidden("Only an administrator can schedule posts without a review.");
  // The whole hand-off holds the batch's run slot: no edits, runs, deletes or second hand-off meanwhile.
  const r = await withRun(id, "handoff", req.user!.id, "Handing posts over", (ctl) => handOff(id, req.user!, mode, ctl));
  await audit(req, "bots.handoff", "bot_batch", id, { mode, created: r.created, skipped: r.skipped.length });
  res.json({ ...r, ...(await loadBatch(id)) });
});
