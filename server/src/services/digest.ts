import { env } from "../config/env.js";
import { one, q } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { getBrand } from "../lib/settings.js";
import { chatJson } from "./ai.js";
import { notify, usersWithPerm } from "./notifications.js";

// Weekly performance digest. Code works out every number from the database; the AI only explains them
// (what worked, what flopped, why the best post did well, three suggestions). If the AI isn't available,
// a plain version written from the numbers goes out instead, so the team always gets its Monday digest.

const PH_MS = 8 * 3_600_000;
const START = `(($1::date)::timestamp AT TIME ZONE 'Asia/Manila')`;
const END = `((($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Manila')`;
const PLATFORM_LABEL: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", twitter: "X", youtube: "YouTube", tiktok: "TikTok", linkedin: "LinkedIn" };

const phToday = () => new Date(Date.now() + PH_MS).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Monday of the week a day falls in. */
export const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
/** Last full week (Monday to Sunday) before today, in Philippine time. */
export const lastWeekStart = () => addDays(mondayOf(phToday()), -7);

interface Totals {
  published: number;
  failed: number;
  reach: number;
  impressions: number;
  engagement: number;
  clicks: number;
  inquiries: number;
}
export interface DigestPost {
  id: number;
  title: string;
  excerpt: string;
  platforms: string[];
  format: "video" | "image" | "link" | "text";
  campaign: string | null;
  published: string; // e.g. "Tue 12:00 PM"
  hasStats: boolean;
  reach: number | null;
  engagement: number | null;
  rate: number | null; // engagement per 100 people reached
  permalink: string | null;
}
export interface DigestStats {
  week: { start: string; end: string };
  totals: Totals;
  previous: Totals;
  byPlatform: { platform: string; label: string; published: number; failed: number }[];
  byFormat: { format: string; posts: number; avgEngagement: number | null }[];
  posts: DigestPost[];
  best: DigestPost | null;
  worst: DigestPost | null;
  failedPosts: { id: number; title: string; error: string | null }[];
  nextWeek: { scheduled: number; emptyDays: string[] };
  statsNote: string | null;
  /** False when no post this week has reach/engagement figures yet (they're unknown, not zero). */
  measured: boolean;
}
export interface DigestSummary {
  headline: string;
  worked: string[];
  flopped: string[];
  bestWhy: string;
  suggestions: string[];
}

/**
 * When a post first went out anywhere. A post that went out on some platforms but failed on another is "failed",
 * yet it was published (and measured) where it went out, so it counts as published from that moment.
 */
const OUT_AT = `COALESCE(p.published_at, (SELECT min(t.published_at) FROM post_targets t WHERE t.post_id=p.id AND t.status='published'))`;
const IN_WEEK = (col: string) => `${col} >= ${START} AND ${col} < ${END}`;

async function totals(from: string, to: string): Promise<Totals> {
  const t = await one<Omit<Totals, "inquiries">>(
    `SELECT count(*) FILTER (WHERE ${IN_WEEK("x.out_at")})::int AS published,
            count(*) FILTER (WHERE x.status='failed' AND ${IN_WEEK("x.updated_at")})::int AS failed,
            COALESCE(sum(f.reach) FILTER (WHERE ${IN_WEEK("x.out_at")}),0)::int AS reach,
            COALESCE(sum(f.impressions) FILTER (WHERE ${IN_WEEK("x.out_at")}),0)::int AS impressions,
            COALESCE(sum(f.reactions + f.comments + f.shares) FILTER (WHERE ${IN_WEEK("x.out_at")}),0)::int AS engagement,
            COALESCE(sum(f.clicks) FILTER (WHERE ${IN_WEEK("x.out_at")}),0)::int AS clicks
     FROM (SELECT p.id, p.status, p.updated_at, p.fb_post_id, ${OUT_AT} AS out_at FROM posts p WHERE p.status IN ('published','failed')) x
     LEFT JOIN fb_page_posts f ON f.fb_post_id=x.fb_post_id`,
    [from, to],
  );
  const l = await one<{ n: number }>(`SELECT count(*)::int AS n FROM leads WHERE created_at >= ${START} AND created_at < ${END} AND consent_given`, [from, to]);
  return { ...(t as Omit<Totals, "inquiries">), inquiries: l?.n ?? 0 };
}

const whenPh = (d: Date) =>
  new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" }).format(d);

export async function gatherStats(weekStart: string): Promise<DigestStats> {
  const weekEnd = addDays(weekStart, 6);
  const [cur, prev] = await Promise.all([totals(weekStart, weekEnd), totals(addDays(weekStart, -7), addDays(weekStart, -1))]);

  const rows = await q(
    `SELECT p.id, p.title, p.message, ${OUT_AT} AS published_at, p.video_url, p.image_url, p.link_url, md.kind AS media_kind, c.name AS campaign,
            f.fb_post_id IS NOT NULL AS has_stats, f.reach, (f.reactions + f.comments + f.shares) AS engagement, f.permalink_url,
            (SELECT COALESCE(array_agg(t.platform ORDER BY t.id), '{}') FROM post_targets t WHERE t.post_id=p.id AND t.status='published') AS platforms
     FROM posts p LEFT JOIN fb_page_posts f ON f.fb_post_id=p.fb_post_id LEFT JOIN media md ON md.id=p.media_id LEFT JOIN campaigns c ON c.id=p.campaign_id
     WHERE p.status IN ('published','failed') AND ${IN_WEEK(OUT_AT)}
     ORDER BY 4`,
    [weekStart, weekEnd],
  );
  const posts: DigestPost[] = rows.map((r) => {
    const format = r.media_kind === "video" || r.video_url ? "video" : r.media_kind === "image" || r.image_url ? "image" : r.link_url ? "link" : "text";
    const reach = r.reach == null ? null : Number(r.reach);
    const engagement = r.has_stats ? Number(r.engagement ?? 0) : null;
    return {
      id: r.id,
      title: r.title,
      excerpt: String(r.message ?? "").replace(/\s+/g, " ").slice(0, 160),
      platforms: (r.platforms as string[]).length ? (r.platforms as string[]) : ["facebook"],
      format,
      campaign: r.campaign ?? null,
      published: whenPh(new Date(r.published_at)),
      hasStats: !!r.has_stats,
      reach,
      engagement,
      rate: reach && engagement != null ? Math.round((engagement / reach) * 1000) / 10 : null,
      permalink: r.permalink_url ?? null,
    };
  });

  const withStats = posts.filter((p) => p.hasStats);
  const rank = (p: DigestPost) => (p.engagement ?? 0) * 1_000_000 + (p.reach ?? 0);
  const sorted = [...withStats].sort((a, b) => rank(b) - rank(a));
  const best = sorted[0] ?? null;
  const worst = sorted.length > 1 ? sorted[sorted.length - 1] : null;

  const byFormat = ["video", "image", "link", "text"]
    .map((format) => {
      const all = posts.filter((p) => p.format === format);
      const s = all.filter((p) => p.hasStats);
      return { format, posts: all.length, avgEngagement: s.length ? Math.round(s.reduce((n, p) => n + (p.engagement ?? 0), 0) / s.length) : null };
    })
    .filter((f) => f.posts);

  const platformRows = await q<{ platform: string; published: number; failed: number }>(
    `SELECT t.platform, count(*) FILTER (WHERE t.status='published')::int AS published, count(*) FILTER (WHERE t.status='failed')::int AS failed
     FROM post_targets t JOIN posts p ON p.id=t.post_id
     WHERE COALESCE(t.published_at, t.updated_at) >= ${START} AND COALESCE(t.published_at, t.updated_at) < ${END} AND t.status IN ('published','failed')
     GROUP BY t.platform ORDER BY published DESC`,
    [weekStart, weekEnd],
  );

  const failedPosts = await q<{ id: number; title: string; error: string | null }>(
    `SELECT id, title, last_error AS error FROM posts WHERE status='failed' AND updated_at >= ${START} AND updated_at < ${END} ORDER BY updated_at DESC LIMIT 10`,
    [weekStart, weekEnd],
  );

  // The week after the digest's week (normally "this week" when it's read on Monday).
  const nextStart = addDays(weekStart, 7);
  const nextEnd = addDays(weekStart, 13);
  const planned = await q<{ day: string }>(
    `SELECT to_char(scheduled_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS day FROM posts
     WHERE status IN ('scheduled','approved','in_review') AND scheduled_at >= ${START} AND scheduled_at < ${END}`,
    [nextStart, nextEnd],
  );
  const plannedDays = new Set(planned.map((p) => p.day));
  const emptyDays = Array.from({ length: 7 }, (_, i) => addDays(nextStart, i))
    .filter((d) => !plannedDays.has(d))
    .map((d) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(new Date(`${d}T00:00:00Z`)));

  const statsNote = !posts.length
    ? "Nothing was published this week."
    : !withStats.length
      ? "No reach or engagement figures yet: Facebook numbers arrive with the analytics sync, and other platforms aren't measured yet."
      : withStats.length < posts.length
        ? `Reach and engagement are from Facebook only (${withStats.length} of ${posts.length} posts).`
        : "Reach and engagement are from Facebook.";

  return {
    week: { start: weekStart, end: weekEnd },
    totals: cur,
    previous: prev,
    byPlatform: platformRows.map((r) => ({ ...r, label: PLATFORM_LABEL[r.platform] ?? r.platform })),
    byFormat,
    posts,
    best,
    worst,
    failedPosts,
    nextWeek: { scheduled: planned.length, emptyDays },
    statsNote,
    measured: withStats.length > 0,
  };
}

// ---------------------------------------------------------------- writing it up

const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : a ? "new" : "no change");

/** The digest without AI: plain sentences built from the numbers. Also the fallback when the AI fails. */
export function rulesSummary(s: DigestStats): DigestSummary {
  const t = s.totals;
  const p = s.previous;
  const worked: string[] = [];
  const flopped: string[] = [];
  if (s.best) worked.push(`"${s.best.title}" had the most engagement (${s.best.engagement ?? 0}${s.best.reach ? ` from ${s.best.reach} people reached` : ""}).`);
  const topFormat = [...s.byFormat].filter((f) => f.avgEngagement != null).sort((a, b) => (b.avgEngagement ?? 0) - (a.avgEngagement ?? 0))[0];
  if (topFormat && s.byFormat.length > 1) worked.push(`${topFormat.format[0].toUpperCase() + topFormat.format.slice(1)} posts averaged the most engagement (${topFormat.avgEngagement}).`);
  if (t.inquiries > p.inquiries) worked.push(`Inquiries went up: ${t.inquiries} this week against ${p.inquiries} the week before.`);
  if (s.worst) flopped.push(`"${s.worst.title}" had the least engagement (${s.worst.engagement ?? 0}).`);
  if (t.failed) flopped.push(`${t.failed} post${t.failed === 1 ? "" : "s"} failed to publish.`);
  if (s.measured && t.reach < p.reach) flopped.push(`Reach dropped ${pct(t.reach, p.reach)} from the week before.`);
  const suggestions: string[] = [];
  if (topFormat) suggestions.push(`Plan more ${topFormat.format} posts this week, since they did best.`);
  if (s.nextWeek.emptyDays.length) suggestions.push(`Fill the empty days this week: ${s.nextWeek.emptyDays.join(", ")}.`);
  if (s.failedPosts.length) suggestions.push("Check the posts that failed, fix them and press Try again.");
  if (s.best) suggestions.push(`Write a follow-up to "${s.best.title}" while the topic is working.`);
  suggestions.push("Reply to this week's comments and inquiries within the day.");
  return {
    headline: !t.published
      ? "Nothing was published last week."
      : s.measured
        ? `${t.published} post${t.published === 1 ? "" : "s"} published, reaching ${t.reach.toLocaleString("en-PH")} people (${pct(t.reach, p.reach)} on the week before).`
        : `${t.published} post${t.published === 1 ? "" : "s"} published. Reach and engagement aren't measured yet.`,
    worked: worked.length ? worked : ["Not enough results yet to say what worked."],
    flopped: flopped.length ? flopped : ["Nothing stood out as weak."],
    bestWhy: s.best ? `It had the highest engagement of the week. It was a ${s.best.format} post published ${s.best.published}.` : "",
    suggestions: suggestions.slice(0, 3),
  };
}

/** The data the AI sees: small and plain, so even a small local model can read it. */
function aiData(s: DigestStats) {
  // Unknown numbers are labelled as such, so the AI never reads "0" as "nobody saw it".
  const NM = "not measured yet";
  const brief = (p: DigestPost) => ({
    title: p.title,
    text: p.excerpt,
    format: p.format,
    platforms: p.platforms,
    published: p.published,
    reach: p.hasStats ? p.reach : NM,
    engagement: p.hasStats ? p.engagement : NM,
    engagement_per_100_reached: p.rate ?? (p.hasStats ? null : NM),
  });
  const tot = (x: DigestStats["totals"], measured: boolean) =>
    measured ? x : { ...x, reach: NM, impressions: NM, engagement: NM, clicks: NM };
  return {
    week: `${s.week.start} to ${s.week.end}`,
    this_week: tot(s.totals, s.measured),
    week_before: tot(s.previous, s.measured && (s.previous.reach > 0 || s.previous.engagement > 0)),
    note_about_numbers: s.statsNote,
    best_post: s.best && brief(s.best),
    weakest_post: s.worst && brief(s.worst),
    posts: s.posts.slice(0, 15).map(brief),
    by_format: s.byFormat,
    by_platform: s.byPlatform.map((p) => ({ platform: p.label, published: p.published, failed: p.failed })),
    failed_posts: s.failedPosts.map((f) => ({ title: f.title, error: f.error })),
    coming_week: { posts_planned: s.nextWeek.scheduled, days_with_nothing_planned: s.nextWeek.emptyDays },
  };
}

export function digestPrompt(s: DigestStats, brand: { name: string; dontList: string[] }) {
  const system = [
    `You are the marketing analyst for ${brand.name}'s digital marketing team. ${brand.name} helps patients in the Philippines get cancer and specialty medicines.`,
    "Every Monday you write a short performance digest of last week's social media posts for the team.",
    "Rules:",
    "- Use ONLY the numbers and posts in the data. Never invent numbers, posts, dates or results.",
    "- When you give a reason, base it on something in the data (format, day and time, topic, platform). If the data can't explain it, say so.",
    "- If a number is missing or zero because it isn't measured, say that plainly instead of guessing.",
    "- Write plain, friendly English in short sentences. No jargon.",
    `- Suggestions must be concrete things the team can do this week, and must follow the brand rules. Never suggest: ${brand.dontList.join("; ") || "medical claims or promises of cures"}.`,
  ].join("\n");
  const prompt = [
    "Here is last week's data as JSON:",
    JSON.stringify(aiData(s)),
    "",
    "Write the digest as a JSON object with exactly these keys:",
    '{"headline": "one sentence summing up the week",',
    ' "worked": ["2 or 3 short points about what went well"],',
    ' "flopped": ["1 to 3 short points about what didn\'t go well"],',
    ' "bestWhy": "1 or 2 sentences on why the best post did well, based on the data; empty string if best_post is null",',
    ' "suggestions": ["exactly 3 concrete actions for this week"]}',
  ].join("\n");
  return { system, prompt };
}

const cleanList = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === "string" && !!x.trim())
    .map((x) => x.trim().slice(0, 400))
    .slice(0, max);

async function aiSummary(s: DigestStats): Promise<DigestSummary> {
  const brand = await getBrand();
  const { system, prompt } = digestPrompt(s, brand);
  const r = await chatJson<Partial<Record<keyof DigestSummary, unknown>>>({
    system,
    prompt,
    effort: "medium",
    temperature: 0.4,
    maxTokens: 900,
    timeoutMs: 600_000,
    queueTimeoutMs: 15 * 60_000,
  });
  const out: DigestSummary = {
    headline: typeof r.headline === "string" ? r.headline.trim().slice(0, 300) : "",
    worked: cleanList(r.worked, 3),
    flopped: cleanList(r.flopped, 3),
    bestWhy: typeof r.bestWhy === "string" ? r.bestWhy.trim().slice(0, 600) : "",
    suggestions: cleanList(r.suggestions, 3),
  };
  if (!out.headline || !out.suggestions.length) throw new Error("The AI's answer was missing the headline or the suggestions.");
  // Fill any gaps from the plain version rather than showing empty sections.
  const plain = rulesSummary(s);
  return {
    headline: out.headline,
    worked: out.worked.length ? out.worked : plain.worked,
    flopped: out.flopped.length ? out.flopped : plain.flopped,
    // No best post (nothing measured): nothing to explain, whatever the AI wrote.
    bestWhy: s.best ? out.bestWhy || plain.bestWhy : "",
    suggestions: out.suggestions.length >= 3 ? out.suggestions : [...out.suggestions, ...plain.suggestions].slice(0, 3),
  };
}

const modelName = () => (env.AI_PROVIDER === "anthropic" ? `Claude (${env.CLAUDE_MODEL})` : `Ollama (${env.OLLAMA_MODEL})`);
const running = new Set<string>();
/** Weeks whose digest is being written right now. */
export const writingWeeks = () => [...running];

/** Works out and writes the digest for a week, saves it (replacing an earlier one) and tells the team. */
export async function createDigest(weekStart: string, userId: number | null, opts: { notifyTeam?: boolean } = {}) {
  const week = mondayOf(weekStart);
  if (running.has(week)) throw new Error("This week's digest is already being written. Give it a minute.");
  running.add(week);
  try {
    const stats = await gatherStats(week);
    let summary: DigestSummary;
    let writtenBy = modelName();
    let aiError: string | null = null;
    try {
      summary = stats.posts.length ? await aiSummary(stats) : rulesSummary(stats);
      if (!stats.posts.length) writtenBy = "rules";
    } catch (err) {
      aiError = errMsg(err);
      log.warn("Weekly digest: AI write-up failed, using the plain version", { week, error: aiError });
      summary = rulesSummary(stats);
      writtenBy = "rules";
    }
    const row = await one<{ id: number }>(
      `INSERT INTO digests (week_start, week_end, stats, summary, written_by, ai_error, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (week_start) DO UPDATE SET stats=EXCLUDED.stats, summary=EXCLUDED.summary, written_by=EXCLUDED.written_by,
         ai_error=EXCLUDED.ai_error, updated_at=now()
       RETURNING id`,
      [week, stats.week.end, JSON.stringify(stats), JSON.stringify(summary), writtenBy, aiError, userId],
    );
    if (opts.notifyTeam !== false) {
      const team = await usersWithPerm("reports.view");
      await notify(team, {
        kind: "report.digest",
        level: "info",
        title: "Your weekly performance digest is ready",
        body: summary.headline,
        link: `/reports/digest/${row!.id}`,
      });
    }
    log.info("Weekly digest written", { week, by: writtenBy });
    return row!.id;
  } finally {
    running.delete(week);
  }
}

/** Background job: on Monday from 8:00 AM Philippine time, writes last week's digest once. */
export async function maybeWeeklyDigest() {
  if (!env.WEEKLY_DIGEST) return;
  const now = new Date(Date.now() + PH_MS);
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 8) return;
  const week = lastWeekStart();
  if (await one("SELECT 1 FROM digests WHERE week_start=$1", [week])) return;
  await createDigest(week, null);
}
