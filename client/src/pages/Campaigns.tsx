import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { BUSINESS_TZ_LABEL, CAMPAIGN_STATUS, fmtBiz, fmtCompact, fmtNum, POST_STATUS } from "../lib/format";
import { useToast } from "../components/Toast";
import { Button, Empty, KpiCard, LoadError, Modal, PageHead, SelectField, Skeleton, StatusTag, TextArea, TextField } from "../components/ui";
import { Icon } from "../components/Icons";

/** Formats a DATE column ("YYYY-MM-DD") as that calendar day, never shifted by the viewer's time zone. */
function fmtDay(v: string | null | undefined) {
  if (!v) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
}
const fmtRange = (a: string | null, b: string | null) => (a || b ? `${fmtDay(a)} – ${fmtDay(b)}` : "No dates");
/** Start of a Philippine calendar day, in ms. */
const phDayStart = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00+08:00`);

interface Campaign {
  id: number;
  name: string;
  objective: string | null;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  posts_total: number;
  posts_published: number;
  posts_scheduled: number;
  posts_failed: number;
  reach: number;
  impressions: number;
  reactions: number;
  comments: number;
  shares: number;
  clicks: number;
}

function CampaignForm({ initial, onClose, onSaved }: { initial?: Campaign; onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: initial?.name ?? "",
    objective: initial?.objective ?? "",
    description: initial?.description ?? "",
    start_date: initial?.start_date ?? "",
    end_date: initial?.end_date ?? "",
    status: initial?.status ?? "planned",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const dateErr = f.start_date && f.end_date && f.end_date < f.start_date ? "The end date can't be before the start date." : null;
  async function save() {
    if (dateErr) return;
    setBusy(true);
    try {
      const body = { ...f, start_date: f.start_date || null, end_date: f.end_date || null, objective: f.objective || null, description: f.description || null };
      const r = initial
        ? await api<{ campaign: Campaign }>(`/campaigns/${initial.id}`, { method: "PATCH", body })
        : await api<{ campaign: Campaign }>("/campaigns", { body });
      toast.ok(initial ? "Campaign saved" : "Campaign created");
      onSaved(r.campaign.id);
    } catch (e) {
      toast.err("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={initial ? "Edit campaign" : "New campaign"}
      onClose={onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!f.name.trim() || !!dateErr} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="stackv">
        <TextField label="Name" value={f.name} onChange={set("name")} autoFocus />
        <TextField label="Objective" optional value={f.objective} onChange={set("objective")} placeholder="e.g. Raise awareness of cervical cancer screening" />
        <TextArea label="Description" optional value={f.description} onChange={set("description")} rows={4} />
        <div className="grid g2">
          <TextField label="Starts" optional type="date" value={f.start_date} onChange={set("start_date")} max={f.end_date || undefined} />
          <TextField label="Ends" optional type="date" value={f.end_date} onChange={set("end_date")} min={f.start_date || undefined} error={dateErr} />
        </div>
        <SelectField label="Status" value={f.status} onChange={set("status")} options={Object.entries(CAMPAIGN_STATUS).map(([value, s]) => ({ value, label: s.label }))} />
      </div>
    </Modal>
  );
}

export function CampaignsPage() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api<{ campaigns: Campaign[] }>("/campaigns"), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead
        title="Campaigns"
        sub="Group posts around a goal and see how the campaign performs."
        actions={can("campaigns.manage") && <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New campaign</Button>}
      />
      {error && <LoadError error={error} retry={reload} />}
      {loading && !data && <Skeleton />}
      {data && !data.campaigns.length && (
        <div className="board">
          <Empty title="No campaigns yet" action={can("campaigns.manage") && <Button variant="primary" size="sm" icon="plus" onClick={() => setOpen(true)}>New campaign</Button>}>
            The AI studio can suggest campaign ideas from a trending topic.
          </Empty>
        </div>
      )}
      {data && data.campaigns.length > 0 && (
        <div className="table-wrap">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Dates</th>
                  <th>Status</th>
                  <th className="num">Posts</th>
                  <th className="num">Reach</th>
                  <th className="num">Engagement</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link className="name" to={`/campaigns/${c.id}`}>
                        {c.name}
                      </Link>
                      <span className="sub">{c.objective}</span>
                    </td>
                    <td className="nowrap">{fmtRange(c.start_date, c.end_date)}</td>
                    <td>
                      <StatusTag map={CAMPAIGN_STATUS} value={c.status} />
                    </td>
                    <td className="num">
                      {c.posts_published}/{c.posts_total}
                      {c.posts_failed > 0 && <div className="sub" style={{ color: "var(--bad)" }}>{c.posts_failed} failed</div>}
                    </td>
                    <td className="num">{fmtCompact(c.reach)}</td>
                    <td className="num">{fmtCompact(c.reactions + c.comments + c.shares)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {open && <CampaignForm onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void reload(); }} />}
    </>
  );
}

export function CampaignDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, error, loading, reload } = useLoad(
    () => api<{ campaign: Campaign; posts: { id: number; title: string; status: string; scheduled_at: string | null; published_at: string | null; reach: number | null; reactions: number | null; comments: number | null; shares: number | null; permalink_url: string | null }[] }>(`/campaigns/${id}`),
    [id],
  );
  const [edit, setEdit] = useState(false);
  if (loading && !data) return <Skeleton rows={4} />;
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return null;
  const c = data.campaign;
  const engagement = c.reactions + c.comments + c.shares;
  const now = Date.now();
  const from = { from: { to: `/campaigns/${c.id}`, label: c.name } };
  const elapsed =
    c.start_date && c.end_date
      ? Math.max(0, Math.min(100, ((now - phDayStart(c.start_date)) / (phDayStart(c.end_date) + 86400_000 - phDayStart(c.start_date))) * 100))
      : undefined;
  return (
    <>
      <PageHead
        crumbs={[{ to: "/campaigns", label: "Campaigns" }, { label: c.name }]}
        title={c.name}
        sub={
          <>
            <StatusTag map={CAMPAIGN_STATUS} value={c.status} /> {fmtRange(c.start_date, c.end_date)}
            {c.objective ? ` · ${c.objective}` : ""}
          </>
        }
        actions={
          <>
            {can("campaigns.manage") && <Button onClick={() => setEdit(true)} icon="edit">Edit</Button>}
            {can("posts.edit") && (
              <Link to={`/posts/new?campaign=${c.id}`} state={from} className="btn btn-primary">
                <Icon name="plus" />
                Add a post
              </Link>
            )}
          </>
        }
      />
      <div className="grid g4">
        <KpiCard strong title="Posts published" sub={`${c.posts_scheduled} scheduled`} value={`${c.posts_published}/${c.posts_total}`} ring={c.posts_total ? (c.posts_published / c.posts_total) * 100 : 0} />
        <KpiCard title="Reach" sub="Unique people (sum per post)" value={fmtCompact(c.reach)} />
        <KpiCard title="Engagement" sub="Reactions, comments, shares" value={fmtCompact(engagement)} note={c.reach ? `${((engagement / c.reach) * 100).toFixed(1)}% of reach` : undefined} />
        <KpiCard title="Time elapsed" sub="Of the campaign dates" value={elapsed !== undefined ? `${Math.round(elapsed)}%` : "—"} bar={elapsed} behind={elapsed !== undefined && c.posts_total > 0 && c.posts_published / c.posts_total < elapsed / 100 - 0.15} />
      </div>
      {c.description && (
        <div className="board mt24">
          <p className="label">About</p>
          <p className="pre mt0 mb0">{c.description}</p>
        </div>
      )}
      <div className="table-wrap mt24">
        {data.posts.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Status</th>
                  <th>Date ({BUSINESS_TZ_LABEL})</th>
                  <th className="num">Reach</th>
                  <th className="num">Reactions</th>
                  <th className="num">Comments</th>
                  <th className="num">Shares</th>
                </tr>
              </thead>
              <tbody>
                {data.posts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link className="name" to={`/posts/${p.id}`} state={from}>
                        {p.title}
                      </Link>
                    </td>
                    <td>
                      <StatusTag map={POST_STATUS} value={p.status} />
                    </td>
                    <td className="nowrap">{fmtBiz(p.published_at ?? p.scheduled_at)}</td>
                    <td className="num">{fmtNum(p.reach)}</td>
                    <td className="num">{fmtNum(p.reactions)}</td>
                    <td className="num">{fmtNum(p.comments)}</td>
                    <td className="num">{fmtNum(p.shares)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No posts in this campaign">Add a post, or pick this campaign when saving from the AI studio.</Empty>
        )}
      </div>
      {edit && <CampaignForm initial={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); void reload(); }} />}
    </>
  );
}
