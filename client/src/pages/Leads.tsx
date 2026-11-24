import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, CONTACT_LABEL, LEAD_STATUS, SOURCE_LABEL } from "../lib/format";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icons";
import { Alert, Avatar, Button, Check, Empty, KpiCard, LoadError, Modal, PageHead, SearchInput, Seg, SelectField, Skeleton, StatusTag, Tag, TextArea, TextField } from "../components/ui";
import "../styles/inquiries.css";

interface LeadRow {
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
  assigned_name: string | null;
  follow_up_at: string | null;
  last_activity_at: string;
  pending_reviews: number;
}
interface Stats {
  stats: { open: number; new: number; needs_review: number; unassigned: number; followups: number; overdue: number; this_week: number; pending_replies: number };
  byCategory: { category: string; label: string; n: number }[];
  categories: { value: string; label: string }[];
}

type View = "all" | "review" | "mine" | "unassigned" | "followups" | "closed";
const VIEWS: View[] = ["all", "review", "mine", "unassigned", "followups", "closed"];

/** Maps zod issues from the server ({ path, message }[]) to field errors. */
function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const details = e instanceof ApiError ? e.details : null;
  if (Array.isArray(details))
    for (const d of details as { path?: (string | number)[]; message?: string }[]) {
      const k = d.path?.[0];
      if (k !== undefined && d.message && !out[String(k)]) out[String(k)] = d.message;
    }
  return out;
}

export function LeadsPage() {
  const { can } = useAuth();
  // Tab, category and search live in the URL (?filter=review&category=…&q=…) so links and the nav badge land on the right view.
  const [params, setParams] = useSearchParams();
  const rawView = params.get("filter") as View | null;
  const view: View = rawView && VIEWS.includes(rawView) ? rawView : "all";
  const category = params.get("category") ?? "";
  const q = params.get("q") ?? "";
  const [qInput, setQInput] = useState(q);
  const [adding, setAdding] = useState(false);

  const setParam = (k: string, v: string | null) =>
    setParams(
      (cur) => {
        const next = new URLSearchParams(cur);
        if (v) next.set(k, v);
        else next.delete(k);
        return next;
      },
      { replace: k === "q" },
    );

  // Search waits until typing pauses (300 ms) so every keystroke doesn't hit the server.
  useEffect(() => {
    if (qInput === q) return;
    const t = setTimeout(() => setParam("q", qInput.trim() || null), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);
  // Back/forward or a link changed the search: show it in the box.
  useEffect(() => setQInput(q), [q]);

  const stats = useLoad(() => api<Stats>("/leads/stats"), []);
  const { data, error, loading, reload } = useLoad(() => api<{ leads: LeadRow[] }>("/leads", { query: { view, q, category } }), [view, q, category]);
  const s = stats.data?.stats;
  const refreshing = loading && !!data;
  const viewLink = (v: View) => `/leads?filter=${v}`;

  return (
    <>
      <PageHead
        title="Inquiries"
        sub="People who messaged the Page or used the website form about a medicine. Prescription, medical, regulatory and availability questions go to the pharmaceutical team before anyone replies."
        actions={can("leads.manage") && <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add an inquiry</Button>}
      />
      {stats.error && (
        <div style={{ marginBottom: 16 }}>
          <LoadError error={stats.error} retry={stats.reload} />
        </div>
      )}
      {s && (
        <div className="grid g4" style={{ marginBottom: 16 }}>
          <KpiCard strong title="Open" sub={`${s.this_week} new this week`} value={s.open} note={`${s.new} not picked up yet`} to={viewLink("all")} />
          <KpiCard
            title="Needs pharmaceutical review"
            sub="Flagged inquiries, or with a reply waiting approval"
            value={s.needs_review}
            tag={s.pending_replies ? <Tag tone="warn" dot>{s.pending_replies} {s.pending_replies === 1 ? "reply" : "replies"} waiting approval</Tag> : undefined}
            to={viewLink("review")}
          />
          <KpiCard
            title="Follow-ups due"
            sub="Overdue, or due in the next 24 hours"
            value={s.followups}
            tag={s.overdue ? <Tag tone="bad" dot>{s.overdue} overdue</Tag> : <Tag tone="good" dot>None overdue</Tag>}
            to={viewLink("followups")}
          />
          <KpiCard title="Unassigned" sub="Open, with no owner yet" value={s.unassigned} to={viewLink("unassigned")} />
        </div>
      )}
      {stats.data && stats.data.byCategory.length > 0 && (
        <div className="board" style={{ marginBottom: 24, padding: "16px 20px" }}>
          <p className="label mb0">Open inquiries by category</p>
          <div className="inq-cats" role="group" aria-label="Filter by category">
            {stats.data.byCategory.map((c) => (
              <button key={c.category} type="button" className="inq-cat" aria-pressed={category === c.category} onClick={() => setParam("category", category === c.category ? null : c.category)}>
                {c.label} <b>{c.n}</b>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={`table-wrap ${refreshing ? "inq-loading" : ""}`} aria-busy={loading || undefined}>
        <div className="toolbar">
          <div className="row">
            <SearchInput value={qInput} onChange={setQInput} placeholder="Search medicine, country or INQ number" />
            <select className="select" style={{ height: 40, width: 220 }} value={category} onChange={(e) => setParam("category", e.target.value || null)} aria-label="Category">
              <option value="">All categories</option>
              {stats.data?.categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <Seg
            label="View"
            value={view}
            onChange={(v) => setParam("filter", v === "all" ? null : v)}
            options={[
              { value: "review", label: "Needs review" },
              { value: "mine", label: "Mine" },
              { value: "unassigned", label: "Unassigned" },
              { value: "followups", label: "Follow-ups" },
              { value: "all", label: "All open" },
              { value: "closed", label: "Closed" },
            ]}
          />
        </div>
        {refreshing && (
          <div className="inq-loading-label" role="status">
            <span className="spin" /> Loading…
          </div>
        )}
        {error && (
          <div style={{ padding: 16 }}>
            <LoadError error={error} retry={reload} />
          </div>
        )}
        {loading && !data ? (
          <div style={{ padding: 18 }}>
            <Skeleton />
          </div>
        ) : data?.leads.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Inquiry</th>
                  <th>Destination</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Owner</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {data.leads.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <div className="cell-who">
                        <span className="ico" style={{ width: 36, height: 36 }}>
                          <Icon name={l.source === "messenger" ? "msg" : l.source === "website" ? "globe" : "phone"} />
                        </span>
                        <div>
                          <Link className="name" to={`/leads/${l.id}`}>
                            {l.medicine_name ?? "Medicine not given"}
                          </Link>
                          <span className="sub">
                            <span className="code">{l.ref}</span> {SOURCE_LABEL[l.source]}
                            {l.contact_preference ? ` · prefers ${CONTACT_LABEL[l.contact_preference]}` : ""}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>{l.destination_country ?? <span className="muted">—</span>}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <Tag tone="outline">{l.categoryLabel}</Tag>
                        {l.needs_review && (
                          <Tag tone="warn" dot title={l.review_reasons.join(", ")}>
                            Review
                          </Tag>
                        )}
                        {l.pending_reviews > 0 && <Tag tone="info">{l.pending_reviews} reply waiting</Tag>}
                        {(l.priority === "high" || l.priority === "urgent") && <Tag tone="bad">{l.priority}</Tag>}
                      </div>
                    </td>
                    <td>
                      <StatusTag map={LEAD_STATUS} value={l.status} />
                    </td>
                    <td>
                      {l.assigned_name ? (
                        <span className="row" style={{ gap: 8 }}>
                          <Avatar name={l.assigned_name} size="sm" white />
                          {l.assigned_name}
                        </span>
                      ) : (
                        <span className="muted">Unassigned</span>
                      )}
                    </td>
                    <td className="nowrap">
                      {ago(l.last_activity_at)}
                      {l.follow_up_at && (
                        <div className="sub" style={{ color: new Date(l.follow_up_at) < new Date() ? "var(--bad)" : undefined }}>
                          Follow up {ago(l.follow_up_at)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !error ? (
          <Empty title="No inquiries here">
            {q || category
              ? "Nothing matches this search or category. Clear the filters to see more."
              : view === "review"
                ? "Nothing is waiting for the pharmaceutical team."
                : "Inquiries from Messenger and the website form appear here."}
          </Empty>
        ) : null}
      </div>
      {adding && (
        <AddLeadModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void reload();
            void stats.reload();
          }}
        />
      )}
    </>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function AddLeadModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [f, setF] = useState({ name: "", email: "", phone: "", medicine_name: "", destination_country: "", contact_preference: "email", inquiry: "" });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const byEmail = f.contact_preference === "email";

  function validate() {
    const e: Record<string, string> = {};
    if (!f.medicine_name.trim()) e.medicine_name = "Enter the medicine";
    if (!f.destination_country.trim()) e.destination_country = "Enter the country";
    if (byEmail && !EMAIL_RE.test(f.email.trim())) e.email = f.email.trim() ? "That doesn't look like an email address" : "Enter the email address to reply to";
    if (!byEmail && f.phone.replace(/\D/g, "").length < 7) e.phone = f.phone.trim() ? "Enter the full number, with the country code" : "Enter the phone number to use";
    if (!consent) e.consent_confirmed = "Confirm the person agreed to us keeping their details";
    return e;
  }
  const shown = tried ? { ...validate(), ...errs } : errs;

  async function save() {
    setTried(true);
    setErr(null);
    setErrs({});
    if (Object.keys(validate()).length) return;
    setBusy(true);
    try {
      const r = await api<{ id: number; ref: string; visible?: boolean }>("/leads", {
        body: {
          name: f.name.trim() || undefined,
          medicine_name: f.medicine_name.trim(),
          destination_country: f.destination_country.trim(),
          contact_preference: f.contact_preference,
          inquiry: f.inquiry.trim() || undefined,
          // Only the contact detail for the chosen method is sent and kept.
          email: byEmail ? f.email.trim() : undefined,
          phone: byEmail ? undefined : f.phone.trim(),
          consent_confirmed: consent,
        },
      });
      if (r.visible === false) {
        toast.ok(`Inquiry ${r.ref} added`, "It needs the pharmaceutical team, so it was assigned to them.");
        onAdded();
      } else {
        toast.ok(`Inquiry ${r.ref} added`);
        nav(`/leads/${r.id}`);
      }
    } catch (e) {
      const fe = fieldErrors(e);
      setErrs(fe);
      if (!Object.keys(fe).length) setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title="Add an inquiry"
      onClose={busy ? () => undefined : onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {busy ? "Adding…" : "Add inquiry"}
          </Button>
        </>
      }
    >
      <p className="muted mt0">For inquiries that came by phone or in person. Collect only what's needed to answer.</p>
      {err && <Alert tone="bad">{err}</Alert>}
      <div className="grid g2 mt16">
        <TextField label="Medicine" value={f.medicine_name} onChange={set("medicine_name")} autoFocus error={shown.medicine_name} required />
        <TextField label="Destination country" value={f.destination_country} onChange={set("destination_country")} error={shown.destination_country} required />
        <TextField label="Name" optional value={f.name} onChange={set("name")} error={shown.name} />
        <SelectField
          label="Contact by"
          value={f.contact_preference}
          onChange={set("contact_preference")}
          options={[
            { value: "email", label: "Email" },
            { value: "phone", label: "Phone call" },
            { value: "whatsapp", label: "WhatsApp" },
          ]}
        />
        {byEmail ? (
          <TextField label="Email" type="email" value={f.email} onChange={set("email")} error={shown.email} required />
        ) : (
          <TextField label={f.contact_preference === "whatsapp" ? "WhatsApp number" : "Phone"} value={f.phone} onChange={set("phone")} placeholder="+63 917 123 4567" error={shown.phone} required />
        )}
      </div>
      <div className="mt16">
        <TextArea label="What they asked" optional value={f.inquiry} onChange={set("inquiry")} rows={3} hint="Don't record diagnoses or medical history." error={shown.inquiry} />
      </div>
      <div className="mt16">
        <Check label="The person agreed that we keep these details to answer their inquiry." checked={consent} onChange={setConsent} />
        {shown.consent_confirmed && (
          <p className="small" style={{ color: "var(--bad)", margin: "6px 0 0" }} role="alert">
            {shown.consent_confirmed}
          </p>
        )}
      </div>
    </Modal>
  );
}
