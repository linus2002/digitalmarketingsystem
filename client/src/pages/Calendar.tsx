import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { bizToday, BUSINESS_TZ, BUSINESS_TZ_LABEL, POST_STATUS } from "../lib/format";
import { Button, LinkButton, LoadError, Modal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icons";
import { ExportMenu, postsDoc, type ExportablePost } from "../components/ExportImport";
import { mediaSrc } from "../components/MediaUpload";
import { PLATFORM, PLATFORM_KEYS, PlatformIcon, platformsOf, type PlatformKey, type Target } from "../components/Platforms";
import "../styles/posts.css";

interface P {
  id: number;
  title: string;
  message: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  image_url: string | null;
  video_url: string | null;
  media_id: number | null;
  media_kind: "image" | "video" | null;
  targets: Target[] | null;
}
interface BotPlanned {
  id: number;
  batch_id: number;
  batch_name: string | null;
  title: string;
  scheduled_at: string;
}
/** One chip per post per platform, so the calendar shows exactly what goes where. */
type Item = { kind: "post"; at: string; post: P; platform: PlatformKey; target: Target | null } | { kind: "bot"; at: string; bot: BotPlanned; platform: PlatformKey };
type View = "month" | "week";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PH_MS = 8 * 3_600_000;
const FROM = { from: { to: "/calendar", label: "Calendar" } };
const STATUSES = "draft,in_review,changes_requested,approved,scheduled,publishing,published,failed";

// All calendar maths is on Philippine calendar days ("YYYY-MM-DD"), done with UTC dates so the
// viewer's own time zone never shifts a post to another day.
const phDayOf = (iso: string) => new Date(new Date(iso).getTime() + PH_MS).toISOString().slice(0, 10);
const dayKey = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const phMidnight = (day: string) => new Date(`${day}T00:00:00+08:00`).toISOString();
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const timeOf = (iso: string) => new Intl.DateTimeFormat("en-PH", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const fmtUTC = (day: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(new Date(`${day}T00:00:00Z`));
const longDay = (day: string) => fmtUTC(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** The chip's color: the platform's own status once it has one, else the post's. */
const stateOf = (it: Item) => (it.kind === "bot" ? "bot" : it.target?.status === "published" ? "published" : it.target?.status === "failed" ? "failed" : it.post.status);
const stateLabel = (it: Item) => (it.kind === "bot" ? "Planned by bots" : POST_STATUS[stateOf(it)]?.label ?? stateOf(it));

function Thumb({ post }: { post: P }) {
  const src = post.media_id ? mediaSrc(post.media_id) : (post.image_url ?? post.video_url);
  const video = post.media_id ? post.media_kind === "video" : !!post.video_url;
  if (!src) return <span className="pcal-thumb text">{post.message.slice(0, 90)}</span>;
  return (
    <span className="pcal-thumb">
      {video ? <video src={`${src}#t=0.5`} preload="metadata" muted playsInline /> : <img src={src} alt="" loading="lazy" />}
      {video && (
        <span className="pcal-thumb-kind" aria-hidden="true">
          <svg viewBox="0 0 12 12" width="10" height="10">
            <path d="M3 1.8v8.4L10 6z" fill="currentColor" />
          </svg>
        </span>
      )}
    </span>
  );
}

/** A calendar item: a link to the post (or the bots page), or plain text for people who can't open the bots page. */
function ItemLink({ it, canBots, className, title, label, children }: { it: Item; canBots: boolean; className: string; title?: string; label?: string; children: ReactNode }) {
  if (it.kind === "bot" && !canBots)
    return (
      <span className={className} title={title} aria-label={label}>
        {children}
      </span>
    );
  return (
    <Link to={it.kind === "post" ? `/posts/${it.post.id}` : "/bots"} state={FROM} className={className} title={title} aria-label={label}>
      {children}
    </Link>
  );
}

export function CalendarPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const today = bizToday();
  const [view, setView] = useState<View>("month");
  const [month, setMonth] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const [weekStart, setWeekStart] = useState(() => mondayOf(today));
  const [only, setOnly] = useState<PlatformKey | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);

  // Month: six-week grid starting on Monday. Week: the seven days from weekStart.
  const days = useMemo(() => {
    if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const first = new Date(Date.UTC(month.y, month.m, 1));
    const start = dayKey(month.y, month.m, 1 - ((first.getUTCDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [view, month, weekStart]);
  const monthPrefix = dayKey(month.y, month.m, 1).slice(0, 7);
  const rangeFrom = phMidnight(days[0]);
  const rangeTo = phMidnight(addDays(days[days.length - 1], 1));

  const { data, error, loading, reload } = useLoad(() => api<{ posts: P[] }>("/posts", { query: { from: rangeFrom, to: rangeTo, status: STATUSES, limit: 500 } }), [rangeFrom, rangeTo]);
  // Times the bots planned but haven't handed off yet. Optional: the page works without it.
  const bots = useLoad(
    () =>
      api<{ items: BotPlanned[] }>("/bots/planned", { query: { from: rangeFrom, to: rangeTo } }).catch((e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return { items: [] as BotPlanned[] };
        throw e;
      }),
    [rangeFrom, rangeTo],
  );

  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    const push = (it: Item) => {
      if (only && it.platform !== only) return;
      const k = phDayOf(it.at);
      m.set(k, [...(m.get(k) ?? []), it]);
    };
    for (const p of data?.posts ?? []) {
      const when = p.published_at ?? p.scheduled_at;
      if (!when) continue;
      for (const platform of platformsOf(p)) {
        const target = p.targets?.find((t) => t.platform === platform) ?? null;
        push({ kind: "post", at: target?.published_at ?? when, post: p, platform, target });
      }
    }
    // Bot batches hand posts to the Facebook Page.
    for (const b of bots.data?.items ?? []) if (b.scheduled_at) push({ kind: "bot", at: b.scheduled_at, bot: b, platform: "facebook" });
    for (const list of m.values()) list.sort((a, b) => a.at.localeCompare(b.at) || PLATFORM_KEYS.indexOf(a.platform) - PLATFORM_KEYS.indexOf(b.platform));
    return m;
  }, [data, bots.data, only]);

  const shift = (n: number) =>
    view === "week" ? setWeekStart((w) => addDays(w, 7 * n)) : setMonth((m) => ({ y: m.y + Math.floor((m.m + n) / 12), m: (((m.m + n) % 12) + 12) % 12 }));
  const goToday = () => {
    setMonth({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 });
    setWeekStart(mondayOf(today));
  };
  const switchView = (v: View) => {
    // Keep the same stretch of time in view when switching.
    if (v === "week") setWeekStart(mondayOf(monthPrefix === today.slice(0, 7) ? today : `${monthPrefix}-01`));
    else {
      // The week's Thursday decides the month (and its year, so the week of 29 Dec 2025 opens January 2026).
      const mid = addDays(weekStart, 3);
      setMonth({ y: Number(mid.slice(0, 4)), m: Number(mid.slice(5, 7)) - 1 });
    }
    setView(v);
  };
  const canPlan = (day: string) => can("posts.edit") && day >= today;
  const plan = (day: string) => nav(`/posts/new?date=${day}`, { state: FROM });
  const rangeLabel =
    view === "month"
      ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(month.y, month.m, 1)))
      : `${fmtUTC(days[0], { day: "numeric", month: "short" })} – ${fmtUTC(days[6], { day: "numeric", month: "short", year: "numeric" })}`;
  const firstLoad = loading && !data;

  const itemKey = (it: Item) => (it.kind === "post" ? `p${it.post.id}-${it.platform}` : `b${it.bot.id}`);
  const itemTitle = (it: Item) =>
    it.kind === "post" ? `${it.post.title} · ${PLATFORM[it.platform].label} · ${stateLabel(it)}` : `${it.bot.title} · Planned by bots${it.bot.batch_name ? ` (${it.bot.batch_name})` : ""}`;
  // Bot-planned times open the bots page only for people allowed there; others see a plain (non-link) item.
  const canBots = can("content.generate");


  /** Month cell chip: time and platform, colored by status. */
  const chip = (it: Item) => (
    <ItemLink canBots={canBots} key={itemKey(it)} it={it} className={`pcal-chip s-${stateOf(it)}`} title={itemTitle(it)} label={`${timeOf(it.at)}, ${itemTitle(it)}`}>
      <Icon name={it.kind === "bot" ? "spark" : "doc"} size={13} />
      <b>{timeOf(it.at)}</b>
      <PlatformIcon p={it.platform} size={15} />
    </ItemLink>
  );
  /** Full row (day details, phone agenda). */
  const row = (it: Item) => (
    <ItemLink canBots={canBots} it={it} className={`pcal-row s-${stateOf(it)}`}>
      <PlatformIcon p={it.platform} size={22} />
      <span className="grow">
        <b>
          {timeOf(it.at)} · {it.kind === "post" ? it.post.title : it.bot.title}
        </b>
        <small>
          {PLATFORM[it.platform].label} · {stateLabel(it)}
          {it.kind === "bot" && `${it.bot.batch_name ? ` · ${it.bot.batch_name}` : ""}: not handed off yet`}
        </small>
      </span>
    </ItemLink>
  );

  const gridRef = useRef<HTMLDivElement>(null);
  const agendaRef = useRef<HTMLDivElement>(null);
  // The month being viewed: its posts (full details) plus what the bots have planned, in date order.
  const buildExport = async () => {
    const from = view === "week" ? days[0] : `${monthPrefix}-01`;
    const to = view === "week" ? addDays(days[6], 1) : new Date(Date.UTC(month.y, month.m + 1, 1)).toISOString().slice(0, 10);
    const inRange = (iso: string) => {
      const d = phDayOf(iso);
      return d >= from && d < to;
    };
    const r = await api<{ posts: (ExportablePost & { id: number })[] }>("/posts", { query: { from: phMidnight(from), to: phMidnight(to), status: STATUSES, limit: 500 } });
    const posts = r.posts
      .filter((p) => (p.published_at ?? p.scheduled_at) && inRange((p.published_at ?? p.scheduled_at)!))
      .sort((a, b) => (a.published_at ?? a.scheduled_at ?? "").localeCompare(b.published_at ?? b.scheduled_at ?? ""));
    const planned = (bots.data?.items ?? [])
      .filter((b) => inRange(b.scheduled_at))
      .map((b) => ({ title: b.title, when: `${longDay(phDayOf(b.scheduled_at))} ${timeOf(b.scheduled_at)}`, note: `Not handed off yet${b.batch_name ? ` (batch: ${b.batch_name})` : ""}` }));
    return postsDoc(
      posts,
      `Content calendar: ${rangeLabel}`,
      `${posts.length} post${posts.length === 1 ? "" : "s"}${planned.length ? ` and ${planned.length} planned by bots` : ""} · ${BUSINESS_TZ_LABEL}`,
      `calendar-${view === "week" ? days[0] : monthPrefix}`,
      planned,
    );
  };
  // The picture is of whichever view is showing: the grid, or the agenda list on phones.
  const pngTarget = () => (gridRef.current && gridRef.current.offsetParent ? gridRef.current : agendaRef.current);
  const openItems = openDay ? (byDay.get(openDay) ?? []) : [];
  const agendaDays = days.filter((d) => (view === "week" || d.startsWith(monthPrefix)) && ((byDay.get(d)?.length ?? 0) > 0 || d === today));
  const MONTH_CHIPS = 2;

  return (
    <>
      <PageHead
        title="Post calendar"
        sub={`Planned, scheduled and published posts on every platform, in ${BUSINESS_TZ_LABEL}. Open a day to see everything on it.`}
        actions={
          <>
            <div className="seg" role="group" aria-label="Calendar view">
              <button type="button" aria-pressed={view === "month"} onClick={() => switchView("month")}>
                Month
              </button>
              <button type="button" aria-pressed={view === "week"} onClick={() => switchView("week")}>
                Week
              </button>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button type="button" className="btn btn-icon" aria-label={`Previous ${view}`} onClick={() => shift(-1)}>
                <Icon name="chev-l" />
              </button>
              <b style={{ minWidth: 170, textAlign: "center" }} aria-live="polite">
                {rangeLabel}
              </b>
              <button type="button" className="btn btn-icon" aria-label={`Next ${view}`} onClick={() => shift(1)}>
                <Icon name="chev-r" />
              </button>
            </div>
            <Button size="sm" variant="quiet" onClick={goToday}>
              Today
            </Button>
            <ExportMenu build={buildExport} pngTarget={pngTarget} disabled={loading} />
            {can("posts.edit") && (
              <LinkButton to="/posts/new" variant="primary" icon="plus">
                New post
              </LinkButton>
            )}
          </>
        }
      />
      {error && <LoadError error={error} retry={reload} />}
      {bots.error && <p className="note mt0">Bot-planned times couldn't be loaded ({bots.error}).</p>}
      <div className="pcal-bar">
        <div className="pf-filter" role="group" aria-label="Show platform">
          <button type="button" aria-pressed={!only} onClick={() => setOnly(null)}>
            All platforms
          </button>
          {PLATFORM_KEYS.map((p) => (
            <button key={p} type="button" aria-pressed={only === p} onClick={() => setOnly(only === p ? null : p)}>
              <PlatformIcon p={p} size={16} />
              {PLATFORM[p].short}
            </button>
          ))}
        </div>
        <div className="pcal-legend">
          {["in_review", "scheduled", "published", "failed"].map((s) => (
            <Tag key={s} tone={POST_STATUS[s].tone} dot>
              {POST_STATUS[s].label}
            </Tag>
          ))}
          <Tag tone="outline">
            <Icon name="spark" size={12} /> Planned by bots
          </Tag>
          {loading && (
            <span className="note mt0" role="status">
              Loading…
            </span>
          )}
        </div>
      </div>

      {view === "month" ? (
        <div ref={gridRef} className={`pcal-grid ${loading ? "is-loading" : ""}`} aria-busy={loading || undefined}>
          {DOW.map((d) => (
            <div key={d} className="pcal-dow" aria-hidden="true">
              {d}
            </div>
          ))}
          {days.map((k) => {
            const items = byDay.get(k) ?? [];
            const out = !k.startsWith(monthPrefix);
            return (
              <div key={k} className={`pcal-day ${out ? "out" : ""} ${k === today ? "today" : ""}`}>
                <button
                  type="button"
                  className="pcal-dnum"
                  onClick={() => setOpenDay(k)}
                  aria-label={`${longDay(k)}${k === today ? ", today" : ""}: ${items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : "nothing planned"}`}
                >
                  {Number(k.slice(8, 10))}
                </button>
                {!firstLoad && items.slice(0, MONTH_CHIPS).map(chip)}
                {items.length > MONTH_CHIPS && (
                  <button type="button" className="pcal-more" onClick={() => setOpenDay(k)}>
                    + {items.length - MONTH_CHIPS} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div ref={gridRef} className={`pcal-week ${loading ? "is-loading" : ""}`} aria-busy={loading || undefined}>
          {days.map((k) => {
            const items = byDay.get(k) ?? [];
            return (
              <section key={k} className={`pcal-wcol ${k === today ? "today" : ""}`} aria-label={longDay(k)}>
                <button type="button" className="pcal-whead" onClick={() => setOpenDay(k)}>
                  {fmtUTC(k, { weekday: "short" })} <b>{Number(k.slice(8, 10))}</b>
                </button>
                {!firstLoad &&
                  items.map((it) => (
                    <ItemLink canBots={canBots} key={itemKey(it)} it={it} className={`pcal-card s-${stateOf(it)}`} title={itemTitle(it)}>
                      <span className="pcal-card-top">
                        <Icon name={it.kind === "bot" ? "spark" : "doc"} size={12} />
                        <b>{timeOf(it.at)}</b>
                      </span>
                      {it.kind === "post" ? <Thumb post={it.post} /> : <span className="pcal-thumb text">{it.bot.title}</span>}
                      <span className="pcal-card-pf">
                        <PlatformIcon p={it.platform} size={16} label={PLATFORM[it.platform].label} />
                      </span>
                    </ItemLink>
                  ))}
                {!firstLoad && !items.length && canPlan(k) && (
                  <button type="button" className="pcal-wplan" onClick={() => plan(k)} aria-label={`Plan a post on ${longDay(k)}`}>
                    <Icon name="plus" size={14} />
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* Agenda (small screens) */}
      <div ref={agendaRef} className="pcal-agenda" aria-busy={loading || undefined}>
        {firstLoad ? (
          <p className="muted">Loading…</p>
        ) : agendaDays.length ? (
          agendaDays.map((k) => {
            const items = byDay.get(k) ?? [];
            return (
              <section key={k} className={k === today ? "today" : ""}>
                <h3>
                  <span>
                    {longDay(k)}
                    {k === today && <span className="muted"> · today</span>}
                  </span>
                  {canPlan(k) && (
                    <Button size="sm" variant="soft" icon="plus" onClick={() => plan(k)}>
                      Plan a post
                    </Button>
                  )}
                </h3>
                {items.length ? (
                  <ul className="pcal-list">
                    {items.map((it) => (
                      <li key={itemKey(it)}>{row(it)}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted mt0">Nothing planned.</p>
                )}
              </section>
            );
          })
        ) : (
          <p className="muted">Nothing planned {view === "week" ? "this week" : "this month"}.</p>
        )}
      </div>

      {openDay && (
        <Modal
          title={longDay(openDay)}
          onClose={() => setOpenDay(null)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setOpenDay(null)}>
                Close
              </Button>
              {canPlan(openDay) && (
                <Button variant="primary" icon="plus" onClick={() => plan(openDay)}>
                  Plan a post
                </Button>
              )}
            </>
          }
        >
          {openItems.length ? (
            <ul className="pcal-list">
              {openItems.map((it) => (
                <li key={itemKey(it)}>{row(it)}</li>
              ))}
            </ul>
          ) : (
            <p className="muted mt0">Nothing planned for this day.</p>
          )}
          <p className="note">Times are {BUSINESS_TZ_LABEL}.</p>
        </Modal>
      )}
    </>
  );
}
