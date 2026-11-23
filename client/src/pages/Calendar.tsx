import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { bizToday, BUSINESS_TZ, BUSINESS_TZ_LABEL, POST_STATUS } from "../lib/format";
import { Button, LinkButton, LoadError, Modal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icons";
import "../styles/posts.css";

interface P {
  id: number;
  title: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
}
interface BotPlanned {
  id: number;
  batch_id: number;
  batch_name: string | null;
  title: string;
  scheduled_at: string;
}
type Item = { kind: "post"; at: string; post: P } | { kind: "bot"; at: string; bot: BotPlanned };

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PH_MS = 8 * 3_600_000;
const FROM = { from: { to: "/calendar", label: "Calendar" } };

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
const timeOf = (iso: string) => new Intl.DateTimeFormat("en-PH", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const longDay = (day: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${day}T00:00:00Z`));

export function CalendarPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const today = bizToday();
  const [month, setMonth] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const [openDay, setOpenDay] = useState<string | null>(null);

  // Six-week grid starting on Monday
  const days = useMemo(() => {
    const first = new Date(Date.UTC(month.y, month.m, 1));
    const start = dayKey(month.y, month.m, 1 - ((first.getUTCDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month]);
  const monthPrefix = dayKey(month.y, month.m, 1).slice(0, 7);
  const rangeFrom = phMidnight(days[0]);
  const rangeTo = phMidnight(addDays(days[41], 1));

  const { data, error, loading, reload } = useLoad(
    () =>
      api<{ posts: P[] }>("/posts", {
        query: { from: rangeFrom, to: rangeTo, status: "draft,in_review,changes_requested,approved,scheduled,publishing,published,failed", limit: 500 },
      }),
    [rangeFrom, rangeTo],
  );
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
      const k = phDayOf(it.at);
      m.set(k, [...(m.get(k) ?? []), it]);
    };
    for (const p of data?.posts ?? []) {
      const when = p.published_at ?? p.scheduled_at;
      if (when) push({ kind: "post", at: when, post: p });
    }
    for (const b of bots.data?.items ?? []) if (b.scheduled_at) push({ kind: "bot", at: b.scheduled_at, bot: b });
    for (const list of m.values()) list.sort((a, b) => a.at.localeCompare(b.at));
    return m;
  }, [data, bots.data]);

  const shift = (n: number) => setMonth((m) => ({ y: m.y + Math.floor((m.m + n) / 12), m: (((m.m + n) % 12) + 12) % 12 }));
  const canPlan = (day: string) => can("posts.edit") && day >= today;
  const plan = (day: string) => nav(`/posts/new?date=${day}`, { state: FROM });
  const monthLabel = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(month.y, month.m, 1)));
  const firstLoad = loading && !data;

  const chip = (it: Item, full = false) =>
    it.kind === "post" ? (
      <Link key={`p${it.post.id}`} to={`/posts/${it.post.id}`} state={FROM} className={`pcal-chip s-${it.post.status}`} title={`${it.post.title} · ${POST_STATUS[it.post.status]?.label ?? it.post.status}`}>
        {timeOf(it.at)} {it.post.title}
        {full && <small>{POST_STATUS[it.post.status]?.label ?? it.post.status}</small>}
      </Link>
    ) : (
      <Link key={`b${it.bot.id}`} to="/bots" className="pcal-chip s-bot" title={`${it.bot.title} · Planned by bots${it.bot.batch_name ? ` (${it.bot.batch_name})` : ""}`}>
        {timeOf(it.at)} {it.bot.title}
        {full ? <small>Planned by bots{it.bot.batch_name ? ` · ${it.bot.batch_name}` : ""}: not handed off yet</small> : null}
      </Link>
    );

  const openItems = openDay ? byDay.get(openDay) ?? [] : [];
  const agendaDays = days.filter((d) => d.startsWith(monthPrefix) && ((byDay.get(d)?.length ?? 0) > 0 || d === today));

  return (
    <>
      <PageHead
        title="Content calendar"
        sub={`Planned, scheduled and published posts by day, in ${BUSINESS_TZ_LABEL}. Open a day to see everything on it.`}
        actions={
          <>
            <div className="row" style={{ gap: 4 }}>
              <button type="button" className="btn btn-icon" aria-label="Previous month" onClick={() => shift(-1)}>
                <Icon name="chev-l" />
              </button>
              <b style={{ minWidth: 150, textAlign: "center" }} aria-live="polite">
                {monthLabel}
              </b>
              <button type="button" className="btn btn-icon" aria-label="Next month" onClick={() => shift(1)}>
                <Icon name="chev-r" />
              </button>
            </div>
            <Button size="sm" variant="quiet" onClick={() => setMonth({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 })}>
              This month
            </Button>
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
      <div className="pcal-legend">
        {["in_review", "approved", "scheduled", "published", "failed"].map((s) => (
          <Tag key={s} tone={POST_STATUS[s].tone} dot>
            {POST_STATUS[s].label}
          </Tag>
        ))}
        <Tag tone="mute">Draft (planned date)</Tag>
        <Tag tone="outline">Planned by bots</Tag>
        {loading && <span className="note mt0" role="status">Loading…</span>}
      </div>

      {/* Month grid (wider screens) */}
      <div className={`pcal-grid ${loading ? "is-loading" : ""}`} aria-busy={loading || undefined}>
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
              {!firstLoad && items.slice(0, 3).map((it) => chip(it))}
              {items.length > 3 && (
                <button type="button" className="pcal-more" onClick={() => setOpenDay(k)}>
                  +{items.length - 3} more
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Agenda (small screens) */}
      <div className="pcal-agenda" aria-busy={loading || undefined}>
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
                {items.length ? <ul className="pcal-list">{items.map((it) => <li key={it.kind + (it.kind === "post" ? it.post.id : it.bot.id)}>{chip(it, true)}</li>)}</ul> : <p className="muted mt0">Nothing planned.</p>}
              </section>
            );
          })
        ) : (
          <p className="muted">Nothing planned this month.</p>
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
                <li key={it.kind + (it.kind === "post" ? it.post.id : it.bot.id)}>{chip(it, true)}</li>
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
