import { useEffect, useState } from "react";
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
interface Snapshot {
  id: number;
  topics: Topic[];
  items_scanned: number;
  sources_ok: number;
  source_errors: { source: string; error: string }[];
  ai_enriched: boolean;
  ai_status: "off" | "pending" | "done" | "failed";
  created_at: string;
  created_by_name: string | null;
}

const CAT_TONE: Record<string, "bad" | "info" | "good" | "mute"> = { oncology: "bad", pharmaceutical: "info", medicine: "good", healthcare: "mute" };

export function TrendsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload, setData } = useLoad(() => api<{ latest: Snapshot | null }>("/trends"), []);
  const [busy, setBusy] = useState(false);
  const [useAi, setUseAi] = useState(true);

  async function refresh() {
    setBusy(true);
    try {
      const r = await api<{ latest: Snapshot }>("/trends/refresh", { body: { useAi } });
      setData({ latest: r.latest });
      toast.ok("Trends updated", `${r.latest.items_scanned} headlines from ${r.latest.sources_ok} sources${r.latest.ai_status === "pending" ? ". AI summaries are on the way." : ""}`);
    } catch (e) {
      toast.err("Couldn't refresh trends", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const snap = data?.latest;

  // While the AI writes summaries in the background, check back every 8 seconds and fill them in.
  const pending = snap?.ai_status === "pending";
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => {
      api<{ latest: Snapshot | null }>("/trends")
        .then((r) => {
          if (r.latest && r.latest.ai_status !== "pending") {
            setData(r);
            if (r.latest.ai_status === "done") toast.ok("AI summaries added");
          }
        })
        .catch(() => undefined);
    }, 8000);
    return () => clearInterval(t);
  }, [pending, setData, toast]);

  return (
    <>
      <PageHead
        title="Trending topics"
        sub="The five health, pharmaceutical and oncology topics most talked about in the last 7 days, from public RSS feeds, PubMed and (optionally) NewsAPI. Edit the sources in Settings."
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
          {snap.topics.length === 0 ? (
            <div className="board">
              <Empty title="No clear trends in this scan">Try again later, or add more sources in Settings.</Empty>
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
                            <a href={it.link} target="_blank" rel="noreferrer noopener">
                              {it.title}
                            </a>
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
          <p className="note">Headlines link to the original publishers. Check the source before you post about a topic; the AI summary is based on headlines only.</p>
        </>
      )}
      {!loading && !snap && !error && (
        <div className="board">
          <Empty title="No scan yet" action={can("trends.refresh") && <Button variant="primary" icon="refresh" loading={busy} onClick={refresh}>Scan now</Button>}>
            Scan the health news feeds to find this week's top five topics.
          </Empty>
        </div>
      )}
    </>
  );
}
