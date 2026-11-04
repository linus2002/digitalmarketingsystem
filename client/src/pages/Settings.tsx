import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { ago } from "../lib/format";
import { useToast } from "../components/Toast";
import { Alert, Button, IconButton, LoadError, PageHead, SelectField, Skeleton, Switch, Tabs, Tag, TextArea, TextField } from "../components/ui";

type Tab = "brand" | "facebook" | "sources" | "privacy" | "system";

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "brand";
  return (
    <>
      <PageHead title="Settings" sub="Brand rules for the AI, the Facebook connection, trend sources and privacy." />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { value: "brand", label: "Brand guidelines" },
          { value: "facebook", label: "Facebook connection" },
          { value: "sources", label: "Trend sources" },
          { value: "privacy", label: "Privacy and retention" },
          { value: "system", label: "System" },
        ]}
      />
      <div className="mt24">
        {tab === "brand" && <BrandTab />}
        {tab === "facebook" && <FacebookTab />}
        {tab === "sources" && <SourcesTab />}
        {tab === "privacy" && <PrivacyTab />}
        {tab === "system" && <SystemTab />}
      </div>
    </>
  );
}

interface Brand {
  name: string;
  voice: string;
  audience: string;
  language: string;
  doList: string[];
  dontList: string[];
  bannedPhrases: string[];
  requiredDisclaimer: string;
  alwaysHashtags: string[];
}

const lines = (v: string) => v.split("\n").map((s) => s.trim()).filter(Boolean);

function BrandTab() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<{ brand: Brand }>("/settings/brand"), []);
  const [b, setB] = useState<Record<keyof Brand, string> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data)
      setB({
        ...data.brand,
        doList: data.brand.doList.join("\n"),
        dontList: data.brand.dontList.join("\n"),
        bannedPhrases: data.brand.bannedPhrases.join("\n"),
        alwaysHashtags: data.brand.alwaysHashtags.join(" "),
      });
  }, [data]);
  if (error) return <LoadError error={error} retry={reload} />;
  if (!b) return <Skeleton />;
  const set = (k: keyof Brand) => (e: { target: { value: string } }) => setB({ ...b, [k]: e.target.value });
  async function save() {
    setBusy(true);
    try {
      await api("/settings/brand", {
        method: "PUT",
        body: { ...b, doList: lines(b!.doList), dontList: lines(b!.dontList), bannedPhrases: lines(b!.bannedPhrases), alwaysHashtags: b!.alwaysHashtags.split(/\s+/).filter(Boolean) },
      });
      toast.ok("Brand guidelines saved", "The AI studio uses them from the next request.");
    } catch (e) {
      toast.err("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="board stackv" style={{ gap: 16 }}>
      <div className="grid g2">
        <TextField label="Brand name" value={b.name} onChange={set("name")} />
        <TextField label="Language" value={b.language} onChange={set("language")} />
      </div>
      <TextArea label="Voice" value={b.voice} onChange={set("voice")} rows={2} />
      <TextArea label="Audience" value={b.audience} onChange={set("audience")} rows={2} />
      <div className="grid g2">
        <TextArea label="Always" value={b.doList} onChange={set("doList")} rows={5} hint="One rule per line" />
        <TextArea label="Never" value={b.dontList} onChange={set("dontList")} rows={5} hint="One rule per line" />
      </div>
      <div className="grid g2">
        <TextArea label="Banned words and phrases" value={b.bannedPhrases} onChange={set("bannedPhrases")} rows={5} hint="One per line. Posts using them are flagged." />
        <div className="stackv">
          <TextArea label="Required disclaimer" value={b.requiredDisclaimer} onChange={set("requiredDisclaimer")} rows={3} />
          <TextField label="Hashtags on every post" value={b.alwaysHashtags} onChange={set("alwaysHashtags")} />
        </div>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button variant="primary" loading={busy} onClick={save}>
          Save guidelines
        </Button>
      </div>
    </div>
  );
}

interface MetaInfo {
  pageId: string;
  pageName?: string;
  source: string;
  hasToken: boolean;
  graphVersion: string;
  webhookConfigured: boolean;
  humanAgentTag: boolean;
  publishDryRun: boolean;
  messengerDryRun: boolean;
  lastSync: { at: string; ok: boolean; error?: string } | null;
}

function FacebookTab() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<MetaInfo>("/settings/meta"), []);
  const [pageId, setPageId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setPageId(data.pageId);
  }, [data]);
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <Skeleton />;
  async function save() {
    setBusy(true);
    try {
      const r = await api<{ pageName: string }>("/settings/meta", { method: "PUT", body: { pageId, token: token || undefined } });
      toast.ok(`Connected to ${r.pageName}`);
      setToken("");
      await reload();
    } catch (e) {
      toast.err("Not connected", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const origin = window.location.origin.replace(":5173", ":4000");
  return (
    <div className="grid g2">
      <div className="board stackv" style={{ gap: 16 }}>
        <div className="spread">
          <h2 className="section">Facebook Page</h2>
          {data.hasToken ? <Tag tone="good" dot>{data.pageName ?? "Connected"}</Tag> : <Tag tone="bad" dot>Not connected</Tag>}
        </div>
        <TextField label="Page ID" value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="e.g. 102938475610293" hint="Facebook Page > About > Page transparency, or Meta Business Suite settings." />
        <TextField
          label="Page access token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={data.hasToken ? "Saved. Paste a new one to replace it." : "Paste a long-lived Page access token"}
          hint="Stored encrypted. Needs pages_manage_posts, pages_read_engagement, read_insights and pages_messaging."
          autoComplete="off"
        />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="primary" loading={busy} disabled={!pageId || (!token && !data.hasToken)} onClick={save}>
            Check and save
          </Button>
        </div>
        {data.source === "env" && <p className="note mt0">Currently using the Page details from .env. Saving here overrides them.</p>}
      </div>
      <div className="board stackv" style={{ gap: 12 }}>
        <h2 className="section">Status</h2>
        <dl className="kv">
          <dt>Graph API</dt>
          <dd>{data.graphVersion}</dd>
          <dt>Publishing</dt>
          <dd>{data.publishDryRun ? <Tag tone="warn">Dry run: posts aren't sent</Tag> : <Tag tone="good">Live</Tag>}</dd>
          <dt>Messenger</dt>
          <dd>{data.messengerDryRun ? <Tag tone="warn">Dry run: replies aren't sent</Tag> : <Tag tone="good">Live</Tag>}</dd>
          <dt>Webhook</dt>
          <dd>{data.webhookConfigured ? <Tag tone="good">Configured</Tag> : <Tag tone="bad">Set META_APP_SECRET and META_VERIFY_TOKEN</Tag>}</dd>
          <dt>Human agent tag</dt>
          <dd>{data.humanAgentTag ? "On (7-day replies by people)" : "Off (24-hour window only)"}</dd>
          <dt>Last sync</dt>
          <dd>{data.lastSync ? `${ago(data.lastSync.at)}${data.lastSync.ok ? "" : ` · failed: ${data.lastSync.error}`}` : "Never"}</dd>
        </dl>
        <Alert tone="info" title="Messenger webhook">
          Callback URL: <span className="code">{origin}/api/webhooks/meta</span> (must be public HTTPS: use a tunnel such as Cloudflare Tunnel while running locally). Subscribe the Page to <span className="code">messages</span> and{" "}
          <span className="code">messaging_postbacks</span> only.
        </Alert>
        <p className="note mt0">Dry-run switches and the webhook secrets live in .env so they can't be changed from the browser.</p>
      </div>
    </div>
  );
}

interface Source {
  id: number;
  name: string;
  kind: "rss" | "pubmed" | "newsapi";
  url: string | null;
  query: string | null;
  enabled: boolean;
}

function SourcesTab() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<{ sources: Source[] }>("/trends/sources"), []);
  const [n, setN] = useState({ name: "", kind: "rss" as Source["kind"], url: "", query: "" });
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <Skeleton />;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.ok(ok);
      await reload();
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
    }
  };
  return (
    <div className="stackv" style={{ gap: 20 }}>
      <Alert tone="info" title="Only use sources that permit this">
        RSS feeds published for syndication, PubMed (NCBI E-utilities) and NewsAPI with your own key. The scanner reads headlines and summaries only, never personal pages or profiles.
      </Alert>
      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Type</th>
                <th>Feed or query</th>
                <th>On</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b style={{ fontWeight: 600 }}>{s.name}</b>
                  </td>
                  <td>
                    <Tag tone="outline">{s.kind.toUpperCase()}</Tag>
                  </td>
                  <td className="small" style={{ maxWidth: 420, wordBreak: "break-all" }}>
                    {s.url ?? s.query}
                  </td>
                  <td>
                    <Switch label={<span className="sr-only">Enabled</span>} checked={s.enabled} onChange={(v) => run(() => api(`/trends/sources/${s.id}`, { method: "PATCH", body: { enabled: v } }), v ? "Source on" : "Source off")} />
                  </td>
                  <td className="right">
                    <IconButton icon="trash" label={`Remove ${s.name}`} danger onClick={() => run(() => api(`/trends/sources/${s.id}`, { method: "DELETE" }), "Source removed")} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="board">
        <p className="label">Add a source</p>
        <div className="grid g4" style={{ alignItems: "end" }}>
          <TextField label="Name" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} />
          <SelectField
            label="Type"
            value={n.kind}
            onChange={(e) => setN({ ...n, kind: e.target.value as Source["kind"] })}
            options={[
              { value: "rss", label: "RSS / Atom feed" },
              { value: "pubmed", label: "PubMed search" },
              { value: "newsapi", label: "NewsAPI search" },
            ]}
          />
          {n.kind === "rss" ? (
            <TextField label="Feed URL" value={n.url} onChange={(e) => setN({ ...n, url: e.target.value })} placeholder="https://…" />
          ) : (
            <TextField label="Search query" value={n.query} onChange={(e) => setN({ ...n, query: e.target.value })} />
          )}
          <Button
            variant="primary"
            disabled={!n.name || (n.kind === "rss" ? !n.url : !n.query)}
            onClick={() =>
              run(
                () => api("/trends/sources", { body: { name: n.name, kind: n.kind, url: n.kind === "rss" ? n.url : null, query: n.kind === "rss" ? null : n.query, enabled: true } }),
                "Source added",
              ).then(() => setN({ name: "", kind: "rss", url: "", query: "" }))
            }
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function PrivacyTab() {
  const toast = useToast();
  const ret = useLoad(() => api<{ retention: { leadDays: number; unconsentedDays: number; auditDays: number; aiLogDays: number }; lastRun: { at: string; anonymized: number; deletedUnconsented: number } | null }>("/settings/retention"), []);
  const con = useLoad(() => api<{ consent: { version: string; text: string } }>("/settings/consent"), []);
  const [r, setR] = useState<Record<string, string> | null>(null);
  const [c, setC] = useState<{ version: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (ret.data) setR(Object.fromEntries(Object.entries(ret.data.retention).map(([k, v]) => [k, String(v)])));
  }, [ret.data]);
  useEffect(() => {
    if (con.data) setC(con.data.consent);
  }, [con.data]);
  if (ret.error || con.error) return <LoadError error={(ret.error || con.error)!} />;
  if (!r || !c) return <Skeleton />;

  const go = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label);
    try {
      await fn();
      toast.ok(ok);
      await ret.reload();
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid g2">
      <div className="board stackv" style={{ gap: 16 }}>
        <h2 className="section">Data retention</h2>
        <TextField label="Anonymise closed inquiries after (days)" type="number" min={30} value={r.leadDays} onChange={(e) => setR({ ...r, leadDays: e.target.value })} hint="Counted from the last activity. Removes names, contact details and messages." />
        <TextField label="Delete conversations without consent after (days)" type="number" min={1} value={r.unconsentedDays} onChange={(e) => setR({ ...r, unconsentedDays: e.target.value })} />
        <TextField label="Keep the audit log for (days)" type="number" min={90} value={r.auditDays} onChange={(e) => setR({ ...r, auditDays: e.target.value })} />
        <TextField label="Keep AI generation history for (days)" type="number" min={7} value={r.aiLogDays} onChange={(e) => setR({ ...r, aiLogDays: e.target.value })} />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="note mt0">
            {ret.data?.lastRun ? `Last run ${ago(ret.data.lastRun.at)}: ${ret.data.lastRun.anonymized} anonymised, ${ret.data.lastRun.deletedUnconsented} deleted` : "Runs daily."}
          </span>
          <div className="row">
            <Button variant="quiet" loading={busy === "run"} onClick={() => go("run", () => api("/settings/retention/run", { body: {} }), "Retention run finished")}>
              Run now
            </Button>
            <Button
              variant="primary"
              loading={busy === "save"}
              onClick={() => go("save", () => api("/settings/retention", { method: "PUT", body: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])) }), "Retention saved")}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
      <div className="board stackv" style={{ gap: 16 }}>
        <h2 className="section">Consent wording</h2>
        <p className="muted mt0 mb0">Shown on the website form and by the Messenger assistant before any details are collected. Change the version whenever you change the wording; each consent record keeps the version agreed to.</p>
        <TextField label="Version" value={c.version} onChange={(e) => setC({ ...c, version: e.target.value })} />
        <TextArea label="Wording" value={c.text} onChange={(e) => setC({ ...c, text: e.target.value })} rows={6} hint="{{business}} is replaced with the business name." />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="primary" loading={busy === "consent"} onClick={() => go("consent", () => api("/settings/consent", { method: "PUT", body: c }), "Consent wording saved")}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function SystemTab() {
  const { data, error, reload } = useLoad(
    () =>
      api<{
        ai: { provider: string; label: string; model: string; ready: boolean; problem?: string; fix?: string; inquiriesAllowed: boolean };
        scheduler: { enabled: boolean; intervalSeconds: number };
        node: string;
        env: string;
      }>("/settings/system"),
    [],
  );
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <Skeleton />;
  return (
    <div className="board">
      <dl className="kv">
        <dt>AI</dt>
        <dd>
          {data.ai.ready ? (
            <Tag tone="good" dot>
              {data.ai.label}: {data.ai.model}
            </Tag>
          ) : (
            <>
              <Tag tone="bad" dot>
                {data.ai.label} not ready
              </Tag>
              <div className="sub">
                {data.ai.problem} {data.ai.fix}
              </div>
            </>
          )}
        </dd>
        <dt>AI on inquiries</dt>
        <dd>
          {data.ai.inquiriesAllowed
            ? "On: inquiry text is sent to the AI for sorting and reply suggestions"
            : "Off: inquiries are sorted by keyword rules only; no inquiry text leaves this system"}
        </dd>
        <dt>Scheduler</dt>
        <dd>{data.scheduler.enabled ? `Checks every ${data.scheduler.intervalSeconds} seconds` : "Off"}</dd>
        <dt>Node.js</dt>
        <dd>{data.node}</dd>
        <dt>Mode</dt>
        <dd>{data.env}</dd>
      </dl>
    </div>
  );
}
