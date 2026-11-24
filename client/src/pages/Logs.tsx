import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Button, Empty, LoadError, PageHead, Seg, SelectField, Skeleton, Tag, TextField } from "../components/ui";

const LOG_TONE: Record<string, { label: string; tone: "good" | "warn" | "bad" | "info" }> = {
  success: { label: "Published", tone: "good" },
  dry_run: { label: "Test mode", tone: "info" },
  retry_scheduled: { label: "Will retry", tone: "warn" },
  error: { label: "Failed", tone: "bad" },
};

export function PublishLogPage() {
  const [status, setStatusRaw] = useState<"" | "error" | "retry_scheduled" | "success,dry_run">("");
  const [offset, setOffset] = useState(0);
  // A new filter starts again from the newest attempts.
  const setStatus = (s: typeof status) => {
    setStatusRaw(s);
    setOffset(0);
  };
  const { data, error, loading, reload } = useLoad(
    () =>
      api<{ logs: { id: number; post_id: number | null; post_title: string | null; attempt: number; status: string; message: string; created_at: string }[]; hasMore?: boolean }>(
        "/logs/publishing",
        { query: { status, limit: PAGE, offset } },
      ),
    [status, offset],
  );
  return (
    <>
      <PageHead
        title="Publishing log"
        sub="Every attempt to publish to Facebook. Temporary errors are retried automatically (1, 2, 4, 8 minutes…); permission or content errors stop at once."
        actions={
          <Seg
            label="Filter"
            value={status}
            onChange={setStatus}
            options={[
              { value: "", label: "All" },
              { value: "success,dry_run", label: "Published" },
              { value: "retry_scheduled", label: "Retries" },
              { value: "error", label: "Failed" },
            ]}
          />
        }
      />
      {error && <LoadError error={error} retry={reload} />}
      <div className="table-wrap">
        {loading && !data ? (
          <div style={{ padding: 18 }}>
            <Skeleton />
          </div>
        ) : data?.logs.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Post</th>
                  <th>Attempt</th>
                  <th>Result</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((l) => (
                  <tr key={l.id}>
                    <td className="nowrap">{fmtDate(l.created_at, true)}</td>
                    <td>{l.post_id ? <Link className="name" to={`/posts/${l.post_id}`}>{l.post_title}</Link> : <span className="muted">Deleted post</span>}</td>
                    <td>{l.attempt}</td>
                    <td>
                      <Tag tone={LOG_TONE[l.status]?.tone ?? "mute"} dot>
                        {LOG_TONE[l.status]?.label ?? l.status}
                      </Tag>
                    </td>
                    <td className="small" style={{ maxWidth: 480 }}>
                      {l.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : offset ? (
          <Empty title="No more attempts" />
        ) : status ? (
          <Empty
            title="No attempts match this filter"
            action={
              <Button variant="quiet" size="sm" onClick={() => setStatus("")}>
                Show all attempts
              </Button>
            }
          />
        ) : (
          <Empty title="Nothing logged yet">Attempts appear here once scheduled posts start going out.</Empty>
        )}
      </div>
      {data && (offset > 0 || data.hasMore) && (
        <nav className="spread mt16" aria-label="Publishing log pages">
          <span className="small muted">Showing {data.logs.length ? `${offset + 1}–${offset + data.logs.length}` : "none"}</span>
          <div className="row">
            <Button variant="secondary" size="sm" icon="chev-l" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Newer
            </Button>
            <Button variant="secondary" size="sm" icon="chev-r" disabled={!data.hasMore || loading} onClick={() => setOffset(offset + PAGE)}>
              Older
            </Button>
          </div>
        </nav>
      )}
    </>
  );
}

// Readable names for audit actions; anything not listed is shown as a tidied-up code.
const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Sign-in failed",
  "auth.password_changed": "Changed their password",
  "user.created": "Added a user",
  "user.updated": "Changed a user",
  "settings.brand_updated": "Changed brand guidelines",
  "settings.consent_updated": "Changed the consent text",
  "settings.meta_connected": "Connected the Facebook Page",
  "settings.retention_updated": "Changed data retention",
  "retention.run_manually": "Ran data clean-up",
  "analytics.synced": "Synced Facebook analytics",
  "post.created": "Created a post",
  "post.updated": "Edited a post",
  "post.deleted": "Deleted a post",
  "post.submitted": "Sent a post for approval",
  "post.approved": "Approved a post",
  "post.changes_requested": "Asked for changes to a post",
  "post.scheduled": "Scheduled a post",
  "post.unscheduled": "Unscheduled a post",
  "post.cancelled": "Cancelled a post",
  "post.publish_now": "Published a post now",
  "post.retry": "Retried publishing a post",
  "campaign.created": "Created a campaign",
  "campaign.updated": "Changed a campaign",
  "template.created": "Created a response template",
  "template.updated": "Edited a response template",
  "template.approved": "Approved a response template",
  "template.retired": "Retired a response template",
  "lead.created": "Added an inquiry",
  "lead.updated": "Updated an inquiry",
  "lead.reply": "Replied to an inquiry",
  "lead.reply_queued": "Queued a reply for review",
  "lead.reply_approved": "Approved a reply",
  "lead.contact_revealed": "Revealed contact details",
  "lead.exported": "Exported inquiries",
  "lead.anonymized": "Anonymised an inquiry",
  "trends.refreshed": "Scanned for trends",
  "trends.live_settings": "Changed live trend settings",
  "trends.source_added": "Added a trend source",
  "trends.source_updated": "Changed a trend source",
  "trends.source_removed": "Removed a trend source",
  "report.exported": "Exported a report",
  "bots.batch_created": "Created posts with an AI bot",
  "bots.batch_deleted": "Deleted an AI bot batch",
  "bots.handoff": "Handed AI bot posts to review",
  "bots.rules_updated": "Changed the AI bots' rules",
  "bots.style_trained": "Taught an AI bot a style",
  "bots.style_forgotten": "Cleared an AI bot's style",
};

function tidy(code: string) {
  const t = code.replace(/[._]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
const actionLabel = (a: string) => ACTION_LABELS[a] ?? tidy(a);
const keyLabel = (k: string) => tidy(k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());

function metaValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(metaValue).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function MetaList({ meta }: { meta: Record<string, unknown> | null }) {
  const rows = Object.entries(meta ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!rows.length) return null;
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{keyLabel(k)}</dt>
          <dd>{metaValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

const AREAS = [
  { value: "", label: "All areas" },
  { value: "auth", label: "Sign-ins" },
  { value: "user", label: "Users" },
  { value: "settings", label: "Settings" },
  { value: "post", label: "Posts" },
  { value: "campaign", label: "Campaigns" },
  { value: "bots", label: "AI bots" },
  { value: "trends", label: "Trends" },
  { value: "analytics", label: "Analytics" },
  { value: "report", label: "Reports" },
  { value: "lead", label: "Inquiries" },
  { value: "template", label: "Response templates" },
  { value: "retention", label: "Data clean-up" },
];

const PAGE = 100;

interface AuditRow {
  id: number;
  user_name: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  meta: Record<string, unknown>;
  ip: string | null;
  created_at: string;
}

export function AuditLogPage() {
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const filtered = !!(action || from || to);
  const rangeBad = !!(from && to && from > to);
  const { data, error, loading, reload } = useLoad(
    () => api<{ logs: AuditRow[]; hasMore?: boolean }>("/logs/audit", { query: { action, from, to: rangeBad ? "" : to, limit: PAGE, offset } }),
    [action, from, to, offset, rangeBad],
  );
  const clear = () => {
    setAction("");
    setFrom("");
    setTo("");
    setOffset(0);
  };
  return (
    <>
      <PageHead title="Audit log" sub="Who did what, including every time someone revealed, exported or anonymised an inquiry's contact details. Dates are Philippine time." />
      <div className="row" style={{ alignItems: "flex-start", marginBottom: 16 }}>
        <div style={{ minWidth: 200 }}>
          <SelectField
            label="Area"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setOffset(0);
            }}
            options={AREAS}
          />
        </div>
        <TextField
          label="From"
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => {
            setFrom(e.target.value);
            setOffset(0);
          }}
        />
        <TextField
          label="To"
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => {
            setTo(e.target.value);
            setOffset(0);
          }}
          error={rangeBad ? "This is before the From date." : undefined}
        />
        {filtered && (
          <div style={{ paddingTop: 26 }}>
            <Button variant="quiet" onClick={clear}>
              Clear filters
            </Button>
          </div>
        )}
      </div>
      {error && <LoadError error={error} retry={reload} />}
      <div className="table-wrap">
        {loading && !data ? (
          <div style={{ padding: 18 }}>
            <Skeleton />
          </div>
        ) : data?.logs.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Record</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((l) => (
                  <tr key={l.id}>
                    <td className="nowrap">{fmtDate(l.created_at, true)}</td>
                    <td>{l.user_name ?? <span className="muted">System</span>}</td>
                    <td>
                      <span title={l.action}>{actionLabel(l.action)}</span>
                    </td>
                    <td className="nowrap">
                      {l.entity === "lead" && l.entity_id ? (
                        <Link to={`/leads/${l.entity_id}`}>INQ-{l.entity_id.padStart(6, "0")}</Link>
                      ) : l.entity === "post" && l.entity_id ? (
                        <Link to={`/posts/${l.entity_id}`}>Post {l.entity_id}</Link>
                      ) : l.entity === "campaign" && l.entity_id ? (
                        <Link to={`/campaigns/${l.entity_id}`}>Campaign {l.entity_id}</Link>
                      ) : l.entity ? (
                        `${tidy(l.entity)} ${l.entity_id ?? ""}`
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small" style={{ minWidth: 180 }}>
                      <MetaList meta={l.meta} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : filtered ? (
          <Empty
            title="Nothing matches these filters"
            action={
              <Button variant="quiet" size="sm" onClick={clear}>
                Clear filters
              </Button>
            }
          >
            Try another area or a wider date range.
          </Empty>
        ) : offset ? (
          <Empty title="No more entries" />
        ) : (
          <Empty title="Nothing logged yet">Sign-ins, changes and data access are recorded here as people use the app.</Empty>
        )}
      </div>
      {data && (offset > 0 || data.hasMore) && (
        <nav className="spread mt16" aria-label="Audit log pages">
          <span className="small muted">
            Showing {data.logs.length ? `${offset + 1}–${offset + data.logs.length}` : "none"}
          </span>
          <div className="row">
            <Button variant="secondary" size="sm" icon="chev-l" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Newer
            </Button>
            <Button variant="secondary" size="sm" icon="chev-r" disabled={!data.hasMore || loading} onClick={() => setOffset(offset + PAGE)}>
              Older
            </Button>
          </div>
        </nav>
      )}
    </>
  );
}
