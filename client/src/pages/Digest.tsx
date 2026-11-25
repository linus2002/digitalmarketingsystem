import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { change, digestPdf, weekLabel, type DigestData } from "../lib/digestPdf";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icons";
import { Alert, Button, Empty, LoadError, PageHead, SelectField, Skeleton, Tag, useDocTitle } from "../components/ui";
import { PlatformIcon, type PlatformKey } from "../components/Platforms";
import { useAppStatus } from "./PostEditor";
import "../styles/digest.css";

interface ListItem {
  id: number;
  week_start: string;
  week_end: string;
  headline: string;
  written_by: string;
  updated_at: string;
}
interface List {
  digests: ListItem[];
  writing: string[];
  lastWeek: string;
}

const n = (v: number | null | undefined) => (v == null ? "—" : new Intl.NumberFormat("en").format(v));

export function DigestPage() {
  useDocTitle("Weekly digest");
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const app = useAppStatus();
  // Writing a digest replaces what the team was told, so it is for managers (the same permission the server checks).
  const canWrite = useAuth().can("analytics.sync");
  const list = useLoad(() => api<List>("/reports/digests"), []);
  const shownId = id ? Number(id) : list.data?.digests[0]?.id;
  const one = useLoad(() => (shownId ? api<{ digest: DigestData }>(`/reports/digests/${shownId}`) : Promise.resolve(null)), [shownId]);
  const [starting, setStarting] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  const writing = list.data?.writing ?? [];
  const reloadList = list.reload;
  // While a digest is being written, check back every few seconds; open it when it's ready.
  // What we're waiting for: the week, when its digest was last saved before we asked (null = there wasn't one),
  // and whether the server has been seen writing it. It's ready only once that save time changes.
  const [waitingFor, setWaitingFor] = useState<{ week: string; since: string | null; sawWriting: boolean } | null>(null);
  useEffect(() => {
    if (!writing.length && !waitingFor) return;
    const t = window.setInterval(() => reloadList(), 5000);
    return () => window.clearInterval(t);
  }, [writing.length, waitingFor, reloadList]);
  useEffect(() => {
    if (!waitingFor || !list.data) return;
    const busyNow = writing.includes(waitingFor.week);
    if (busyNow) {
      if (!waitingFor.sawWriting) setWaitingFor({ ...waitingFor, sawWriting: true });
      return;
    }
    const row = list.data.digests.find((d) => d.week_start.slice(0, 10) === waitingFor.week);
    if (row && row.updated_at !== waitingFor.since) {
      setWaitingFor(null);
      toast.ok("The digest is ready");
      if (row.id === shownId) one.reload();
      else nav(`/reports/digest/${row.id}`);
    } else if (waitingFor.sawWriting) {
      // The server stopped writing without saving anything new.
      setWaitingFor(null);
      toast.err("The digest couldn't be written", "Try again in a few minutes. If it keeps failing, check that the AI is running.");
    }
  }, [waitingFor, writing, list.data, nav, toast, shownId, one]);

  async function writeNow(week?: string) {
    setStarting(true);
    try {
      const r = await api<{ week: string }>("/reports/digests", { body: week ? { week } : {} });
      const before = list.data?.digests.find((d) => d.week_start.slice(0, 10) === r.week);
      setWaitingFor({ week: r.week, since: before?.updated_at ?? null, sawWriting: false });
      toast.ok("Writing the digest", "This can take a few minutes with the local AI. You can keep working; it opens when ready.");
      list.reload();
    } catch (e) {
      toast.err("Couldn't start the digest", (e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const d = one.data?.digest;
  const isWriting = (week: string) => writing.includes(week.slice(0, 10));
  const lastWeekDone = list.data?.digests.some((x) => x.week_start.slice(0, 10) === list.data?.lastWeek);

  return (
    <>
      <PageHead
        title="Weekly digest"
        sub="Every Monday at 8:00 AM, last week's results with what worked, what didn't, and three things to do this week. The numbers come from the system; the AI writes the explanation."
        actions={
          <>
            <Link className="btn btn-quiet" to="/reports">
              <Icon name="chev-l" />
              Reports
            </Link>
            {list.data && list.data.digests.length > 0 && (
              <SelectField
                label="Week"
                value={String(shownId ?? "")}
                onChange={(e) => nav(`/reports/digest/${e.target.value}`)}
                options={list.data.digests.map((x) => ({ value: x.id, label: weekLabel(x.week_start.slice(0, 10), x.week_end.slice(0, 10)) }))}
              />
            )}
            {d && (
              <Button
                variant="soft"
                icon="download"
                loading={pdfBusy}
                onClick={async () => {
                  setPdfBusy(true);
                  try {
                    await digestPdf(d, app?.businessName ?? "");
                  } catch (e) {
                    toast.err("Couldn't make the PDF", (e as Error).message);
                  } finally {
                    setPdfBusy(false);
                  }
                }}
              >
                Download PDF
              </Button>
            )}
            {canWrite && list.data && !lastWeekDone && (
              <Button variant="primary" icon="spark" loading={starting || isWriting(list.data.lastWeek)} onClick={() => void writeNow()}>
                {isWriting(list.data.lastWeek) ? "Writing…" : "Write last week's digest"}
              </Button>
            )}
          </>
        }
      />
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {writing.length > 0 && (
        <Alert tone="info" title="Writing a digest">
          The AI is writing it now. This page updates by itself when it's ready.
        </Alert>
      )}
      {list.loading && !list.data ? (
        <Skeleton rows={6} />
      ) : !list.data?.digests.length ? (
        <div className="board">
          <Empty title="No digests yet">The first one is written automatically next Monday at 8:00 AM, or press "Write last week's digest" to make one now.</Empty>
        </div>
      ) : one.error ? (
        <LoadError error={one.error} retry={one.reload} />
      ) : !d ? (
        <Skeleton rows={6} />
      ) : (
        <DigestView d={d} rewriting={isWriting(d.week_start)} onRewrite={canWrite ? () => void writeNow(d.week_start.slice(0, 10)) : undefined} />
      )}
    </>
  );
}

function DigestView({ d, rewriting, onRewrite }: { d: DigestData; rewriting: boolean; onRewrite?: () => void }) {
  const t = d.stats.totals;
  const p = d.stats.previous;
  const m = d.stats.measured !== false;
  const kpis: [string, number, number, boolean][] = [
    ["Posts published", t.published, p.published, true],
    ["People reached", t.reach, p.reach, m],
    ["Engagement", t.engagement, p.engagement, m],
    ["Inquiries", t.inquiries, p.inquiries, true],
  ];
  const best = d.stats.best;
  return (
    <div className="dg stackv" style={{ gap: 20 }}>
      <section className="dg-hero">
        <span className="dg-week">{weekLabel(d.week_start.slice(0, 10), d.week_end.slice(0, 10))}</span>
        <h2>{d.summary.headline}</h2>
        <div className="dg-kpis">
          {kpis.map(([label, cur, prev, known]) => {
            const c = change(cur, prev);
            return (
              <div key={label} className="dg-kpi">
                <span>{label}</span>
                <b>{known ? n(cur) : "—"}</b>
                {known ? <small className={c.startsWith("-") ? "down" : c === "—" ? "" : "up"}>{c} vs week before</small> : <small>not measured yet</small>}
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid g2">
        <section className="board dg-list good">
          <h3>
            <Icon name="check" /> What worked
          </h3>
          <ul>
            {d.summary.worked.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </section>
        <section className="board dg-list bad">
          <h3>
            <Icon name="alert" /> What didn't work
          </h3>
          <ul>
            {d.summary.flopped.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </section>
      </div>

      {best && (
        <section className="board dg-best">
          <p className="label mt0">Best post of the week</p>
          <div className="dg-best-row">
            <div className="grow">
              <Link className="dg-best-title" to={`/posts/${best.id}`} state={{ from: { to: "/reports/digest", label: "Weekly digest" } }}>
                {best.title}
              </Link>
              <p className="muted mt0">{best.excerpt}</p>
              <div className="row" style={{ gap: 6 }}>
                {best.platforms.map((pf) => (
                  <PlatformIcon key={pf} p={pf as PlatformKey} size={16} />
                ))}
                <Tag tone="outline">{best.format}</Tag>
                <span className="note mt0">{best.published}</span>
              </div>
            </div>
            <div className="dg-best-nums">
              <div>
                <b>{n(best.reach)}</b>
                <span>reached</span>
              </div>
              <div>
                <b>{n(best.engagement)}</b>
                <span>engagement</span>
              </div>
            </div>
          </div>
          {d.summary.bestWhy && (
            <p className="dg-why">
              <Icon name="spark" /> {d.summary.bestWhy}
            </p>
          )}
        </section>
      )}

      <section className="board dg-todo">
        <h3>Three things to do this week</h3>
        <ol>
          {d.summary.suggestions.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ol>
      </section>

      <div className="grid g2">
        <section className="board">
          <p className="label mt0">By platform</p>
          {d.stats.byPlatform.length ? (
            <ul className="dg-plat">
              {d.stats.byPlatform.map((x) => (
                <li key={x.platform}>
                  <PlatformIcon p={x.platform as PlatformKey} size={20} />
                  <span className="grow">{x.label}</span>
                  <b>{x.published}</b> published
                  {x.failed > 0 && <Tag tone="bad">{x.failed} failed</Tag>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted mt0">Nothing went out.</p>
          )}
        </section>
        <section className="board">
          <p className="label mt0">This week so far</p>
          <p className="mt0">
            <b>{d.stats.nextWeek.scheduled}</b> post{d.stats.nextWeek.scheduled === 1 ? "" : "s"} planned.
          </p>
          {d.stats.nextWeek.emptyDays.length > 0 && <p className="muted mt0">Nothing planned on {d.stats.nextWeek.emptyDays.join(", ")}.</p>}
          <Link className="btn btn-soft btn-sm" to="/calendar">
            Open the calendar
          </Link>
        </section>
      </div>

      {d.stats.posts.length > 0 && (
        <section className="table-wrap">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Published</th>
                  <th>Platforms</th>
                  <th className="right">Reach</th>
                  <th className="right">Engagement</th>
                </tr>
              </thead>
              <tbody>
                {d.stats.posts.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link className="name" to={`/posts/${x.id}`} state={{ from: { to: "/reports/digest", label: "Weekly digest" } }}>
                        {x.title}
                      </Link>
                      <span className="sub">{x.format}</span>
                    </td>
                    <td className="nowrap">{x.published}</td>
                    <td>
                      <span className="row" style={{ gap: 4 }}>
                        {x.platforms.map((pf) => (
                          <PlatformIcon key={pf} p={pf as PlatformKey} size={16} />
                        ))}
                      </span>
                    </td>
                    <td className="right">{n(x.reach)}</td>
                    <td className="right">{n(x.engagement)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="spread">
        <p className="note mt0">
          {d.stats.statsNote} Written by {d.written_by === "rules" ? "the system from the numbers (the AI wasn't available)" : d.written_by} · {fmtDate(d.updated_at, true)}
          {d.ai_error && ` · AI problem: ${d.ai_error}`}
        </p>
        {onRewrite && (
          <Button size="sm" variant="quiet" icon="refresh" loading={rewriting} onClick={onRewrite}>
            {rewriting ? "Writing…" : "Write it again"}
          </Button>
        )}
      </div>
    </div>
  );
}
