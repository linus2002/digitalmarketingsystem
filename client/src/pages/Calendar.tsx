import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime, POST_STATUS } from "../lib/format";
import { Button, LinkButton, LoadError, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icons";

interface P {
  id: number;
  title: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function CalendarPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Six-week grid starting on Monday
  const days = useMemo(() => {
    const start = new Date(month);
    start.setDate(1 - ((month.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);

  const { data, error, reload } = useLoad(
    () => api<{ posts: P[] }>("/posts", { query: { from: days[0].toISOString(), to: new Date(days[41].getTime() + 86400_000).toISOString(), status: "draft,in_review,changes_requested,approved,scheduled,publishing,published,failed", limit: 500 } }),
    [days],
  );

  const byDay = useMemo(() => {
    const m = new Map<string, P[]>();
    for (const p of data?.posts ?? []) {
      const when = p.published_at ?? p.scheduled_at;
      if (!when) continue;
      const k = key(new Date(when));
      m.set(k, [...(m.get(k) ?? []), p].sort((a, b) => (a.published_at ?? a.scheduled_at ?? "").localeCompare(b.published_at ?? b.scheduled_at ?? "")));
    }
    return m;
  }, [data]);

  const today = key(new Date());
  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));

  return (
    <>
      <PageHead
        title="Content calendar"
        sub="Planned, scheduled and published posts by day. Click a day to plan a post for it."
        actions={
          <>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn btn-icon" aria-label="Previous month" onClick={() => shift(-1)}>
                <Icon name="chev-l" />
              </button>
              <b style={{ minWidth: 150, textAlign: "center" }}>{month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</b>
              <button className="btn btn-icon" aria-label="Next month" onClick={() => shift(1)}>
                <Icon name="chev-r" />
              </button>
            </div>
            <Button size="sm" variant="quiet" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
              Today
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
      <div className="row" style={{ gap: 6, marginBottom: 14 }}>
        {["in_review", "approved", "scheduled", "published", "failed"].map((s) => (
          <Tag key={s} tone={POST_STATUS[s].tone} dot>
            {POST_STATUS[s].label}
          </Tag>
        ))}
        <Tag tone="mute">Draft (planned date)</Tag>
      </div>
      <div className="cal" role="grid">
        {DOW.map((d) => (
          <div key={d} className="dow" role="columnheader">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const k = key(d);
          const items = byDay.get(k) ?? [];
          return (
            <div
              key={k}
              role="gridcell"
              className={`day ${d.getMonth() !== month.getMonth() ? "out" : ""} ${k === today ? "today" : ""}`}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a")) return;
                if (can("posts.edit") && k >= today) nav(`/posts/new?date=${k}`);
              }}
              title={can("posts.edit") && k >= today ? "Plan a post for this day" : undefined}
            >
              <span className="d">{d.getDate()}</span>
              {items.slice(0, 4).map((p) => (
                <Link key={p.id} to={`/posts/${p.id}`} className={`chip s-${p.status}`} title={`${p.title} · ${POST_STATUS[p.status]?.label}`}>
                  {fmtTime(p.published_at ?? p.scheduled_at)} {p.title}
                </Link>
              ))}
              {items.length > 4 && <span className="sub">+{items.length - 4} more</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}
