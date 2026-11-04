import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Empty, LoadError, PageHead, Seg, Skeleton, Tag } from "../components/ui";

const LOG_TONE: Record<string, { label: string; tone: "good" | "warn" | "bad" | "info" }> = {
  success: { label: "Published", tone: "good" },
  dry_run: { label: "Dry run", tone: "info" },
  retry_scheduled: { label: "Will retry", tone: "warn" },
  error: { label: "Failed", tone: "bad" },
};

export function PublishLogPage() {
  const [status, setStatus] = useState<"" | "error" | "retry_scheduled" | "success,dry_run">("");
  const { data, error, loading, reload } = useLoad(
    () => api<{ logs: { id: number; post_id: number | null; post_title: string | null; attempt: number; status: string; message: string; created_at: string }[] }>("/logs/publishing", { query: { status } }),
    [status],
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
        ) : (
          <Empty title="Nothing logged yet">Attempts appear here once scheduled posts start going out.</Empty>
        )}
      </div>
    </>
  );
}

export function AuditLogPage() {
  const [action, setAction] = useState<"" | "lead" | "post" | "auth" | "settings" | "user">("");
  const { data, error, loading, reload } = useLoad(
    () => api<{ logs: { id: number; user_name: string | null; action: string; entity: string | null; entity_id: string | null; meta: Record<string, unknown>; ip: string | null; created_at: string }[] }>("/logs/audit", { query: { action } }),
    [action],
  );
  return (
    <>
      <PageHead
        title="Audit log"
        sub="Who did what, including every time someone revealed, exported or anonymised an inquiry's contact details."
        actions={
          <Seg
            label="Area"
            value={action}
            onChange={setAction}
            options={[
              { value: "", label: "All" },
              { value: "lead", label: "Inquiries" },
              { value: "post", label: "Posts" },
              { value: "auth", label: "Sign-ins" },
              { value: "settings", label: "Settings" },
              { value: "user", label: "Users" },
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
                      <span className="code">{l.action}</span>
                    </td>
                    <td className="nowrap">
                      {l.entity === "lead" && l.entity_id ? (
                        <Link to={`/leads/${l.entity_id}`}>INQ-{l.entity_id.padStart(6, "0")}</Link>
                      ) : l.entity === "post" && l.entity_id ? (
                        <Link to={`/posts/${l.entity_id}`}>Post {l.entity_id}</Link>
                      ) : (
                        `${l.entity ?? ""} ${l.entity_id ?? ""}`
                      )}
                    </td>
                    <td className="small muted">{Object.keys(l.meta ?? {}).length ? JSON.stringify(l.meta) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Nothing logged yet" />
        )}
      </div>
    </>
  );
}
