import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, fmtDate, fmtNum, fromLocalInput, POST_STATUS, toLocalInput } from "../lib/format";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icons";
import { Alert, Avatar, Button, ConfirmModal, LoadError, Modal, PageHead, SelectField, Skeleton, StatusTag, Steps, Tag, TextArea, TextField } from "../components/ui";

interface Post {
  id: number;
  title: string;
  message: string;
  hashtags: string[];
  image_url: string | null;
  image_prompt: string | null;
  link_url: string | null;
  campaign_id: number | null;
  campaign_name: string | null;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  next_attempt_at: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  fb_post_id: string | null;
  ai_generated: boolean;
  source_topic: string | null;
  created_by: number;
  created_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
}
interface Detail {
  post: Post;
  reviews: { id: number; decision: string; comment: string | null; user_name: string | null; created_at: string }[];
  logs: { id: number; attempt: number; status: string; message: string; created_at: string }[];
  stats: { reach: number | null; impressions: number | null; reactions: number; comments: number; shares: number; clicks: number | null; permalink_url: string | null; updated_at: string } | null;
  preview: string;
}

const EDITABLE = ["draft", "changes_requested", "in_review", "approved", "scheduled", "failed"];
const DECISION: Record<string, string> = {
  submitted: "Sent for review",
  approved: "Approved",
  changes_requested: "Asked for changes",
  comment: "Comment",
  scheduled: "Scheduled",
  unscheduled: "Unscheduled",
  cancelled: "Cancelled",
};

function stepIndex(status: string) {
  return { draft: 0, changes_requested: 0, in_review: 1, approved: 2, scheduled: 3, publishing: 3, failed: 3, published: 5, cancelled: 0 }[status] ?? 0;
}

export function PostEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { user, can } = useAuth();
  const toast = useToast();
  const detail = useLoad(() => (isNew ? Promise.resolve(null) : api<Detail>(`/posts/${id}`)), [id]);
  const campaigns = useLoad(() => api<{ campaigns: { id: number; name: string; status: string }[] }>("/campaigns"), []);

  const [form, setForm] = useState({ title: "", message: "", hashtags: "", image_url: "", image_prompt: "", link_url: "", campaign_id: "", planned: "" });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<{ issues: string[]; hasDisclaimer: boolean; disclaimer: string } | null>(null);
  const [schedAt, setSchedAt] = useState("");
  const [changesOpen, setChangesOpen] = useState(false);
  const [changesText, setChangesText] = useState("");
  const [comment, setComment] = useState("");
  const [confirm, setConfirm] = useState<null | "delete" | "publish">(null);

  const post = detail.data?.post;

  useEffect(() => {
    if (post) {
      setForm({
        title: post.title,
        message: post.message,
        hashtags: post.hashtags.join(" "),
        image_url: post.image_url ?? "",
        image_prompt: post.image_prompt ?? "",
        link_url: post.link_url ?? "",
        campaign_id: post.campaign_id ? String(post.campaign_id) : "",
        planned: toLocalInput(post.scheduled_at),
      });
      setSchedAt(toLocalInput(post.scheduled_at ?? new Date(Date.now() + 3600_000)));
      setDirty(false);
    } else if (isNew) {
      const d = params.get("date");
      setForm((f) => ({ ...f, planned: d ? `${d}T09:00` : "", campaign_id: params.get("campaign") ?? "" }));
      setSchedAt(toLocalInput(new Date(Date.now() + 3600_000)));
    }
  }, [post, isNew, params]);

  // Live brand-rule check while typing
  useEffect(() => {
    const t = setTimeout(() => {
      if (!form.message.trim()) return setCheck(null);
      api<{ issues: string[]; hasDisclaimer: boolean; disclaimer: string }>("/studio/check", { body: { text: `${form.title}\n${form.message}` } })
        .then(setCheck)
        .catch(() => undefined);
    }, 600);
    return () => clearTimeout(t);
  }, [form.title, form.message]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setDirty(true);
  };

  const payload = () => ({
    title: form.title.trim(),
    message: form.message,
    hashtags: form.hashtags.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean).map((h) => (h.startsWith("#") ? h : `#${h}`)),
    image_url: form.image_url.trim() || null,
    image_prompt: form.image_prompt.trim() || null,
    link_url: form.link_url.trim() || null,
    campaign_id: form.campaign_id ? Number(form.campaign_id) : null,
    ...(post?.status !== "scheduled" ? { scheduled_at: fromLocalInput(form.planned) } : {}),
  });

  async function run(label: string, fn: () => Promise<unknown>, okMsg?: string) {
    setBusy(label);
    try {
      await fn();
      if (okMsg) toast.ok(okMsg);
      await detail.reload();
      setDirty(false);
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (isNew) {
      setBusy("save");
      try {
        const r = await api<{ post: { id: number } }>("/posts", { body: payload() });
        toast.ok("Draft saved");
        nav(`/posts/${r.post.id}`, { replace: true });
      } catch (e) {
        toast.err("Couldn't save", (e as Error).message);
      } finally {
        setBusy(null);
      }
      return;
    }
    await run("save", async () => {
      const r = await api<{ resetApproval: boolean }>(`/posts/${id}`, { method: "PATCH", body: payload() });
      if (r.resetApproval) toast.ok("Saved. It needs approval again", "Because the content changed after review.");
      else toast.ok("Saved");
    });
  }

  async function saveThen(action: string, body?: unknown, okMsg?: string) {
    await run(action, async () => {
      if (dirty) await api(`/posts/${id}`, { method: "PATCH", body: payload() });
      await api(`/posts/${id}/${action}`, { body: body ?? {} });
    }, okMsg);
  }

  if (!isNew && detail.loading && !detail.data) return <Skeleton rows={5} />;
  if (detail.error) return <LoadError error={detail.error} retry={detail.reload} />;

  const status = post?.status ?? "draft";
  const editable = can("posts.edit") && (isNew || EDITABLE.includes(status));
  const isAuthor = post?.created_by === user?.id;
  const canApproveThis = can("posts.approve") && (!isAuthor || user?.role === "admin");
  const valid = form.title.trim() && form.message.trim();
  const preview = `${form.message.trim()}${payload().hashtags.filter((h) => !form.message.includes(h)).length ? `\n\n${payload().hashtags.filter((h) => !form.message.includes(h)).join(" ")}` : ""}`;

  return (
    <>
      <PageHead
        crumbs={[{ to: "/posts", label: "Posts" }, { label: isNew ? "New post" : post?.title ?? "" }]}
        title={isNew ? "New post" : post?.title}
        sub={
          post ? (
            <span className="row" style={{ gap: 8 }}>
              <StatusTag map={POST_STATUS} value={status} />
              {post.ai_generated && <Tag tone="info">AI draft</Tag>}
              {post.campaign_name && <Tag tone="outline">{post.campaign_name}</Tag>}
              <span className="small muted">by {post.created_by_name}</span>
            </span>
          ) : (
            "Write the post, then send it for approval."
          )
        }
        actions={
          editable && (
            <Button variant={dirty || isNew ? "primary" : "secondary"} loading={busy === "save"} disabled={!valid || (!dirty && !isNew)} onClick={save}>
              {isNew ? "Save draft" : "Save changes"}
            </Button>
          )
        }
      />

      <div className="grid g-side">
        <div className="stackv" style={{ gap: 20 }}>
          {post && ["approved", "scheduled"].includes(status) && dirty && (
            <Alert tone="warn" title="Saving will send this post back for approval">
              It was approved as it was. Any change to the text, hashtags, image or link needs approval again.
            </Alert>
          )}
          <div className="board stackv" style={{ gap: 16 }}>
            <TextField label="Internal title" value={form.title} onChange={set("title")} disabled={!editable} placeholder="Only your team sees this" maxLength={200} />
            <TextArea
              label="Post text"
              value={form.message}
              onChange={set("message")}
              disabled={!editable}
              rows={8}
              hint={`${form.message.length} characters`}
              placeholder="What do you want to say?"
            />
            <TextField label="Hashtags" optional value={form.hashtags} onChange={set("hashtags")} disabled={!editable} placeholder="#CancerAwareness #GetMeds" hint="Separate with spaces. They're added at the end unless already in the text." />
            {check && (check.issues.length > 0 || !check.hasDisclaimer) && (
              <Alert tone="warn" title="Brand and compliance check">
                {check.issues.join(" ")}
                {!check.hasDisclaimer && (
                  <>
                    {" "}
                    The brand disclaimer is missing: “{check.disclaimer}”{" "}
                    {editable && (
                      <button
                        className="btn btn-quiet btn-sm"
                        onClick={() => {
                          setForm((f) => ({ ...f, message: `${f.message.trim()}\n\n${check.disclaimer}` }));
                          setDirty(true);
                        }}
                      >
                        Add it
                      </button>
                    )}
                  </>
                )}
              </Alert>
            )}
            {check && !check.issues.length && check.hasDisclaimer && (
              <Alert tone="good" title="Passes the brand check">
                No banned phrases, dosing or pressure wording found.
              </Alert>
            )}
            <div className="grid g2">
              <TextField label="Image URL" optional value={form.image_url} onChange={set("image_url")} disabled={!editable} placeholder="https://… (public image link)" hint="Posts with an image are published as a photo post." />
              <TextField label="Link" optional value={form.link_url} onChange={set("link_url")} disabled={!editable} placeholder="https://…" />
            </div>
            <TextArea label="Image prompt" optional value={form.image_prompt} onChange={set("image_prompt")} disabled={!editable} rows={2} hint="Kept for the designer; not published." />
            <div className="grid g2">
              <SelectField
                label="Campaign"
                optional
                value={form.campaign_id}
                onChange={set("campaign_id")}
                disabled={!editable}
                options={[{ value: "", label: "None" }, ...(campaigns.data?.campaigns ?? []).map((c) => ({ value: c.id, label: c.name }))]}
              />
              {status !== "scheduled" && (
                <TextField label="Planned date" optional type="datetime-local" value={form.planned} onChange={set("planned")} disabled={!editable} hint="Places it on the calendar. Publishing needs approval and scheduling." />
              )}
            </div>
          </div>

          <div>
            <p className="label">Facebook preview</p>
            <div className="card soft" style={{ maxWidth: 520 }}>
              <div className="row" style={{ gap: 10 }}>
                <Avatar name="Get Meds" size="sm" />
                <div>
                  <b style={{ fontSize: 13.5 }}>Your Page</b>
                  <div className="sub">{post?.scheduled_at ? fmtDate(post.scheduled_at, true) : "Not scheduled"} · 🌐</div>
                </div>
              </div>
              <p className="pre" style={{ margin: "12px 0", fontSize: 14 }}>
                {preview || <span className="muted">Your text appears here.</span>}
              </p>
              {form.image_url && <img src={form.image_url} alt="" style={{ width: "100%", borderRadius: 12, border: "1px solid var(--rule)" }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />}
              {form.link_url && !form.image_url && (
                <div className="code" style={{ display: "block", padding: 10 }}>
                  {form.link_url}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ---- Workflow side panel ---- */}
        <aside className="stackv first-on-mobile" style={{ gap: 16 }}>
          {post && (
            <div className="board">
              <p className="label">Where it is</p>
              <Steps steps={["Draft", "Review", "Approved", "Scheduled", "Published"]} current={stepIndex(status)} failed={status === "failed"} vertical />
              <div className="stackv mt24">
                {(status === "draft" || status === "changes_requested") && can("posts.edit") && (
                  <>
                    <Button variant="primary" icon="send" loading={busy === "submit"} disabled={!valid} onClick={() => saveThen("submit", {}, "Sent for review")}>
                      Send for review
                    </Button>
                    <Button variant="quiet" icon="trash" onClick={() => setConfirm("delete")}>
                      Delete draft
                    </Button>
                  </>
                )}
                {status === "in_review" &&
                  (canApproveThis ? (
                    <>
                      <TextField label="Publish at" type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} />
                      {can("posts.schedule") && (
                        <Button variant="primary" loading={busy === "approve"} disabled={dirty} onClick={() => run("approve", () => api(`/posts/${id}/approve`, { body: { scheduleAt: fromLocalInput(schedAt) } }), "Approved and scheduled")}>
                          Approve and schedule
                        </Button>
                      )}
                      <Button variant="secondary" loading={busy === "approve-only"} disabled={dirty} onClick={() => run("approve-only", () => api(`/posts/${id}/approve`, { body: {} }), "Approved")}>
                        Approve only
                      </Button>
                      <Button variant="quiet" onClick={() => setChangesOpen(true)}>
                        Ask for changes
                      </Button>
                      {dirty && <p className="note mt0">Save your edits first: they'll need another review.</p>}
                    </>
                  ) : (
                    <Alert tone="info" title="Waiting for approval">
                      {isAuthor ? "A marketing manager will review it. You'll see their comments here." : "Only marketing managers can approve posts."}
                    </Alert>
                  ))}
                {status === "approved" && can("posts.schedule") && (
                  <>
                    <TextField label="Publish at" type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} />
                    <Button variant="primary" icon="cal" loading={busy === "schedule"} onClick={() => run("schedule", () => api(`/posts/${id}/schedule`, { body: { scheduledAt: fromLocalInput(schedAt) } }), "Scheduled")}>
                      Schedule
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirm("publish")}>
                      Publish now
                    </Button>
                  </>
                )}
                {status === "scheduled" && post.scheduled_at && (
                  <>
                    <Alert tone="info" title={`Publishes ${fmtDate(post.scheduled_at, true)}`}>
                      {post.attempts > 0
                        ? `Attempt ${post.attempts} of ${post.max_attempts} failed: ${post.last_error}. Next try ${ago(post.next_attempt_at)}.`
                        : `That's ${ago(post.scheduled_at)}. Approved by ${post.approved_by_name}.`}
                    </Alert>
                    {can("posts.schedule") && (
                      <>
                        <Button variant="secondary" onClick={() => setConfirm("publish")}>
                          Publish now
                        </Button>
                        <Button variant="quiet" loading={busy === "unschedule"} onClick={() => run("unschedule", () => api(`/posts/${id}/unschedule`, { body: {} }), "Unscheduled")}>
                          Unschedule
                        </Button>
                      </>
                    )}
                  </>
                )}
                {status === "publishing" && <Alert tone="info" title="Publishing now">Refresh in a moment.</Alert>}
                {status === "failed" && (
                  <>
                    <Alert tone="bad" title={`Didn't publish after ${post.attempts} attempt${post.attempts === 1 ? "" : "s"}`}>
                      {post.last_error}
                    </Alert>
                    {can("posts.schedule") && (
                      <>
                        <Button variant="primary" icon="refresh" loading={busy === "retry"} onClick={() => run("retry", () => api(`/posts/${id}/retry`, { body: {} }), "Retrying now")}>
                          Try again
                        </Button>
                        <Button variant="quiet" loading={busy === "cancel"} onClick={() => run("cancel", () => api(`/posts/${id}/cancel`, { body: {} }), "Cancelled")}>
                          Cancel post
                        </Button>
                      </>
                    )}
                  </>
                )}
                {status === "published" && (
                  <>
                    <Alert tone="good" title={`Published ${fmtDate(post.published_at, true)}`}>
                      {post.fb_post_id?.startsWith("dryrun_") ? "Dry run: this wasn't really sent to Facebook (PUBLISH_DRY_RUN=true)." : `Facebook post ID ${post.fb_post_id}`}
                    </Alert>
                    {detail.data?.stats?.permalink_url && (
                      <a className="btn btn-secondary" href={detail.data.stats.permalink_url} target="_blank" rel="noreferrer">
                        View on Facebook
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {detail.data?.stats && (
            <div className="board">
              <p className="label">Performance</p>
              <div className="facts" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
                <div><small>Reach</small><b>{fmtNum(detail.data.stats.reach)}</b></div>
                <div><small>Reactions</small><b>{fmtNum(detail.data.stats.reactions)}</b></div>
                <div><small>Comments</small><b>{fmtNum(detail.data.stats.comments)}</b></div>
                <div><small>Shares</small><b>{fmtNum(detail.data.stats.shares)}</b></div>
                <div><small>Clicks</small><b>{fmtNum(detail.data.stats.clicks)}</b></div>
                <div><small>Views</small><b>{fmtNum(detail.data.stats.impressions)}</b></div>
              </div>
              <p className="note">Synced {ago(detail.data.stats.updated_at)}</p>
            </div>
          )}

          {post && (
            <div className="board">
              <p className="label">Review history</p>
              <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
                <div className="grow">
                  <TextField label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a note for the team" />
                </div>
                <Button
                  size="sm"
                  disabled={!comment.trim()}
                  loading={busy === "comment"}
                  onClick={() => run("comment", () => api(`/posts/${id}/comment`, { body: { comment } }).then(() => setComment("")))}
                >
                  Add
                </Button>
              </div>
              <ol className="timeline">
                {detail.data?.reviews.map((r) => (
                  <li key={r.id}>
                    <span className="ico">
                      <Icon name={r.decision === "approved" ? "check" : r.decision === "changes_requested" ? "alert" : r.decision === "scheduled" ? "cal" : "msg"} />
                    </span>
                    <div>
                      <b>{DECISION[r.decision] ?? r.decision}</b>
                      <div className="meta">
                        {r.user_name}
                        {r.comment ? ` · ${r.decision === "scheduled" && !isNaN(Date.parse(r.comment)) ? fmtDate(r.comment, true) : r.comment}` : ""}
                      </div>
                    </div>
                    <time>{ago(r.created_at)}</time>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {post && detail.data && detail.data.logs.length > 0 && (
            <div className="board">
              <p className="label">Publishing attempts</p>
              <ol className="timeline">
                {detail.data.logs.map((l) => (
                  <li key={l.id}>
                    <span className="ico">
                      <Icon name={l.status === "success" || l.status === "dry_run" ? "check" : l.status === "retry_scheduled" ? "refresh" : "alert"} />
                    </span>
                    <div>
                      <b>Attempt {l.attempt}</b>
                      <div className="meta">{l.message}</div>
                    </div>
                    <time>{fmtDate(l.created_at, true)}</time>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </div>

      {changesOpen && (
        <Modal
          title="Ask for changes"
          onClose={() => setChangesOpen(false)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setChangesOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={changesText.trim().length < 3}
                loading={busy === "changes"}
                onClick={() => run("changes", () => api(`/posts/${id}/request-changes`, { body: { comment: changesText } }), "Sent back to the author").then(() => setChangesOpen(false))}
              >
                Send back
              </Button>
            </>
          }
        >
          <TextArea label="What needs to change?" value={changesText} onChange={(e) => setChangesText(e.target.value)} rows={4} autoFocus />
        </Modal>
      )}
      {confirm === "delete" && (
        <ConfirmModal
          title={`Delete “${post?.title}”?`}
          confirmLabel="Delete draft"
          busy={busy === "delete"}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            run("delete", async () => {
              await api(`/posts/${id}`, { method: "DELETE" });
              nav("/posts");
            }, "Draft deleted")
          }
        />
      )}
      {confirm === "publish" && (
        <Modal
          title="Publish to Facebook now?"
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy === "publish-now"} onClick={() => run("publish-now", () => api(`/posts/${id}/publish-now`, { body: {} }), "Publishing within a minute").then(() => setConfirm(null))}>
                Publish now
              </Button>
            </>
          }
        >
          <p className="muted mt0">It goes out on your Facebook Page within the next minute, exactly as approved.</p>
        </Modal>
      )}
    </>
  );
}
