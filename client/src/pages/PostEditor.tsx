import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, bizToday, BUSINESS_TZ_LABEL, fmtBiz, fmtDate, fmtNum, fromBizInput, POST_STATUS, toBizInput } from "../lib/format";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icons";
import { Alert, Avatar, Button, ConfirmModal, LoadError, Modal, PageHead, SelectField, Skeleton, StatusTag, Steps, Tag, TextArea, TextField } from "../components/ui";
import { MediaPreview, MediaUpload, type UploadedMedia } from "../components/MediaUpload";
import { RevisionModal } from "../components/EditorBot";
import { LeaveGuard } from "../components/LeaveGuard";
import "../styles/posts.css";

// ---------------- Shared helpers for the posts pages ----------------

export interface AppStatus {
  ai?: unknown;
  facebook?: { connected: boolean; pageName?: string };
  publishTestMode?: boolean;
  messengerTestMode?: boolean;
  businessName?: string;
}

let statusCache: { at: number; p: Promise<AppStatus | null> } | null = null;

/** GET /api/status, cached for a minute. null while loading or if it isn't available. */
export function useAppStatus() {
  const [s, setS] = useState<AppStatus | null>(null);
  useEffect(() => {
    let alive = true;
    if (!statusCache || Date.now() - statusCache.at > 60_000) {
      statusCache = {
        at: Date.now(),
        p: api<AppStatus>("/status").catch(() => {
          statusCache = null;
          return null;
        }),
      };
    }
    void statusCache.p.then((v) => alive && setS(v));
    return () => {
      alive = false;
    };
  }, []);
  return s;
}

/** Where "back" goes: pages linking here may pass `state={{ from: { to, label } }}`. */
export type FromState = { from?: { to: string; label: string } } | null;

const PAGE_HOSTS = /(^|\.)(facebook\.com|fb\.watch|fb\.com|instagram\.com|youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|drive\.google\.com|docs\.google\.com|dropbox\.com)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (!h.includes(".") && !h.includes(":")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}

/** Same rules as the server (server/src/routes/posts.ts mediaUrl). Returns a message, or null when fine/empty. */
export function mediaProblem(kind: "image" | "video", raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return `That isn't a full web address. It should start with https://`;
  }
  if (u.protocol !== "https:") return `The ${kind} link must start with https://`;
  if (u.username || u.password) return `The ${kind} link can't contain a username or password.`;
  if (isPrivateHost(u.hostname)) return `The ${kind} link must be on a public website Facebook can reach (not localhost or a private network).`;
  if (PAGE_HOSTS.test(u.hostname)) return `That's a link to a web page, not the ${kind} file itself. Use a direct link to the file.`;
  if (kind === "video" && !VIDEO_EXT.test(u.pathname)) return "The video link must point directly to a .mp4, .mov, .m4v or .webm file.";
  return null;
}

/** Message + hashtags as they'll be published (same whole-tag rule as the server's composeMessage). */
export function composePreview(message: string, hashtags: string[]) {
  const text = message.trim();
  const present = new Set((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()));
  const tags: string[] = [];
  for (const raw of hashtags) {
    const h = raw.trim();
    if (!h) continue;
    const tag = h.startsWith("#") ? h : `#${h}`;
    if (present.has(tag.toLowerCase())) continue;
    present.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags.length ? `${text}\n\n${tags.join(" ")}` : text;
}

/** A sensible default time on a Philippine day: 09:00, or the next full hour when that's already past today. */
export function defaultSlot(day: string) {
  if (day !== bizToday()) return `${day}T09:00`;
  const phHour = new Date(Date.now() + 8 * 3_600_000).getUTCHours();
  const h = Math.max(9, phHour + 1);
  return h > 23 ? `${day}T23:30` : `${day}T${String(h).padStart(2, "0")}:00`;
}

const futureBizInput = (v: string | null | undefined) => toBizInput(v && new Date(v).getTime() > Date.now() + 60_000 ? v : new Date(Date.now() + 3600_000));

// ---------------- Page ----------------

interface Post {
  id: number;
  title: string;
  message: string;
  hashtags: string[];
  image_url: string | null;
  video_url: string | null;
  media_id?: number | null;
  media_kind?: "image" | "video" | null;
  media_name?: string | null;
  media_size?: number | null;
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
  created_by: number | null;
  created_by_name: string | null;
  last_edited_by?: number | null;
  last_edited_by_name?: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  updated_at: string;
}
interface Detail {
  post: Post;
  reviews: { id: number; decision: string; comment: string | null; user_name: string | null; created_at: string }[];
  logs: { id: number; attempt: number; status: string; message: string; created_at: string }[];
  stats: { reach: number | null; impressions: number | null; reactions: number; comments: number; shares: number; clicks: number | null; permalink_url: string | null; updated_at: string } | null;
  preview: string;
}

type Form = { title: string; message: string; hashtags: string; image_url: string; video_url: string; media: UploadedMedia | null; image_prompt: string; link_url: string; campaign_id: string; planned: string };

const EMPTY: Form = { title: "", message: "", hashtags: "", image_url: "", video_url: "", media: null, image_prompt: "", link_url: "", campaign_id: "", planned: "" };
const EDITABLE = ["draft", "changes_requested", "in_review", "approved", "scheduled", "failed"];
/** Statuses where a content change sends the post back for approval (matches the server). */
const RESETS_APPROVAL = ["approved", "scheduled", "in_review", "failed"];
const DELETABLE = ["draft", "changes_requested", "cancelled", "failed"];
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

const splitTags = (s: string) => s.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean).map((h) => (h.startsWith("#") ? h : `#${h}`));

function formFrom(post: Post): Form {
  return {
    title: post.title,
    message: post.message,
    hashtags: post.hashtags.join(" "),
    image_url: post.image_url ?? "",
    video_url: post.video_url ?? "",
    media: post.media_id && post.media_kind ? { id: post.media_id, kind: post.media_kind, name: post.media_name ?? "Uploaded file", size: post.media_size ?? undefined } : null,
    image_prompt: post.image_prompt ?? "",
    link_url: post.link_url ?? "",
    campaign_id: post.campaign_id ? String(post.campaign_id) : "",
    planned: toBizInput(post.scheduled_at),
  };
}

const LEAVE_MSG = "You have unsaved changes to this post. Leave without saving?";

export function PostEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const location = useLocation();
  const from = (location.state as FromState)?.from;
  const back = from?.to && from.label ? from : { to: "/posts", label: "Posts" };
  const { user, can } = useAuth();
  const toast = useToast();
  const appStatus = useAppStatus();
  const detail = useLoad(() => (isNew ? Promise.resolve(null) : api<Detail>(`/posts/${id}`)), [id]);
  const campaigns = useLoad(() => api<{ campaigns: { id: number; name: string; status: string }[] }>("/campaigns"), []);

  const [form, setForm] = useState<Form>(EMPTY);
  const [showLinks, setShowLinks] = useState(false);
  const [revising, setRevising] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<{ issues: string[]; hasDisclaimer: boolean; disclaimer: string } | null>(null);
  const [schedAt, setSchedAt] = useState("");
  const [changesOpen, setChangesOpen] = useState(false);
  const [changesText, setChangesText] = useState("");
  const [comment, setComment] = useState("");
  const [confirm, setConfirm] = useState<null | "delete" | "publish" | "cancel" | "unschedule">(null);
  const [videoBroken, setVideoBroken] = useState(false);

  const post = detail.data?.post;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  /** Set by our own successful actions, so the version they produce isn't reported as someone else's change. */
  const ownChange = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Fill the form from the server only when a different version of the post arrives and there are
  // no unsaved edits, so reloading after an action (comment, schedule, …) never wipes what's typed.
  const postKey = post ? `${post.id}:${post.updated_at}` : null;
  useEffect(() => {
    if (!post || !postKey || postKey === loadedKey) return;
    if (!dirty) {
      ownChange.current = false;
      setLoadedKey(postKey);
      setForm(formFrom(post));
      setSchedAt(futureBizInput(post.scheduled_at));
    } else if (ownChange.current) {
      ownChange.current = false;
      setLoadedKey(postKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postKey, dirty, loadedKey]);
  const serverChanged = !!post && !!loadedKey && postKey !== loadedKey && dirty;

  // New post: prefill from ?date= (a Philippine day) and ?campaign=
  useEffect(() => {
    if (!isNew) return;
    setLoadedKey(null);
    const d = params.get("date");
    setForm({ ...EMPTY, planned: d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? defaultSlot(d) : "", campaign_id: params.get("campaign") ?? "" });
    setSchedAt(futureBizInput(null));
    setDirty(false);
  }, [isNew, params]);

  // Live brand-rule check while typing; only the newest answer counts.
  const checkSeq = useRef(0);
  useEffect(() => {
    const t = setTimeout(() => {
      const seq = ++checkSeq.current;
      if (!form.message.trim()) return setCheck(null);
      api<{ issues: string[]; hasDisclaimer: boolean; disclaimer: string }>("/studio/check", { body: { text: `${form.title}\n${form.message}` } })
        .then((r) => {
          if (seq === checkSeq.current) setCheck(r);
        })
        .catch(() => undefined);
    }, 600);
    return () => clearTimeout(t);
  }, [form.title, form.message]);

  useEffect(() => setVideoBroken(false), [form.video_url]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setDirty(true);
  };

  const payload = () => ({
    title: form.title.trim(),
    message: form.message,
    hashtags: splitTags(form.hashtags),
    image_url: form.media ? null : form.image_url.trim() || null,
    video_url: form.media ? null : form.video_url.trim() || null,
    media_id: form.media?.id ?? null,
    image_prompt: form.image_prompt.trim() || null,
    link_url: form.link_url.trim() || null,
    campaign_id: form.campaign_id ? Number(form.campaign_id) : null,
    ...(post?.status !== "scheduled" ? { scheduled_at: fromBizInput(form.planned) } : {}),
  });

  /** Runs an action; resolves true on success. The form is only marked saved when `saved` is set. */
  async function run(label: string, fn: () => Promise<unknown>, okMsg?: string, opts: { saved?: boolean; reload?: boolean } = {}): Promise<boolean> {
    setBusy(label);
    try {
      await fn();
      ownChange.current = true;
      if (opts.saved) setDirty(false);
      if (okMsg) toast.ok(okMsg);
      if (opts.reload !== false) await detail.reload();
      return true;
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (isNew) {
      setBusy("save");
      try {
        const r = await api<{ post: { id: number } }>("/posts", { body: payload() });
        setDirty(false);
        dirtyRef.current = false;
        toast.ok("Draft saved");
        nav(`/posts/${r.post.id}`, { replace: true, state: location.state });
      } catch (e) {
        toast.err("Couldn't save", (e as Error).message);
      } finally {
        setBusy(null);
      }
      return;
    }
    await run(
      "save",
      async () => {
        const r = await api<{ resetApproval: boolean }>(`/posts/${id}`, { method: "PATCH", body: payload() });
        if (r.resetApproval) toast.ok("Saved. It needs approval again", "Because the content changed after review.");
        else toast.ok("Saved");
      },
      undefined,
      { saved: true },
    );
  }

  async function saveThen(action: string, body?: unknown, okMsg?: string) {
    const hadEdits = dirty;
    return run(
      action,
      async () => {
        if (hadEdits) {
          await api(`/posts/${id}`, { method: "PATCH", body: payload() });
          setDirty(false);
        }
        await api(`/posts/${id}/${action}`, { body: body ?? {} });
      },
      okMsg,
    );
  }

  async function addComment() {
    setBusy("comment");
    try {
      await api(`/posts/${id}/comment`, { body: { comment } });
      setComment("");
      // Only the history changes: refresh it without touching the post or the form.
      const d = await api<Detail>(`/posts/${id}`);
      detail.setData((cur) => (cur ? { ...cur, reviews: d.reviews } : cur));
    } catch (e) {
      toast.err("Couldn't add the comment", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function discardAndReload() {
    setLoadedKey(null);
    setDirty(false);
  }

  if (!isNew && detail.loading && !detail.data) return <Skeleton rows={5} />;
  if (detail.error && !detail.data) return <LoadError error={detail.error} retry={detail.reload} />;

  const status = post?.status ?? "draft";
  const editable = can("posts.edit") && (isNew || EDITABLE.includes(status));
  const isAuthor = !!post && post.created_by === user?.id;
  const isLastEditor = !!post && post.last_edited_by === user?.id;
  const isAdmin = user?.role === "admin";
  const ownWork = (isAuthor || isLastEditor) && !isAdmin;
  const canApproveThis = can("posts.approve") && !ownWork;
  const testMode = appStatus?.publishTestMode === true;
  const pageName = appStatus?.facebook?.pageName || appStatus?.businessName || "Your Page";

  const imageErr = editable ? mediaProblem("image", form.image_url) : null;
  const videoErr = editable ? mediaProblem("video", form.video_url) : null;
  const bothMedia = [form.media, form.image_url.trim(), form.video_url.trim()].filter(Boolean).length > 1;
  const plannedErr = form.planned && !fromBizInput(form.planned) ? "Pick a valid date and time." : null;
  const valid = !!form.title.trim() && !!form.message.trim() && !imageErr && !videoErr && !bothMedia && !plannedErr;

  // Matches the server's contentChanged: only these fields send a post back for approval.
  const contentChanged =
    !!post &&
    (form.title.trim() !== post.title ||
      form.message !== post.message ||
      JSON.stringify(splitTags(form.hashtags)) !== JSON.stringify(post.hashtags) ||
      (form.image_url.trim() || null) !== (post.image_url ?? null) ||
      (form.video_url.trim() || null) !== (post.video_url ?? null) ||
      (form.media?.id ?? null) !== (post.media_id ?? null) ||
      (form.link_url.trim() || null) !== (post.link_url ?? null));

  const preview = composePreview(form.message, splitTags(form.hashtags));
  const videoUrl = form.video_url.trim();
  const imageUrl = form.image_url.trim();
  const schedIso = fromBizInput(schedAt);

  return (
    <>
      <LeaveGuard when={() => dirtyRef.current} message={LEAVE_MSG} />
      <PageHead
        crumbs={[{ to: back.to, label: back.label }, { label: isNew ? "New post" : post?.title ?? "" }]}
        title={isNew ? "New post" : post?.title}
        sub={
          post ? (
            <span className="row" style={{ gap: 8 }}>
              <StatusTag map={POST_STATUS} value={status} />
              {post.ai_generated && <Tag tone="info">AI draft</Tag>}
              {post.campaign_name && <Tag tone="outline">{post.campaign_name}</Tag>}
              <span className="small muted">
                by {post.created_by_name ?? "—"}
                {post.last_edited_by_name && post.last_edited_by !== post.created_by ? ` · last edited by ${post.last_edited_by_name}` : ""}
              </span>
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
          {serverChanged && (
            <Alert tone="warn" title="Someone else changed this post">
              Your unsaved edits are based on an older version. Saving will overwrite their changes.{" "}
              <button type="button" className="btn btn-quiet btn-sm" onClick={discardAndReload}>
                Discard my edits and load theirs
              </button>
            </Alert>
          )}
          {post && RESETS_APPROVAL.includes(status) && dirty && contentChanged && (
            <Alert tone="warn" title="Saving will send this post back for approval">
              {status === "in_review" ? "It's being reviewed as it was." : "It was approved as it was."} Any change to the title, text, hashtags, image, video or link needs approval again.
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
            {editable && can("content.generate") && (
              <div className="row" style={{ marginTop: -6 }}>
                <Button size="sm" variant="soft" icon="spark" disabled={!form.message.trim()} onClick={() => setRevising(true)}>
                  Revise with Editor Bot
                </Button>
                <span className="note mt0">Checks the text against your standards and suggests a revision.</span>
              </div>
            )}
            {revising && (
              <RevisionModal
                text={form.message}
                postId={post?.id ?? null}
                onAccept={(t) => {
                  setForm((f) => ({ ...f, message: t }));
                  setDirty(true);
                }}
                onClose={() => setRevising(false)}
              />
            )}
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
                        type="button"
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
            <MediaUpload
              value={form.media}
              disabled={!editable}
              onChange={(m) => {
                // An upload replaces any image or video link.
                setForm((f) => ({ ...f, media: m, ...(m ? { image_url: "", video_url: "" } : {}) }));
                setDirty(true);
              }}
            />
            {!form.media && !showLinks && !form.image_url && !form.video_url && editable && (
              <button type="button" className="linkish link-toggle" onClick={() => setShowLinks(true)}>
                Or use a link to an image or video that's already online
              </button>
            )}
            {!form.media && (showLinks || !!form.image_url || !!form.video_url) && (
            <>
            <div className="grid g2">
              <TextField
                label="Image URL"
                optional
                value={form.image_url}
                onChange={set("image_url")}
                disabled={!editable}
                placeholder="https://… (public image link)"
                error={imageErr}
                hint="Posts with an image are published as a photo post."
              />
            </div>
            <TextField
              label="Video URL"
              optional
              value={form.video_url}
              onChange={set("video_url")}
              disabled={!editable}
              placeholder="https://… (direct .mp4, .mov, .m4v or .webm link)"
              error={videoErr}
              hint="Posts with a video are published as a video post. Facebook downloads it from this link."
            />
            </>
            )}
            <TextField label="Link" optional value={form.link_url} onChange={set("link_url")} disabled={!editable} placeholder="https://…" hint="Shown as a link preview when the post has no image or video." />
            {bothMedia && (
              <Alert tone={editable ? "bad" : "warn"} title="Use either an image or a video">
                {editable
                  ? "A post can have one image or one video. Remove the upload or clear the links before saving."
                  : "This post has both. The video is what gets published; the image is ignored."}
              </Alert>
            )}
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
                <TextField
                  label={`Planned date (${BUSINESS_TZ_LABEL})`}
                  optional
                  type="datetime-local"
                  value={form.planned}
                  onChange={set("planned")}
                  disabled={!editable}
                  error={plannedErr}
                  hint="Places it on the calendar. Publishing needs approval and scheduling."
                />
              )}
            </div>
          </div>
        </div>

        {/* ---- Side panel: live preview, then the workflow ---- */}
        <aside className="stackv first-on-mobile" style={{ gap: 16 }}>
          <div>
            <p className="label">Facebook preview</p>
            <div className="card soft">
              <div className="row" style={{ gap: 10 }}>
                <Avatar name={pageName} size="sm" />
                <div>
                  <b style={{ fontSize: 13.5 }}>{pageName}</b>
                  <div className="sub">{post?.scheduled_at ? `${fmtBiz(post.scheduled_at)} (${BUSINESS_TZ_LABEL})` : "Not scheduled"} · 🌐</div>
                </div>
              </div>
              <p className="pre" style={{ margin: "12px 0", fontSize: 14, overflowWrap: "anywhere" }}>
                {preview || <span className="muted">Your text appears here.</span>}
              </p>
              {form.media ? (
                <MediaPreview media={form.media} />
              ) : videoUrl ? (
                !mediaProblem("video", videoUrl) && !videoBroken ? (
                  <video className="pe-video" src={videoUrl} controls preload="metadata" onError={() => setVideoBroken(true)} />
                ) : (
                  <div className="pe-video-ph">
                    <Icon name="alert" />
                    <div>
                      <b>Video</b>
                      <span>{videoBroken ? "The preview couldn't load this video. Check the link opens the file directly." : "Add a direct video file link to preview it."}</span>
                      <a href={videoUrl} target="_blank" rel="noreferrer">
                        {videoUrl}
                      </a>
                    </div>
                  </div>
                )
              ) : imageUrl ? (
                <img src={imageUrl} alt="" style={{ width: "100%", borderRadius: 12, border: "1px solid var(--rule)" }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
              ) : form.link_url ? (
                <div className="code" style={{ display: "block", padding: 10, overflowWrap: "anywhere", whiteSpace: "normal" }}>
                  {form.link_url}
                </div>
              ) : null}
              {videoUrl && imageUrl && <p className="note">Only the video is shown: a post can't have both.</p>}
            </div>
          </div>
          {post && (
            <div className="board">
              <p className="label">Where it is</p>
              <Steps steps={["Draft", "Review", "Approved", "Scheduled", "Published"]} current={stepIndex(status)} failed={status === "failed"} vertical />
              <div className="stackv mt24">
                {testMode && ["approved", "scheduled", "publishing", "failed"].includes(status) && (
                  <Alert tone="warn" title="Test mode is on">
                    It will be marked published but not sent to Facebook.
                  </Alert>
                )}
                {(status === "draft" || status === "changes_requested") && can("posts.edit") && (
                  <Button variant="primary" icon="send" loading={busy === "submit"} disabled={!valid} onClick={() => void saveThen("submit", {}, "Sent for review")}>
                    Send for review
                  </Button>
                )}
                {status === "in_review" &&
                  (canApproveThis ? (
                    <>
                      <TextField label={`Publish at (${BUSINESS_TZ_LABEL})`} type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} />
                      {can("posts.schedule") && (
                        <Button
                          variant="primary"
                          loading={busy === "approve"}
                          disabled={dirty || !schedIso}
                          onClick={() => void run("approve", () => api(`/posts/${id}/approve`, { body: { scheduleAt: schedIso } }), "Approved and scheduled")}
                        >
                          Approve and schedule
                        </Button>
                      )}
                      <Button variant="secondary" loading={busy === "approve-only"} disabled={dirty} onClick={() => void run("approve-only", () => api(`/posts/${id}/approve`, { body: {} }), "Approved")}>
                        Approve only
                      </Button>
                      <Button variant="quiet" onClick={() => setChangesOpen(true)}>
                        Ask for changes
                      </Button>
                      {dirty && <p className="note mt0">Save your edits first: they'll need another review.</p>}
                    </>
                  ) : (
                    <Alert tone="info" title="Waiting for approval">
                      {can("posts.approve") && ownWork
                        ? `Another manager has to approve this, because you ${isAuthor ? "wrote it" : "made the latest changes"}.`
                        : isAuthor
                          ? "A marketing manager will review it. You'll see their comments here."
                          : "Only marketing managers can approve posts."}
                    </Alert>
                  ))}
                {status === "approved" && can("posts.schedule") && (
                  <>
                    <TextField label={`Publish at (${BUSINESS_TZ_LABEL})`} type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} />
                    <Button
                      variant="primary"
                      icon="cal"
                      loading={busy === "schedule"}
                      disabled={!schedIso}
                      onClick={() => void run("schedule", () => api(`/posts/${id}/schedule`, { body: { scheduledAt: schedIso } }), "Scheduled")}
                    >
                      Schedule
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirm("publish")}>
                      Publish now
                    </Button>
                  </>
                )}
                {status === "scheduled" && post.scheduled_at && (
                  <>
                    <Alert tone="info" title={`Publishes ${fmtBiz(post.scheduled_at)} (${BUSINESS_TZ_LABEL})`}>
                      {post.attempts > 0
                        ? `Attempt ${post.attempts} of ${post.max_attempts} failed: ${post.last_error}. Next try ${ago(post.next_attempt_at)}.`
                        : `That's ${ago(post.scheduled_at)}. Approved by ${post.approved_by_name ?? "—"}.`}
                    </Alert>
                    {can("posts.schedule") && (
                      <>
                        <Button variant="secondary" onClick={() => setConfirm("publish")}>
                          Publish now
                        </Button>
                        <Button variant="quiet" loading={busy === "unschedule"} onClick={() => setConfirm("unschedule")}>
                          Unschedule
                        </Button>
                      </>
                    )}
                  </>
                )}
                {["approved", "scheduled"].includes(status) && can("posts.schedule") && (
                  <Button variant="quiet" icon="x" loading={busy === "cancel"} onClick={() => setConfirm("cancel")}>
                    Cancel post
                  </Button>
                )}
                {status === "publishing" && (
                  <Alert tone="info" title="Publishing now">
                    Refresh in a moment.{" "}
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => void detail.reload()}>
                      Refresh
                    </button>
                  </Alert>
                )}
                {status === "failed" && (
                  <>
                    <Alert tone="bad" title={`Didn't publish after ${post.attempts} attempt${post.attempts === 1 ? "" : "s"}`}>
                      {post.last_error}
                    </Alert>
                    {can("posts.schedule") && (
                      <>
                        <Button variant="primary" icon="refresh" loading={busy === "retry"} onClick={() => void run("retry", () => api(`/posts/${id}/retry`, { body: {} }), "Retrying now")}>
                          Try again
                        </Button>
                        <Button variant="quiet" icon="x" loading={busy === "cancel"} onClick={() => setConfirm("cancel")}>
                          Cancel post
                        </Button>
                      </>
                    )}
                  </>
                )}
                {status === "cancelled" && (
                  <Alert tone="info" title="Cancelled">
                    This post won't be published.
                  </Alert>
                )}
                {DELETABLE.includes(status) && can("posts.edit") && (
                  <Button variant="quiet" icon="trash" onClick={() => setConfirm("delete")}>
                    {status === "draft" || status === "changes_requested" ? "Delete draft" : "Delete post"}
                  </Button>
                )}
                {status === "published" && (
                  <>
                    <Alert tone="good" title={`Published ${fmtBiz(post.published_at)} (${BUSINESS_TZ_LABEL})`}>
                      {post.fb_post_id?.startsWith("dryrun_") ? "Test mode: this wasn't really sent to Facebook." : `Facebook post ID ${post.fb_post_id}`}
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
                  <TextField label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a note for the team" maxLength={1000} />
                </div>
                <Button size="sm" disabled={!comment.trim()} loading={busy === "comment"} onClick={() => void addComment()}>
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
                        {r.comment ? ` · ${r.decision === "scheduled" && !isNaN(Date.parse(r.comment)) ? `for ${fmtBiz(r.comment)} (${BUSINESS_TZ_LABEL})` : r.comment}` : ""}
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
                      <div className="meta">{l.status === "dry_run" ? "Test mode: not sent to Facebook" : l.message}</div>
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
                onClick={async () => {
                  if (await run("changes", () => api(`/posts/${id}/request-changes`, { body: { comment: changesText } }), "Sent back to the author")) {
                    setChangesOpen(false);
                    setChangesText("");
                  }
                }}
              >
                Send back
              </Button>
            </>
          }
        >
          <TextArea label="What needs to change?" value={changesText} onChange={(e) => setChangesText(e.target.value)} rows={4} autoFocus maxLength={1000} />
        </Modal>
      )}
      {confirm === "delete" && (
        <ConfirmModal
          title={`Delete “${post?.title}”?`}
          confirmLabel={status === "draft" || status === "changes_requested" ? "Delete draft" : "Delete post"}
          busy={busy === "delete"}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const ok = await run(
              "delete",
              async () => {
                await api(`/posts/${id}`, { method: "DELETE" });
              },
              "Post deleted",
              { reload: false },
            );
            if (ok) {
              setDirty(false);
              dirtyRef.current = false;
              setConfirm(null);
              nav(back.to);
            }
          }}
        />
      )}
      {confirm === "cancel" && (
        <ConfirmModal
          title={`Cancel “${post?.title}”?`}
          warning="It won't be published. To publish it later it would have to be written and approved again."
          confirmLabel="Cancel post"
          busy={busy === "cancel"}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            if (await run("cancel", () => api(`/posts/${id}/cancel`, { body: {} }), "Cancelled")) setConfirm(null);
          }}
        />
      )}
      {confirm === "unschedule" && (
        <Modal
          title="Unschedule this post?"
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setConfirm(null)}>
                Keep it scheduled
              </Button>
              <Button
                variant="primary"
                loading={busy === "unschedule"}
                onClick={async () => {
                  if (await run("unschedule", () => api(`/posts/${id}/unschedule`, { body: {} }), "Unscheduled")) setConfirm(null);
                }}
              >
                Unschedule
              </Button>
            </>
          }
        >
          <p className="muted mt0">
            It stays approved but won't go out{post?.scheduled_at ? ` on ${fmtBiz(post.scheduled_at)} (${BUSINESS_TZ_LABEL})` : ""}. You can schedule it again any time.
          </p>
        </Modal>
      )}
      {confirm === "publish" && (
        <Modal
          title={testMode ? "Publish now (Test mode)?" : "Publish to Facebook now?"}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={busy === "publish-now"}
                onClick={async () => {
                  if (await run("publish-now", () => api(`/posts/${id}/publish-now`, { body: {} }), testMode ? "Will be marked published within a minute (Test mode)" : "Publishing within a minute")) setConfirm(null);
                }}
              >
                Publish now
              </Button>
            </>
          }
        >
          {testMode ? (
            <Alert tone="warn" title="Test mode is on">
              It will be marked published but not sent to Facebook.
            </Alert>
          ) : (
            <p className="muted mt0">It goes out on {pageName === "Your Page" ? "your Facebook Page" : pageName} within the next minute, exactly as approved.</p>
          )}
        </Modal>
      )}
    </>
  );
}
