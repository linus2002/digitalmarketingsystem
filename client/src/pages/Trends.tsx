import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, fmtDate } from "../lib/format";
import { useToast } from "../components/Toast";
import { Alert, Button, Empty, LoadError, PageHead, Skeleton, Switch, Tag } from "../components/ui";

interface Topic {
  rank: number;
  phrase: string;
  label: string;
  score: number;
  mentions: number;
  sources: string[];
  category: string;
  why?: string;
  angle?: string;
  items: { title: string; link: string; source: string; published: string | null }[];
}
interface GoogleTrend {
  term: string;
  geo: string;
  traffic: string;
  published: string | null;
  news: { title: string; url: string; source: string }[];
  web?: { title: string; url: string }[];
  /** Picture shown as the card background */
  image?: string;
  overview?: string;
  angle?: string;
  /** "news": a top Google News health story, shown when none of the trending searches are about health */
  matchedBy: "ai" | "keywords" | "news";
}
interface Snapshot {
  id: number;
  topics: Topic[];
  google?: { scanned: number; items: GoogleTrend[] };
  items_scanned: number;
  sources_ok: number;
  source_errors: { source: string; error: string }[];
  ai_enriched: boolean;
  ai_status: "off" | "pending" | "done" | "failed";
  created_at: string;
  created_by_name: string | null;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
function country(geo: string): string {
  return geo
    .split(", ")
    .map((g) => {
      try {
        return regionNames.of(g) ?? g;
      } catch {
        return g;
      }
    })
    .join(", ");
}

/** Feed links are only made clickable if they're ordinary web addresses (never "javascript:" and the like). */
const isWebLink = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);
function FeedLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  return isWebLink(href) ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

const CAT_TONE: Record<string, "bad" | "info" | "good" | "mute"> = { oncology: "bad", pharmaceutical: "info", medicine: "good", healthcare: "mute" };

export function TrendsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload, setData } = useLoad(() => api<{ latest: Snapshot | null; autoRefreshMinutes?: number }>("/trends"), []);
  const [busy, setBusy] = useState(false);
  const [useAi, setUseAi] = useState(true);
  // Kept in a ref so the polling timer isn't rebuilt every time the page renders.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const sourcesHint = can("settings.brand") ? "Edit the sources in Settings." : "Ask an administrator if you'd like other sources.";

  async function refresh() {
    setBusy(true);
    try {
      const r = await api<{ latest: Snapshot }>("/trends/refresh", { body: { useAi } });
      // Keep the rest of the page data (e.g. the automatic rescan interval).
      setData((d) => ({ ...d, latest: r.latest }));
      toast.ok("Trends updated", `${r.latest.items_scanned} headlines from ${r.latest.sources_ok} sources${r.latest.ai_status === "pending" ? ". AI summaries are on the way." : ""}`);
    } catch (e) {
      toast.err("Couldn't refresh trends", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const snap = data?.latest;

  // While the AI writes summaries in the background, check back every 8 seconds and fill them in.
  // Otherwise check once a minute, so scans made by the automatic refresh appear without reloading.
  const pending = snap?.ai_status === "pending";
  const snapId = snap?.id;
  useEffect(() => {
    const t = setInterval(
      () => {
        if (document.hidden) return;
        api<{ latest: Snapshot | null; autoRefreshMinutes?: number }>("/trends")
          .then((r) => {
            if (!r.latest) return;
            if (r.latest.id !== snapId) setData(r);
            else if (pending && r.latest.ai_status !== "pending") {
              setData(r);
              if (r.latest.ai_status === "done") toastRef.current.ok("AI summaries added");
            }
          })
          .catch(() => undefined);
      },
      pending ? 8000 : 60_000,
    );
    return () => clearInterval(t);
  }, [pending, snapId, setData]);

  return (
    <>
      <PageHead
        title="Trending topics"
        sub={`What people are searching for on Google right now, plus the five health, pharmaceutical and oncology topics most talked about in the news this week. ${sourcesHint}`}
        actions={
          can("trends.refresh") && (
            <>
              <Switch label="Summarise with AI" checked={useAi} onChange={setUseAi} />
              <Button variant="primary" icon="refresh" loading={busy} onClick={refresh}>
                {busy ? "Scanning feeds…" : "Scan now"}
              </Button>
            </>
          )
        }
      />
      {error && <LoadError error={error} retry={reload} />}
      {loading && !data && <Skeleton rows={5} />}
      {snap && (
        <>
          <p className="note mt0" style={{ marginBottom: 16 }}>
            Scanned {fmtDate(snap.created_at, true)} ({ago(snap.created_at)}) · {snap.items_scanned} headlines · {snap.sources_ok} sources
            {snap.ai_status === "done" ? " · summarised by AI" : ""}
            {data?.autoRefreshMinutes ? ` · rescans automatically every ${data.autoRefreshMinutes} min` : ""}
          </p>
          {pending && (
            <div style={{ marginBottom: 16 }}>
              <Alert tone="info" title="The AI is writing a summary and a post idea for each topic">
                The topics below are ready to use now. Summaries appear here automatically when they're done, usually within a few minutes on this computer.
              </Alert>
            </div>
          )}
          {snap.ai_status === "failed" && (
            <div style={{ marginBottom: 16 }}>
              <Alert tone="warn" title="The AI summaries didn't finish">
                The topics and headlines are still accurate. Scan again to retry, or turn off "Summarise with AI" for a faster scan.
              </Alert>
            </div>
          )}
          {snap.source_errors.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Alert tone="warn" title={`${snap.source_errors.length} source${snap.source_errors.length > 1 ? "s" : ""} couldn't be read`}>
                {snap.source_errors.map((e) => `${e.source}: ${e.error}`).join(" · ")}
              </Alert>
            </div>
          )}
          {snap.google && snap.google.scanned > 0 && <GoogleNow google={snap.google} pending={pending} />}
          <h2 className="trend-h" style={{ marginBottom: 14 }}>
            In the news this week
          </h2>
          {snap.topics.length === 0 ? (
            <div className="board">
              <Empty title="No clear trends in this scan">
                {can("settings.brand") ? "Try again later, or add more sources in Settings." : "Try again later, or ask an administrator to add more sources."}
              </Empty>
            </div>
          ) : (
            <div className="stackv" style={{ gap: 16 }}>
              {snap.topics.map((t) => (
                <div key={t.rank} className={`card ${t.rank === 1 ? "" : "soft"}`}>
                  <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
                    <span className="rank">{t.rank}</span>
                    <div className="grow">
                      <div className="spread">
                        <div className="row" style={{ gap: 8 }}>
                          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{t.label}</h3>
                          <Tag tone={CAT_TONE[t.category] ?? "mute"} dot>
                            {t.category}
                          </Tag>
                        </div>
                        {can("content.generate") && (
                          <Button size="sm" variant="soft" icon="spark" onClick={() => nav(`/studio?topic=${encodeURIComponent(t.label)}${t.angle ? `&notes=${encodeURIComponent(t.angle)}` : ""}`)}>
                            Create content
                          </Button>
                        )}
                      </div>
                      <p className="note mt8">
                        Mentioned in {t.mentions} item{t.mentions === 1 ? "" : "s"} across {t.sources.length} source{t.sources.length === 1 ? "" : "s"} · trend score {t.score}
                      </p>
                      <div className="bar" style={{ maxWidth: 360 }}>
                        <i style={{ width: `${t.score}%` }} />
                      </div>
                      {t.why && (
                        <p style={{ margin: "14px 0 0" }}>
                          <b style={{ fontWeight: 600 }}>Why it's in the news: </b>
                          {t.why}
                        </p>
                      )}
                      {t.angle && (
                        <p style={{ margin: "6px 0 0" }}>
                          <b style={{ fontWeight: 600 }}>Post idea: </b>
                          {t.angle}
                        </p>
                      )}
                      <ul className="trend-items">
                        {t.items.map((it) => (
                          <li key={it.link + it.title}>
                            <FeedLink href={it.link}>{it.title}</FeedLink>
                            <span className="sub">
                              {" "}
                              · {it.source}
                              {it.published ? ` · ${fmtDate(it.published)}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="note">Headlines link to the original publishers. Check the source before you post about a topic; AI summaries are based on headlines{snap.google?.items.some((g) => g.web?.length) ? " and web search results" : ""} only.</p>
        </>
      )}
      {!loading && !snap && !error && (
        <div className="board">
          <Empty title="No scan yet" action={can("trends.refresh") && <Button variant="primary" icon="refresh" loading={busy} onClick={refresh}>Scan now</Button>}>
            {can("trends.refresh") ? "Scan the health news feeds to find this week's top five topics." : "Nobody has scanned the health news feeds yet. Ask a marketer or manager to run a scan."}
          </Empty>
        </div>
      )}
    </>
  );
}

function GoogleNow({ google, pending }: { google: { scanned: number; items: GoogleTrend[] }; pending: boolean }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const searches = google.items.filter((g) => g.matchedBy !== "news").length;
  const showingNews = google.items.length > 0 && searches === 0;
  return (
    <section style={{ marginBottom: 28 }}>
      <div className="spread" style={{ marginBottom: 14 }}>
        <h2 className="trend-h">Trending on Google now</h2>
        <span className="note mt0">
          {searches} of {google.scanned} trending searches are about health
        </span>
      </div>
      {showingNews && (
        <p className="note" style={{ marginTop: -6, marginBottom: 14 }}>
          {pending
            ? "The AI is still checking the trending searches. Meanwhile, here are today's top health stories on Google News."
            : "None of today's trending searches are about health, so here are the top health stories on Google News instead."}
        </p>
      )}
      {google.items.length === 0 ? (
        <div className="board">
          <Empty title="No health searches are trending right now">
            {pending
              ? "The AI is still checking the trending searches."
              : `None of the ${google.scanned} searches trending on Google are about health. That's common: check back later${
                  can("settings.brand") ? ", or add more countries in Settings → Trend sources" : ", or ask an administrator to add more countries"
                }.`}
          </Empty>
        </div>
      ) : (
        <div className="grid g2">
          {google.items.map((g) => (
            <div
              key={g.term}
              className={`card soft gtrend${isWebLink(g.image) ? " has-img" : ""}`}
              style={isWebLink(g.image) ? ({ "--gtrend-img": `url("${g.image.replace(/["\\()]/g, "")}")` } as React.CSSProperties) : undefined}
            >
              <div className="spread" style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <h3>{g.term}</h3>
                  <p className="note" style={{ marginTop: 4 }}>
                    {g.matchedBy === "news" ? `Top health story${g.news[0] ? ` · ${g.news[0].source}` : ""}` : g.traffic ? `${g.traffic} searches` : "Trending"} ·{" "}
                    {country(g.geo)}
                    {g.published ? ` · ${ago(g.published)}` : ""}
                  </p>
                </div>
                <Tag tone="info" dot>
                  {g.matchedBy === "news" ? "Google News" : "Google"}
                </Tag>
              </div>
              {g.overview ? (
                <p className="gtrend-overview">
                  <b>Overview: </b>
                  {g.overview}
                </p>
              ) : (
                <p className="note">
                  {pending ? "The AI is writing an overview…" : g.matchedBy === "keywords" ? "Matched by keywords. The AI hasn't checked this one yet." : "No overview yet."}
                </p>
              )}
              {g.angle && (
                <p style={{ margin: "6px 0 0" }}>
                  <b style={{ fontWeight: 600 }}>Post idea: </b>
                  {g.angle}
                </p>
              )}
              {(g.news.length > 0 || (g.web?.length ?? 0) > 0) && (
                <ul className="trend-items">
                  {g.news.map((n) => (
                    <li key={n.url + n.title}>
                      <FeedLink href={n.url}>{g.matchedBy === "news" && n.title === g.term ? "Read the full story" : n.title}</FeedLink>
                      <span className="sub"> · {n.source}</span>
                    </li>
                  ))}
                  {g.web?.map((w) => (
                    <li key={w.url + w.title}>
                      <FeedLink href={w.url}>{w.title || w.url}</FeedLink>
                      <span className="sub"> · web</span>
                    </li>
                  ))}
                </ul>
              )}
              {can("content.generate") && (
                <div className="row gtrend-actions">
                  <Button size="sm" variant="soft" icon="spark" onClick={() => nav(`/studio?topic=${encodeURIComponent(g.term)}${g.angle ? `&notes=${encodeURIComponent(g.angle)}` : ""}`)}>
                    Create content
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
