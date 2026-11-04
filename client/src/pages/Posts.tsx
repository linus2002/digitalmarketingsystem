import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, fmtDate, POST_STATUS } from "../lib/format";
import { Empty, LinkButton, LoadError, PageHead, SearchInput, Skeleton, StatusTag, Tabs, Tag } from "../components/ui";

interface PostRow {
  id: number;
  title: string;
  message: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  updated_at: string;
  campaign_name: string | null;
  created_by_name: string | null;
  ai_generated: boolean;
  last_error: string | null;
  attempts: number;
}

const VIEWS = {
  all: { label: "All", statuses: "" },
  drafts: { label: "Drafts", statuses: "draft,changes_requested" },
  review: { label: "In review", statuses: "in_review" },
  ready: { label: "Approved", statuses: "approved" },
  scheduled: { label: "Scheduled", statuses: "scheduled,publishing" },
  published: { label: "Published", statuses: "published" },
  failed: { label: "Failed", statuses: "failed" },
} as const;
type View = keyof typeof VIEWS;

export function PostsPage() {
  const { can } = useAuth();
  // Open on "All" so posts are never hidden behind an empty tab; the tab counts show what's waiting
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const counts = useLoad(() => api<{ counts: Record<string, number> }>("/posts/counts"), []);
  const { data, error, loading, reload } = useLoad(() => api<{ posts: PostRow[] }>("/posts", { query: { status: VIEWS[view].statuses, q } }), [view, q]);

  const c = counts.data?.counts ?? {};
  const n = (statuses: string) => (statuses ? statuses.split(",").reduce((s, k) => s + (c[k] ?? 0), 0) : Object.values(c).reduce((s, v) => s + v, 0));

  return (
    <>
      <PageHead
        title="Posts and approvals"
        sub="Every post goes draft → review → approved → scheduled. Editing an approved post sends it back for approval."
        actions={
          can("posts.edit") && (
            <LinkButton to="/posts/new" variant="primary" icon="plus">
              New post
            </LinkButton>
          )
        }
      />
      <Tabs value={view} onChange={setView} tabs={(Object.keys(VIEWS) as View[]).map((v) => ({ value: v, label: VIEWS[v].label, n: n(VIEWS[v].statuses) }))} />
      <div className="table-wrap mt16">
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search posts" />
        </div>
        {error && (
          <div style={{ padding: 16 }}>
            <LoadError error={error} retry={reload} />
          </div>
        )}
        {loading && !data ? (
          <div style={{ padding: 18 }}>
            <Skeleton />
          </div>
        ) : data?.posts.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>Author</th>
                </tr>
              </thead>
              <tbody>
                {data.posts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link className="name" to={`/posts/${p.id}`}>
                        {p.title}
                      </Link>
                      <span className="sub clamp">{p.message}</span>
                    </td>
                    <td>{p.campaign_name ? <Tag tone="outline">{p.campaign_name}</Tag> : <span className="muted">—</span>}</td>
                    <td>
                      <StatusTag map={POST_STATUS} value={p.status} />
                      {p.status === "failed" && <div className="sub" style={{ color: "var(--bad)", maxWidth: 240 }}>{p.last_error}</div>}
                      {p.status === "scheduled" && p.attempts > 0 && <div className="sub">Retry {p.attempts} pending</div>}
                    </td>
                    <td className="nowrap">
                      {p.published_at ? fmtDate(p.published_at, true) : p.scheduled_at ? fmtDate(p.scheduled_at, true) : <span className="muted">Not scheduled</span>}
                      <div className="sub">Edited {ago(p.updated_at)}</div>
                    </td>
                    <td className="nowrap">
                      {p.created_by_name ?? "—"}
                      {p.ai_generated && <div className="sub">AI draft</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No posts here" action={can("posts.edit") ? <LinkButton to="/posts/new" variant="primary" size="sm" icon="plus">New post</LinkButton> : undefined}>
            {view === "review" ? "Nothing is waiting for approval." : "Posts you create or save from the AI studio appear here."}
          </Empty>
        )}
      </div>
    </>
  );
}
