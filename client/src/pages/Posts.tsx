import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, BUSINESS_TZ_LABEL, fmtBiz, POST_STATUS } from "../lib/format";
import { Button, Empty, LinkButton, LoadError, PageHead, SearchInput, Skeleton, StatusTag, Tabs, Tag } from "../components/ui";
import "../styles/posts.css";

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
  cancelled: { label: "Cancelled", statuses: "cancelled" },
} as const;
type View = keyof typeof VIEWS;
const VIEW_KEYS = Object.keys(VIEWS) as View[];

/**
 * `?status=` accepts a tab name (drafts, review, …) or post statuses (failed, in_review, "draft,changes_requested").
 * Returns the tab to highlight and the statuses to load.
 */
function resolveFilter(raw: string | null): { view: View | null; statuses: string } {
  const v = (raw ?? "").trim();
  if (!v || v === "all") return { view: "all", statuses: "" };
  if (VIEW_KEYS.includes(v as View)) return { view: v as View, statuses: VIEWS[v as View].statuses };
  const list = v.split(",").map((s) => s.trim()).filter((s) => s in POST_STATUS);
  if (!list.length) return { view: "all", statuses: "" };
  const norm = [...list].sort().join(",");
  const match = VIEW_KEYS.find((k) => VIEWS[k].statuses && VIEWS[k].statuses.split(",").sort().join(",") === norm);
  if (match) return { view: match, statuses: VIEWS[match].statuses };
  // A single status that belongs to one tab (e.g. "draft" or "publishing"): show that tab but only that status.
  const owner = list.length === 1 ? VIEW_KEYS.find((k) => VIEWS[k].statuses.split(",").includes(list[0])) : undefined;
  return { view: owner ?? null, statuses: list.join(",") };
}

export function PostsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const filter = resolveFilter(params.get("status"));
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);

  // Keep the box in sync with back/forward
  useEffect(() => setSearch(q), [q]);

  // Debounce typing: update the URL (and so the query) 300 ms after the last key.
  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => {
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          if (search.trim()) n.set("q", search);
          else n.delete("q");
          return n;
        },
        { replace: true },
      );
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const setView = (v: View) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (v === "all") n.delete("status");
      else n.set("status", v);
      return n;
    });

  const counts = useLoad(() => api<{ counts: Record<string, number> }>("/posts/counts"), []);
  const filterKey = `${filter.statuses}|${q}`;
  const { data, error, loading, reload } = useLoad(
    () => api<{ posts: PostRow[] }>("/posts", { query: { status: filter.statuses, q } }).then((r) => ({ key: filterKey, posts: r.posts })),
    [filterKey],
  );
  // Rows from a different tab are never shown while the new tab loads; a new search on the same tab just dims them.
  const sameTab = data?.key.split("|")[0] === filter.statuses;
  const rows = data && sameTab ? data.posts : null;

  const c = counts.data?.counts ?? {};
  const n = (statuses: string) => (statuses ? statuses.split(",").reduce((s, k) => s + (c[k] ?? 0), 0) : Object.values(c).reduce((s, v) => s + v, 0));
  const linkState = { from: { to: `/posts${params.toString() ? `?${params.toString()}` : ""}`, label: "Posts" } };
  const customLabel = !filter.view || filter.statuses !== VIEWS[filter.view].statuses ? filter.statuses.split(",").map((s) => POST_STATUS[s]?.label ?? s).join(", ") : null;

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
      <Tabs value={(filter.view ?? "") as View} onChange={setView} tabs={VIEW_KEYS.map((v) => ({ value: v, label: VIEWS[v].label, n: n(VIEWS[v].statuses) }))} />
      <div className="table-wrap mt16">
        <div className="toolbar">
          <SearchInput value={search} onChange={setSearch} placeholder="Search posts" />
          {customLabel && (
            <span className="row" style={{ gap: 6 }}>
              <Tag tone="outline">Showing: {customLabel}</Tag>
              <Button size="sm" variant="quiet" onClick={() => setView("all")}>
                Show all
              </Button>
            </span>
          )}
        </div>
        {error && (
          <div style={{ padding: 16 }}>
            <LoadError error={error} retry={reload} />
          </div>
        )}
        {!rows ? (
          loading || !error ? (
            <div style={{ padding: 18 }}>
              <Skeleton />
            </div>
          ) : null
        ) : rows.length ? (
          <div className={`table-scroll ${loading ? "posts-loading" : ""}`} aria-busy={loading || undefined}>
            <table>
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>When ({BUSINESS_TZ_LABEL})</th>
                  <th>Author</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link className="name" to={`/posts/${p.id}`} state={linkState}>
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
                      {p.published_at ? fmtBiz(p.published_at) : p.scheduled_at ? fmtBiz(p.scheduled_at) : <span className="muted">Not scheduled</span>}
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
          <Empty title={q ? "No posts match your search" : "No posts here"} action={can("posts.edit") && !q ? <LinkButton to="/posts/new" variant="primary" size="sm" icon="plus">New post</LinkButton> : undefined}>
            {q ? "Try other words, or look in another tab." : filter.view === "review" ? "Nothing is waiting for approval." : filter.view === "failed" ? "Nothing has failed to publish." : "Posts you create or save from the AI studio appear here."}
          </Empty>
        )}
      </div>
    </>
  );
}
