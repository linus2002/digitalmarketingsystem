import { Link } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, fmtCompact, fmtDate, POST_STATUS } from "../lib/format";
import { Icon } from "../components/Icons";
import { Empty, GlowCard, LinkButton, LoadError, PageHead, Skeleton, StatusTag, Tag } from "../components/ui";

interface Dash {
  posts?: { scheduled_week: number; published_month: number; in_review: number; failed: number; my_drafts: number };
  upcoming?: { id: number; title: string; scheduled_at: string; status: string }[];
  attentionPosts?: { id: number; title: string; status: string; last_error: string | null; updated_at: string }[];
  engagement?: { reach: number; engagement: number; posts: number };
  trends?: { at: string; topics: { rank: number; label: string; category: string; mentions: number }[] } | null;
  leads?: { open: number; needs_review: number; overdue: number; new: number };
  attentionLeads?: { id: number; medicine_name: string | null; destination_country: string | null; category: string; needs_review: boolean; follow_up_at: string | null }[];
}

export function HomePage() {
  const { user, can } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api<Dash>("/dashboard"), []);
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const attention = [
    ...(data?.attentionPosts ?? []).map((p) => ({
      key: `p${p.id}`,
      to: `/posts/${p.id}`,
      icon: p.status === "failed" ? ("alert" as const) : ("doc" as const),
      title: p.status === "failed" ? `Post didn't publish: ${p.title}` : p.status === "in_review" ? `Waiting on your approval: ${p.title}` : `Changes asked on ${p.title}`,
      meta: p.status === "failed" ? p.last_error ?? "Publishing failed" : `Updated ${ago(p.updated_at)}`,
    })),
    ...(data?.attentionLeads ?? []).map((l) => ({
      key: `l${l.id}`,
      to: `/leads/${l.id}`,
      icon: l.needs_review ? ("shield" as const) : ("clock" as const),
      title: `${l.needs_review ? "Needs pharmaceutical review" : "Follow-up due"}: ${l.medicine_name ?? "inquiry"}`,
      meta: `INQ-${String(l.id).padStart(6, "0")} · ${l.destination_country ?? "country not given"}${l.follow_up_at ? ` · due ${ago(l.follow_up_at)}` : ""}`,
    })),
  ];

  return (
    <>
      <PageHead
        title={`${greet}, ${user?.name.split(" ")[0]}`}
        sub="What's planned, what's waiting on you and how the Page is doing."
        actions={
          <>
            {can("content.generate") && (
              <LinkButton to="/studio" icon="spark">
                Write with AI
              </LinkButton>
            )}
            {can("posts.edit") && (
              <LinkButton to="/posts/new" variant="primary" icon="plus">
                New post
              </LinkButton>
            )}
          </>
        }
      />
      {error && <LoadError error={error} retry={reload} />}
      {loading && !data ? (
        <Skeleton rows={4} />
      ) : (
        data && (
          <>
            <div className="grid g4">
              {data.posts && (
                <>
                  <GlowCard
                    tone="blue"
                    icon="cal"
                    title="Scheduled"
                    sub="Next 7 days"
                    value={data.posts.scheduled_week}
                    to="/calendar"
                    note={data.posts.in_review ? `${data.posts.in_review} more waiting for approval` : "Nothing waiting for approval"}
                  />
                  <GlowCard
                    tone="green"
                    icon="check"
                    title="Published"
                    sub="This month"
                    value={data.posts.published_month}
                    to="/posts"
                    note={data.posts.failed ? <span style={{ color: "var(--bad)" }}>{data.posts.failed} failed to publish</span> : "No failed posts"}
                  />
                </>
              )}
              {data.engagement && (
                <GlowCard
                  tone="yellow"
                  icon="trend"
                  title="Reach"
                  sub="Last 28 days"
                  value={fmtCompact(data.engagement.reach)}
                  to="/analytics"
                  note={`${fmtCompact(data.engagement.engagement)} reactions, comments and shares`}
                />
              )}
              {data.leads && (
                <GlowCard
                  tone="red"
                  icon="inbox"
                  title="Open inquiries"
                  sub={`${data.leads.new} new`}
                  value={data.leads.open}
                  to="/leads"
                  tag={
                    data.leads.needs_review ? (
                      <Tag tone="warn" dot>
                        {data.leads.needs_review} need review
                      </Tag>
                    ) : (
                      <Tag tone="good" dot>
                        No reviews waiting
                      </Tag>
                    )
                  }
                  note={data.leads.overdue ? <span style={{ color: "var(--bad)" }}>{data.leads.overdue} follow-ups overdue</span> : undefined}
                />
              )}
            </div>

            <div className="grid g3 mt24">
              <div className="panel attention">
                <div className="spread">
                  <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Needs your attention</h3>
                  <Tag tone="outline">{attention.length}</Tag>
                </div>
                {attention.length ? (
                  <ul>
                    {attention.map((a) => (
                      <li key={a.key}>
                        <span className="ico">
                          <Icon name={a.icon} />
                        </span>
                        <Link to={a.to}>
                          <b>{a.title}</b>
                          <div className="meta">{a.meta}</div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="note">You're all caught up.</p>
                )}
              </div>

              {data.upcoming && (
                <div className="card soft">
                  <div className="spread">
                    <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Coming up</h3>
                    <Link to="/calendar" className="small">
                      Calendar
                    </Link>
                  </div>
                  {data.upcoming.length ? (
                    <ol className="timeline">
                      {data.upcoming.map((p) => (
                        <li key={p.id}>
                          <span className="ico">
                            <Icon name="cal" />
                          </span>
                          <div>
                            <Link to={`/posts/${p.id}`} style={{ color: "inherit" }}>
                              <b>{p.title}</b>
                            </Link>
                            <div className="meta">
                              <StatusTag map={POST_STATUS} value={p.status} />
                            </div>
                          </div>
                          <time>{fmtDate(p.scheduled_at, true)}</time>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <Empty title="Nothing scheduled" action={can("posts.edit") ? <LinkButton to="/posts/new" size="sm" variant="primary" icon="plus">Plan a post</LinkButton> : undefined}>
                      Approved posts you schedule appear here.
                    </Empty>
                  )}
                </div>
              )}

              {data.trends !== undefined && (
                <div className="card soft">
                  <div className="spread">
                    <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Trending now</h3>
                    <Link to="/trends" className="small">
                      All topics
                    </Link>
                  </div>
                  {data.trends?.topics.length ? (
                    <>
                      <ul className="trend-items" style={{ marginTop: 14 }}>
                        {data.trends.topics.map((t) => (
                          <li key={t.rank} className="row" style={{ gap: 10 }}>
                            <span className="code">{t.rank}</span>
                            <span className="grow">{t.label}</span>
                            <Tag tone="outline">{t.category}</Tag>
                          </li>
                        ))}
                      </ul>
                      <p className="note">Updated {ago(data.trends.at)}</p>
                    </>
                  ) : (
                    <Empty title="No trends yet" action={<LinkButton to="/trends" size="sm">Find trends</LinkButton>}>
                      Scan the health news feeds to see what's being talked about.
                    </Empty>
                  )}
                </div>
              )}
            </div>
          </>
        )
      )}
    </>
  );
}
