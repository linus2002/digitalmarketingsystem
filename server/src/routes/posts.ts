import { Router, type Request } from "express";
import { z } from "zod";
import { one, q, tx, type Db, type Row } from "../lib/db.js";
import { badRequest, conflict, forbidden, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { notify, usersWithPerm } from "../services/notifications.js";
import { fmtPh } from "../services/bots.js";
import { requirePerm, userCan } from "../middleware/auth.js";
import { composeMessage } from "../services/publisher.js";
import { postBotStatus } from "../services/teamReview.js";
import { toFacebookText } from "../lib/fbText.js";
import { env } from "../config/env.js";
import { platformProblem } from "../lib/platformRules.js";
import { connectedPlatforms, defaultPlatformsFor, getDefaultPlatforms, PLATFORM_IDS, PLATFORM_LABEL, type PlatformId } from "../services/platforms/index.js";

export const postsRouter = Router();

// draft → in_review → approved → scheduled → publishing → published
//            ↘ changes_requested → (edit) → in_review          ↘ failed → (retry) → scheduled
// Editing an approved or scheduled post sends it back to draft: what gets published is always what was approved.

// Media must be something Facebook can download: https, a public host, and (for video) a direct file.
const PAGE_HOSTS = /(^|\.)(facebook\.com|fb\.watch|fb\.com|instagram\.com|youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|drive\.google\.com|docs\.google\.com|dropbox\.com)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // single-label intranet name
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}

/** Same rules as client/src/pages/PostEditor.tsx mediaProblem(). */
function mediaUrl(kind: "image" | "video") {
  return z
    .string()
    .trim()
    .max(1000)
    .url()
    .superRefine((v, ctx) => {
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return;
      }
      const fail = (message: string) => ctx.addIssue({ code: "custom", message });
      if (u.protocol !== "https:") return fail(`The ${kind} link must start with https://`);
      if (u.username || u.password) return fail(`The ${kind} link can't contain a username or password.`);
      if (isPrivateHost(u.hostname)) return fail(`The ${kind} link must be on a public website Facebook can reach (not localhost or a private network).`);
      if (PAGE_HOSTS.test(u.hostname)) return fail(`That's a link to a web page, not the ${kind} file itself. Use a direct link to the file.`);
      if (kind === "video" && !VIDEO_EXT.test(u.pathname)) return fail("The video link must point directly to a .mp4, .mov, .m4v or .webm file.");
    });
}

const postBody = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(5000),
  hashtags: z.array(z.string().max(60)).max(30).default([]),
  image_url: mediaUrl("image").nullable().optional(),
  video_url: mediaUrl("video").nullable().optional(),
  /** An uploaded image or video (POST /api/media). */
  media_id: z.number().int().positive().nullable().optional(),
  image_prompt: z.string().max(2000).nullable().optional(),
  link_url: z.string().url().max(1000).nullable().optional(),
  campaign_id: z.number().int().nullable().optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  ai_generated: z.boolean().optional(),
  source_topic: z.string().max(300).nullable().optional(),
  /** Where it goes. Defaults to Facebook. */
  platforms: z.array(z.enum(PLATFORM_IDS)).min(1, "Pick at least one platform.").max(PLATFORM_IDS.length).optional(),
});

const BOTH_MEDIA = "Use one image or one video per post (an upload or a link, not both). Remove the others.";
/** Fields that change what gets published. Same list as the editor's "needs approval again" warning. */
const CONTENT_FIELDS = ["title", "message", "hashtags", "image_url", "video_url", "media_id", "link_url"] as const;

/** Each platform the post goes to, with its own status and link. */
const TARGETS_SQL = `(SELECT COALESCE(json_agg(json_build_object('platform', t.platform, 'status', t.status, 'url', t.external_url, 'error', t.last_error,
                       'published_at', t.published_at, 'uncertain', t.uncertain) ORDER BY t.id), '[]'::json) FROM post_targets t WHERE t.post_id = p.id) AS targets`;

/** Sets the platforms a post goes to. Ones it's already published on always stay. */
async function setPlatforms(postId: number, platforms: PlatformId[], db?: Db) {
  await q("DELETE FROM post_targets WHERE post_id=$1 AND status <> 'published' AND NOT (platform = ANY($2::text[]))", [postId, platforms], db);
  await q("INSERT INTO post_targets (post_id, platform) SELECT $1, unnest($2::text[]) ON CONFLICT (post_id, platform) DO NOTHING", [postId, platforms], db);
}

/**
 * Before scheduling: failed platforms get another go, except ones whose post may already be live (no answer, or
 * interrupted mid-send). Those wait until a person checks the platform and says what they found
 * (POST /:id/targets/:platform), so Try again never posts twice.
 */
async function resetFailedTargets(postId: number, db?: Db) {
  await q("UPDATE post_targets SET status='pending', last_error=NULL, updated_at=now() WHERE post_id=$1 AND status='failed' AND NOT uncertain", [postId], db);
}

/** Problems that would stop the post going out on one of its platforms (rules, and connections when live). */
async function platformProblems(post: Row, rulesOnly = false): Promise<string[]> {
  const targets = await q<{ platform: PlatformId }>("SELECT platform FROM post_targets WHERE post_id=$1 AND status <> 'published'", [post.id]);
  const list = targets.length ? targets.map((t) => t.platform) : (["facebook"] as PlatformId[]);
  const media = post.media_id
    ? { kind: post.media_kind as "image" | "video", mime: post.media_mime as string }
    : post.video_url
      ? { kind: "video" as const }
      : post.image_url
        ? { kind: "image" as const }
        : null;
  const text = toFacebookText(composeMessage(post as { message: string; hashtags: string[] }));
  const connected = env.PUBLISH_DRY_RUN || rulesOnly ? null : await connectedPlatforms();
  const out: string[] = [];
  for (const p of list) {
    const problem = platformProblem(p, { text, link: post.link_url ?? null, media });
    if (problem) out.push(problem);
    else if (connected && !connected[p]) out.push(`${PLATFORM_LABEL[p]} isn't connected (Settings → Social accounts).`);
  }
  return out;
}
async function requirePlatformsReady(post: Row) {
  const problems = await platformProblems(post);
  if (problems.length) throw badRequest(`This post can't go out yet: ${problems.join(" ")} Fix it, or take that platform off the post.`);
}

async function checkMediaExists(id: number | null | undefined) {
  if (!id) return;
  if (!(await one("SELECT id FROM media WHERE id=$1", [id]))) throw badRequest("That uploaded file wasn't found. Upload it again.");
}
const mediaCount = (...xs: unknown[]) => xs.filter(Boolean).length;
const EDITABLE = ["draft", "changes_requested", "in_review", "approved", "scheduled", "failed"];

async function load(id: number): Promise<Row> {
  const post = await one(
    `SELECT p.*, c.name AS campaign_name, cu.name AS created_by_name, au.name AS approved_by_name, eu.name AS last_edited_by_name,
            md.kind AS media_kind, md.mime AS media_mime, md.original_name AS media_name, md.size_bytes AS media_size, ${TARGETS_SQL}
     FROM posts p LEFT JOIN campaigns c ON c.id=p.campaign_id LEFT JOIN users cu ON cu.id=p.created_by LEFT JOIN users au ON au.id=p.approved_by
     LEFT JOIN users eu ON eu.id=p.last_edited_by LEFT JOIN media md ON md.id=p.media_id
     WHERE p.id=$1`,
    [id],
  );
  if (!post) throw notFound("Post");
  return post;
}

async function review(postId: number, req: Request, decision: string, comment: string | null = null, db?: Db) {
  await q("INSERT INTO post_reviews (post_id, user_id, decision, comment) VALUES ($1,$2,$3,$4)", [postId, req.user!.id, decision, comment], db);
}

function requireStatus(post: Row, allowed: string[], action: string) {
  if (!allowed.includes(post.status)) throw conflict(`A ${String(post.status).replaceAll("_", " ")} post can't be ${action}.`);
}

/**
 * Runs a status-changing UPDATE only if the post is still in one of the allowed states: the JS
 * check before it can race with the publisher or another person. $1 = id, $2 = allowed states, extra params from $3.
 */
async function guarded(sql: string, id: number, allowed: string[], params: unknown[], action: string, db?: Db) {
  const rows = await q(`${sql} WHERE id=$1 AND status = ANY($2::text[]) RETURNING id`, [id, allowed, ...params], db);
  if (!rows.length) throw conflict(`This post changed in the meantime, so it couldn't be ${action}. Reload and try again.`);
}

const dateParam = z
  .string()
  .trim()
  .refine(
    (v) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v)),
    "must be a date (YYYY-MM-DD) or an ISO date-time",
  )
  .optional();

postsRouter.get("/", requirePerm("posts.view"), async (req, res) => {
  const f = parse(
    z.object({
      status: z.string().max(200).optional(),
      from: dateParam,
      to: dateParam,
      campaignId: z.coerce.number().int().optional(),
      q: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
      offset: z.coerce.number().int().min(0).default(0),
      /** "me": only posts this person may approve (not their own or last edited), as the nav badge counts them. */
      for: z.enum(["me"]).optional(),
      platform: z.enum(PLATFORM_IDS).optional(),
    }),
    req.query,
  );
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  const statuses = f.status?.split(",").map((x) => x.trim()).filter(Boolean);
  if (statuses?.length) add("p.status = ANY(?::text[])", statuses);
  if (f.from) add("COALESCE(p.published_at, p.scheduled_at, p.created_at) >= ?::timestamptz", f.from);
  if (f.to) add("COALESCE(p.published_at, p.scheduled_at, p.created_at) < ?::timestamptz", f.to);
  if (f.campaignId) add("p.campaign_id = ?", f.campaignId);
  if (f.platform) add("EXISTS (SELECT 1 FROM post_targets t WHERE t.post_id = p.id AND t.platform = ?)", f.platform);
  // Same rule as GET /status/badges: authors and last editors can't approve their own posts (admins can).
  if (f.for === "me" && req.user!.role !== "admin") add("(p.created_by IS DISTINCT FROM ? AND p.last_edited_by IS DISTINCT FROM ?)", req.user!.id);
  if (f.q) add("(p.title ILIKE ? OR p.message ILIKE ?)", `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  // One extra row tells the screen whether there are more to show.
  params.push(f.limit + 1, f.offset);
  const rows = await q(
    `SELECT p.id, p.title, p.message, p.status, p.scheduled_at, p.published_at, p.next_attempt_at, p.attempts, p.last_error, p.campaign_id, p.image_url, p.video_url,
            p.hashtags, p.fb_post_id, p.ai_generated, p.created_at, p.updated_at, c.name AS campaign_name, u.name AS created_by_name,
            p.media_id, (SELECT kind FROM media WHERE id = p.media_id) AS media_kind, ${TARGETS_SQL}
     FROM posts p LEFT JOIN campaigns c ON c.id=p.campaign_id LEFT JOIN users u ON u.id=p.created_by
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY COALESCE(p.scheduled_at, p.published_at, p.updated_at) DESC, p.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ posts: rows.slice(0, f.limit), hasMore: rows.length > f.limit, offset: f.offset });
});

/**
 * Import posts from a spreadsheet (the browser reads the Excel/CSV file and sends the rows).
 * Every row becomes a DRAFT: nothing is approved or scheduled by an import. Valid rows are created,
 * invalid ones are reported by row number so they can be fixed and imported again.
 */
postsRouter.post("/import", requirePerm("posts.edit"), async (req, res) => {
  const { rows } = parse(
    z.object({
      rows: z
        .array(
          z.object({
            row: z.number().int().min(1),
            title: z.string().max(500).optional(),
            message: z.string().max(10_000).optional(),
            hashtags: z.string().max(2000).optional(),
            planned_at: z.string().datetime({ offset: true }).nullable().optional(),
            campaign: z.string().max(200).optional(),
            image_url: z.string().max(2000).optional(),
            video_url: z.string().max(2000).optional(),
            link_url: z.string().max(2000).optional(),
          }),
        )
        .min(1, "The file has no posts in it.")
        .max(200, "Import up to 200 posts at a time."),
    }),
    req.body,
  );
  const campaigns = await q<{ id: number; name: string }>("SELECT id, name FROM campaigns WHERE status <> 'archived'");
  const byName = new Map(campaigns.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const created: { row: number; id: number; title: string }[] = [];
  const errors: { row: number; error: string }[] = [];
  const warnings: { row: number; warning: string }[] = [];

  for (const r of rows) {
    const message = (r.message ?? "").trim();
    const title = ((r.title ?? "").trim() || message.split(/[.!?\n]/)[0] || "").slice(0, 200);
    const hashtags = (r.hashtags ?? "")
      .split(/[\s,]+/)
      .map((h) => h.trim())
      .filter(Boolean)
      .map((h) => (h.startsWith("#") ? h : `#${h}`))
      .slice(0, 30);
    const candidate = {
      title,
      message,
      hashtags,
      image_url: r.image_url?.trim() || null,
      video_url: r.video_url?.trim() || null,
      link_url: r.link_url?.trim() || null,
      scheduled_at: r.planned_at ?? null,
    };
    const check = postBody.safeParse(candidate);
    if (!check.success) {
      const i = check.error.issues[0];
      const field = { title: "Title", message: "Post text", hashtags: "Hashtags", image_url: "Image URL", video_url: "Video URL", link_url: "Link" }[String(i?.path[0])] ?? String(i?.path[0] ?? "");
      errors.push({ row: r.row, error: !message ? "Post text is empty." : `${field}: ${i?.message ?? "not valid"}` });
      continue;
    }
    if (candidate.image_url && candidate.video_url) {
      errors.push({ row: r.row, error: BOTH_MEDIA });
      continue;
    }
    let campaignId: number | null = null;
    if (r.campaign?.trim()) {
      campaignId = byName.get(r.campaign.trim().toLowerCase()) ?? null;
      if (!campaignId) warnings.push({ row: r.row, warning: `No campaign called "${r.campaign.trim()}": imported without a campaign.` });
    }
    const post = await one<{ id: number }>(
      `INSERT INTO posts (title, message, hashtags, image_url, video_url, link_url, campaign_id, scheduled_at, source_topic, created_by, last_edited_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Imported from a spreadsheet',$9,$9) RETURNING id`,
      [candidate.title, candidate.message, candidate.hashtags, candidate.image_url, candidate.video_url, candidate.link_url, campaignId, candidate.scheduled_at, req.user!.id],
    );
    const media = candidate.video_url ? { kind: "video" as const } : candidate.image_url ? { kind: "image" as const } : null;
    const text = [candidate.message, ...candidate.hashtags].join(" ");
    await setPlatforms(post!.id, await defaultPlatformsFor({ text, link: candidate.link_url, media }));
    created.push({ row: r.row, id: post!.id, title: candidate.title });
  }
  await audit(req, "post.imported", "post", null, { created: created.length, failed: errors.length });
  res.status(created.length ? 201 : 200).json({ created, errors, warnings });
});

postsRouter.get("/counts", requirePerm("posts.view"), async (_req, res) => {
  const rows = await q<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM posts GROUP BY status");
  res.json({ counts: Object.fromEntries(rows.map((r) => [r.status, r.n])) });
});

/** What the bots are doing with this post (polled by the post page while they work). */
postsRouter.get("/:id/bots", requirePerm("posts.view"), async (req, res) => {
  const status = await postBotStatus(intParam(req.params.id));
  if (!status) throw notFound("Post");
  res.json({ bots: status });
});

postsRouter.get("/:id", requirePerm("posts.view"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  const [reviews, logs, stats] = await Promise.all([
    q("SELECT r.*, u.name AS user_name FROM post_reviews r LEFT JOIN users u ON u.id=r.user_id WHERE post_id=$1 ORDER BY created_at DESC", [id]),
    q("SELECT * FROM publish_logs WHERE post_id=$1 ORDER BY created_at DESC LIMIT 50", [id]),
    post.fb_post_id ? one("SELECT * FROM fb_page_posts WHERE fb_post_id=$1", [post.fb_post_id]) : null,
  ]);
  res.json({ post, reviews, logs, stats, preview: toFacebookText(composeMessage(post as { message: string; hashtags: string[] })) });
});

postsRouter.post("/", requirePerm("posts.edit"), async (req, res) => {
  const b = parse(postBody, req.body);
  if (mediaCount(b.image_url, b.video_url, b.media_id) > 1) throw badRequest(BOTH_MEDIA);
  await checkMediaExists(b.media_id);
  const platforms = b.platforms ?? (await getDefaultPlatforms());
  const post = await tx(async (c) => {
    const row = await one<{ id: number }>(
      `INSERT INTO posts (title, message, hashtags, image_url, image_prompt, link_url, campaign_id, scheduled_at, ai_generated, source_topic, created_by, video_url, last_edited_by, media_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11,$13) RETURNING id`,
      [b.title, b.message, b.hashtags, b.image_url ?? null, b.image_prompt ?? null, b.link_url ?? null, b.campaign_id ?? null, b.scheduled_at ?? null, b.ai_generated ?? false, b.source_topic ?? null, req.user!.id, b.video_url ?? null, b.media_id ?? null],
      c,
    );
    await setPlatforms(row!.id, platforms, c);
    return row;
  });
  await audit(req, "post.created", "post", post!.id, { platforms });
  res.status(201).json({ post: await load(post!.id) });
});

postsRouter.patch("/:id", requirePerm("posts.edit"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, EDITABLE, "edited");
  const b = parse(postBody.partial(), req.body);
  const nextImage = "image_url" in b ? (b.image_url ?? null) : post.image_url;
  const nextVideo = "video_url" in b ? (b.video_url ?? null) : post.video_url;
  const nextMedia = "media_id" in b ? (b.media_id ?? null) : post.media_id;
  if (("image_url" in b || "video_url" in b || "media_id" in b) && mediaCount(nextImage, nextVideo, nextMedia) > 1) throw badRequest(BOTH_MEDIA);
  if ("media_id" in b) await checkMediaExists(b.media_id);
  const currentPlatforms = ((post.targets ?? []) as { platform: string }[]).map((t) => t.platform).sort();
  const platformsChanged = !!b.platforms && JSON.stringify([...new Set(b.platforms)].sort()) !== JSON.stringify(currentPlatforms);
  const contentChanged = platformsChanged || CONTENT_FIELDS.some((k) => k in b && JSON.stringify((b as Row)[k] ?? null) !== JSON.stringify(post[k] ?? null));
  const resetApproval = contentChanged && ["approved", "scheduled", "in_review", "failed"].includes(post.status);
  // Applies only if the status is still the one resetApproval was based on, so a post that started
  // publishing in the meantime is never overwritten.
  const rows = await q(
    `UPDATE posts SET title=COALESCE($2,title), message=COALESCE($3,message), hashtags=COALESCE($4,hashtags),
       image_url=CASE WHEN $11 THEN $5 ELSE image_url END, image_prompt=CASE WHEN $12 THEN $6 ELSE image_prompt END,
       link_url=CASE WHEN $13 THEN $7 ELSE link_url END, campaign_id=CASE WHEN $14 THEN $8 ELSE campaign_id END,
       scheduled_at=CASE WHEN $15 THEN $9 ELSE scheduled_at END,
       video_url=CASE WHEN $16 THEN $17 ELSE video_url END,
       media_id=CASE WHEN $22 THEN $23::int ELSE media_id END,
       last_edited_by=CASE WHEN $19 THEN $20 ELSE last_edited_by END,
       status=CASE WHEN $10 THEN 'draft' ELSE status END,
       approved_by=CASE WHEN $10 THEN NULL ELSE approved_by END, approved_at=CASE WHEN $10 THEN NULL ELSE approved_at END,
       next_attempt_at=CASE WHEN $10 THEN NULL ELSE next_attempt_at END, updated_at=now()
     WHERE id=$1 AND status=$18 AND status = ANY($21::text[]) RETURNING id`,
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
      "video_url" in b,
      b.video_url ?? null,
      post.status,
      contentChanged,
      req.user!.id,
      EDITABLE,
      "media_id" in b,
      b.media_id ?? null,
    ],
  );
  if (!rows.length) throw conflict("This post changed while you were editing (it may be publishing now). Reload to see the latest version.");
  if (platformsChanged) await setPlatforms(id, b.platforms!);
  if (resetApproval) await review(id, req, "comment", "Edited after review: needs approval again.");
  await audit(req, "post.updated", "post", id, { resetApproval, ...(platformsChanged ? { platforms: b.platforms } : {}) });
  res.json({ post: await load(id), resetApproval });
});

postsRouter.delete("/:id", requirePerm("posts.edit"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  const allowed = ["draft", "changes_requested", "cancelled", "failed"];
  requireStatus(post, allowed, "deleted");
  const rows = await q("DELETE FROM posts WHERE id=$1 AND status = ANY($2::text[]) RETURNING id", [id, allowed]);
  if (!rows.length) throw conflict("This post changed in the meantime, so it couldn't be deleted. Reload and try again.");
  await audit(req, "post.deleted", "post", id, { title: post.title });
  res.json({ ok: true });
});

postsRouter.post("/:id/submit", requirePerm("posts.edit"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  const allowed = ["draft", "changes_requested"];
  requireStatus(post, allowed, "sent for review");
  const ruleProblems = await platformProblems(post, true);
  if (ruleProblems.length) throw badRequest(`Fix this before sending it for review: ${ruleProblems.join(" ")}`);
  const note = parse(z.object({ comment: z.string().max(1000).optional() }), req.body ?? {}).comment ?? null;
  await guarded("UPDATE posts SET status='in_review', updated_at=now()", id, allowed, [], "sent for review");
  await review(id, req, "submitted", note);
  await audit(req, "post.submitted", "post", id);
  // Approvers, except the people who can't approve this one (its author and last editor, unless they're admins).
  const approvers = (await usersWithPerm("posts.approve", [req.user!.id])).filter((u) => u !== post.created_by && u !== post.last_edited_by);
  await notify(approvers, { kind: "post.review", title: "A post is waiting for your approval", body: `"${post.title}" from ${req.user!.name}`, link: `/posts/${id}` });
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/approve", requirePerm("posts.approve"), async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(z.object({ comment: z.string().max(1000).optional(), scheduleAt: z.string().datetime({ offset: true }).optional() }), req.body ?? {});
  const post = await load(id);
  requireStatus(post, ["in_review"], "approved");
  if (req.user!.role !== "admin") {
    if (post.created_by === req.user!.id) throw forbidden("Someone other than the author needs to approve this post.");
    if (post.last_edited_by === req.user!.id) throw forbidden("You made the latest changes to this post, so another manager needs to approve it.");
  }
  if (b.scheduleAt && !userCan(req, "posts.schedule")) throw forbidden("You can approve but not schedule.");
  if (b.scheduleAt && new Date(b.scheduleAt).getTime() < Date.now() - 60_000) throw badRequest("Pick a time in the future.");
  if (b.scheduleAt) await requirePlatformsReady(post);
  await tx(async (c) => {
    // Also require the version checked above, so an edit can't slip in between the check and the approval.
    // (JS Dates hold milliseconds and Postgres microseconds, hence the small window.)
    const rows = await q(
      `UPDATE posts SET status='approved', approved_by=$3, approved_at=now(), updated_at=now()
       WHERE id=$1 AND status = ANY($2::text[]) AND updated_at BETWEEN $4::timestamptz - interval '2 milliseconds' AND $4::timestamptz + interval '2 milliseconds'
       RETURNING id`,
      [id, ["in_review"], req.user!.id, post.updated_at],
      c,
    );
    if (!rows.length) throw conflict("This post changed in the meantime, so it couldn't be approved. Reload and check it again.");
    await review(id, req, "approved", b.comment ?? null, c);
    if (b.scheduleAt) {
      await guarded("UPDATE posts SET status='scheduled', scheduled_at=$3, next_attempt_at=$3, attempts=0, last_error=NULL", id, ["approved"], [b.scheduleAt], "scheduled", c);
      await resetFailedTargets(id, c);
      await review(id, req, "scheduled", null, c);
    }
  });
  await audit(req, "post.approved", "post", id, { scheduledAt: b.scheduleAt });
  if (post.created_by !== req.user!.id)
    await notify([post.created_by], {
      kind: "post.approved",
      level: "good",
      title: "Your post was approved",
      body: `${req.user!.name} approved "${post.title}"${b.scheduleAt ? `. It goes out ${fmtPh(new Date(b.scheduleAt))} (Philippine time).` : "."}`,
      link: `/posts/${id}`,
    });
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/request-changes", requirePerm("posts.approve"), async (req, res) => {
  const id = intParam(req.params.id);
  const { comment } = parse(z.object({ comment: z.string().min(3, "Say what needs to change").max(1000) }), req.body);
  const post = await load(id);
  requireStatus(post, ["in_review"], "sent back");
  await guarded("UPDATE posts SET status='changes_requested', updated_at=now()", id, ["in_review"], [], "sent back");
  await review(id, req, "changes_requested", comment);
  await audit(req, "post.changes_requested", "post", id);
  await notify([post.created_by], { kind: "post.changes", level: "warn", title: "Changes requested on your post", body: `${req.user!.name} on "${post.title}": ${comment}`, link: `/posts/${id}` });
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
  const allowed = ["approved", "scheduled"];
  requireStatus(post, allowed, "scheduled");
  if (!post.approved_by) throw conflict("This post needs approval before it can be scheduled.");
  if (new Date(scheduledAt).getTime() < Date.now() - 60_000) throw badRequest("Pick a time in the future.");
  await requirePlatformsReady(post);
  await resetFailedTargets(id);
  await guarded(
    "UPDATE posts SET status='scheduled', scheduled_at=$3, next_attempt_at=$3, attempts=0, last_error=NULL, updated_at=now()",
    id,
    allowed,
    [scheduledAt],
    "scheduled",
  );
  await review(id, req, "scheduled", new Date(scheduledAt).toISOString());
  await audit(req, "post.scheduled", "post", id, { scheduledAt });
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/publish-now", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  const allowed = ["approved", "scheduled"];
  requireStatus(post, allowed, "published now");
  if (!post.approved_by) throw conflict("This post needs approval first.");
  await requirePlatformsReady(post);
  await resetFailedTargets(id);
  await guarded("UPDATE posts SET status='scheduled', scheduled_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL, updated_at=now()", id, allowed, [], "published now");
  await review(id, req, "scheduled", "Publish now");
  await audit(req, "post.publish_now", "post", id);
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/unschedule", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, ["scheduled"], "unscheduled");
  await guarded("UPDATE posts SET status='approved', next_attempt_at=NULL, updated_at=now()", id, ["scheduled"], [], "unscheduled");
  await review(id, req, "unscheduled");
  await audit(req, "post.unscheduled", "post", id);
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/retry", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  requireStatus(post, ["failed"], "retried");
  if (!post.approved_by) throw conflict("This post needs approval again before it can be retried.");
  await requirePlatformsReady(post);
  // Only the platforms that failed are tried again; ones it's already on are never posted twice.
  await resetFailedTargets(id);
  await guarded("UPDATE posts SET status='scheduled', next_attempt_at=now(), attempts=0, last_error=NULL, updated_at=now()", id, ["failed"], [], "retried");
  await review(id, req, "scheduled", "Retry after failure");
  await audit(req, "post.retry", "post", id);
  res.json({ post: await load(id) });
});

postsRouter.post("/:id/cancel", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const post = await load(id);
  const allowed = ["approved", "scheduled", "failed"];
  requireStatus(post, allowed, "cancelled");
  await guarded("UPDATE posts SET status='cancelled', next_attempt_at=NULL, updated_at=now()", id, allowed, [], "cancelled");
  await review(id, req, "cancelled");
  await audit(req, "post.cancelled", "post", id);
  res.json({ post: await load(id) });
});

/**
 * A platform whose post may already be live: a person checks the platform and says what they found.
 * "posted": it's there, so mark it published (it is never sent again). "retry": it isn't, so it can be sent again.
 */
postsRouter.post("/:id/targets/:platform", requirePerm("posts.schedule"), async (req, res) => {
  const id = intParam(req.params.id);
  const { action } = parse(z.object({ action: z.enum(["posted", "retry"]) }), req.body);
  const platform = parse(z.enum(PLATFORM_IDS), req.params.platform);
  const post = await load(id);
  requireStatus(post, ["failed", "approved", "scheduled", "cancelled"], "changed");
  const rows = await q(
    action === "posted"
      ? "UPDATE post_targets SET status='published', uncertain=false, last_error=NULL, published_at=COALESCE(published_at, now()), updated_at=now() WHERE post_id=$1 AND platform=$2 AND status='failed' RETURNING id"
      : "UPDATE post_targets SET uncertain=false, updated_at=now() WHERE post_id=$1 AND platform=$2 AND status='failed' RETURNING id",
    [id, platform],
  );
  if (!rows.length) throw conflict("That platform isn't waiting for a check any more. Reload to see the latest.");
  // Everything is out now: the post counts as published.
  if (action === "posted") {
    const left = await one<{ n: number }>("SELECT count(*)::int AS n FROM post_targets WHERE post_id=$1 AND status <> 'published'", [id]);
    if (!left?.n)
      await q(
        "UPDATE posts SET status='published', published_at=COALESCE(published_at, now()), last_error=NULL, next_attempt_at=NULL, updated_at=now() WHERE id=$1 AND status='failed'",
        [id],
      );
  }
  const name = PLATFORM_LABEL[platform];
  await review(id, req, "comment", action === "posted" ? `Checked ${name}: the post is there.` : `Checked ${name}: the post isn't there, so it can be sent again.`);
  await audit(req, "post.target_checked", "post", id, { platform, action });
  res.json({ post: await load(id) });
});
