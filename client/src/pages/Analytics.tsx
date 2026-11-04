import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, fmtCompact, fmtDate, fmtNum } from "../lib/format";
import { useToast } from "../components/Toast";
import { LineChart } from "../components/Chart";
import { Alert, Button, Empty, KpiCard, LinkButton, LoadError, PageHead, Seg, Skeleton, Tag } from "../components/ui";

interface SeriesData {
  metric: string;
  points: { day: string; value: number }[];
  total: number;
}
interface Overview {
  connected: boolean;
  pageName?: string;
  lastSync: { ok: boolean; at: string; error?: string; postsSynced: number; skippedMetrics: { metric: string; error: string }[] } | null;
  days: number;
  series: Record<"reach" | "impressions" | "engagement" | "follows" | "views", SeriesData | null>;
  postTotals: { posts: number; reactions: number; comments: number; shares: number; impressions: number; reach: number; clicks: number };
  topPosts: {
    fb_post_id: string;
    message: string | null;
    permalink_url: string | null;
    created_time: string;
    reactions: number;
    comments: number;
    shares: number;
    reach: number | null;
    impressions: number | null;
    engagement: number;
    engagement_rate: number | null;
    post_id: number | null;
    post_title: string | null;
    campaign_name: string | null;
  }[];
}

export function AnalyticsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [days, setDays] = useState<"7" | "28" | "90">("28");
  const { data, error, loading, reload } = useLoad(() => api<Overview>("/analytics/overview", { query: { days } }), [days]);
  const [syncing, setSyncing] = useState(false);

  async function sync() {
    setSyncing(true);
    try {
      const r = await api<{ result: { ok: boolean; postsSynced: number; error?: string } }>("/analytics/sync", { body: {} });
      if (r.result.ok) toast.ok("Synced from Facebook", `${r.result.postsSynced} posts updated`);
      else toast.err("Sync failed", r.result.error);
      await reload();
    } catch (e) {
      toast.err("Sync failed", (e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const s = data?.series;
  const t = data?.postTotals;
  const lineSeries = [
    s?.reach && { label: "Reach", points: s.reach.points.map((p) => ({ x: p.day, y: p.value })) },
    s?.engagement && { label: "Post engagement", points: s.engagement.points.map((p) => ({ x: p.day, y: p.value })) },
  ].filter(Boolean) as { label: string; points: { x: string; y: number }[] }[];

  return (
    <>
      <PageHead
        title="Facebook analytics"
        sub={data?.pageName ? `${data.pageName}: reach, engagement and post performance from the Meta Graph API.` : "Reach, engagement and post performance from the Meta Graph API."}
        actions={
          <>
            <Seg label="Period" value={days} onChange={setDays} options={[{ value: "7", label: "7 days" }, { value: "28", label: "28 days" }, { value: "90", label: "90 days" }]} />
            {can("analytics.sync") && (
              <Button variant="primary" icon="refresh" loading={syncing} onClick={sync} disabled={!data?.connected}>
                Sync now
              </Button>
            )}
          </>
        }
      />
      {error && <LoadError error={error} retry={reload} />}
      {loading && !data && <Skeleton rows={4} />}
      {data && !data.connected && (
        <div className="board">
          <Empty title="Connect your Facebook Page" action={can("settings.manage") ? <LinkButton to="/settings?tab=facebook" variant="primary" size="sm">Connect the Page</LinkButton> : undefined}>
            Add your Page ID and Page access token in Settings. Analytics then sync every few hours.
          </Empty>
        </div>
      )}
      {data && data.connected && (
        <>
          {data.lastSync && (
            <p className="note mt0" style={{ marginBottom: 14 }}>
              Last synced {ago(data.lastSync.at)}
              {data.lastSync.ok ? "" : ` · failed: ${data.lastSync.error}`}
            </p>
          )}
          {data.lastSync?.skippedMetrics?.length ? (
            <div style={{ marginBottom: 16 }}>
              <Alert tone="info" title={`${data.lastSync.skippedMetrics.length} metric${data.lastSync.skippedMetrics.length > 1 ? "s" : ""} not available from Facebook`}>
                Meta renames and retires metrics between API versions; these were skipped: {data.lastSync.skippedMetrics.map((m) => m.metric).join(", ")}. Adjust META_PAGE_METRICS / META_POST_METRICS in .env if needed.
              </Alert>
            </div>
          ) : null}
          <div className="grid g4">
            <KpiCard strong title="Reach" sub={s?.reach ? `Page, ${days} days` : "Sum of synced posts"} value={fmtCompact(s?.reach?.total ?? t?.reach)} />
            <KpiCard title="Views" sub={s?.impressions ? `Page, ${days} days` : "Sum of synced posts"} value={fmtCompact(s?.impressions?.total ?? t?.impressions)} />
            <KpiCard
              title="Engagement"
              sub="Reactions, comments, shares"
              value={fmtCompact((t?.reactions ?? 0) + (t?.comments ?? 0) + (t?.shares ?? 0))}
              note={t?.reach ? `${((((t.reactions + t.comments + t.shares) / t.reach) * 100) || 0).toFixed(1)}% of post reach` : undefined}
            />
            <KpiCard title="Posts" sub={`Published in ${days} days`} value={fmtNum(t?.posts)} note={`${fmtCompact(t?.shares)} shares · ${fmtCompact(t?.comments)} comments`} />
          </div>
          <div className="board mt24">
            <div className="spread" style={{ marginBottom: 12 }}>
              <h2 className="section">Daily trend</h2>
              {s?.follows && <Tag tone="good">{fmtNum(s.follows.total)} new follows</Tag>}
            </div>
            {lineSeries.length ? <LineChart series={lineSeries} /> : <p className="muted small">Daily Page metrics will appear after the first sync.</p>}
          </div>
          <div className="table-wrap mt24">
            <div className="toolbar">
              <h2 className="section">Top posts</h2>
              <span className="sub">By engagement, last {days} days</span>
            </div>
            {data.topPosts.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Post</th>
                      <th>Published</th>
                      <th className="num">Reach</th>
                      <th className="num">Reactions</th>
                      <th className="num">Comments</th>
                      <th className="num">Shares</th>
                      <th className="num">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topPosts.map((p) => (
                      <tr key={p.fb_post_id}>
                        <td>
                          {p.post_id ? (
                            <Link className="name" to={`/posts/${p.post_id}`}>
                              {p.post_title}
                            </Link>
                          ) : (
                            <span className="name">Posted on Facebook</span>
                          )}
                          <span className="sub clamp">{p.message}</span>
                          {p.campaign_name && <Tag tone="outline">{p.campaign_name}</Tag>}
                        </td>
                        <td className="nowrap">
                          {fmtDate(p.created_time)}
                          {p.permalink_url && (
                            <div className="sub">
                              <a href={p.permalink_url} target="_blank" rel="noreferrer">
                                Open
                              </a>
                            </div>
                          )}
                        </td>
                        <td className="num">{fmtNum(p.reach)}</td>
                        <td className="num">{fmtNum(p.reactions)}</td>
                        <td className="num">{fmtNum(p.comments)}</td>
                        <td className="num">{fmtNum(p.shares)}</td>
                        <td className="num">{p.engagement_rate != null ? `${p.engagement_rate}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No posts synced for this period">Press Sync now, or wait for the next automatic sync.</Empty>
            )}
          </div>
        </>
      )}
    </>
  );
}
