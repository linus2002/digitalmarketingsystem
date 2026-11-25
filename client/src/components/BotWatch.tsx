import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtBiz, POST_STATUS } from "../lib/format";
import { BotFace, BOTS, type BotName, type Mood } from "./BotArt";
import { Button, StatusTag } from "./ui";
import "../styles/botwatch.css";

// The bots looking after a post the team wrote: the Editor Bot scores it against the standards, the Checker Bot looks
// for problems, and the Posting Bot posts it at its scheduled time. Shown on the post page and on the AI bots page,
// with a live indicator while a bot is working on it.

export interface LiveWork {
  bot: "editor" | "checker";
  postId: number;
  title: string;
  task: string;
  since: string;
}
interface Issue {
  level: "bad" | "warn";
  text: string;
}
interface RuleResult {
  key: string;
  label: string;
  pass: boolean | null;
  detail: string;
}
export interface PostBots {
  id: number;
  title: string;
  status: string;
  scheduled_at: string | null;
  next_attempt_at: string | null;
  published_at?: string | null;
  last_error?: string | null;
  attempts?: number;
  max_attempts?: number;
  bot_checked_at: string | null;
  bot_issues: Issue[];
  bot_standards: RuleResult[];
  fresh: boolean;
  pending_revision_id: number | null;
  live?: LiveWork | null;
  created_by_name?: string | null;
  source_topic?: string | null;
}
export interface TeamData {
  live: LiveWork | null;
  queue: number;
  posts: PostBots[];
}

type State = "working" | "waiting" | "done" | "attention" | "idle";
export interface BotLine {
  bot: BotName;
  state: State;
  text: string;
  detail?: ReactNode;
}

const WATCHED = ["in_review", "approved", "scheduled"];

/** What each of the three bots is doing with this post. */
export function postLines(p: PostBots, live: LiveWork | null): Record<"editor" | "checker" | "posting", BotLine> {
  const watched = WATCHED.includes(p.status);
  const workingOn = live && live.postId === p.id ? live : null;
  const checked = !!p.bot_checked_at;
  const queued = watched && !p.fresh;

  const misses = p.bot_standards.filter((r) => r.pass === false);
  const editor: BotLine = workingOn?.bot === "editor"
    ? { bot: "editor", state: "working", text: `${workingOn.task}…` }
    : queued
      ? { bot: "editor", state: "waiting", text: checked ? "It changed: checking it again shortly" : "Checks it in a moment" }
      : !checked
        ? { bot: "editor", state: "idle", text: watched ? "Checks it in a moment" : "Checks it once it's sent for review" }
        : misses.length
          ? {
              bot: "editor",
              state: "attention",
              text: `Misses ${misses.length} of your standards${p.pending_revision_id ? ". Suggested a revision" : ""}`,
              detail: (
                <ul className="bw-list">
                  {misses.map((m) => (
                    <li key={m.key}>
                      <b>{m.label}:</b> {m.detail}
                    </li>
                  ))}
                </ul>
              ),
            }
          : { bot: "editor", state: "done", text: "Meets your standards" };

  const bad = p.bot_issues.filter((i) => i.level === "bad");
  const checker: BotLine = workingOn?.bot === "checker"
    ? { bot: "checker", state: "working", text: `${workingOn.task}…` }
    : queued || (workingOn?.bot === "editor")
      ? { bot: "checker", state: "waiting", text: "Next in line" }
      : !checked
        ? { bot: "checker", state: "idle", text: watched ? "Checks it in a moment" : "Checks it once it's sent for review" }
        : p.bot_issues.length
          ? {
              bot: "checker",
              state: "attention",
              text: bad.length ? `Found ${bad.length} problem${bad.length === 1 ? "" : "s"}${p.bot_issues.length > bad.length ? " and warnings" : ""}` : `${p.bot_issues.length} warning${p.bot_issues.length === 1 ? "" : "s"}`,
              detail: (
                <ul className="bw-list">
                  {p.bot_issues.map((i, n) => (
                    <li key={n} className={i.level}>
                      {i.text}
                    </li>
                  ))}
                </ul>
              ),
            }
          : { bot: "checker", state: "done", text: "No problems found" };

  const at = p.next_attempt_at ?? p.scheduled_at;
  const posting: BotLine =
    p.status === "publishing"
      ? { bot: "posting", state: "working", text: "Posting it to the Facebook Page now…" }
      : p.status === "scheduled"
        ? {
            bot: "posting",
            state: "waiting",
            text: at ? `Posts it automatically ${fmtBiz(at)}` : "Posts it automatically at its time",
            detail: p.attempts ? <p className="bw-note">Attempt {p.attempts} of {p.max_attempts} didn't go through{p.last_error ? `: ${p.last_error}` : ""}. It tries again by itself.</p> : undefined,
          }
        : p.status === "published"
          ? { bot: "posting", state: "done", text: p.published_at ? `Posted ${fmtBiz(p.published_at)}` : "Posted" }
          : p.status === "failed"
            ? { bot: "posting", state: "attention", text: "Couldn't post it", detail: p.last_error ? <p className="bw-note">{p.last_error}</p> : undefined }
            : p.status === "approved"
              ? { bot: "posting", state: "idle", text: "Approved. Waiting for a publish time" }
              : p.status === "in_review"
                ? { bot: "posting", state: "idle", text: "Waits for approval, then posts it at its time" }
                : p.status === "cancelled"
                  ? { bot: "posting", state: "idle", text: "Cancelled: it won't be posted" }
                  : { bot: "posting", state: "idle", text: "Posts it once it's approved and scheduled" };
  return { editor, checker, posting };
}

const MOOD: Record<State, Mood> = { working: "focus", waiting: "determined", done: "happy", attention: "alert", idle: "neutral" };

function Line({ line, compact, action }: { line: BotLine; compact?: boolean; action?: ReactNode }) {
  return (
    <div className={`bw-line s-${line.state} ${compact ? "compact" : ""}`}>
      <span className="bw-face">
        <BotFace bot={line.bot} mood={MOOD[line.state]} size={compact ? 28 : 34} />
        {line.state === "working" && <i className="bw-pulse" aria-hidden="true" />}
      </span>
      <div className="bw-body">
        {!compact && <b>{BOTS[line.bot].name}</b>}
        <span className="bw-text" title={compact ? `${BOTS[line.bot].name}: ${line.text}` : undefined}>
          {line.state === "working" && <span className="bw-live">Working</span>}
          {line.text}
        </span>
        {!compact && line.detail}
        {!compact && action}
      </div>
    </div>
  );
}

/** Polls `load` every few seconds while something is happening, and every 30 seconds otherwise. */
function usePoll<T>(load: () => Promise<T>, busy: (d: T) => boolean, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const ref = useRef(load);
  ref.current = load;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next = 30_000;
      try {
        const d = await ref.current();
        if (!alive) return;
        setData(d);
        if (busy(d)) next = 4000;
      } catch {
        /* keep the last result; try again later */
      }
      if (alive) timer = setTimeout(tick, document.hidden ? 30_000 : next);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
}

const isBusy = (p: PostBots, live: LiveWork | null) => (WATCHED.includes(p.status) && !p.fresh) || p.status === "publishing" || (!!live && live.postId === p.id);

/** On the post page: the three bots and what they're doing with this post. */
export function PostBotsCard({ postId, version, onReview, onStatus }: { postId: number; version: string; onReview?: (revisionId: number) => void; onStatus: (status: string) => void }) {
  const data = usePoll(
    () => api<{ bots: PostBots }>(`/posts/${postId}/bots`).then((r) => r.bots),
    (b) => isBusy(b, b.live ?? null),
    [postId, version],
  );
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    // The Posting Bot finished (or the status changed elsewhere): let the page reload the post.
    if (reported.current && reported.current !== data.status) onStatus(data.status);
    reported.current = data.status;
  }, [data, onStatus]);
  if (!data) return null;
  const lines = postLines(data, data.live ?? null);
  const anyWorking = Object.values(lines).some((l) => l.state === "working");
  return (
    <div className="board bw-card">
      <div className="spread">
        <p className="label mb0">The bots on this post</p>
        {anyWorking && <span className="bw-live">Live</span>}
      </div>
      <div className="bw-lines">
        <Line
          line={lines.editor}
          action={
            data.pending_revision_id && onReview ? (
              <Button size="sm" variant="primary" onClick={() => onReview(data.pending_revision_id!)}>
                Review suggestion
              </Button>
            ) : undefined
          }
        />
        <Line line={lines.checker} />
        <Line line={lines.posting} />
      </div>
    </div>
  );
}

/** Loads what the bots are doing on the team's posts (for the AI bots page). */
export function useTeamWatch() {
  return usePoll(() => api<TeamData>("/bots/team"), (d) => !!d.live || d.queue > 0 || d.posts.some((p) => p.status === "publishing"), []);
}

/** On the AI bots page: every post on its way to the Page, with what each bot is doing. */
export function TeamWatch({ data }: { data: TeamData | null }) {
  if (!data) return null;
  return (
    <section className="board mt24 bw-team">
      <div className="spread" style={{ gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 className="section mb0">Posts the bots are looking after</h2>
          <p className="meta mt8 mb0">Every post sent for review, whoever wrote it. The Editor and Checker Bots check it; the Posting Bot posts it at its time. Approval stays with your managers.</p>
        </div>
        {data.live ? (
          <span className="bw-live">
            {BOTS[data.live.bot].name}: {data.live.task.toLowerCase()}
          </span>
        ) : data.queue ? (
          <span className="meta">{data.queue} waiting to be checked</span>
        ) : null}
      </div>
      {!data.posts.length ? (
        <p className="muted">No posts are waiting for review or scheduled right now.</p>
      ) : (
        <ul className="bw-rows">
          {data.posts.map((p) => {
            const l = postLines(p, data.live);
            const active = isBusy(p, data.live);
            return (
              <li key={p.id} className={active ? "active" : ""}>
                <div className="bw-row-head">
                  <Link to={`/posts/${p.id}`} className="bw-title">
                    {p.title}
                  </Link>
                  <StatusTag map={POST_STATUS} value={p.status} />
                  <span className="meta">{p.source_topic?.startsWith("Bots:") ? "From a bot batch" : `By ${p.created_by_name ?? "the team"}`}</span>
                </div>
                <div className="bw-row-bots">
                  <Line line={l.editor} compact />
                  <Line line={l.checker} compact />
                  <Line line={l.posting} compact />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
