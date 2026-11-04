import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, CONTACT_LABEL, LEAD_STATUS, SOURCE_LABEL } from "../lib/format";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icons";
import { Alert, Avatar, Button, Check, Empty, KpiCard, LoadError, Modal, PageHead, SearchInput, Seg, SelectField, Skeleton, StatusTag, Tag, TextArea, TextField } from "../components/ui";

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
  stats: { open: number; new: number; needs_review: number; unassigned: number; overdue: number; this_week: number; pending_replies: number };
  categories: { value: string; label: string }[];
}

type View = "all" | "review" | "mine" | "unassigned" | "followups" | "closed";

export function LeadsPage() {
  const { can } = useAuth();
  // Open on all open inquiries so nothing looks missing; "Needs review" is one click away
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const stats = useLoad(() => api<Stats>("/leads/stats"), []);
  const { data, error, loading, reload } = useLoad(() => api<{ leads: LeadRow[] }>("/leads", { query: { view, q, category } }), [view, q, category]);
  const s = stats.data?.stats;

  return (
    <>
      <PageHead
        title="Inquiries"
        sub="People who messaged the Page or used the website form about a medicine. Prescription, medical, regulatory and availability questions go to the pharmaceutical team before anyone replies."
        actions={can("leads.manage") && <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add an inquiry</Button>}
      />
      {s && (
        <div className="grid g4" style={{ marginBottom: 24 }}>
          <KpiCard strong title="Open" sub={`${s.this_week} new this week`} value={s.open} note={`${s.unassigned} not assigned yet`} />
          <KpiCard
            title="Needs pharmaceutical review"
            sub="Inquiries and drafted replies"
            value={s.needs_review + s.pending_replies}
            tag={s.pending_replies ? <Tag tone="warn" dot>{s.pending_replies} replies waiting approval</Tag> : undefined}
          />
          <KpiCard title="Follow-ups overdue" sub="Past their follow-up date" value={s.overdue} tag={s.overdue ? <Tag tone="bad" dot>Overdue</Tag> : <Tag tone="good" dot>On track</Tag>} />
          <KpiCard title="New" sub="Not yet picked up" value={s.new} />
        </div>
      )}
      <div className="table-wrap">
        <div className="toolbar">
          <div className="row">
            <SearchInput value={q} onChange={setQ} placeholder="Search medicine, country or INQ number" />
            <select className="select" style={{ height: 40, width: 220 }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
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
            onChange={setView}
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
        ) : (
          <Empty title="No inquiries here">{view === "review" ? "Nothing is waiting for the pharmaceutical team." : "Inquiries from Messenger and the website form appear here."}</Empty>
        )}
      </div>
      {adding && <AddLeadModal categories={stats.data?.categories ?? []} onClose={() => setAdding(false)} />}
    </>
  );
}

function AddLeadModal({ onClose }: { categories: { value: string; label: string }[]; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [f, setF] = useState({ name: "", email: "", phone: "", medicine_name: "", destination_country: "", contact_preference: "email", inquiry: "" });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: number; ref: string }>("/leads", { body: { ...f, email: f.email || undefined, phone: f.phone || undefined, consent_confirmed: consent } });
      toast.ok(`Inquiry ${r.ref} added`);
      nav(`/leads/${r.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title="Add an inquiry"
      onClose={onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!consent || !f.medicine_name || !f.destination_country} onClick={save}>
            Add inquiry
          </Button>
        </>
      }
    >
      <p className="muted mt0">For inquiries that came by phone or in person. Collect only what's needed to answer.</p>
      {err && <Alert tone="bad">{err}</Alert>}
      <div className="grid g2 mt16">
        <TextField label="Medicine" value={f.medicine_name} onChange={set("medicine_name")} autoFocus />
        <TextField label="Destination country" value={f.destination_country} onChange={set("destination_country")} />
        <TextField label="Name" optional value={f.name} onChange={set("name")} />
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
        <TextField label="Email" optional type="email" value={f.email} onChange={set("email")} />
        <TextField label="Phone" optional value={f.phone} onChange={set("phone")} placeholder="+63 …" />
      </div>
      <div className="mt16">
        <TextArea label="What they asked" optional value={f.inquiry} onChange={set("inquiry")} rows={3} hint="Don't record diagnoses or medical history." />
      </div>
      <div className="mt16">
        <Check label="The person agreed that we keep these details to answer their inquiry." checked={consent} onChange={setConsent} />
      </div>
    </Modal>
  );
}
