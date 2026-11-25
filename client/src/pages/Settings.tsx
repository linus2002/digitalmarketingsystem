import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago } from "../lib/format";
import { useToast } from "../components/Toast";
import { Alert, Button, ConfirmModal, Empty, IconButton, LoadError, PageHead, SelectField, Skeleton, Switch, Tabs, Tag, TextArea, TextField } from "../components/ui";
import { LeaveGuard } from "../components/LeaveGuard";
import { SocialAccountsTab } from "../components/SocialAccounts";
import "../styles/content.css";

type Tab = "brand" | "facebook" | "social" | "sources" | "privacy" | "system";

// settings.brand (marketing managers) covers the brand guidelines and trend sources; settings.manage (administrators) covers everything.
const TABS: { value: Tab; label: string; perm: "settings.brand" | "settings.manage" }[] = [
  { value: "brand", label: "Brand guidelines", perm: "settings.brand" },
  { value: "facebook", label: "Facebook connection", perm: "settings.manage" },
  { value: "social", label: "Social accounts", perm: "settings.manage" },
  { value: "sources", label: "Trend sources", perm: "settings.brand" },
  { value: "privacy", label: "Privacy and retention", perm: "settings.manage" },
  { value: "system", label: "System", perm: "settings.manage" },
];

export function SettingsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const isAdmin = can("settings.manage");
  const allowed = TABS.filter((t) => isAdmin || can(t.perm));
  const asked = params.get("tab");
  // An unknown or not-allowed ?tab= falls back to the first tab this person may use.
  const tab: Tab | undefined = allowed.find((t) => t.value === asked)?.value ?? allowed[0]?.value;
  /** Unsaved edits on the current tab (Brand, Facebook or Privacy). */
  const [dirty, setDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<Tab | null>(null);

  const go = (t: Tab) => {
    if (t === tab) return;
    if (dirty) setPendingTab(t);
    else setParams({ tab: t });
  };

  if (!tab)
    return (
      <>
        <PageHead title="Settings" />
        <div className="board">
          <Empty title="Nothing to change here">Settings are managed by administrators. Ask one if something needs changing.</Empty>
        </div>
      </>
    );

  const sub = isAdmin ? "Brand rules for the AI, Facebook and the other social accounts, trend sources and privacy." : "Brand rules for the AI and the sources the trend scanner reads.";
  return (
    <>
      <LeaveGuard when={dirty} message="Your changes in Settings haven't been saved. Leave without saving?" />
      <PageHead title="Settings" sub={sub} />
      {allowed.length > 1 && <Tabs value={tab} onChange={go} tabs={allowed.map(({ value, label }) => ({ value, label }))} />}
      <div className="mt24">
        {tab === "brand" && <BrandTab onDirty={setDirty} />}
        {tab === "facebook" && <FacebookTab onDirty={setDirty} />}
        {tab === "social" && <SocialAccountsTab />}
        {tab === "sources" && <SourcesTab />}
        {tab === "privacy" && <PrivacyTab onDirty={setDirty} />}
        {tab === "system" && <SystemTab />}
      </div>
      {pendingTab && (
        <ConfirmModal
          title="Leave without saving?"
          warning="Your changes on this tab haven't been saved."
          confirmLabel="Leave without saving"
          onClose={() => setPendingTab(null)}
          onConfirm={() => {
            setDirty(false);
            setParams({ tab: pendingTab });
            setPendingTab(null);
          }}
        >
          <p className="muted mt0">Stay on this tab and save to keep them.</p>
        </ConfirmModal>
      )}
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

const toForm = (brand: Brand): Record<keyof Brand, string> => ({
  ...brand,
  doList: brand.doList.join("\n"),
  dontList: brand.dontList.join("\n"),
  bannedPhrases: brand.bannedPhrases.join("\n"),
  alwaysHashtags: brand.alwaysHashtags.join(" "),
});

function BrandTab({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<{ brand: Brand }>("/settings/brand"), []);
  const [b, setB] = useState<Record<keyof Brand, string> | null>(null);
  const [saved, setSaved] = useState<Record<keyof Brand, string> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) {
      const f = toForm(data.brand);
      setB(f);
      setSaved(f);
    }
  }, [data]);
  const dirty = !!b && !!saved && (Object.keys(b) as (keyof Brand)[]).some((k) => b[k] !== saved[k]);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  // Leaving the tab by other means (e.g. the sidebar) clears the flag.
  useEffect(() => () => onDirty(false), [onDirty]);
  if (error) return <LoadError error={error} retry={reload} />;
  if (!b) return <Skeleton />;
  const set = (k: keyof Brand) => (e: { target: { value: string } }) => setB({ ...b, [k]: e.target.value });
  async function save() {
    setBusy(true);
    try {
      const r = await api<{ brand: Brand }>("/settings/brand", {
        method: "PUT",
        body: { ...b, doList: lines(b!.doList), dontList: lines(b!.dontList), bannedPhrases: lines(b!.bannedPhrases), alwaysHashtags: b!.alwaysHashtags.split(/\s+/).filter(Boolean) },
      });
      const f = toForm(r.brand);
      setB(f);
      setSaved(f);
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
        {dirty && <span className="note mt0">Unsaved changes</span>}
        <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>
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
  tokenSource?: "settings" | "env" | "none";
  lastSync: { at: string; ok: boolean; error?: string } | null;
}

function FacebookTab({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<MetaInfo>("/settings/meta"), []);
  const [pageId, setPageId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setPageId(data.pageId);
  }, [data]);
  const dirty = !!data && (!!token || pageId !== data.pageId);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
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
  const origin = window.location.origin.replace(":5190", ":4000");
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
        {data.source === "settings" && data.tokenSource === "env" && (
          <p className="note mt0">Using the Page ID saved here with the access token from .env. Paste a token above to store one here instead.</p>
        )}
      </div>
      <div className="board stackv" style={{ gap: 12 }}>
        <h2 className="section">Status</h2>
        <dl className="kv">
          <dt>Graph API</dt>
          <dd>{data.graphVersion}</dd>
          <dt>Publishing</dt>
          <dd>{data.publishDryRun ? <Tag tone="warn">Test mode: posts aren't sent to Facebook</Tag> : <Tag tone="good">Live</Tag>}</dd>
          <dt>Messenger</dt>
          <dd>{data.messengerDryRun ? <Tag tone="warn">Test mode: replies aren't sent</Tag> : <Tag tone="good">Live</Tag>}</dd>
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
        <p className="note mt0">Test mode switches (PUBLISH_DRY_RUN, MESSENGER_DRY_RUN) and the webhook secrets live in .env so they can't be changed from the browser.</p>
      </div>
    </div>
  );
}

interface Source {
  id: number;
  name: string;
  kind: "rss" | "pubmed" | "newsapi" | "google_trends";
  url: string | null;
  query: string | null;
  enabled: boolean;
}

const EMPTY_SOURCE = { name: "", kind: "rss" as Source["kind"], url: "", query: "" };

function SourcesTab() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<{ sources: Source[] }>("/trends/sources"), []);
  const [n, setN] = useState(EMPTY_SOURCE);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <Skeleton />;
  /** Runs a change and reports whether it worked, so callers only reset their form on success. */
  const run = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    try {
      await fn();
      toast.ok(ok);
      await reload();
      return true;
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
      return false;
    }
  };
  async function add() {
    if (adding) return;
    setAdding(true);
    const done = await run(
      () => api("/trends/sources", { body: { name: n.name.trim(), kind: n.kind, url: n.kind === "rss" ? n.url.trim() : null, query: n.kind === "rss" ? null : n.query.trim(), enabled: true } }),
      "Source added",
    );
    // Keep what was typed if the server refused it, so it can be corrected.
    if (done) setN(EMPTY_SOURCE);
    setAdding(false);
  }
  async function remove(src: Source) {
    setBusyId(src.id);
    const done = await run(() => api(`/trends/sources/${src.id}`, { method: "DELETE" }), "Source removed");
    setBusyId(null);
    if (done) setRemoving(null);
  }
  return (
    <div className="stackv" style={{ gap: 20 }}>
      <Alert tone="info" title="Only use sources that permit this">
        RSS feeds published for syndication, Google Trends' public "Trending now" feed, PubMed (NCBI E-utilities) and NewsAPI with your own key. The scanner reads headlines and summaries
        only, never personal pages or profiles.
      </Alert>
      <LiveTrendsBox />
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
                    <Tag tone="outline">{s.kind === "google_trends" ? "GOOGLE TRENDS" : s.kind.toUpperCase()}</Tag>
                  </td>
                  <td className="small" style={{ maxWidth: 420, wordBreak: "break-all" }}>
                    {s.url ?? s.query}
                  </td>
                  <td>
                    <Switch
                      label={<span className="sr-only">Enabled</span>}
                      checked={s.enabled}
                      onChange={async (v) => {
                        if (busyId) return;
                        setBusyId(s.id);
                        await run(() => api(`/trends/sources/${s.id}`, { method: "PATCH", body: { enabled: v } }), v ? "Source on" : "Source off");
                        setBusyId(null);
                      }}
                    />
                  </td>
                  <td className="right">
                    <IconButton icon="trash" label={`Remove ${s.name}`} danger onClick={() => setRemoving(s)} />
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
              { value: "google_trends", label: "Google Trends (trending now)" },
              { value: "pubmed", label: "PubMed search" },
              { value: "newsapi", label: "NewsAPI search" },
            ]}
          />
          {n.kind === "rss" ? (
            <TextField label="Feed URL" value={n.url} onChange={(e) => setN({ ...n, url: e.target.value })} placeholder="https://…" />
          ) : n.kind === "google_trends" ? (
            <TextField
              label="Country code"
              value={n.query}
              maxLength={2}
              placeholder="PH"
              hint="Two letters: PH, US, SG, AE…"
              onChange={(e) => setN({ ...n, query: e.target.value.toUpperCase() })}
            />
          ) : (
            <TextField label="Search query" value={n.query} onChange={(e) => setN({ ...n, query: e.target.value })} />
          )}
          <Button
            variant="primary"
            loading={adding}
            disabled={!n.name.trim() || (n.kind === "rss" ? !/^https?:\/\/\S+/i.test(n.url.trim()) : n.kind === "google_trends" ? !/^[A-Z]{2}$/.test(n.query) : !n.query.trim())}
            onClick={add}
          >
            Add
          </Button>
        </div>
        {n.kind === "rss" && n.url.trim() !== "" && !/^https?:\/\//i.test(n.url.trim()) && <p className="note">Feed addresses start with https:// (or http://).</p>}
      </div>
      {removing && (
        <ConfirmModal
          title={`Remove ${removing.name}?`}
          warning="The scanner stops reading this source. Past scans keep their headlines."
          confirmLabel="Remove source"
          busy={busyId === removing.id}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        >
          <p className="muted mt0 content-break">{removing.url ?? removing.query}</p>
        </ConfirmModal>
      )}
    </div>
  );
}

function LiveTrendsBox() {
  const toast = useToast();
  const { can } = useAuth();
  const isAdmin = can("settings.manage");
  const { data, reload } = useLoad(() => api<{ webSearch: boolean; keySet: boolean; autoRefreshMinutes: number }>("/trends/live"), []);
  if (!data) return null;
  const save = async (webSearch: boolean) => {
    try {
      await api("/trends/live", { method: "PUT", body: { webSearch } });
      toast.ok(webSearch ? "Web search on" : "Web search off", webSearch ? "New Google trends are looked up from the next scan." : undefined);
      await reload();
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
    }
  };
  return (
    <div className="board">
      <p className="label">Live Google trends</p>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div style={{ maxWidth: 640 }}>
          <b style={{ fontWeight: 600 }}>Look up each trending health search on the web</b>
          <p className="note mt0" style={{ marginTop: 4 }}>
            Uses Ollama web search so the AI can explain why a search is trending, not just repeat the headline. Only the trending search term is sent to ollama.com, never
            inquiry data.
            {!data.keySet &&
              (isAdmin
                ? " To turn it on, create a key at ollama.com (Settings → Keys), add it to .env as OLLAMA_API_KEY and restart the app."
                : " It isn't set up on this server yet: ask your administrator to turn it on.")}
          </p>
        </div>
        <Switch label={<span className="sr-only">Web search</span>} checked={data.webSearch && data.keySet} onChange={(v) => (data.keySet ? save(v) : toast.err(isAdmin ? "Add OLLAMA_API_KEY to .env first" : "Ask your administrator to set up web search first"))} />
      </div>
      <p className="note">
        {data.autoRefreshMinutes
          ? `Trends are rescanned automatically every ${data.autoRefreshMinutes} minutes.${isAdmin ? " Change TRENDS_AUTO_REFRESH_MINUTES in .env to adjust." : ""}`
          : `Automatic rescans are off.${isAdmin ? " Set TRENDS_AUTO_REFRESH_MINUTES in .env to turn them on." : " Ask your administrator if you'd like them on."}`}
      </p>
    </div>
  );
}

function PrivacyTab({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const toast = useToast();
  const ret = useLoad(() => api<{ retention: { leadDays: number; unconsentedDays: number; auditDays: number; aiLogDays: number }; lastRun: { at: string; anonymized: number; deletedUnconsented: number } | null }>("/settings/retention"), []);
  const con = useLoad(() => api<{ consent: { version: string; text: string } }>("/settings/consent"), []);
  const [r, setR] = useState<Record<string, string> | null>(null);
  const [c, setC] = useState<{ version: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The confirmation before a run or before lowering the limits, with what it would remove. */
  const [confirm, setConfirm] = useState<{ kind: "run" | "save"; anonymize: number; deleteUnconsented: number } | null>(null);
  useEffect(() => {
    if (ret.data) setR(Object.fromEntries(Object.entries(ret.data.retention).map(([k, v]) => [k, String(v)])));
  }, [ret.data]);
  useEffect(() => {
    if (con.data) setC(con.data.consent);
  }, [con.data]);
  const dirty =
    (!!r && !!ret.data && Object.entries(ret.data.retention).some(([k, v]) => r[k] !== String(v))) ||
    (!!c && !!con.data && (c.version !== con.data.consent.version || c.text !== con.data.consent.text));
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  if (ret.error || con.error)
    return (
      <LoadError
        error={(ret.error || con.error)!}
        retry={() => {
          if (ret.error) void ret.reload();
          if (con.error) void con.reload();
        }}
      />
    );
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
  const saved = ret.data!.retention;
  const values = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])) as typeof saved;
  const save = () => go("save", () => api("/settings/retention", { method: "PUT", body: values }), "Retention saved");
  const run = () => go("run", () => api("/settings/retention/run", { body: {} }), "Retention run finished");
  /** Looks up what would be removed, then asks. Saving only asks when a limit gets shorter. */
  const ask = async (kind: "run" | "save") => {
    const lowered = values.leadDays < saved.leadDays || values.unconsentedDays < saved.unconsentedDays;
    if (kind === "save" && !lowered) return void save();
    setBusy(kind);
    try {
      const lim = kind === "save" ? { leadDays: values.leadDays, unconsentedDays: values.unconsentedDays } : {};
      const { preview } = await api<{ preview: { anonymize: number; deleteUnconsented: number } }>("/settings/retention/preview", { query: lim });
      if (kind === "save" && !preview.anonymize && !preview.deleteUnconsented) return void (await save());
      setConfirm({ kind, ...preview });
    } catch (e) {
      toast.err("Couldn't check what would be removed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <div className="grid g2">
      {confirm && (
        <ConfirmModal
          title={confirm.kind === "run" ? "Run data retention now?" : "Shorten how long inquiries are kept?"}
          warning="Removed personal data can't be recovered."
          confirmLabel={confirm.kind === "run" ? "Run now" : "Save"}
          confirmWord={confirm.anonymize + confirm.deleteUnconsented > 0 ? "remove" : undefined}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const k = confirm.kind;
            setConfirm(null);
            void (k === "run" ? run() : save());
          }}
        >
          <p>
            {confirm.kind === "run" ? "This run will" : "With the new limits, the next daily run will"}:
          </p>
          <ul>
            <li>anonymise {plural(confirm.anonymize, "inquiry", "inquiries")} (names, contact details and messages are removed)</li>
            <li>delete {plural(confirm.deleteUnconsented, "conversation", "conversations")} where the person never agreed</li>
          </ul>
          {confirm.kind === "run" && <p className="note">Old audit log and AI history entries past their limits are also removed.</p>}
        </ConfirmModal>
      )}
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
            <Button variant="quiet" loading={busy === "run"} disabled={!!busy} onClick={() => void ask("run")}>
              Run now
            </Button>
            <Button variant="primary" loading={busy === "save"} disabled={!!busy} onClick={() => void ask("save")}>
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
          <Button variant="primary" loading={busy === "consent"} onClick={() => go("consent", async () => { await api("/settings/consent", { method: "PUT", body: c }); await con.reload(); }, "Consent wording saved")}>
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
