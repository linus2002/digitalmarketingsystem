import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, CONTACT_LABEL, fmtDate, fromLocalInput, LEAD_STATUS, SOURCE_LABEL, toLocalInput } from "../lib/format";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icons";
import { Alert, Button, ConfirmModal, LoadError, Modal, PageHead, SelectField, Skeleton, StatusTag, Tag, TextArea, TextField } from "../components/ui";

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
  assigned_to: number | null;
  assigned_name: string | null;
  follow_up_at: string | null;
  consent_given: boolean;
  consent_at: string | null;
  consent_version: string | null;
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
  status: string;
  error: string | null;
  created_at: string;
}
interface Detail {
  lead: Lead;
  messages: Msg[];
  activities: { id: number; type: string; note: string | null; user_name: string | null; created_at: string }[];
  consents: { action: string; consent_version: string | null; channel: string; created_at: string }[];
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

const MSG_STATUS: Record<string, string> = {
  pending_review: "Waiting for pharmaceutical approval",
  blocked: "Not sent",
  failed: "Failed to send",
  rejected: "Not approved",
  logged: "Logged (sent outside this system)",
};

export function LeadDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const [reveal, setReveal] = useState(false);
  const { data, error, loading, reload } = useLoad(() => api<Detail>(`/leads/${id}`, { query: { reveal: reveal ? 1 : undefined } }), [id, reveal]);
  const templates = useLoad(() => api<{ templates: Template[] }>("/templates"), []);
  const users = useLoad(() => api<{ users: { id: number; name: string; role: string }[] }>("/users/directory"), []);

  const [reply, setReply] = useState("");
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [rejecting, setRejecting] = useState<{ id: number; reason: string } | null>(null);
  const [anonymise, setAnonymise] = useState(false);
  const [anonReason, setAnonReason] = useState("Person asked for their details to be deleted");
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [data?.messages.length]);

  if (loading && !data) return <Skeleton rows={5} />;
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return null;
  const { lead, messages, activities, consents, replyWindow } = data;
  const vars: Record<string, string> = {
    ref: lead.ref,
    medicine: lead.medicine_name ?? "the medicine",
    country: lead.destination_country ?? "your country",
    name: lead.name?.split(" ")[0] ?? "",
    business: "GetMeds",
  };
  const fill = (body: string) => body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
  const agentTemplates = (templates.data?.templates ?? []).filter((t) => !t.key && t.status === "approved");
  const reviewer = can("leads.review");
  const closed = !!lead.anonymized_at || lead.status === "opted_out";

  async function act(label: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(label);
    try {
      await fn();
      if (ok) toast.ok(ok);
      await reload();
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const update = (body: Record<string, unknown>, ok = "Saved") => act("update", () => api(`/leads/${lead.id}`, { method: "PATCH", body }), ok);

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
      setReply(r.suggestion.reply);
      setTemplateId(r.suggestion.templateId);
      setSuggestNote(`${r.suggestion.reason}${r.suggestion.needsPharmacist ? " · Needs pharmaceutical review before sending." : ""}`);
    } catch (e) {
      toast.err("No suggestion", (e as Error).message);
    } finally {
      setBusy(null);
    }
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

      {lead.anonymized_at && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="info" title={`Personal data removed ${fmtDate(lead.anonymized_at)}`}>Only anonymous details remain for reporting.</Alert>
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
                    {MSG_STATUS[m.status] ? ` · ${MSG_STATUS[m.status]}` : ""}
                    {m.error ? `: ${m.error}` : ""}
                    {m.reviewer_name ? ` · reviewed by ${m.reviewer_name}` : ""}
                  </span>
                  {m.status === "pending_review" && reviewer && (
                    <div className="row mt8" style={{ gap: 6 }}>
                      <Button size="sm" variant="primary" loading={busy === `ap${m.id}`} onClick={() => act(`ap${m.id}`, () => api(`/leads/${lead.id}/messages/${m.id}/approve`, { body: {} }), "Approved and sent")}>
                        Approve and send
                      </Button>
                      <Button size="sm" onClick={() => setEditing({ id: m.id, body: m.body ?? "" })}>
                        Edit first
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => setRejecting({ id: m.id, reason: "" })}>
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
                    <Button icon="spark" variant="soft" loading={busy === "suggest"} onClick={suggest}>
                      Suggest a reply
                    </Button>
                  )}
                </div>
                <div className="mt16">
                  <TextArea label={lead.source === "messenger" ? "Reply" : "What you sent"} value={reply} onChange={(e) => setReply(e.target.value)} rows={4} maxLength={2000} hint={suggestNote ?? undefined} />
                </div>
                <div className="row mt16" style={{ justifyContent: "flex-end" }}>
                  <Button variant="primary" icon="send" loading={busy === "send"} disabled={!reply.trim() || (lead.source === "messenger" && !replyWindow?.ok)} onClick={send}>
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
                <Button size="sm" disabled={!note.trim()} loading={busy === "note"} onClick={() => act("note", () => api(`/leads/${lead.id}/notes`, { body: { note } }).then(() => setNote("")), "Note added")}>
                  Add
                </Button>
              </div>
            )}
            <ol className="timeline">
              {activities.map((a) => (
                <li key={a.id}>
                  <span className="ico">
                    <Icon name={a.type === "note" ? "edit" : a.type === "assign" ? "users" : a.type === "review" ? "shield" : a.type === "consent" ? "check" : "clock"} />
                  </span>
                  <div>
                    <b>{a.note ?? (a.type === "note" ? "Note removed" : a.type)}</b>
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
              {!lead.anonymized_at && (
                <Button size="sm" variant="quiet" icon="eye" onClick={() => setReveal((r) => !r)}>
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
          </div>

          {can("leads.manage") && !lead.anonymized_at && (
            <div className="board stackv">
              <p className="label mb0">Handling</p>
              <SelectField label="Status" value={lead.status} onChange={(e) => update({ status: e.target.value }, "Status updated")} options={Object.entries(LEAD_STATUS).filter(([k]) => !["awaiting_consent", "collecting"].includes(k) || k === lead.status).map(([value, s]) => ({ value, label: s.label }))} />
              <SelectField
                label="Owner"
                value={lead.assigned_to ?? ""}
                onChange={(e) => update({ assigned_to: e.target.value ? Number(e.target.value) : null }, "Owner updated")}
                options={[
                  { value: "", label: "Unassigned" },
                  ...(users.data?.users ?? []).filter((u) => ["pharma_team", "lead_agent", "admin"].includes(u.role)).map((u) => ({ value: u.id, label: u.name })),
                ]}
              />
              <SelectField
                label="Category"
                value={lead.category}
                onChange={(e) => update({ category: e.target.value }, "Category updated")}
                options={[
                  ["product_availability", "Availability"],
                  ["pricing_quote", "Price or quote"],
                  ["prescription", "Prescription"],
                  ["medical_question", "Medical question"],
                  ["regulatory_import", "Regulatory / import"],
                  ["shipping_logistics", "Shipping"],
                  ["order_status", "Order status"],
                  ["privacy_request", "Privacy request"],
                  ["general", "General"],
                ].map(([value, label]) => ({ value, label }))}
              />
              <SelectField label="Priority" value={lead.priority} onChange={(e) => update({ priority: e.target.value }, "Priority updated")} options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))} />
              <TextField
                label="Follow up"
                type="datetime-local"
                defaultValue={toLocalInput(lead.follow_up_at)}
                key={lead.follow_up_at ?? "none"}
                onBlur={(e) => {
                  const v = fromLocalInput(e.target.value);
                  if (v !== (lead.follow_up_at ? new Date(lead.follow_up_at).toISOString() : null)) void update({ follow_up_at: v }, "Follow-up set");
                }}
              />
              {lead.needs_review && reviewer && (
                <Button variant="primary" icon="check" onClick={() => update({ needs_review: false }, "Review marked done")}>
                  Mark review done
                </Button>
              )}
              {!lead.needs_review && (
                <Button variant="quiet" icon="shield" onClick={() => update({ needs_review: true }, "Sent to the pharmaceutical team")}>
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

      {editing && (
        <Modal
          title="Edit, then approve and send"
          onClose={() => setEditing(null)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={busy === "edit"}
                onClick={() => act("edit", () => api(`/leads/${lead.id}/messages/${editing.id}/approve`, { body: { body: editing.body } }), "Approved and sent").then(() => setEditing(null))}
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
          onClose={() => setRejecting(null)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setRejecting(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={rejecting.reason.trim().length < 2}
                loading={busy === "reject"}
                onClick={() => act("reject", () => api(`/leads/${lead.id}/messages/${rejecting.id}/reject`, { body: { reason: rejecting.reason } }), "Reply returned").then(() => setRejecting(null))}
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
          onClose={() => setAnonymise(false)}
          onConfirm={() =>
            act("anon", () => api(`/leads/${lead.id}/anonymize`, { body: { reason: anonReason } }), "Personal data deleted").then(() => {
              setAnonymise(false);
              nav("/leads");
            })
          }
        >
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--ink-3)" }}>Removed: name, email, phone, Messenger ID, medicine name, every message and note. Kept: category, country, dates and the consent history, with no personal details.</p>
          <TextField label="Reason" value={anonReason} onChange={(e) => setAnonReason(e.target.value)} />
        </ConfirmModal>
      )}
    </>
  );
}
