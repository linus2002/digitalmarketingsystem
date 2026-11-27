import { one, q, type Row } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { getBrand } from "../lib/settings.js";
import { aiStatus } from "./ai.js";
import { activity, DEFAULT_SCHEDULE, fmtPh, mediaProblem, type Issue } from "./bots.js";
import { evaluate, failing, getStandards, meetsStandards, revise, type RuleResult } from "./editor.js";
import { checkCompliance, complianceSig } from "./guardrails.js";
import { notify } from "./notifications.js";
import { composeMessage } from "./publisher.js";
import { toFacebookText } from "../lib/fbText.js";

// The bots also look after posts the team writes by hand. Once a post is sent for review (or approved, or scheduled),
// the Editor Bot scores it against the standards and, if it misses some, prepares a suggested revision for a person to
// accept; the Checker Bot looks for problems (wording, disclaimer, media, clashing times). Neither bot changes the post:
// a person approved what will be published. The Posting Bot (the publisher) then posts it at its scheduled time.

/** Statuses the bots watch. Drafts are still being written; published and cancelled posts are finished. */
export const WATCHED = ["in_review", "approved", "scheduled"];

/** Fingerprint of everything the bots check. A post whose fingerprint differs from the saved one is checked again. */
export const SIG = `md5(concat_ws('|', p.title, p.message, p.hashtags::text, coalesce(p.image_url,''), coalesce(p.video_url,''),
  coalesce(p.media_id::text,''), coalesce(p.link_url,''), coalesce(p.scheduled_at::text,''), coalesce(p.compliance_signoff->>'sig','')))`;

export interface LiveWork {
  bot: "editor" | "checker";
  postId: number;
  title: string;
  task: string;
  since: string;
}
let live: LiveWork | null = null;
/** What the Editor or Checker Bot is doing on a team post right now (null when idle). */
export const teamLive = () => live;

const setLive = (bot: LiveWork["bot"], post: Row, task: string) => {
  live = { bot, postId: post.id, title: String(post.title), task, since: new Date().toISOString() };
};

async function checkerIssues(post: Row): Promise<Issue[]> {
  const brand = await getBrand();
  const full = composeMessage(post as { message: string; hashtags: string[] });
  const issues: Issue[] = [];
  if (full.length > 4800) issues.push({ level: "warn", text: "The text (with its hashtags) is very long for a Facebook post. Shorter posts get read." });
  // Blocking compliance problems stop approval, unless the pharmaceutical team signed this exact wording off.
  const signedOff = !!post.compliance_signoff && post.compliance_signoff.sig === complianceSig(post);
  for (const c of checkCompliance(`${post.title}\n${full}`, brand))
    issues.push(
      c.level === "block" && !signedOff
        ? { level: "bad", text: `${c.text} This blocks approval until it's fixed or the pharmaceutical team signs it off.` }
        : { level: "warn", text: c.level === "block" ? `${c.text} (Signed off by the pharmaceutical team.)` : c.text },
    );
  // **bold** is turned into bold letters when publishing; a ** left over after that has no partner and shows as typed.
  if (toFacebookText(full).includes("**")) issues.push({ level: "warn", text: 'A "**" mark has no partner, so it will show as typed. Bold text needs ** on both sides, like **this**.' });
  // An uploaded file is sent to Facebook directly, so there's no link to check.
  if (!post.media_id) {
    const media = post.video_url ? mediaProblem(post.video_url, "video") : post.image_url ? mediaProblem(post.image_url, "image") : null;
    if (media) issues.push(media);
  }
  if (post.status === "scheduled" && post.scheduled_at) {
    const at = new Date(post.scheduled_at).getTime();
    const gap = DEFAULT_SCHEDULE.minGapMinutes * 60_000;
    const near = await q<{ title: string; scheduled_at: Date }>(
      `SELECT title, scheduled_at FROM posts WHERE id<>$1 AND status IN ('scheduled','publishing') AND scheduled_at BETWEEN $2 AND $3 ORDER BY abs(extract(epoch FROM scheduled_at - $4::timestamptz)) LIMIT 1`,
      [post.id, new Date(at - gap), new Date(at + gap), new Date(at)],
    );
    if (near[0]) {
      const mins = Math.round(Math.abs(new Date(near[0].scheduled_at).getTime() - at) / 60_000);
      issues.push(
        mins < 1
          ? { level: "bad", text: `Goes out at the same time as "${near[0].title}". Move one of them.` }
          : { level: "warn", text: `Only ${mins} minutes from "${near[0].title}". Posts spaced apart reach more people.` },
      );
    }
  }
  return issues;
}

async function reviewOne(post: Row) {
  const title = String(post.title);
  // ---- Editor Bot: score against the standards; suggest a revision if it misses some.
  setLive("editor", post, "Checking it against your standards");
  const [standards, brand] = await Promise.all([getStandards(), getBrand()]);
  const results: RuleResult[] = evaluate(String(post.message ?? ""), standards, brand);
  const misses = failing(results);
  let suggested = false;
  if (!meetsStandards(results)) {
    const pending = await one("SELECT id FROM content_revisions WHERE post_id=$1 AND status='pending' LIMIT 1", [post.id]);
    if (!pending && (await aiStatus()).ready) {
      setLive("editor", post, "Writing a suggested revision");
      try {
        const r = await revise(String(post.message), { tries: 2 });
        await q(
          "INSERT INTO content_revisions (post_id, before_text, after_text, results_before, results_after, status, created_by) VALUES ($1,$2,$3,$4,$5,'pending',NULL)",
          [post.id, post.message, r.text, JSON.stringify(r.before), JSON.stringify(r.after)],
        );
        suggested = true;
      } catch (err) {
        log.warn("Editor Bot couldn't suggest a revision for a team post", { postId: post.id, error: errMsg(err) });
      }
    }
  }

  // ---- Checker Bot
  setLive("checker", post, "Checking for problems");
  const issues = await checkerIssues(post);

  // Saved only if the post hasn't changed meanwhile; otherwise the next round checks the new version.
  const saved = await one(
    `UPDATE posts AS p SET bot_issues=$3, bot_standards=$4, bot_checked_at=now(), bot_check_sig=$2
     WHERE p.id=$1 AND ${SIG} = $2 RETURNING id`,
    [post.id, post.sig, JSON.stringify(issues), JSON.stringify(results)],
  );
  if (!saved) return;

  const bad = issues.filter((i) => i.level === "bad").length;
  const warn = issues.length - bad;
  if (misses.length) {
    await activity(
      "editor",
      `"${title}" misses ${misses.length} of your standards (${misses.map((m) => m.label.toLowerCase()).join(", ")}).${suggested ? " I suggested a revision: open the post to review it." : ""}`,
      { level: "warn" },
    );
  }
  await activity(
    "checker",
    bad || warn
      ? `Checked "${title}": ${[bad ? `${bad} problem${bad === 1 ? "" : "s"}` : "", warn ? `${warn} warning${warn === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}.`
      : `Checked "${title}": no problems found.`,
    { level: bad ? "bad" : warn ? "warn" : "good" },
  );
  // A problem on a post that will go out by itself: tell the people responsible for it.
  if (bad || (post.status === "scheduled" && (warn || misses.length))) {
    await notify([post.created_by, post.approved_by], {
      kind: "bot",
      bot: "checker",
      level: bad ? "bad" : "warn",
      title: "Checker Bot",
      body:
        `"${title}"${post.status === "scheduled" && post.scheduled_at ? ` (posts ${fmtPh(new Date(post.scheduled_at))})` : ""}: ` +
        [...issues.map((i) => i.text), ...(misses.length ? [`Misses ${misses.length} of your standards.`] : [])].slice(0, 3).join(" "),
      link: `/posts/${post.id}`,
    });
  }
}

let running = false;

/** Checks team posts that are new or changed since they were last checked. Runs from the background jobs. */
export async function reviewTeamPosts() {
  if (running) return;
  running = true;
  try {
    const posts = await q(
      `SELECT p.*, ${SIG} AS sig FROM posts p
       WHERE p.status = ANY($1::text[]) AND p.bot_check_sig IS DISTINCT FROM ${SIG}
       ORDER BY coalesce(p.next_attempt_at, p.scheduled_at, p.updated_at) LIMIT 5`,
      [WATCHED],
    );
    for (const post of posts) {
      try {
        await reviewOne(post);
      } catch (err) {
        log.warn("Bots couldn't check a team post", { postId: post.id, error: errMsg(err) });
      }
    }
  } finally {
    live = null;
    running = false;
  }
}

/** The bots' view of one post, for the post page. */
export async function postBotStatus(id: number) {
  const row = await one(
    `SELECT p.id, p.status, p.title, p.scheduled_at, p.next_attempt_at, p.published_at, p.last_error, p.attempts, p.max_attempts,
            p.bot_checked_at, p.bot_issues, p.bot_standards, (p.bot_check_sig IS NOT DISTINCT FROM ${SIG}) AS fresh,
            (SELECT r.id FROM content_revisions r WHERE r.post_id=p.id AND r.status='pending' ORDER BY r.id DESC LIMIT 1) AS pending_revision_id
     FROM posts p WHERE p.id=$1`,
    [id],
  );
  if (!row) return null;
  const l = teamLive();
  return { ...row, watched: WATCHED.includes(row.status), live: l && l.postId === id ? l : null };
}

/** Everything the bots are doing on team posts, for the AI bots page. */
export async function teamOverview() {
  const [posts, queue] = await Promise.all([
    q(
      `SELECT p.id, p.title, p.status, p.scheduled_at, p.next_attempt_at, p.source_topic, p.bot_checked_at, p.bot_issues, p.bot_standards,
              (p.bot_check_sig IS NOT DISTINCT FROM ${SIG}) AS fresh, u.name AS created_by_name,
              (SELECT r.id FROM content_revisions r WHERE r.post_id=p.id AND r.status='pending' ORDER BY r.id DESC LIMIT 1) AS pending_revision_id
       FROM posts p LEFT JOIN users u ON u.id=p.created_by
       WHERE p.status IN ('in_review','approved','scheduled','publishing','failed')
       ORDER BY (p.status='publishing') DESC, coalesce(p.next_attempt_at, p.scheduled_at, p.updated_at) LIMIT 30`,
    ),
    one<{ n: number }>(`SELECT count(*)::int AS n FROM posts p WHERE p.status = ANY($1::text[]) AND p.bot_check_sig IS DISTINCT FROM ${SIG}`, [WATCHED]),
  ]);
  return { live: teamLive(), queue: queue?.n ?? 0, posts };
}
