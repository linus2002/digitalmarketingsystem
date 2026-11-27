import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { ago, fmtDate } from "../lib/format";
import { useToast } from "../components/Toast";
import { PlatformIcon } from "../components/Platforms";
import { Alert, Button, ConfirmModal, Empty, LoadError, Modal, PageHead, Seg, Skeleton, Tabs, Tag, TextArea } from "../components/ui";
import "../styles/inquiries.css";

// Comments inbox: comments on the Facebook Page's and Instagram account's posts, with the questions first.

type Show = "inquiries" | "open" | "review" | "done" | "all";
type Platform = "all" | "facebook" | "instagram";

interface Comment {
  id: number;
  platform: "facebook" | "instagram";
  text: string;
  author: string | null;
  post_url: string | null;
  parent_external_id: string | null;
  is_inquiry: boolean;
  needs_review: boolean;
  review_reasons: string[];
  status: "open" | "replied" | "hidden" | "dismissed";
  private_reply_at: string | null;
  public_reply_at: string | null;
  handled_by_name: string | null;
  handled_at: string | null;
  error: string | null;
  commented_at: string;
}
interface Data {
  comments: Comment[];
  counts: { inquiries: number; open: number; review: number };
  lastReceivedAt: string | null;
  testMode: boolean;
  canReply: boolean;
  canReview: boolean;
}

const SHOWS: Show[] = ["inquiries", "open", "review", "done", "all"];
const PLATFORM_NAME = { facebook: "Facebook", instagram: "Instagram" } as const;
const PRIVATE_REPLY_MS = 7 * 86_400_000;

export function CommentsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const raw = params.get("show") as Show | null;
  const show: Show = raw && SHOWS.includes(raw) ? raw : "inquiries";
  const platform = (["facebook", "instagram"].includes(params.get("platform") ?? "") ? params.get("platform") : "all") as Platform;
  const set = (k: string, v: string | null) =>
    setParams((cur) => {
      const next = new URLSearchParams(cur);
      if (v) next.set(k, v);
      else next.delete(k);
      return next;
    });

  const data = useLoad(() => api<Data>("/comments", { query: { show, platform } }), [show, platform]);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      const r = await api<{ added: number; errors: string[] }>("/comments/sync", { method: "POST", body: {} });
      if (r.errors.length) toast.err("Some comments couldn't be read", r.errors.join(" "));
      else toast.ok(r.added ? `${r.added} new comment${r.added === 1 ? "" : "s"}` : "No new comments");
      data.reload();
    } catch (e) {
      toast.err("Couldn't check for comments", (e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const d = data.data;
  return (
    <div className="page">
      <PageHead
        title="Comments"
        sub="Comments on your Facebook Page and Instagram posts. Questions are listed first so nobody asking about a medicine gets missed."
        actions={
          <Button icon="refresh" loading={checking} onClick={check}>
            Check for new comments
          </Button>
        }
      />
      {d?.testMode && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="info" title="Test mode">
            Replies and hiding are recorded here but not sent to Facebook or Instagram.
          </Alert>
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <Tabs
          value={show}
          onChange={(v) => set("show", v === "inquiries" ? null : v)}
          tabs={[
            { value: "inquiries", label: "Questions", n: d?.counts.inquiries },
            { value: "review", label: "For the pharma team", n: d?.counts.review },
            { value: "open", label: "All open", n: d?.counts.open },
            { value: "done", label: "Done" },
            { value: "all", label: "Everything" },
          ]}
        />
        <Seg
          label="Platform"
          value={platform}
          onChange={(v) => set("platform", v === "all" ? null : v)}
          options={[
            { value: "all", label: "Both" },
            { value: "facebook", label: "Facebook" },
            { value: "instagram", label: "Instagram" },
          ]}
        />
      </div>

      {data.error && !d ? (
        <LoadError error={data.error} retry={data.reload} />
      ) : !d ? (
        <Skeleton rows={4} />
      ) : d.comments.length === 0 ? (
        <Empty title={show === "inquiries" ? "No unanswered questions" : "No comments here"}>
          {d.lastReceivedAt
            ? `The last comment came in ${ago(d.lastReceivedAt)}. New ones are checked every 10 minutes.`
            : "Comments appear here once your Facebook Page is connected. New ones are checked every 10 minutes, or press Check for new comments."}
        </Empty>
      ) : (
        <div className="cm-list">
          {d.comments.map((c) => (
            <CommentCard key={c.id} c={c} canReply={d.canReply} canReview={d.canReview} testMode={d.testMode} reload={data.reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommentCard({ c, canReply, canReview, testMode, reload }: { c: Comment; canReply: boolean; canReview: boolean; testMode: boolean; reload: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [confirmHide, setConfirmHide] = useState(false);
  const [confirmPrivate, setConfirmPrivate] = useState(false);
  const name = PLATFORM_NAME[c.platform];
  const open = c.status === "open";
  const privateOk = !c.private_reply_at && Date.now() - new Date(c.commented_at).getTime() < PRIVATE_REPLY_MS;
  const publicBlocked = c.needs_review && !canReview;
  const note = testMode ? " (test mode: not sent)" : "";

  const act = async (key: string, path: string, body: unknown, done: string) => {
    setBusy(key);
    try {
      await api(`/comments/${c.id}/${path}`, { method: "POST", body });
      toast.ok(done + note);
      reload();
      return true;
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`card soft cm-card ${open ? "" : "cm-done"}`}>
      <div className="cm-head">
        <PlatformIcon p={c.platform} size={28} label={name} />
        <div className="grow">
          <b>{c.author ?? `Someone on ${name}`}</b>
          <div className="muted small">
            {c.parent_external_id ? "Reply in a comment thread · " : ""}
            <time dateTime={c.commented_at} title={fmtDate(c.commented_at, true)}>
              {ago(c.commented_at)}
            </time>
            {c.post_url && (
              <>
                {" · "}
                <a href={c.post_url} target="_blank" rel="noreferrer">
                  See it on {name}
                </a>
              </>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {c.is_inquiry && <Tag tone="info">Question</Tag>}
          {c.needs_review && (
            <Tag tone="warn" title={c.review_reasons.join(", ")}>
              Pharma team
            </Tag>
          )}
          {c.status === "replied" && <Tag tone="good">Answered</Tag>}
          {c.status === "hidden" && <Tag tone="mute">Hidden</Tag>}
          {c.status === "dismissed" && <Tag tone="mute">Done</Tag>}
        </div>
      </div>

      <p className="cm-text">{c.text}</p>

      {c.needs_review && open && (
        <p className="muted small">
          Mentions {c.review_reasons.join(", ").toLowerCase() || "a topic for the pharmaceutical team"}. Don't give medical or availability answers in public: reply privately so the
          assistant can take down the inquiry.
        </p>
      )}
      {c.error && open && <Alert tone="bad">Last try failed: {c.error}</Alert>}
      {!open && (c.handled_by_name || c.private_reply_at || c.public_reply_at) && (
        <p className="muted small">
          {[c.private_reply_at && "Sent a private message", c.public_reply_at && "Replied in public", c.status === "hidden" && "Hidden", c.status === "dismissed" && "Marked done"]
            .filter(Boolean)
            .join(" · ")}
          {c.handled_by_name ? ` by ${c.handled_by_name}` : ""}
          {c.handled_at ? `, ${ago(c.handled_at)}` : ""}
        </p>
      )}

      {canReply && open && (
        <>
          {replying ? (
            <div className="cm-reply">
              <TextArea label={`Public reply on ${name}`} value={reply} onChange={(e) => setReply(e.target.value)} rows={3} maxLength={2000} autoFocus hint="Everyone can see this reply." />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <Button variant="quiet" onClick={() => setReplying(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  icon="send"
                  loading={busy === "reply"}
                  disabled={!reply.trim() || (!!busy && busy !== "reply")}
                  onClick={async () => {
                    if (await act("reply", "reply", { text: reply }, "Reply posted")) {
                      setReply("");
                      setReplying(false);
                    }
                  }}
                >
                  Post reply
                </Button>
              </div>
            </div>
          ) : (
            <div className="row cm-actions">
              <Button
                variant="primary"
                size="sm"
                icon="msg"
                loading={busy === "private"}
                disabled={!privateOk || (!!busy && busy !== "private")}
                title={
                  c.private_reply_at
                    ? "A private message was already sent for this comment."
                    : !privateOk
                      ? "Meta only allows a private message within 7 days of the comment."
                      : `Sends the approved "private reply" message to their ${name} inbox.`
                }
                onClick={() => setConfirmPrivate(true)}
              >
                Reply privately
              </Button>
              <Button
                size="sm"
                icon="send"
                disabled={publicBlocked || !!busy}
                title={publicBlocked ? "This comment is for the pharmaceutical team to answer in public. You can still reply privately." : undefined}
                onClick={() => setReplying(true)}
              >
                Reply in public
              </Button>
              <Button size="sm" variant="quiet" icon="eye-off" loading={busy === "hide"} disabled={!!busy && busy !== "hide"} onClick={() => setConfirmHide(true)}>
                Hide
              </Button>
              <Button size="sm" variant="quiet" icon="check" loading={busy === "done"} disabled={!!busy && busy !== "done"} onClick={() => act("done", "status", { status: "dismissed" }, "Marked as done")}>
                Mark done
              </Button>
            </div>
          )}
        </>
      )}
      {canReply && !open && (
        <div className="row cm-actions">
          <Button size="sm" variant="quiet" icon="refresh" loading={busy === "reopen"} onClick={() => act("reopen", "status", { status: "open" }, "Moved back to open")}>
            Reopen
          </Button>
        </div>
      )}

      {confirmPrivate && (
        <Modal
          title="Send a private message?"
          onClose={() => setConfirmPrivate(false)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setConfirmPrivate(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon="send"
                onClick={async () => {
                  setConfirmPrivate(false);
                  await act("private", "private-reply", {}, "Private message sent");
                }}
              >
                Send
              </Button>
            </>
          }
        >
          <p>
            This sends the approved "Comments: private reply" message to their {name} inbox. Meta allows only one per comment. If they answer it, the inquiry assistant
            takes over and the conversation appears under Inquiries.
          </p>
        </Modal>
      )}
      {confirmHide && (
        <ConfirmModal
          title="Hide this comment?"
          confirmLabel="Hide"
          warning={`To show it again later, unhide it on ${name}.`}
          onClose={() => setConfirmHide(false)}
          onConfirm={async () => {
            setConfirmHide(false);
            await act("hide", "hide", {}, "Comment hidden");
          }}
        >
          It stays visible to the person who wrote it{c.platform === "facebook" ? " and their friends" : ""}, but nobody else sees it. Use this for spam or comments that
          share personal or medical details in public.
        </ConfirmModal>
      )}
    </article>
  );
}
