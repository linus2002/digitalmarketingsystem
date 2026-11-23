import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, BUSINESS_TZ_LABEL, CONTACT_LABEL, fmtBiz, fmtDate, fromBizInput, LEAD_STATUS, SOURCE_LABEL, toBizInput } from "../lib/format";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icons";
import { Alert, Button, ConfirmModal, LoadError, Modal, PageHead, SelectField, Skeleton, StatusTag, Tag, TextArea, TextField } from "../components/ui";
import "../styles/inquiries.css";

interface Lead {
  id: number;
  ref: string;
  source: string;
  status: string;
  category: string;
  categoryLabel: string;
  priority: string;
  needs_review: boolean;
  review_reasons: string[];
  medicine_name: string | null;
  destination_country: string | null;
  contact_preference: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  revealed: boolean;
  assigned_to: number | null;
  assigned_name: string | null;
  assigned_active: boolean | null;
  follow_up_at: string | null;
  consent_given: boolean;
  consent_at: string | null;
  consent_version: string | null;
  opted_out_at: string | null;
  anonymized_at: string | null;
  created_at: string;
  inquiry: string | null;
}
interface Msg {
  id: number;
  direction: "in" | "out";
  sender_type: string;
  sender_name: string | null;
  reviewer_name: string | null;
  body: string | null;
  masked?: boolean;
  status: string;
  error: string | null;
  created_at: string;
}
interface Detail {
  lead: Lead;
  messages: Msg[];
  activities: { id: number; type: string; note: string | null; user_name: string | null; created_at: string }[];
  consents: { action: string; consent_version: string | null; channel: string; created_at: string }[];
  truncated?: { messages: boolean; activities: boolean };
  canReveal?: boolean;
  statusOptions?: string[];
  replyWindow: { ok: boolean; reason?: string; messagingType?: string; tag?: string } | null;
  aiSuggestions: boolean;
}
interface Template {
  id: number;
  key: string | null;
  name: string;
  category: string;
  body: string;
  status: string;
}
/** The parts of GET /api/status this page uses. It may be unavailable: everything here works without it. */
interface AppStatus {
  businessName?: string;
  messengerTestMode?: boolean;
}

// Same labels as the server's CATEGORY_LABELS (server/src/services/guardrails.ts); the server's list wins when loaded.
const CATEGORY_FALLBACK = [
  { value: "product_availability", label: "Availability" },
  { value: "pricing_quote", label: "Price or quote" },
  { value: "prescription", label: "Prescription" },
  { value: "medical_question", label: "Medical question" },
  { value: "regulatory_import", label: "Regulatory / import" },
  { value: "shipping_logistics", label: "Shipping" },
  { value: "order_status", label: "Order status" },
  { value: "privacy_request", label: "Privacy request" },
  { value: "general", label: "General" },
];

const ANON_REASONS = [
  { value: "erasure_request", label: "Person asked for their details to be deleted" },
  { value: "consent_withdrawn", label: "Person withdrew consent" },
  { value: "entered_by_mistake", label: "Entered by mistake or a duplicate" },
  { value: "other", label: "Other reason" },
];

const MSG_STATUS: Record<string, string> = {
  pending_review: "Waiting for pharmaceutical approval",
  sending: "Sending…",
  blocked: "Not sent",
  failed: "Failed to send",
  rejected: "Not approved",
  logged: "Logged (sent outside this system)",
};

const STAFF_ROLES = ["pharma_team", "lead_agent", "admin"];

export function LeadDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, user } = useAuth();
  const toast = useToast();
  const [reveal, setReveal] = useState(false);
  const { data, error, loading, reload } = useLoad(() => api<Detail>(`/leads/${id}`, { query: { reveal: reveal ? 1 : undefined } }), [id, reveal]);
  const templates = useLoad(() => api<{ templates: Template[]; categories?: { value: string; label: string }[] }>("/templates"), []);
  const users = useLoad(() => api<{ users: { id: number; name: string; role: string }[] }>("/users/directory"), []);
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api<AppStatus>("/status")
      .then((s) => alive && setAppStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const [reply, setReply] = useState("");
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [rejecting, setRejecting] = useState<{ id: number; reason: string } | null>(null);
  const [anonymise, setAnonymise] = useState(false);
  const [anonReason, setAnonReason] = useState("erasure_request");
  const [confirmStatus, setConfirmStatus] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [data?.messages.length]);

  if (loading && !data) return <Skeleton rows={5} />;
  if (error && !data) return <LoadError error={error} retry={reload} />;
  if (!data) return null;
  const { lead, messages, activities, consents, replyWindow } = data;
  const canReveal = data.canReveal ?? true;
  const optedOut = lead.status === "opted_out" || !!lead.opted_out_at;
  // Placeholders we can't fill here stay as {{…}}: the server fills them when the reply is sent.
  const vars: Record<string, string | undefined> = {
    ref: lead.ref,
    medicine: lead.medicine_name ?? "the medicine",
    country: lead.destination_country ?? "your country",
    name: lead.revealed && lead.name ? lead.name.split(" ")[0] : undefined,
    business: appStatus?.businessName || undefined,
  };
  const fill = (body: string) => body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
  const agentTemplates = (templates.data?.templates ?? []).filter((t) => !t.key && t.status === "approved");
  const categories = templates.data?.categories?.length ? templates.data.categories : CATEGORY_FALLBACK;
  const reviewer = can("leads.review");
  const closed = !!lead.anonymized_at || optedOut;
  const statusOptions = data.statusOptions ?? [lead.status];

  // Owner choices: people who can see every inquiry may pick anyone on the inquiry team; agents only themselves.
  const directory = (users.data?.users ?? []).filter((u) => STAFF_ROLES.includes(u.role));
  const ownerOptions: { value: string | number; label: string }[] = [{ value: "", label: "Unassigned" }];
  if (can("leads.view_all")) ownerOptions.push(...directory.map((u) => ({ value: u.id, label: u.name })));
  else if (user) ownerOptions.push({ value: user.id, label: `Me (${user.name})` });
  if (lead.assigned_to && !ownerOptions.some((o) => o.value === lead.assigned_to))
    ownerOptions.push({ value: lead.assigned_to, label: `${lead.assigned_name ?? "Unknown person"}${lead.assigned_active === false ? " (inactive)" : ""}` });

  /** Runs an action; returns true only if it worked, so dialogs close and pages change only on success. */
  async function act(label: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
    setBusy(label);
    try {
      await fn();
      if (ok) toast.ok(ok);
      await reload();
      return true;
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
      await reload();
      return false;
    } finally {
      setBusy(null);
    }
  }

  const update = (body: Record<string, unknown>, ok = "Saved", label = "update") => act(label, () => api(`/leads/${lead.id}`, { method: "PATCH", body }), ok);

  async function send() {
    setBusy("send");
    try {
      const r = await api<{ status: string }>(`/leads/${lead.id}/messages`, { body: { body: reply, templateId } });
      toast.ok(r.status === "pending_review" ? "Sent to the pharmaceutical team for approval" : r.status === "logged" ? "Reply logged" : "Reply sent");
      setReply("");
      setTemplateId(null);
      setSuggestNote(null);
    } catch (e) {
      toast.err("The reply wasn't sent", (e as Error).message);
    } finally {
      setBusy(null);
      await reload();
    }
  }

  async function suggest() {
    setBusy("suggest");
    try {
      const r = await api<{ suggestion: { templateId: number | null; reply: string; needsPharmacist: boolean; reason: string } }>(`/leads/${lead.id}/suggest`, { body: {} });
      setReply(fill(r.suggestion.reply));
      setTemplateId(r.suggestion.templateId);
      setSuggestNote(`${r.suggestion.reason}${r.suggestion.needsPharmacist ? " · Needs pharmaceutical review before sending." : ""}`);
    } catch (e) {
      toast.err("No suggestion", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function changeStatus(next: string) {
    if (next === lead.status) return;
    if (next === "closed" || next === "opted_out") setConfirmStatus(next);
    else void update({ status: next }, lead.status === "closed" ? "Inquiry reopened" : "Status updated", "status");
  }

  return (
    <>
      <PageHead
        crumbs={[{ to: "/leads", label: "Inquiries" }, { label: lead.ref }]}
        title={lead.medicine_name ?? "Inquiry"}
        sub={
          <span className="row" style={{ gap: 8 }}>
            <span className="code">{lead.ref}</span>
            <StatusTag map={LEAD_STATUS} value={lead.status} />
            <Tag tone="outline">{lead.categoryLabel}</Tag>
            {lead.needs_review && <Tag tone="warn" dot>Pharmaceutical review</Tag>}
            <span className="small muted">
              {SOURCE_LABEL[lead.source]} · received {fmtDate(lead.created_at, true)}
            </span>
          </span>
        }
        actions={
          <>
            {can("leads.export") && (
              <a className="btn btn-quiet" href={`/api/leads/${lead.id}/export`}>
                <Icon name="download" />
                Export data
              </a>
            )}
            {can("leads.delete") && !lead.anonymized_at && (
              <Button variant="quiet" icon="trash" onClick={() => setAnonymise(true)}>
                Delete personal data
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div style={{ marginBottom: 16 }}>
          <LoadError error={error} retry={reload} />
        </div>
      )}
      {lead.anonymized_at && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="info" title={`Personal data removed ${fmtDate(lead.anonymized_at)}`}>Only anonymous details remain for reporting.</Alert>
        </div>
      )}
      {optedOut && !lead.anonymized_at && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="bad" title="This person opted out">
            No messages can be sent to them. Only they can restart the conversation, by messaging the Page again.
          </Alert>
        </div>
      )}
      {lead.needs_review && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warn" title="This inquiry needs the pharmaceutical team" icon="shield">
            Reasons: {lead.review_reasons.join(", ") || "flagged by staff"}.{" "}
            {reviewer
              ? "Answer within your professional judgement, then mark the review done."
              : "Replies you write go to them for approval before they're sent. Don't answer medical, prescription, regulatory or availability questions yourself."}
          </Alert>
        </div>
      )}

      <div className="grid g-side">
        <div className="stackv" style={{ gap: 20 }}>
          <div className="board">
            <div className="spread" style={{ marginBottom: 12 }}>
              <h2 className="section">Conversation</h2>
              {lead.inquiry && <Tag tone="mute">Form message included</Tag>}
            </div>
            {data.truncated?.messages && <p className="note mt0">Showing the latest 300 messages. Export the data to see the full conversation.</p>}
            {lead.inquiry && (
              <div className="bubble-msg in" style={{ marginBottom: 10 }}>
                {lead.inquiry}
                <span className="m">Website form · {fmtDate(lead.created_at, true)}</span>
              </div>
            )}
            <div className="thread" ref={threadRef}>
              {messages.length === 0 && !lead.inquiry && <p className="muted small">No messages.</p>}
              {messages.map((m) => (
                <div key={m.id} className={`bubble-msg ${m.direction} ${m.sender_type === "bot" ? "bot" : ""} ${m.status === "pending_review" ? "pending" : ""} ${["blocked", "failed", "rejected"].includes(m.status) ? m.status : ""}`}>
                  {m.body ?? <i className="muted">Message removed</i>}
                  <span className="m">
                    {m.direction === "in" ? "Customer" : m.sender_type === "bot" ? "Assistant (approved template)" : m.sender_name ?? "Team"} · {fmtDate(m.created_at, true)}
                    {m.masked ? " · contact details hidden" : ""}
                    {MSG_STATUS[m.status] ? ` · ${MSG_STATUS[m.status]}` : ""}
                    {m.error ? `: ${m.error}` : ""}
                    {m.reviewer_name ? ` · reviewed by ${m.reviewer_name}` : ""}
                  </span>
                  {m.status === "pending_review" && reviewer && !optedOut && (
                    <div className="row mt8" style={{ gap: 6 }}>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy === `ap${m.id}`}
                        disabled={!!busy}
                        onClick={() => void act(`ap${m.id}`, () => api(`/leads/${lead.id}/messages/${m.id}/approve`, { body: {} }), "Approved and sent")}
                      >
                        Approve and send
                      </Button>
                      <Button size="sm" disabled={!!busy} onClick={() => setEditing({ id: m.id, body: m.body ?? "" })}>
                        Edit first
                      </Button>
                      <Button size="sm" variant="quiet" disabled={!!busy} onClick={() => setRejecting({ id: m.id, reason: "" })}>
                        Don't send
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {can("leads.reply") && !closed && (
              <div className="mt24">
                <hr className="split" />
                {lead.source === "messenger" && appStatus?.messengerTestMode && (
                  <div style={{ marginBottom: 12 }}>
                    <Alert tone="info" title="Test mode">
                      Test mode: Messenger replies aren't really sent. They're recorded here as if they were.
                    </Alert>
                  </div>
                )}
                {lead.source === "messenger" && replyWindow && !replyWindow.ok && (
                  <div style={{ marginBottom: 12 }}>
                    <Alert tone="warn" title="Messenger won't allow a reply now">
                      {replyWindow.reason}
                    </Alert>
                  </div>
                )}
                {lead.source === "messenger" && replyWindow?.ok && replyWindow.tag && (
                  <div style={{ marginBottom: 12 }}>
                    <Alert tone="info">Outside the 24-hour window: this reply is sent with Meta's human agent tag, so it must be written by a person.</Alert>
                  </div>
                )}
                {lead.source !== "messenger" && (
                  <div style={{ marginBottom: 12 }}>
                    <Alert tone="info">
                      Reply by {CONTACT_LABEL[lead.contact_preference ?? "email"]}, then log what you sent here so the team can see it.
                    </Alert>
                  </div>
                )}
                <div className="row" style={{ alignItems: "flex-end" }}>
                  <div className="grow">
                    <SelectField
                      label="Start from an approved template"
                      value={templateId ?? ""}
                      onChange={(e) => {
                        const t = agentTemplates.find((x) => x.id === Number(e.target.value));
                        setTemplateId(t?.id ?? null);
                        if (t) setReply(fill(t.body));
                      }}
                      options={[{ value: "", label: "Write my own" }, ...agentTemplates.map((t) => ({ value: t.id, label: t.name }))]}
                    />
                  </div>
                  {data.aiSuggestions && (
                    <Button icon="spark" variant="soft" loading={busy === "suggest"} disabled={!!busy && busy !== "suggest"} onClick={suggest}>
                      Suggest a reply
                    </Button>
                  )}
                </div>
                <div className="mt16">
                  <TextArea
                    label={lead.source === "messenger" ? "Reply" : "What you sent"}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    rows={4}
                    maxLength={2000}
                    hint={suggestNote ?? (/\{\{\s*\w+\s*\}\}/.test(reply) ? "Placeholders like {{name}} are filled in when the reply is sent." : undefined)}
                  />
                </div>
                <div className="row mt16" style={{ justifyContent: "flex-end" }}>
                  <Button variant="primary" icon="send" loading={busy === "send"} disabled={!reply.trim() || (!!busy && busy !== "send") || (lead.source === "messenger" && !replyWindow?.ok)} onClick={send}>
                    {lead.needs_review && !reviewer ? "Send for approval" : lead.source === "messenger" ? "Send on Messenger" : "Log reply"}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="board">
            <h2 className="section">Activity</h2>
            {can("leads.manage") && !lead.anonymized_at && (
              <div className="row mt16" style={{ alignItems: "flex-end" }}>
                <div className="grow">
                  <TextField label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called the supplier, waiting for stock confirmation" />
                </div>
                <Button
                  size="sm"
                  disabled={!note.trim() || (!!busy && busy !== "note")}
                  loading={busy === "note"}
                  onClick={async () => {
                    if (await act("note", () => api(`/leads/${lead.id}/notes`, { body: { note } }), "Note added")) setNote("");
                  }}
                >
                  Add
                </Button>
              </div>
            )}
            {data.truncated?.activities && <p className="note">Showing the latest 300 entries.</p>}
            <ol className="timeline">
              {activities.map((a) => (
                <li key={a.id}>
                  <span className="ico">
                    <Icon name={a.type === "note" ? "edit" : a.type === "assign" ? "users" : a.type === "review" ? "shield" : a.type === "consent" ? "check" : "clock"} />
                  </span>
                  <div>
                    <b>{a.note ?? (lead.anonymized_at ? "Details removed" : a.type === "note" ? "Note removed" : a.type)}</b>
                    <div className="meta">{a.user_name ?? "System"}</div>
                  </div>
                  <time>{ago(a.created_at)}</time>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <aside className="stackv" style={{ gap: 16 }}>
          <div className="board">
            <div className="spread">
              <p className="label mb0">Contact</p>
              {!lead.anonymized_at && canReveal && (
                <Button size="sm" variant="quiet" icon="eye" loading={loading && reveal !== lead.revealed} onClick={() => setReveal((r) => !r)}>
                  {reveal ? "Hide" : "Show"}
                </Button>
              )}
            </div>
            <dl className="kv mt16">
              <dt>Name</dt>
              <dd>{lead.name ?? "—"}</dd>
              <dt>Email</dt>
              <dd>{lead.email ?? "—"}</dd>
              <dt>Phone</dt>
              <dd>{lead.phone ?? "—"}</dd>
              <dt>Prefers</dt>
              <dd>{lead.contact_preference ? CONTACT_LABEL[lead.contact_preference] : "—"}</dd>
              <dt>Country</dt>
              <dd>{lead.destination_country ?? "—"}</dd>
            </dl>
            {reveal && <p className="note">Viewing contact details is recorded in the audit log.</p>}
            {!canReveal && !lead.anonymized_at && <p className="note">Contact details are shown to the inquiry's owner. Assign it to yourself to see them.</p>}
          </div>

          {can("leads.manage") && !lead.anonymized_at && (
            <div className="board stackv">
              <p className="label mb0">Handling</p>
              <SelectField
                label="Status"
                value={lead.status}
                disabled={!!busy || statusOptions.length < 2}
                hint={optedOut ? "Opted out can't be changed by staff." : undefined}
                onChange={(e) => changeStatus(e.target.value)}
                options={statusOptions.map((value) => ({ value, label: LEAD_STATUS[value]?.label ?? value }))}
              />
              <SelectField
                label="Owner"
                value={lead.assigned_to ?? ""}
                disabled={!!busy}
                onChange={(e) => void update({ assigned_to: e.target.value ? Number(e.target.value) : null }, "Owner updated", "owner")}
                options={ownerOptions}
                hint={!can("leads.view_all") ? "You can take an inquiry yourself or hand it back." : undefined}
              />
              <SelectField
                label="Category"
                value={lead.category}
                disabled={!!busy}
                onChange={(e) => void update({ category: e.target.value }, "Category updated", "category")}
                options={[...categories, ...(categories.some((c) => c.value === lead.category) ? [] : [{ value: lead.category, label: lead.categoryLabel }])]}
              />
              <SelectField
                label="Priority"
                value={lead.priority}
                disabled={!!busy}
                onChange={(e) => void update({ priority: e.target.value }, "Priority updated", "priority")}
                options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))}
              />
              {!optedOut && (
                <FollowUpEditor
                  key={lead.follow_up_at ?? "none"}
                  value={lead.follow_up_at}
                  busy={busy === "followup"}
                  disabled={!!busy && busy !== "followup"}
                  onSave={(v) => update({ follow_up_at: v }, v ? "Follow-up set" : "Follow-up removed", "followup")}
                />
              )}
              {lead.needs_review && reviewer && (
                <Button variant="primary" icon="check" loading={busy === "review"} disabled={!!busy && busy !== "review"} onClick={() => void update({ needs_review: false }, "Review marked done", "review")}>
                  Mark review done
                </Button>
              )}
              {!lead.needs_review && !optedOut && (
                <Button variant="quiet" icon="shield" loading={busy === "review"} disabled={!!busy && busy !== "review"} onClick={() => void update({ needs_review: true }, "Sent to the pharmaceutical team", "review")}>
                  Ask the pharmaceutical team
                </Button>
              )}
            </div>
          )}

          <div className="board">
            <p className="label">Consent</p>
            {consents.length ? (
              <ol className="timeline" style={{ marginTop: 0 }}>
                {consents.map((c, i) => (
                  <li key={i}>
                    <span className="ico">
                      <Icon name={c.action === "granted" ? "check" : "x"} />
                    </span>
                    <div>
                      <b>{c.action === "granted" ? "Agreed" : c.action === "declined" ? "Declined" : "Withdrew"}</b>
                      <div className="meta">
                        {c.channel} · version {c.consent_version ?? "—"}
                      </div>
                    </div>
                    <time>{fmtDate(c.created_at)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted small">No consent recorded.</p>
            )}
          </div>
        </aside>
      </div>

      {confirmStatus && (
        <ConfirmModal
          title={confirmStatus === "opted_out" ? `Mark ${lead.ref} as opted out?` : `Close ${lead.ref}?`}
          warning={
            confirmStatus === "opted_out"
              ? "No more messages can be sent to this person, and staff can't undo it. Only they can restart, by messaging again."
              : "It leaves the open lists. You can reopen it later if they get back in touch."
          }
          confirmLabel={confirmStatus === "opted_out" ? "Mark as opted out" : "Close inquiry"}
          busy={busy === "status"}
          onClose={() => setConfirmStatus(null)}
          onConfirm={async () => {
            const ok = await update({ status: confirmStatus }, confirmStatus === "opted_out" ? "Marked as opted out" : "Inquiry closed", "status");
            if (ok) setConfirmStatus(null);
          }}
        >
          {confirmStatus === "opted_out" && <p className="small muted" style={{ margin: "0 0 8px" }}>Use this when the person asked us, by phone or in writing, to stop contacting them. It's recorded in their consent history.</p>}
        </ConfirmModal>
      )}
      {editing && (
        <Modal
          title="Edit, then approve and send"
          onClose={() => busy !== "edit" && setEditing(null)}
          actions={
            <>
              <Button variant="quiet" disabled={busy === "edit"} onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={busy === "edit"}
                disabled={!editing.body.trim()}
                onClick={async () => {
                  const ok = await act("edit", () => api(`/leads/${lead.id}/messages/${editing.id}/approve`, { body: { body: editing.body } }), "Approved and sent");
                  if (ok) setEditing(null); // on failure the dialog stays open with the edited text
                }}
              >
                Approve and send
              </Button>
            </>
          }
        >
          <TextArea label="Reply" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={6} />
        </Modal>
      )}
      {rejecting && (
        <Modal
          title="Don't send this reply"
          onClose={() => busy !== "reject" && setRejecting(null)}
          actions={
            <>
              <Button variant="quiet" disabled={busy === "reject"} onClick={() => setRejecting(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={rejecting.reason.trim().length < 2}
                loading={busy === "reject"}
                onClick={async () => {
                  const ok = await act("reject", () => api(`/leads/${lead.id}/messages/${rejecting.id}/reject`, { body: { reason: rejecting.reason } }), "Reply returned");
                  if (ok) setRejecting(null);
                }}
              >
                Return to the author
              </Button>
            </>
          }
        >
          <TextArea label="Why? (the author sees this)" value={rejecting.reason} onChange={(e) => setRejecting({ ...rejecting, reason: e.target.value })} rows={3} autoFocus />
        </Modal>
      )}
      {anonymise && (
        <ConfirmModal
          title={`Delete personal data in ${lead.ref}?`}
          confirmWord="delete"
          confirmLabel="Delete personal data"
          busy={busy === "anon"}
          onClose={() => busy !== "anon" && setAnonymise(false)}
          onConfirm={async () => {
            const ok = await act("anon", () => api(`/leads/${lead.id}/anonymize`, { body: { reason: anonReason } }), "Personal data deleted");
            if (ok) {
              setAnonymise(false);
              nav("/leads");
            }
          }}
        >
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--ink-3)" }}>
            Removed: name, email, phone, Messenger ID, medicine name, every message, note and activity detail. Kept: category, country, dates and the consent history, with no personal details.
          </p>
          <SelectField label="Reason" value={anonReason} onChange={(e) => setAnonReason(e.target.value)} options={ANON_REASONS} />
        </ConfirmModal>
      )}
    </>
  );
}

/** Follow-up date in Philippine time, saved with an explicit button (no save-on-blur). */
function FollowUpEditor({ value, busy, disabled, onSave }: { value: string | null; busy: boolean; disabled: boolean; onSave: (v: string | null) => Promise<boolean> }) {
  const current = toBizInput(value); // minute precision, Philippine time
  const [input, setInput] = useState(current);
  const parsed = fromBizInput(input);
  const invalid = !!input && !parsed;
  const changed = input !== current;
  return (
    <div className="stackv" style={{ gap: 6 }}>
      <div className="inq-followup">
        <TextField
          label={`Follow up (${BUSINESS_TZ_LABEL})`}
          type="datetime-local"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          error={invalid ? "Enter a full date and time" : undefined}
        />
        <Button size="sm" variant="primary" loading={busy} disabled={disabled || !changed || !parsed} onClick={() => void onSave(parsed)}>
          Save
        </Button>
        {value && (
          <Button size="sm" variant="quiet" disabled={disabled || busy} onClick={() => void onSave(null)}>
            Clear
          </Button>
        )}
      </div>
      {value && !changed && <span className="small muted">{fmtBiz(value)} ({BUSINESS_TZ_LABEL})</span>}
      {changed && input && parsed && (
        <span className="small muted">
          Not saved yet.{" "}
          <button type="button" className="linklike" style={{ background: "none", border: 0, padding: 0, color: "var(--deep)", cursor: "pointer" }} onClick={() => setInput(current)}>
            Undo
          </button>
        </span>
      )}
    </div>
  );
}
