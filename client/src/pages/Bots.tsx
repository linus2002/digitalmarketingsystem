import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { MediaUpload, mediaSrc, type UploadedMedia } from "../components/MediaUpload";
import { RevisionModal, StandardsPanel } from "../components/EditorBot";
import { Link } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";
import { ago, bizToday, BUSINESS_TZ_LABEL, fmtBiz, fmtDate, fromBizInput, POST_STATUS, toBizInput } from "../lib/format";
import { Alert, Button, Check, ConfirmModal, Empty, IconButton, LoadError, Modal, PageHead, Seg, SelectField, Skeleton, StatusTag, Steps, Switch, Tabs, Tag, TextArea, TextField } from "../components/ui";
import { BOT_ORDER, BOTS, BotFace, BotFlow, FLOW, type BotName, type BotView } from "../components/BotArt";
import { BotOffice } from "../components/OfficeScene";
import "../styles/bots.css";

// ---------------------------------------------------------------- types

interface Rules {
  keywordCount: number;
  hashtags: boolean;
  language: "English" | "Filipino" | "Taglish";
  words: number;
  addDisclaimer: boolean;
}
interface Run {
  step: "caption" | "edit" | "schedule" | "check" | "handoff";
  message: string;
  done: number;
  total: number;
  cancelling?: boolean;
}
interface BatchRow {
  id: number;
  name: string;
  items: number;
  captioned: number;
  timed: number;
  handed: number;
  blocked: number;
  checked_at: string | null;
  updated_at: string;
  run: Run | null;
}
interface Overview {
  ai: { ready: boolean; label: string; problem?: string; fix?: string };
  rules: Rules;
  style: { trained: boolean; profile: string; sampleCount: number; trainedAt: string | null };
  batches: BatchRow[];
  running: ({ batchId: number } & Run)[];
  activity: { id: number; bot: BotName; batch_name: string | null; level: "info" | "good" | "warn" | "bad"; message: string; created_at: string }[];
  outcomes: Record<string, number>;
  dryRun: boolean;
  canScheduleDirectly: boolean;
}
interface Issue {
  level: "bad" | "warn";
  text: string;
}
interface Item {
  id: number;
  position: number;
  title: string;
  brief: string;
  media_type: "none" | "image" | "video";
  media_url: string | null;
  media_id?: number | null;
  /** A suggestion from the Editor Bot waiting to be accepted or rejected */
  pending_revision_id?: number | null;
  caption: string | null;
  keywords: string[];
  hashtags: string[];
  caption_error: string | null;
  scheduled_at: string | null;
  time_locked: boolean;
  issues: Issue[];
  post_id: number | null;
  handed_off_at: string | null;
  post_status: string | null;
}
interface Schedule {
  days: "daily" | "weekdays" | "mwf" | "custom";
  customDays: number[];
  startDate: string | null;
  mode: "auto" | "times";
  times: string[];
  windowStart: string;
  windowEnd: string;
  perDay: number;
  minGapMinutes: number;
}
interface BatchData {
  batch: { id: number; name: string; checked_at: string | null; handed_off_at: string | null; campaign_id: number | null };
  items: Item[];
  schedule: Schedule;
  run: Run | null;
}

/** Limits that match the server (requests stay well under its 1 MB limit). */
const BRIEF_MAX = 3000;
const ITEMS_MAX = 100;
const STYLE_MAX_SAMPLES = 30;
const STYLE_MAX_CHARS = 1500;

const phTime = (v: string | null) => (v ? `${fmtBiz(v)}` : "No time yet");
/** Handed off: has a post, or had one that was deleted since (it isn't handed off again). */
const handed = (i: Item) => !!i.post_id || !!i.handed_off_at;

const RUN_BOT: Record<Run["step"], BotName> = { caption: "caption", edit: "editor", schedule: "scheduler", check: "checker", handoff: "posting" };
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function storedBatch(): number | null {
  try {
    return Number(localStorage.getItem("bots.batch")) || null;
  } catch {
    return null;
  }
}
function rememberBatch(id: number | null) {
  try {
    if (id) localStorage.setItem("bots.batch", String(id));
    else localStorage.removeItem("bots.batch");
  } catch {
    /* private mode */
  }
}
function storedMotion(): boolean | null {
  try {
    const v = localStorage.getItem("bots.motion");
    return v === "on" ? true : v === "off" ? false : null;
  } catch {
    return null;
  }
}

function useMedia(query: string) {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return m;
}

/** Why the Caption Bot can't write, in words the person can act on. */
function aiReason(o: Overview, admin: boolean) {
  if (o.ai.ready) return null;
  return admin
    ? `The Caption Bot needs ${o.ai.label}: ${o.ai.problem ?? "it isn't ready."} ${o.ai.fix ?? ""}`.trim()
    : "The Caption Bot can't write right now because the AI isn't running. Ask your administrator to start the AI. Picking times and checking still work.";
}

// ---------------------------------------------------------------- what each bot is doing

function botViews(ov: Overview, data: BatchData | null): Record<BotName, BotView> {
  const pending = (data?.items ?? []).filter((i) => !handed(i));
  const blocked = pending.filter((i) => i.issues.some((x) => x.level === "bad")).length;
  const failed = ov.outcomes.failed ?? 0;
  const run = data?.run ?? null;
  const v: Record<BotName, BotView> = {
    caption: !ov.ai.ready
      ? { mood: "sleep", state: "off", task: "The AI isn't running" }
      : pending.some((i) => i.caption_error)
        ? { mood: "sad", state: "attention", task: `${pending.filter((i) => i.caption_error).length} captions failed` }
        : pending.some((i) => !i.caption)
          ? { mood: "neutral", state: "idle", task: `${pending.filter((i) => !i.caption).length} captions to write` }
          : { mood: "happy", state: "done", task: pending.length ? "All captions written" : "On a coffee break" },
    editor: pending.some((i) => i.pending_revision_id)
      ? { mood: "alert", state: "attention", task: `${pending.filter((i) => i.pending_revision_id).length} revision${pending.filter((i) => i.pending_revision_id).length === 1 ? "" : "s"} to review` }
      : { mood: "determined", state: "idle", task: pending.some((i) => i.caption) ? "Ready to revise" : "Waiting for captions" },
    style: ov.style.trained ? { mood: "happy", state: "done", task: "Writing like your team" } : { mood: "sleep", state: "off", task: "Teach me your style" },
    scheduler: pending.some((i) => !i.scheduled_at)
      ? { mood: "wink", state: "idle", task: `${pending.filter((i) => !i.scheduled_at).length} posts need times` }
      : { mood: "happy", state: "done", task: pending.length ? "Every post has a time" : "On a coffee break" },
    checker: blocked
      ? { mood: "alert", state: "attention", task: `${blocked} post${blocked === 1 ? "" : "s"} to fix` }
      : pending.length && data?.batch.checked_at
        ? { mood: "happy", state: "done", task: "All clear" }
        : { mood: "determined", state: "idle", task: pending.length ? "Ready to check" : "Watching the posts" },
    posting: failed
      ? { mood: "sad", state: "attention", task: `${failed} post${failed === 1 ? "" : "s"} failed to publish` }
      : pending.length && !blocked && data?.batch.checked_at
        ? { mood: "neutral", state: "idle", task: `Ready to hand off ${pending.length}` }
        : { mood: "happy", state: "idle", task: (ov.outcomes.scheduled ?? 0) ? `${ov.outcomes.scheduled} posts lined up` : "On a coffee break" },
  };
  const active = run ?? ov.running[0] ?? null;
  if (active) {
    const b = RUN_BOT[active.step];
    v[b] = {
      mood: "focus",
      state: "working",
      task: active.cancelling ? "Stopping…" : active.total > 1 ? `${active.step === "caption" ? "Writing" : "Working"} ${Math.min(active.done + 1, active.total)} of ${active.total}` : active.message,
    };
  }
  return v;
}

function flowStage(ov: Overview, data: BatchData | null): number {
  if (!data) return 0;
  const run = data.run;
  if (run) return run.step === "caption" ? 2 : run.step === "edit" ? 3 : run.step === "schedule" ? 4 : run.step === "check" ? 5 : 6;
  const pending = data.items.filter((i) => !handed(i));
  const done = data.items.filter(handed);
  if (!data.items.length) return 0;
  if (!pending.length) return done.every((i) => i.post_status === "published") ? FLOW.length : 7;
  if (pending.some((i) => !i.caption)) return ov.style.trained ? 2 : 1;
  if (pending.some((i) => i.pending_revision_id)) return 3;
  if (pending.some((i) => !i.scheduled_at)) return 4;
  if (!data.batch.checked_at || pending.some((i) => i.issues.some((x) => x.level === "bad"))) return 5;
  return 6;
}

// ---------------------------------------------------------------- page

export function BotsPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const ov = useLoad(() => api<Overview>("/bots/overview"), []);
  const [batchId, setBatchId] = useState<number | null>(storedBatch());
  // The loaded batch carries the id it was loaded for, so a stale result is never mistaken for the current one.
  const batch = useLoad(
    () =>
      batchId
        ? api<BatchData>(`/bots/batches/${batchId}`)
            .then((d) => ({ id: batchId, d: d as BatchData | null }))
            .catch((e: { status?: number }) => (e.status === 404 ? { id: batchId, d: null } : Promise.reject(e)))
        : Promise.resolve(null),
    [batchId],
  );
  const [bot, setBot] = useState<BotName>("caption");
  const [view, setView] = useState<"office" | "flow">("office");
  const reduceMotion = useMedia("(prefers-reduced-motion: reduce)");
  const narrow = useMedia("(max-width: 759px)");
  const [motionPref, setMotionPref] = useState<boolean | null>(storedMotion);
  const motion = motionPref ?? !reduceMotion;
  const toggleMotion = (on: boolean) => {
    setMotionPref(on);
    try {
      localStorage.setItem("bots.motion", on ? "on" : "off");
    } catch {
      /* private mode */
    }
  };
  // On a phone the office is too small to read, so it starts folded away; the bot chips stay.
  const [officePref, setOfficePref] = useState<boolean | null>(null);
  const showOffice = officePref ?? !narrow;
  const [newOpen, setNewOpen] = useState(false);
  const editable = can("posts.edit");
  const canBrand = can("settings.brand");
  const admin = user?.role === "admin";
  const panelRef = useRef<HTMLElement>(null);

  // Unsaved Team rules / Scheduler settings: ask before switching away from them.
  const dirtyRef = useRef(false);
  const setDirty = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);
  const [leave, setLeave] = useState<null | (() => void)>(null);
  const guard = (fn: () => void) => {
    if (dirtyRef.current) setLeave(() => fn);
    else fn();
  };
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const choose = (id: number | null) => {
    setBatchId(id);
    rememberBatch(id);
  };
  const pickBatch = (id: number | null) => {
    if (id === batchId) return;
    guard(() => {
      dirtyRef.current = false;
      choose(id);
    });
  };
  const pickBot = (b: BotName) => {
    const reveal = () => {
      if (narrow) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: motion ? "smooth" : "auto", block: "start" }));
    };
    if (b === bot) return reveal();
    guard(() => {
      dirtyRef.current = false;
      setBot(b);
      reveal();
    });
  };

  // Pick a batch when none is chosen, or when the remembered one no longer exists. A remembered batch that is
  // simply older than the newest 50 stays selected (it's loaded directly).
  useEffect(() => {
    if (!ov.data) return;
    const first = ov.data.batches[0]?.id ?? null;
    if (!batchId) {
      if (first) choose(first);
      return;
    }
    if (batch.data && batch.data.id === batchId && batch.data.d === null) choose(first === batchId ? null : first);
  }, [ov.data, batchId, batch.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = batch.data && batch.data.id === batchId ? batch.data.d : null;

  // While the bots work, refresh every 2 seconds so the office shows them at it.
  const working = !!data?.run || !!ov.data?.running.length;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => {
      void batch.reload();
      void ov.reload();
    }, 2000);
    return () => clearInterval(t);
  }, [working, batch.reload, ov.reload]);

  const refresh = () => Promise.all([batch.reload(), ov.reload()]);

  if (ov.error) return <LoadError error={ov.error} retry={ov.reload} />;
  if (!ov.data)
    return (
      <div className="board">
        <Skeleton rows={6} />
      </div>
    );

  const o = ov.data;
  const views = botViews(o, data);
  const stage = flowStage(o, data);

  return (
    <div className="bots-page">
      <PageHead
        title="AI bots"
        sub="Five bots that turn your notes into scheduled Facebook posts: one writes captions, one learns your style, one picks times, one checks everything and one hands the posts over. Another manager still approves every post."
      />
      {o.dryRun && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="info" title="Test mode">Posts the bots line up go through the whole workflow, but nothing is sent to Facebook while Test mode is on.</Alert>
        </div>
      )}

      <section className="board office-board">
        <div className="spread office-head">
          <Tabs
            value={view}
            onChange={setView}
            tabs={[
              { value: "office", label: "The office" },
              { value: "flow", label: "How it flows" },
            ]}
          />
          <div className="row" style={{ gap: 16 }}>
            {data && <span className="meta">Batch: {data.batch.name}</span>}
            {view === "office" && (
              <Button size="sm" variant="quiet" aria-expanded={showOffice} onClick={() => setOfficePref(!showOffice)}>
                {showOffice ? "Hide office" : "Show office"}
              </Button>
            )}
            {view === "office" && showOffice && <Switch label="Motion" checked={motion} onChange={toggleMotion} />}
          </div>
        </div>
        {view === "office" ? (
          <>
            {showOffice && <BotOffice views={views} selected={bot} onSelect={pickBot} motion={motion} />}
            <div className="bot-chips" role="group" aria-label="Bots">
              {BOT_ORDER.map((b) => (
                <button key={b} type="button" className={`bot-chip s-${views[b].state}`} aria-pressed={bot === b} onClick={() => pickBot(b)}>
                  <BotFace bot={b} mood={views[b].mood} size={34} />
                  <span>
                    <b>{BOTS[b].name}</b>
                    <small>{views[b].task}</small>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <FlowView stage={stage} onPick={pickBot} />
        )}
      </section>

      <div className="grid g-side mt24">
        <div className="stackv" style={{ gap: 20 }}>
          <BatchPicker o={o} batchId={batchId} current={data} onChoose={pickBatch} onNew={() => setNewOpen(true)} editable={editable} />
          {batch.error && <LoadError error={batch.error} retry={batch.reload} />}
          {batchId && !data && !batch.error && (
            <div className="board">
              <Skeleton rows={4} />
            </div>
          )}
          {!o.batches.length && !data && (
            <div className="board">
              <Empty
                title="No batches yet"
                action={
                  editable && (
                    <Button variant="primary" icon="plus" onClick={() => setNewOpen(true)}>
                      Start a batch
                    </Button>
                  )
                }
              >
                A batch is a set of posts the bots work on together. Add your notes, video transcripts or image links, then let the bots do the rest.
              </Empty>
            </div>
          )}
          {data && (
            <Workspace
              data={data}
              o={o}
              admin={admin}
              editable={editable}
              onChange={refresh}
              setBatch={(d) => batch.setData({ id: d.batch.id, d })}
              onDeleted={() => {
                choose(null);
                void ov.reload();
              }}
            />
          )}
        </div>
        <aside ref={panelRef} className="board stackv bot-panel" style={{ gap: 16 }} aria-label={`${BOTS[bot].name} panel`}>
          <BotPanel bot={bot} view={views[bot]} o={o} data={data} editable={editable} canBrand={canBrand} admin={admin} onChange={refresh} onDirty={setDirty} />
        </aside>
      </div>

      <section className="board mt24">
        <h2 className="section">What the bots did</h2>
        {!o.activity.length ? (
          <p className="muted">Nothing yet. Their work shows up here as they go.</p>
        ) : (
          <ul className="bot-feed">
            {o.activity.map((a) => (
              <li key={a.id}>
                <BotFace bot={a.bot} mood={a.level === "bad" ? "sad" : a.level === "warn" ? "alert" : a.level === "good" ? "happy" : undefined} size={36} />
                <div className="grow">
                  <b>{BOTS[a.bot].name}</b> <span className="pre">{a.message}</span>
                  <div className="meta">
                    {ago(a.created_at)}
                    {a.batch_name ? ` · ${a.batch_name}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {newOpen && (
        <NewBatchModal
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false);
            dirtyRef.current = false;
            choose(id);
            void ov.reload();
            toast.ok("Batch started", "Add the posts the bots should work on.");
          }}
        />
      )}
      {leave && (
        <ConfirmModal
          title="Leave without saving?"
          warning="Your changes to the Team rules or the Scheduler Bot's settings haven't been saved."
          confirmLabel="Leave without saving"
          onClose={() => setLeave(null)}
          onConfirm={() => {
            const go = leave;
            setLeave(null);
            dirtyRef.current = false;
            go();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- flow view (journey map)

function FlowView({ stage, onPick }: { stage: number; onPick: (b: BotName) => void }) {
  const text: Record<string, string> = {
    add: "You add the posts: notes, key points or a video's transcript, plus an image or video link if there is one.",
    style: "Learns your team's writing from old captions, so every new caption sounds like you.",
    caption: "Writes each caption with search keyword phrases, following the Team rules and the brand guidelines.",
    editor: "Checks each caption against your standards (length, hook, call to action, words to use or avoid…) and revises it. You accept or reject each revision, unless auto-revise is on.",
    schedule: "Spreads the posts over the days you choose, in Philippine time, without clashing with posts already booked.",
    check: "Flags past times, clashes, posts too close together, brand-rule problems and media Facebook can't reach.",
    handoff: "Turns each ready post into a real post and sends it for review (an administrator can schedule directly).",
    publish: "Another manager approves each post (you can't approve posts you handed off). It's published on the Page at its planned time, and the Checker Bot follows up.",
  };
  return (
    <div className="flow-wrap">
      <BotFlow current={stage} done={stage} />
      <ol className="flow-cards">
        {FLOW.map((f, i) => {
          const b = f.bot !== "you" && f.bot !== "team" ? f.bot : null;
          return (
            <li key={f.key} className={i === stage ? "now" : i < stage ? "done" : ""}>
              <span className="flow-n">{i < stage ? "✓" : i + 1}</span>
              <div className="grow">
                <b>{f.title}</b>
                <p>{text[f.key]}</p>
                <div className="flow-who">
                  {b ? (
                    <button type="button" className="linkish" onClick={() => onPick(b)}>
                      <BotFace bot={b} size={26} /> {BOTS[b].name}
                    </button>
                  ) : (
                    <span className="meta">{f.bot === "you" ? "You" : "Another marketing manager"}</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- batches

const batchLabel = (b: BatchRow) => `${b.name} · ${b.items} post${b.items === 1 ? "" : "s"}${b.handed ? `, ${b.handed} handed off` : ""}`;

function BatchPicker({
  o,
  batchId,
  current,
  onChoose,
  onNew,
  editable,
}: {
  o: Overview;
  batchId: number | null;
  current: BatchData | null;
  onChoose: (id: number) => void;
  onNew: () => void;
  editable: boolean;
}) {
  const toast = useToast();
  // The overview lists the newest 50 batches; "Show all" loads the rest so older ones can be picked.
  const [all, setAll] = useState<BatchRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  if (!o.batches.length && !current) return null;
  const list = (all ?? o.batches).filter((b) => !search.trim() || b.name.toLowerCase().includes(search.trim().toLowerCase()));
  const options = list.map((b) => ({ value: b.id, label: batchLabel(b) }));
  if (batchId && current && !options.some((x) => x.value === batchId)) options.unshift({ value: batchId, label: current.batch.name });
  const mayHaveMore = !all && o.batches.length >= 50;
  async function showAll() {
    setLoading(true);
    try {
      const r = await api<{ batches: BatchRow[] }>("/bots/batches");
      setAll(r.batches);
    } catch (e) {
      toast.err("Couldn't load the batches", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="stackv" style={{ gap: 8 }}>
      <div className="spread batch-picker">
        <SelectField label="Batch" className="grow" value={batchId ?? ""} onChange={(e) => onChoose(Number(e.target.value))} options={options} />
        <div className="row" style={{ gap: 8, alignSelf: "flex-end" }}>
          {mayHaveMore && (
            <Button variant="quiet" loading={loading} onClick={showAll}>
              Show all batches
            </Button>
          )}
          {editable && (
            <Button icon="plus" onClick={onNew}>
              New batch
            </Button>
          )}
        </div>
      </div>
      {all && <TextField label="Find a batch" optional value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type part of the name" hint={`${all.length} batch${all.length === 1 ? "" : "es"} in all.`} />}
    </div>
  );
}

function NewBatchModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const campaigns = useLoad(() => api<{ campaigns: { id: number; name: string; status: string }[] }>("/campaigns"), []);
  const [name, setName] = useState(`Posts for the week of ${fmtDate(new Date().toISOString())}`);
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ batch: { id: number } }>("/bots/batches", { body: { name, campaign_id: campaign ? Number(campaign) : null } });
      onCreated(r.batch.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Start a batch"
      onClose={onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>
            Start
          </Button>
        </>
      }
    >
      <div className="stackv" style={{ gap: 14 }}>
        {err && <Alert tone="bad">{err}</Alert>}
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <SelectField
          label="Campaign"
          optional
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
          options={[{ value: "", label: "None" }, ...(campaigns.data?.campaigns ?? []).filter((c) => c.status !== "archived").map((c) => ({ value: c.id, label: c.name }))]}
        />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the batch workspace

function Workspace({
  data,
  o,
  admin,
  editable,
  onChange,
  setBatch,
  onDeleted,
}: {
  data: BatchData;
  o: Overview;
  admin: boolean;
  editable: boolean;
  onChange: () => Promise<unknown>;
  setBatch: (d: BatchData) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [recaption, setRecaption] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [reviewing, setReviewing] = useState<Item | null>(null);
  const [removing, setRemoving] = useState<Item | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { items, run } = data;
  const pending = items.filter((i) => !handed(i));
  const locked = !!run || !editable;
  const step = !items.length ? 0 : pending.length && (pending.some((i) => !i.caption || !i.scheduled_at) || !data.batch.checked_at) ? 1 : pending.length ? 2 : 3;
  const aiDown = aiReason(o, admin);
  // Without the AI, "Run all bots" can still pick times and check when every post already has a caption.
  const allCaptioned = pending.every((i) => !!i.caption?.trim());
  const runAllSteps = !aiDown ? ["caption", "schedule", "check"] : allCaptioned && !recaption ? ["schedule", "check"] : null;

  async function act(label: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(label);
    try {
      await fn();
      if (ok) toast.ok(ok);
      await onChange();
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const runBots = (steps: string[], label: string) => act(label, () => api(`/bots/batches/${data.batch.id}/run`, { body: { steps, recaption } }));
  const move = (i: number, dir: -1 | 1) => {
    const ids = items.map((x) => x.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void act("move", async () => setBatch({ ...data, ...(await api<Omit<BatchData, "schedule" | "run">>(`/bots/batches/${data.batch.id}/reorder`, { body: { ids } })) }));
  };

  return (
    <>
      <div className="board">
        <div className="spread">
          <h2 className="section">{data.batch.name}</h2>
          {editable && <IconButton icon="trash" label="Delete this batch" danger disabled={!!run} onClick={() => setConfirmDelete(true)} />}
        </div>
        <div className="mt16">
          <Steps steps={["Add posts", "Run the bots", "Hand off", "Done"]} current={step} />
        </div>
        {editable && (
          <AddPosts
            batchId={data.batch.id}
            disabled={!!run}
            onAdded={(d) => {
              setBatch({ ...data, ...d });
              void onChange();
            }}
          />
        )}
      </div>

      {run && (
        <div className="card soft bot-run" aria-live="polite">
          <BotFace bot={RUN_BOT[run.step]} mood="focus" size={60} />
          <div className="grow">
            <b>{run.cancelling ? `${BOTS[RUN_BOT[run.step]].name} is stopping` : `${BOTS[RUN_BOT[run.step]].name} is working`}</b>
            <p className="muted mt0 mb0">{run.cancelling ? "Finishing the post in hand, then stopping." : run.message}</p>
            {run.total > 1 && (
              <div className="bar">
                <i style={{ width: `${Math.round((run.done / run.total) * 100)}%` }} />
              </div>
            )}
          </div>
          {editable && (
            <Button
              size="sm"
              variant="quiet"
              loading={busy === "cancel"}
              disabled={!!run.cancelling}
              onClick={() => act("cancel", () => api(`/bots/batches/${data.batch.id}/cancel`, { body: {} }), "Stopping after the current post")}
            >
              {run.cancelling ? "Stopping…" : "Cancel"}
            </Button>
          )}
        </div>
      )}

      {editable && pending.length > 0 && (
        <div className="board stackv" style={{ gap: 12 }}>
          <div className="row">
            <Button variant="primary" icon="spark" loading={busy === "all"} disabled={locked || !runAllSteps} onClick={() => runAllSteps && runBots(runAllSteps, "all")}>
              {aiDown && runAllSteps ? "Pick times and check" : "Run all bots"}
            </Button>
            <Button variant="secondary" icon="send" disabled={locked || !!busy} onClick={() => setHandoff(true)}>
              Hand to the Posting Bot
            </Button>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="soft" loading={busy === "cap"} disabled={locked || !!aiDown} onClick={() => runBots(["caption"], "cap")}>
              Captions only
            </Button>
            <Button size="sm" variant="soft" loading={busy === "sched"} disabled={locked} onClick={() => act("sched", () => api(`/bots/batches/${data.batch.id}/schedule`, { body: {} }), "Times picked")}>
              Pick times
            </Button>
            <Button size="sm" variant="soft" loading={busy === "check"} disabled={locked} onClick={() => act("check", () => api(`/bots/batches/${data.batch.id}/check`, { body: {} }), "Checked")}>
              Check
            </Button>
            {!aiDown && <Check label="Rewrite captions that already exist" checked={recaption} onChange={setRecaption} />}
          </div>
          {aiDown && (
            <p className="note mt0" role="status">
              {aiDown}
            </p>
          )}
        </div>
      )}

      {!items.length ? (
        <div className="board">
          <Empty title="No posts in this batch yet">Add posts above. One per video, photo or idea.</Empty>
        </div>
      ) : (
        <div className="stackv" style={{ gap: 12 }}>
          {items.map((it, i) => (
            <ItemCard key={it.id} it={it} n={i + 1} checked={!!data.batch.checked_at} last={i === items.length - 1} locked={locked} onMove={(d) => move(i, d)} onEdit={() => setEditing(it)} onDelete={() => setRemoving(it)} onReview={() => setReviewing(it)} />
          ))}
        </div>
      )}

      {reviewing && (
        <RevisionModal
          text={reviewing.caption ?? ""}
          itemId={reviewing.id}
          revisionId={reviewing.pending_revision_id ?? null}
          onAccept={() => void onChange()}
          onClose={() => {
            setReviewing(null);
            void onChange();
          }}
        />
      )}
      {editing && (
        <EditItemModal
          item={editing}
          aiReady={!aiDown}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void onChange();
          }}
        />
      )}
      {removing && (
        <ConfirmModal
          title="Remove this post from the batch?"
          warning="Its notes, caption and time will be lost."
          confirmLabel="Remove"
          busy={busy === "del"}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            act(
              "del",
              async () => {
                await api(`/bots/items/${removing.id}`, { method: "DELETE" });
                setRemoving(null);
              },
              "Removed",
            )
          }
        >
          <p className="mt0">"{removing.title || removing.brief.slice(0, 70) || "Untitled"}"</p>
        </ConfirmModal>
      )}
      {handoff && (
        <HandoffModal
          data={data}
          o={o}
          onClose={() => setHandoff(false)}
          onDone={() => {
            setHandoff(false);
            void onChange();
          }}
        />
      )}
      {confirmDelete && (
        <Modal
          title="Delete this batch?"
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                loading={busy === "delete"}
                onClick={() =>
                  act(
                    "delete",
                    async () => {
                      await api(`/bots/batches/${data.batch.id}`, { method: "DELETE" });
                      setConfirmDelete(false);
                      onDeleted();
                    },
                    "Batch deleted",
                  )
                }
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="mt0">The captions and times in "{data.batch.name}" will be lost. Posts already handed off stay in Posts and approvals, and the bots' activity history is kept.</p>
        </Modal>
      )}
    </>
  );
}

function guessType(url: string): "image" | "video" {
  return /\.(mp4|mov|m4v|webm)(\?|$)/i.test(url) ? "video" : "image";
}

function AddPosts({ batchId, disabled, onAdded }: { batchId: number; disabled: boolean; onAdded: (d: Omit<BatchData, "schedule" | "run">) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"one" | "many">("one");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [mediaType, setMediaType] = useState<"none" | "upload" | "image" | "video">("none");
  const [url, setUrl] = useState("");
  const [uploaded, setUploaded] = useState<UploadedMedia | null>(null);
  const [lines, setLines] = useState("");
  const [busy, setBusy] = useState(false);

  const many = lines
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(https?:\/\/\S+)\s*(?:\||-|–)?\s*(.*)$/);
      return m ? { brief: m[2] || "", media_url: m[1], media_type: guessType(m[1]) } : { brief: l, media_url: null, media_type: "none" as const };
    });

  const briefErr = brief.length > BRIEF_MAX ? `Keep it under ${BRIEF_MAX.toLocaleString("en")} characters (now ${brief.length.toLocaleString("en")}). Paste the most important part.` : undefined;
  const longLines = many.map((m, i) => (m.brief.length > BRIEF_MAX ? i + 1 : 0)).filter(Boolean);
  const manyErr =
    many.length > ITEMS_MAX
      ? `Add up to ${ITEMS_MAX} posts at a time (you have ${many.length}). Add the rest in a second go.`
      : longLines.length
        ? `Line${longLines.length === 1 ? "" : "s"} ${longLines.slice(0, 5).join(", ")}${longLines.length > 5 ? "…" : ""} ${longLines.length === 1 ? "is" : "are"} longer than ${BRIEF_MAX.toLocaleString("en")} characters.`
        : undefined;
  const canAdd = mode === "one" ? !!brief.trim() && !briefErr : many.length > 0 && !manyErr;

  function pickMedia(v: "none" | "upload" | "image" | "video") {
    setMediaType(v);
    // Nothing hidden is sent: switching away clears the other kind of media.
    if (v !== "image" && v !== "video") setUrl("");
    if (v !== "upload") setUploaded(null);
  }

  async function add() {
    setBusy(true);
    try {
      const items =
        mode === "one"
          ? [
              mediaType === "upload" && uploaded
                ? { title, brief, media_type: uploaded.kind, media_id: uploaded.id }
                : {
                    title,
                    brief,
                    media_type: (mediaType === "image" || mediaType === "video") && url.trim() ? mediaType : "none",
                    media_url: (mediaType === "image" || mediaType === "video") && url.trim() ? url.trim() : null,
                  },
            ]
          : many;
      const r = await api<Omit<BatchData, "schedule" | "run">>(`/bots/batches/${batchId}/items`, { body: { items } });
      toast.ok(`Added ${items.length} post${items.length === 1 ? "" : "s"}`);
      setTitle("");
      setBrief("");
      setUrl("");
      setUploaded(null);
      setMediaType("none");
      setLines("");
      onAdded(r);
    } catch (e) {
      toast.err("Couldn't add", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stackv mt24" style={{ gap: 14 }}>
      <div className="spread">
        <p className="label mb0">Add posts</p>
        <Seg
          label="How to add"
          value={mode}
          onChange={setMode}
          options={[
            { value: "one", label: "One post" },
            { value: "many", label: "Several at once" },
          ]}
        />
      </div>
      {mode === "one" ? (
        <>
          <TextField label="Working title" optional value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Cold chain: how we keep medicines safe" />
          <TextArea
            label="What's it about?"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={4}
            error={briefErr}
            hint={`Notes, key points, or paste the video's transcript (up to ${BRIEF_MAX.toLocaleString("en")} characters). The Caption Bot writes from this.`}
          />
          <div className="grid g2">
            <div>
              <p className="lab-sm">Media</p>
              <Seg
                label="Media type"
                value={mediaType}
                onChange={pickMedia}
                options={[
                  { value: "none", label: "None" },
                  { value: "upload", label: "Upload" },
                  { value: "image", label: "Image link" },
                  { value: "video", label: "Video link" },
                ]}
              />
            </div>
            {(mediaType === "image" || mediaType === "video") && (
              <TextField
                label={`${mediaType === "video" ? "Video" : "Image"} link`}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://… (public link)"
                hint={mediaType === "video" ? "A direct .mp4 or .mov link Facebook can download." : "A public image link."}
              />
            )}
          </div>
          {mediaType === "upload" && <MediaUpload value={uploaded} onChange={setUploaded} label="Upload an image or video" />}
        </>
      ) : (
        <TextArea
          label="One post per line"
          value={lines}
          onChange={(e) => setLines(e.target.value)}
          rows={6}
          error={manyErr}
          placeholder={"Why cold chain matters for cancer medicines\nhttps://example.com/videos/pharmacist-tips.mp4 | Our pharmacist on storing medicines at home"}
          hint={
            many.length
              ? `${many.length} post${many.length === 1 ? "" : "s"} · ${many.filter((m) => m.media_type === "video").length} with video, ${many.filter((m) => m.media_type === "image").length} with an image`
              : `Start a line with a public link to attach an image or video, then | and what it's about. Up to ${ITEMS_MAX} lines at a time.`
          }
        />
      )}
      <div>
        <Button variant="primary" icon="plus" loading={busy} disabled={disabled || !canAdd} onClick={add}>
          Add to batch
        </Button>
      </div>
    </div>
  );
}

function ItemCard({ it, n, checked, last, locked, onMove, onEdit, onDelete, onReview }: { it: Item; n: number; checked: boolean; last: boolean; locked: boolean; onMove: (d: -1 | 1) => void; onEdit: () => void; onDelete: () => void; onReview: () => void }) {
  const bad = it.issues.filter((x) => x.level === "bad");
  const warn = it.issues.filter((x) => x.level === "warn");
  const done = handed(it);
  const status = done ? null : bad.length ? { tone: "bad" as const, label: "Needs fixing" } : !it.caption ? { tone: "mute" as const, label: "Needs a caption" } : !it.scheduled_at ? { tone: "warn" as const, label: "Needs a time" } : !checked ? { tone: "mute" as const, label: "Not checked yet" } : { tone: "good" as const, label: "Ready" };
  return (
    <div className={`card soft bot-item ${done ? "handed" : ""}`}>
      <div className="spread">
        <div className="row" style={{ gap: 10, minWidth: 0, flex: 1 }}>
          <span className="item-n">{n}</span>
          {it.media_id && it.media_type === "image" && <img className="media-thumb" src={mediaSrc(it.media_id)} alt="" />}
          <b className="grow" style={{ overflowWrap: "anywhere" }}>{it.title || it.brief.slice(0, 70) || "Untitled"}</b>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {status ? (
            <Tag tone={status.tone} dot>{status.label}</Tag>
          ) : it.post_id ? (
            <StatusTag map={POST_STATUS} value={it.post_status ?? "draft"} />
          ) : (
            <Tag tone="mute">Handed off, post deleted</Tag>
          )}
          {it.media_type !== "none" && <Tag tone="outline">{(it.media_type === "video" ? "Video" : "Image") + (it.media_id ? " (uploaded)" : " link")}</Tag>}
        </div>
      </div>
      <p className="meta mt8 mb0">
        {phTime(it.scheduled_at)}
        {it.scheduled_at ? ` (${BUSINESS_TZ_LABEL})` : ""}
        {it.scheduled_at && it.time_locked && !done ? " · set by you" : ""}
      </p>
      {it.caption ? <p className="pre clamp-4">{it.caption}</p> : <p className="muted clamp">{it.brief}</p>}
      {it.caption_error && !it.caption && <Alert tone="bad">The Caption Bot couldn't write this one: {it.caption_error}</Alert>}
      {it.pending_revision_id && !handed(it) && (
        <div className="ed-suggest">
          <BotFace bot="editor" mood="happy" size={30} />
          <span className="grow">The Editor Bot revised this caption to meet your standards.</span>
          {!locked && (
            <Button size="sm" variant="primary" onClick={onReview}>
              Review revision
            </Button>
          )}
        </div>
      )}
      {(it.keywords.length > 0 || it.hashtags.length > 0) && (
        <div className="row" style={{ gap: 6 }}>
          {it.keywords.map((k) => (
            <Tag key={k} tone="info">{k}</Tag>
          ))}
          {it.hashtags.map((h) => (
            <Tag key={h} tone="outline">{h}</Tag>
          ))}
        </div>
      )}
      {!done && (bad.length > 0 || warn.length > 0) && (
        <ul className="issue-list">
          {[...bad, ...warn].map((x, i) => (
            <li key={i} className={x.level}>{x.text}</li>
          ))}
        </ul>
      )}
      <div className="row mt8" style={{ gap: 4 }}>
        {done ? (
          it.post_id ? (
            <Link to={`/posts/${it.post_id}`} className="btn btn-sm btn-soft">
              Open the post
            </Link>
          ) : null
        ) : (
          !locked && (
            <>
              <Button size="sm" variant="soft" icon="edit" onClick={onEdit}>
                Edit
              </Button>
              {it.caption && !it.pending_revision_id && (
                <Button size="sm" variant="quiet" icon="spark" onClick={onReview}>
                  Editor Bot
                </Button>
              )}
              <IconButton icon="chev-l" label="Move up" disabled={n === 1} onClick={() => onMove(-1)} style={{ transform: "rotate(90deg)" }} />
              <IconButton icon="chev-r" label="Move down" disabled={last} onClick={() => onMove(1)} style={{ transform: "rotate(90deg)" }} />
              <IconButton icon="trash" label="Remove" danger onClick={onDelete} />
            </>
          )
        )}
      </div>
    </div>
  );
}

function EditItemModal({ item, aiReady, onClose, onSaved }: { item: Item; aiReady: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    title: item.title,
    brief: item.brief,
    media_type: item.media_type,
    media_url: item.media_url ?? "",
    media: (item.media_id && item.media_type !== "none" ? { id: item.media_id, kind: item.media_type, name: "Uploaded file" } : null) as UploadedMedia | null,
    caption: item.caption ?? "",
    keywords: item.keywords.join(", "),
    hashtags: item.hashtags.join(" "),
    at: toBizInput(item.scheduled_at),
    locked: item.time_locked,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const briefErr = f.brief.length > BRIEF_MAX ? `Keep it under ${BRIEF_MAX.toLocaleString("en")} characters (now ${f.brief.length.toLocaleString("en")}).` : undefined;
  const timeErr = f.at && !fromBizInput(f.at) ? "That isn't a valid date and time." : undefined;
  const hasMedia = !f.media && f.media_type !== "none" && !!f.media_url.trim();

  async function save() {
    setBusy("save");
    try {
      await api(`/bots/items/${item.id}`, {
        method: "PATCH",
        body: {
          title: f.title,
          brief: f.brief,
          ...(f.media
            ? { media_id: f.media.id, media_type: f.media.kind, media_url: null }
            : { media_id: null, media_type: hasMedia ? f.media_type : "none", media_url: hasMedia ? f.media_url.trim() : null }),
          caption: f.caption || null,
          keywords: f.keywords.split(",").map((k) => k.trim()).filter(Boolean),
          hashtags: f.hashtags.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean).map((h) => (h.startsWith("#") ? h : `#${h}`)),
          scheduled_at: fromBizInput(f.at),
          time_locked: !!f.at && f.locked,
        },
      });
      toast.ok("Saved", "Run the Checker Bot again before handing it off.");
      onSaved();
    } catch (e) {
      toast.err("Couldn't save", (e as Error).message);
      setBusy(null);
    }
  }
  async function rewrite() {
    setBusy("rewrite");
    try {
      // Save the notes first so the bot writes from the latest version.
      await api(`/bots/items/${item.id}`, { method: "PATCH", body: { title: f.title, brief: f.brief } });
      const r = await api<{ item: Item }>(`/bots/items/${item.id}/caption`, { body: {} });
      setF((x) => ({ ...x, caption: r.item.caption ?? "", keywords: r.item.keywords.join(", "), hashtags: r.item.hashtags.join(" "), title: x.title || r.item.title }));
      toast.ok("New caption written");
    } catch (e) {
      toast.err("The Caption Bot couldn't write it", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      wide
      title="Edit post"
      onClose={onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy === "save"} disabled={!!busy || !!briefErr || !!timeErr} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="stackv" style={{ gap: 14 }}>
        <TextField label="Working title" optional value={f.title} onChange={set("title")} />
        <TextArea label="What it's about" value={f.brief} onChange={set("brief")} rows={3} error={briefErr} />
        <MediaUpload value={f.media} onChange={(m) => setF((x) => ({ ...x, media: m }))} label="Uploaded image or video" />
        {!f.media && (
        <div className="grid g2">
          <SelectField
            label="Or use a link"
            value={f.media_type}
            onChange={(e) => {
              const v = e.target.value as Item["media_type"];
              setF((x) => ({ ...x, media_type: v, media_url: v === "none" ? "" : x.media_url }));
            }}
            options={[
              { value: "none", label: "None" },
              { value: "image", label: "Image" },
              { value: "video", label: "Video" },
            ]}
          />
          {f.media_type !== "none" && <TextField label="Link" value={f.media_url} onChange={set("media_url")} placeholder="https://…" />}
        </div>
        )}
        <div className="spread">
          <p className="label mb0">Caption</p>
          <Button size="sm" variant="soft" icon="spark" loading={busy === "rewrite"} disabled={!!busy || !f.brief.trim() || !!briefErr || !aiReady} onClick={rewrite} title={aiReady ? undefined : "The AI isn't running"}>
            Rewrite with the Caption Bot
          </Button>
        </div>
        <TextArea label="Caption" value={f.caption} onChange={set("caption")} rows={7} />
        <TextField label="Keyword phrases" optional value={f.keywords} onChange={set("keywords")} hint="Separate with commas." />
        <TextField label="Hashtags" optional value={f.hashtags} onChange={set("hashtags")} />
        <div className="grid g2">
          <TextField
            label={`Posting time (${BUSINESS_TZ_LABEL})`}
            optional
            type="datetime-local"
            value={f.at}
            error={timeErr}
            onChange={(e) => setF((x) => ({ ...x, at: e.target.value, locked: true }))}
            hint={`Enter the time in ${BUSINESS_TZ_LABEL}, whatever your computer's time zone is.`}
          />
          <div style={{ alignSelf: "center" }}>
            <Check label="Keep this time when the Scheduler Bot runs" checked={f.locked} onChange={(v) => setF((x) => ({ ...x, locked: v }))} />
          </div>
        </div>
        <p className="note mt0">Saving clears this post's last check, so run the Checker Bot again before handing it off.</p>
      </div>
    </Modal>
  );
}

function HandoffModal({ data, o, onClose, onDone }: { data: BatchData; o: Overview; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"review" | "schedule">("review");
  const [busy, setBusy] = useState(false);
  const pending = data.items.filter((i) => !handed(i));
  const blocked = pending.filter((i) => i.issues.some((x) => x.level === "bad") || !i.caption || !i.scheduled_at).length;
  const warned = pending.filter((i) => !i.issues.some((x) => x.level === "bad") && i.issues.some((x) => x.level === "warn")).length;
  async function go() {
    setBusy(true);
    try {
      const r = await api<{ created: number; skipped: { id: number; reason: string }[] }>(`/bots/batches/${data.batch.id}/handoff`, { body: { mode } });
      if (r.created)
        toast.ok(
          `${r.created} post${r.created === 1 ? "" : "s"} handed off`,
          r.skipped.length ? `${r.skipped.length} held back to fix first.` : mode === "review" ? "They're waiting in Posts and approvals for another manager." : "They're scheduled.",
        );
      else toast.err("Nothing was handed off", r.skipped[0]?.reason ?? "Fix the problems the Checker Bot found first.");
      onDone();
    } catch (e) {
      toast.err("The Posting Bot couldn't hand them off", (e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Hand to the Posting Bot"
      onClose={onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="send" loading={busy} onClick={go}>
            Hand off
          </Button>
        </>
      }
    >
      <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
        <BotFace bot="posting" mood="happy" size={64} />
        <div className="grow">
          <p className="mt0">The Checker Bot looks at everything again first. Posts with problems stay in the batch for you to fix.</p>
          <p className="mb0">
            <b>Posts you hand off are authored by you</b>, so a different manager has to approve them. You can't approve posts you handed off yourself.
          </p>
        </div>
      </div>
      <div className="stackv mt16" style={{ gap: 10 }}>
        <Check
          type="radio"
          name="mode"
          checked={mode === "review"}
          onChange={() => setMode("review")}
          label={
            <span>
              <b>Send for review</b> (recommended). Another manager approves each post (you can't approve posts you handed off), then it goes out at its planned time.
            </span>
          }
        />
        {o.canScheduleDirectly && (
          <Check
            type="radio"
            name="mode"
            checked={mode === "schedule"}
            onChange={() => setMode("schedule")}
            label={
              <span>
                <b>Approve and schedule now</b> (administrators only). Skips the second approval, so only posts with no warnings at all go; the rest stay until fixed.
              </span>
            }
          />
        )}
      </div>
      <p className="note">
        {pending.length - blocked} of {pending.length} look ready{blocked ? `, ${blocked} need fixing` : ""}
        {warned ? `, ${warned} have warnings for the reviewer` : ""}.{o.dryRun ? " Test mode is on, so nothing reaches Facebook." : ""}
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------- the bot panels

function BotPanel({
  bot,
  view,
  o,
  data,
  editable,
  canBrand,
  admin,
  onChange,
  onDirty,
}: {
  bot: BotName;
  view: BotView;
  o: Overview;
  data: BatchData | null;
  editable: boolean;
  canBrand: boolean;
  admin: boolean;
  onChange: () => Promise<unknown>;
  onDirty: (d: boolean) => void;
}) {
  const tone = view.state === "attention" ? "bad" : view.state === "working" ? "info" : view.state === "done" ? "good" : view.state === "off" ? "warn" : "mute";
  return (
    <>
      <div className="bot-head">
        <BotFace bot={bot} mood={view.mood} size={92} title={BOTS[bot].name} />
        <div>
          <h2 className="section">{BOTS[bot].name}</h2>
          <p className="muted mt0 mb0 small">{BOTS[bot].role}</p>
          <div className="mt8">
            <Tag tone={tone} dot>{view.task}</Tag>
          </div>
        </div>
      </div>
      <p className="bot-says">"{BOTS[bot].line}"</p>
      {bot === "caption" && <CaptionPanel o={o} canEdit={canBrand} admin={admin} onChange={onChange} onDirty={onDirty} />}
      {bot === "style" && <StylePanel o={o} canEdit={canBrand} onChange={onChange} />}
      {bot === "scheduler" && <SchedulerPanel data={data} editable={editable} onChange={onChange} onDirty={onDirty} />}
      {bot === "checker" && <CheckerPanel o={o} data={data} editable={editable} onChange={onChange} />}
      {bot === "posting" && <PostingPanel o={o} data={data} />}
      {bot === "editor" && <StandardsPanel canEdit={canBrand} onSaved={() => void onChange()} onDirty={onDirty} />}
    </>
  );
}

function ReadOnlyNote({ what }: { what: string }) {
  return <p className="note mt0 bot-readonly">Only marketing managers and administrators can change {what}, because they apply to the whole team. Ask a marketing manager if something should change.</p>;
}

const LENGTHS = [
  { value: 50, label: "Short (about 50 words)" },
  { value: 80, label: "Standard (about 80 words)" },
  { value: 150, label: "Long (about 150 words)" },
  { value: 250, label: "Very long (about 250 words)" },
];

function CaptionPanel({ o, canEdit, admin, onChange, onDirty }: { o: Overview; canEdit: boolean; admin: boolean; onChange: () => Promise<unknown>; onDirty: (d: boolean) => void }) {
  const toast = useToast();
  const [r, setR] = useState<Rules>(o.rules);
  const [base, setBase] = useState<Rules>(o.rules);
  const [busy, setBusy] = useState(false);
  const dirty = canEdit && JSON.stringify(r) !== JSON.stringify(base);
  const server = JSON.stringify(o.rules);
  // Someone else may change the rules: follow the server unless there are unsaved edits here.
  useEffect(() => {
    if (!dirty) {
      setR(o.rules);
      setBase(o.rules);
    }
  }, [server]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  async function save() {
    setBusy(true);
    try {
      const res = await api<{ rules: Rules }>("/bots/rules", { method: "PUT", body: r });
      setR(res.rules);
      setBase(res.rules);
      toast.ok("Team rules saved", "The Caption Bot follows them from the next caption.");
      await onChange();
    } catch (e) {
      toast.err("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const aiNote = o.ai.ready ? "" : admin ? ` (not ready: ${o.ai.problem ?? ""})` : " (not running: ask your administrator to start the AI)";
  return (
    <div className="stackv" style={{ gap: 14 }}>
      <p className="label mb0">Team rules</p>
      {canEdit ? (
        <>
          <SelectField label="Keyword phrases per caption" value={r.keywordCount} onChange={(e) => setR({ ...r, keywordCount: Number(e.target.value) })} options={[3, 5, 8, 10, 12, 15, 20].map((n) => ({ value: n, label: String(n) }))} />
          <SelectField label="Language" value={r.language} onChange={(e) => setR({ ...r, language: e.target.value as Rules["language"] })} options={["English", "Filipino", "Taglish"].map((l) => ({ value: l, label: l }))} />
          <SelectField label="Length" value={r.words} onChange={(e) => setR({ ...r, words: Number(e.target.value) })} options={LENGTHS.some((l) => l.value === r.words) ? LENGTHS : [...LENGTHS, { value: r.words, label: `About ${r.words} words` }]} />
          <Switch label="Add hashtags" checked={r.hashtags} onChange={(v) => setR({ ...r, hashtags: v })} />
          <Switch label="Add the brand disclaimer" checked={r.addDisclaimer} onChange={(v) => setR({ ...r, addDisclaimer: v })} />
          {!r.addDisclaimer && <p className="note mt0">With this off, the Checker Bot holds back any post whose caption doesn't include the brand disclaimer.</p>}
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>
            Save team rules
          </Button>
          {dirty && <p className="note mt0">Unsaved changes.</p>}
        </>
      ) : (
        <>
          <dl className="kv">
            <dt>Keyword phrases</dt>
            <dd>{o.rules.keywordCount}</dd>
            <dt>Language</dt>
            <dd>{o.rules.language}</dd>
            <dt>Length</dt>
            <dd>About {o.rules.words} words</dd>
            <dt>Hashtags</dt>
            <dd>{o.rules.hashtags ? "Yes" : "No"}</dd>
            <dt>Brand disclaimer</dt>
            <dd>{o.rules.addDisclaimer ? "Added automatically" : "Not added"}</dd>
          </dl>
          <ReadOnlyNote what="the team rules" />
        </>
      )}
      <p className="note mt0">
        Writes with {o.ai.label}
        {aiNote}. Brand guidelines and words to avoid always apply. {o.style.trained ? "Uses the style the Style Bot learned." : "Train the Style Bot to make it sound like your team."}
      </p>
    </div>
  );
}

function StylePanel({ o, canEdit, onChange }: { o: Overview; canEdit: boolean; onChange: () => Promise<unknown> }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const samples = useMemo(
    () =>
      [text, ...files.map((f) => f.text)]
        .join("\n\n---\n\n")
        .split(/\n\s*-{3,}\s*\n|\n\s*\n\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 20),
    [text, files],
  );
  // Only what the server accepts is sent: the first 30 captions, each cut to 1,500 characters.
  const send = samples.slice(0, STYLE_MAX_SAMPLES).map((s) => s.slice(0, STYLE_MAX_CHARS));
  const trimmed = samples.slice(0, STYLE_MAX_SAMPLES).filter((s) => s.length > STYLE_MAX_CHARS).length;
  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const list = [...(e.target.files ?? [])];
    try {
      // Big files are cut: only the first 30 captions are used anyway.
      const read = await Promise.all(list.map(async (f) => ({ name: f.name, text: (await f.text()).slice(0, STYLE_MAX_SAMPLES * STYLE_MAX_CHARS * 2) })));
      setFiles((x) => [...x, ...read]);
    } catch (err) {
      toast.err("Couldn't read that file", (err as Error).message);
    }
    e.target.value = "";
  }
  async function train() {
    setBusy("train");
    try {
      await api("/bots/style/train", { body: { samples: send } });
      toast.ok("Style learned", "New captions will sound like your team.");
      setText("");
      setFiles([]);
      await onChange();
    } catch (e) {
      toast.err("The Style Bot couldn't learn from that", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function forget() {
    setBusy("forget");
    try {
      await api("/bots/style", { method: "DELETE" });
      toast.ok("Style forgotten", "Captions follow the brand voice only.");
      setConfirmForget(false);
      await onChange();
    } catch (e) {
      toast.err("Couldn't forget the style", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="stackv" style={{ gap: 14 }}>
      {o.style.trained ? (
        <div className="panel" style={{ padding: 16 }}>
          <p className="label">The team's style, as the Style Bot sees it</p>
          <p className="pre small mt0 mb0">{o.style.profile}</p>
          <p className="note">Learned {ago(o.style.trainedAt)} from {o.style.sampleCount} captions.</p>
        </div>
      ) : (
        <p className="muted mt0">Not trained yet. Captions follow the brand voice from Settings.</p>
      )}
      {canEdit ? (
        <>
          <TextArea
            label={o.style.trained ? "Teach it again" : "Paste captions you've written"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={"Paste a few old captions.\nSeparate them with a line of --- or two blank lines."}
            hint={`Up to ${STYLE_MAX_SAMPLES} captions, ${STYLE_MAX_CHARS.toLocaleString("en")} characters each.`}
          />
          <label className="field">
            <span className="lab">
              Or upload text files <em>(.txt, .md, .csv)</em>
            </span>
            <input type="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv" multiple onChange={pick} className="file-input" />
          </label>
          {files.length > 0 && (
            <div className="row" style={{ gap: 6 }}>
              {files.map((f, i) => (
                <Tag key={i} tone="outline">{f.name}</Tag>
              ))}
            </div>
          )}
          {(samples.length > STYLE_MAX_SAMPLES || trimmed > 0) && (
            <Alert tone="warn">
              {samples.length > STYLE_MAX_SAMPLES ? `You gave ${samples.length} captions; the Style Bot learns from the first ${STYLE_MAX_SAMPLES}. ` : ""}
              {trimmed ? `${trimmed} long caption${trimmed === 1 ? " is" : "s are"} cut to ${STYLE_MAX_CHARS.toLocaleString("en")} characters.` : ""}
            </Alert>
          )}
          <Button variant="primary" icon="spark" loading={busy === "train"} disabled={send.length < 2 || !!busy} onClick={train}>
            {send.length ? `Learn from ${send.length} caption${send.length === 1 ? "" : "s"}` : "Learn the team's style"}
          </Button>
          {o.style.trained && (
            <Button variant="quiet" disabled={!!busy} onClick={() => setConfirmForget(true)}>
              Forget the team's style
            </Button>
          )}
        </>
      ) : (
        <ReadOnlyNote what="the trained style" />
      )}
      <p className="note mt0">Kept in your own database. Only the style is used, never the facts or claims in the old captions.</p>
      {confirmForget && (
        <ConfirmModal
          title="Forget the team's style?"
          warning="The Caption Bot will write in the plain brand voice for everyone until the Style Bot is trained again."
          confirmLabel="Forget it"
          busy={busy === "forget"}
          onClose={() => setConfirmForget(false)}
          onConfirm={forget}
        />
      )}
    </div>
  );
}

function SchedulerPanel({ data, editable, onChange, onDirty }: { data: BatchData | null; editable: boolean; onChange: () => Promise<unknown>; onDirty: (d: boolean) => void }) {
  const toast = useToast();
  const [s, setS] = useState<Schedule | null>(data?.schedule ?? null);
  const [times, setTimes] = useState((data?.schedule.times ?? []).join(", "));
  const [base, setBase] = useState(JSON.stringify(data?.schedule ?? null));
  const [busy, setBusy] = useState<string | null>(null);
  const parsedTimes = times
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t));
  const body = s ? { ...s, times: parsedTimes.length ? parsedTimes : ["09:00"] } : null;
  const dirty = editable && !!body && JSON.stringify(body) !== base;
  const server = JSON.stringify(data?.schedule ?? null);
  const lastBatch = useRef(data?.batch.id);
  // A different batch always loads its own settings (switching was confirmed); the same batch follows the server
  // unless there are unsaved edits here.
  useEffect(() => {
    const changed = lastBatch.current !== data?.batch.id;
    lastBatch.current = data?.batch.id;
    if (changed || !dirty) {
      setS(data?.schedule ?? null);
      setTimes((data?.schedule.times ?? []).join(", "));
      setBase(server);
    }
  }, [data?.batch.id, server]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  if (!data || !s || !body) return <p className="muted">Start a batch, then tell me which days to post on.</p>;
  const windowErr = s.mode === "auto" && s.windowEnd < s.windowStart ? "The window has to end after it starts." : undefined;
  const timesErr = s.mode === "times" && parsedTimes.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) ? "Use 24-hour times like 09:00, separated by commas." : undefined;
  async function save(andRun: boolean) {
    setBusy(andRun ? "run" : "save");
    try {
      await api(`/bots/batches/${data!.batch.id}`, { method: "PATCH", body: { schedule: body } });
      setBase(JSON.stringify(body));
      if (andRun) await api(`/bots/batches/${data!.batch.id}/schedule`, { body: {} });
      toast.ok(andRun ? "Times picked" : "Saved");
      await onChange();
    } catch (e) {
      toast.err("Couldn't save", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const dis = !editable || !!data.run;
  return (
    <div className="stackv" style={{ gap: 14 }}>
      <p className="label mb0">Days</p>
      <Seg
        grid
        label="Days"
        value={s.days}
        onChange={(v) => setS({ ...s, days: v })}
        options={[
          { value: "daily", label: "Every day" },
          { value: "weekdays", label: "Weekdays" },
          { value: "mwf", label: "Mon, Wed, Fri" },
          { value: "custom", label: "Choose days" },
        ]}
      />
      {s.days === "custom" && (
        <div className="row" style={{ gap: 10 }}>
          {DAY_NAMES.map((d, i) => (
            <Check key={d} label={d} checked={s.customDays.includes(i)} onChange={(v) => setS({ ...s, customDays: v ? [...s.customDays, i].sort() : s.customDays.filter((x) => x !== i) })} />
          ))}
        </div>
      )}
      <TextField label="Start on" type="date" min={bizToday()} value={s.startDate ?? ""} onChange={(e) => setS({ ...s, startDate: e.target.value || null })} hint={`Empty means today (${BUSINESS_TZ_LABEL}).`} />
      <p className="label mb0">Times</p>
      <Seg
        grid
        label="How to pick times"
        value={s.mode}
        onChange={(v) => setS({ ...s, mode: v })}
        options={[
          { value: "auto", label: "Space them out" },
          { value: "times", label: "Set times" },
        ]}
      />
      {s.mode === "auto" ? (
        <>
          <div className="grid g2">
            <TextField label="From" type="time" value={s.windowStart} onChange={(e) => setS({ ...s, windowStart: e.target.value })} />
            <TextField label="Until" type="time" value={s.windowEnd} error={windowErr} onChange={(e) => setS({ ...s, windowEnd: e.target.value })} />
          </div>
          <TextField label="Posts per day" type="number" min={1} max={100} value={s.perDay} onChange={(e) => setS({ ...s, perDay: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} hint="Up to 100." />
        </>
      ) : (
        <TextField label="Times each day" value={times} error={timesErr} onChange={(e) => setTimes(e.target.value)} hint="24-hour times separated by commas, up to 20. Example: 09:00, 12:30, 18:00" />
      )}
      <SelectField
        label="Keep posts apart by at least"
        value={s.minGapMinutes}
        onChange={(e) => setS({ ...s, minGapMinutes: Number(e.target.value) })}
        options={[0, 15, 30, 60, 90, 120, 180].map((m) => ({ value: m, label: m ? `${m} minutes` : "No minimum" }))}
      />
      <p className="note mt0">All times are {BUSINESS_TZ_LABEL}. Times you set yourself on a post are kept, and posts already booked in the calendar are avoided.</p>
      <div className="row">
        <Button variant="primary" icon="cal" loading={busy === "run"} disabled={dis || !!busy || !!windowErr || !!timesErr} onClick={() => save(true)}>
          Save and pick times
        </Button>
        <Button variant="quiet" loading={busy === "save"} disabled={dis || !!busy || !dirty || !!windowErr || !!timesErr} onClick={() => save(false)}>
          Save
        </Button>
      </div>
      {dirty && <p className="note mt0">Unsaved changes.</p>}
    </div>
  );
}

function CheckerPanel({ o, data, editable, onChange }: { o: Overview; data: BatchData | null; editable: boolean; onChange: () => Promise<unknown> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pending = (data?.items ?? []).filter((i) => !handed(i));
  const bad = pending.reduce((n, i) => n + i.issues.filter((x) => x.level === "bad").length, 0);
  const warn = pending.reduce((n, i) => n + i.issues.filter((x) => x.level === "warn").length, 0);
  async function check() {
    setBusy(true);
    try {
      await api(`/bots/batches/${data!.batch.id}/check`, { body: {} });
      toast.ok("Checked");
      await onChange();
    } catch (e) {
      toast.err("Couldn't check", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const out = o.outcomes;
  return (
    <div className="stackv" style={{ gap: 14 }}>
      <p className="label mb0">Before hand-off</p>
      {!data ? (
        <p className="muted mt0">No batch selected.</p>
      ) : !data.batch.checked_at ? (
        <p className="muted mt0">{pending.length ? "Not checked since the last change." : "Not checked yet."}</p>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <Tag tone={bad ? "bad" : "good"} dot>{bad ? `${bad} problem${bad === 1 ? "" : "s"}` : "No problems"}</Tag>
          {warn > 0 && <Tag tone="warn" dot>{warn} warning{warn === 1 ? "" : "s"}</Tag>}
          <span className="meta">Checked {ago(data.batch.checked_at)}</span>
        </div>
      )}
      <p className="small muted mt0">
        I check everything that gets published (caption, hashtags and disclaimer) for: times in the past, two posts at the same time, posts too close together, missing captions or times, a missing brand disclaimer, words the brand doesn't allow, dosing or claims that need the pharmaceutical team, and image or video links Facebook can't reach.
      </p>
      {data && editable && pending.length > 0 && (
        <Button variant="primary" icon="check" loading={busy} disabled={!!data.run} onClick={check}>
          Check now
        </Button>
      )}
      <hr className="split" style={{ margin: "6px 0" }} />
      <p className="label mb0">After hand-off (all batches)</p>
      <dl className="kv">
        <dt>In review</dt>
        <dd>{out.in_review ?? 0}</dd>
        <dt>Approved</dt>
        <dd>{out.approved ?? 0}</dd>
        <dt>Scheduled</dt>
        <dd>{out.scheduled ?? 0}</dd>
        <dt>Published</dt>
        <dd>{out.published ?? 0}</dd>
        <dt>Failed</dt>
        <dd>{out.failed ? <Link to="/posts?status=failed">{out.failed}, see why</Link> : 0}</dd>
        <dt>Sent back</dt>
        <dd>{out.changes_requested ?? 0}</dd>
      </dl>
    </div>
  );
}

function PostingPanel({ o, data }: { o: Overview; data: BatchData | null }) {
  const done = (data?.items ?? []).filter(handed);
  return (
    <div className="stackv" style={{ gap: 14 }}>
      <p className="small mt0">
        I turn every post that passes the checks into a real post in <Link to="/posts">Posts and approvals</Link>, with its caption, hashtags, image or video and planned time. The posts are authored by whoever hands them
        off, so another manager approves each one (you can't approve posts you handed off). It's then published to the Facebook Page at its time, with retries if Facebook has a hiccup.
      </p>
      {o.canScheduleDirectly && <p className="small muted mt0">As an administrator you can also approve and schedule in one go, for posts with no warnings.</p>}
      {o.dryRun && <Alert tone="info">Test mode is on, so nothing reaches Facebook.</Alert>}
      {data && (
        <>
          <p className="label mb0">From this batch</p>
          {!done.length ? (
            <p className="muted mt0">Nothing handed off yet.</p>
          ) : (
            <ul className="handed-list">
              {done.map((i) => (
                <li key={i.id}>
                  {i.post_id ? (
                    <Link to={`/posts/${i.post_id}`} className="grow clamp">
                      {i.title || i.caption?.slice(0, 60)}
                    </Link>
                  ) : (
                    <span className="grow clamp muted">{i.title || i.caption?.slice(0, 60)}</span>
                  )}
                  {i.post_id ? <StatusTag map={POST_STATUS} value={i.post_status ?? "draft"} /> : <Tag tone="mute">Post deleted</Tag>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
