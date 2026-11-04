import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { CAMPAIGN_STATUS, fmtCompact, fmtNum, SOURCE_LABEL } from "../lib/format";
import { BarChart } from "../components/Chart";
import { Empty, KpiCard, LoadError, PageHead, Skeleton, StatusTag, TextField } from "../components/ui";
import { Icon } from "../components/Icons";

interface Summary {
  from: string;
  to: string;
  totals: { published: number; failed: number; reach: number; impressions: number; engagement: number; shares: number; comments: number };
  attempts: { ok: number; retried: number; errors: number };
  weekly: { week: string; posts: number; reach: number; engagement: number }[];
  campaigns: { id: number; name: string; status: string; published: number; failed: number; reach: number; impressions: number; reactions: number; comments: number; shares: number; clicks: number }[];
  leads: { source: string; n: number; reviewed: number }[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function ReportsPage() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(iso(new Date(Date.now() + 86400_000)));
  const { data, error, loading, reload } = useLoad(() => api<Summary>("/reports/summary", { query: { from, to } }), [from, to]);

  const total = (data?.attempts.ok ?? 0) + (data?.attempts.errors ?? 0);
  const successRate = total ? (data!.attempts.ok / total) * 100 : 100;

  return (
    <>
      <PageHead
        title="Campaign performance"
        sub="Published posts, reach and engagement by campaign, plus how reliably scheduled posts went out."
        actions={
          <>
            <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <a className="btn btn-soft" style={{ alignSelf: "flex-end" }} href={`/api/reports/campaigns.csv?from=${from}&to=${to}`}>
              <Icon name="download" />
              Export to Excel (CSV)
            </a>
          </>
        }
      />
      {error && <LoadError error={error} retry={reload} />}
      {loading && !data && <Skeleton rows={4} />}
      {data && (
        <>
          <div className="grid g4">
            <KpiCard strong title="Posts published" sub="In this period" value={data.totals.published} note={data.totals.failed ? `${data.totals.failed} failed` : "None failed"} />
            <KpiCard title="Reach" sub="Sum across posts" value={fmtCompact(data.totals.reach)} />
            <KpiCard title="Engagement" sub="Reactions, comments, shares" value={fmtCompact(data.totals.engagement)} note={data.totals.reach ? `${((data.totals.engagement / data.totals.reach) * 100).toFixed(1)}% of reach` : undefined} />
            <KpiCard
              title="Publishing success"
              sub={`${data.attempts.retried} retries needed`}
              value={`${Math.round(successRate)}%`}
              ring={successRate}
              note={`${data.attempts.ok} succeeded · ${data.attempts.errors} gave up`}
            />
          </div>
          <div className="grid g2 mt24">
            <div className="board">
              <h2 className="section" style={{ marginBottom: 12 }}>Reach by week</h2>
              <BarChart data={data.weekly.map((w) => ({ x: w.week, y: w.reach }))} label="Reach by week" />
            </div>
            <div className="board">
              <h2 className="section" style={{ marginBottom: 12 }}>Inquiries received</h2>
              {data.leads.length ? (
                <dl className="kv">
                  {data.leads.map((l) => (
                    <div key={l.source} style={{ display: "contents" }}>
                      <dt>{SOURCE_LABEL[l.source] ?? l.source}</dt>
                      <dd>
                        <b>{l.n}</b> <span className="sub">· {l.reviewed} needed pharmaceutical review</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="muted small">No consented inquiries in this period.</p>
              )}
            </div>
          </div>
          <div className="table-wrap mt24">
            {data.campaigns.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Status</th>
                      <th className="num">Published</th>
                      <th className="num">Reach</th>
                      <th className="num">Views</th>
                      <th className="num">Reactions</th>
                      <th className="num">Comments</th>
                      <th className="num">Shares</th>
                      <th className="num">Clicks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.campaigns.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link className="name" to={`/campaigns/${c.id}`}>
                            {c.name}
                          </Link>
                        </td>
                        <td>
                          <StatusTag map={CAMPAIGN_STATUS} value={c.status} />
                        </td>
                        <td className="num">{c.published}</td>
                        <td className="num">{fmtNum(c.reach)}</td>
                        <td className="num">{fmtNum(c.impressions)}</td>
                        <td className="num">{fmtNum(c.reactions)}</td>
                        <td className="num">{fmtNum(c.comments)}</td>
                        <td className="num">{fmtNum(c.shares)}</td>
                        <td className="num">{fmtNum(c.clicks)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No campaigns yet" />
            )}
          </div>
        </>
      )}
    </>
  );
}
