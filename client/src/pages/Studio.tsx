import { useEffect, useRef, useState } from "react";
import { Generating } from "../components/Generating";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { bizToday } from "../lib/format";
import { useToast } from "../components/Toast";
import { Alert, Button, Check, Empty, Modal, PageHead, Seg, SelectField, TextArea, TextField, Tag } from "../components/ui";
import "../styles/content.css";

type Kind = "captions" | "campaign_ideas" | "hashtags" | "image_prompts";
interface Item {
  title?: string;
  caption?: string;
  hashtags?: string[];
  suggestedDisclaimer?: string | null;
  name?: string;
  objective?: string;
  description?: string;
  posts?: string[];
  weeks?: number;
  group?: string;
  tag?: string;
  prompt?: string;
  alt_text?: string;
  issues: string[];
}
interface Status {
  ai: { provider: "anthropic" | "ollama"; label: string; model: string; ready: boolean; problem?: string; fix?: string };
}
/** What a result was generated from (the form may have changed since). */
interface Input {
  topic: string;
  notes: string;
}

const KIND_LABEL: Record<Kind, string> = { captions: "Captions", campaign_ideas: "Campaign ideas", hashtags: "Hashtags", image_prompts: "Image prompts" };

// Posts hold at most 5,000 characters including the disclaimer, so captions stop at about 600 words (the server enforces the same).
const LENGTHS = [
  { value: 80, label: "Short (about 80 words)" },
  { value: 150, label: "Medium (about 150 words)" },
  { value: 300, label: "Long (about 300 words)" },
  { value: 450, label: "Article (about 450 words)" },
  { value: 600, label: "Long article (about 600 words, the most a post can hold)" },
];

/** POST with a way to cancel; the server stops writing when the connection closes. Mirrors api() error handling. */
async function postCancellable<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach the server. Check that it's running.");
  }
  const data = res.headers.get("content-type")?.includes("application/json") ? await res.json().catch(() => null) : null;
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

/** Copies text, falling back to a hidden text box where the Clipboard API isn't available (plain HTTP). */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy refused");
  } finally {
    document.body.removeChild(ta);
  }
}

export function StudioPage() {
  const [params] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const status = useLoad(() => api<Status>("/studio/status"), []);
  const campaigns = useLoad(() => api<{ campaigns: { id: number; name: string; status: string }[] }>("/campaigns"), []);
  const brand = useLoad(() => api<{ brand: { requiredDisclaimer: string } }>("/settings/brand"), []);

  const [kind, setKind] = useState<Kind>("captions");
  const [topic, setTopic] = useState(params.get("topic") ?? "");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("Warm and informative");
  const [notes, setNotes] = useState(params.get("notes") ?? "");
  const [count, setCount] = useState(2);
  const [words, setWords] = useState(80);
  // Load the local model as soon as the studio opens, so Generate starts writing straight away.
  useEffect(() => {
    api("/studio/warm", { body: {} }).catch(() => undefined);
  }, []);
  // "Create content" on the Trends page links here with ?topic=&notes=; follow it on every visit, not just the first.
  const qTopic = params.get("topic");
  const qNotes = params.get("notes");
  useEffect(() => {
    if (qTopic === null && qNotes === null) return;
    if (qTopic !== null) setTopic(qTopic);
    setNotes(qNotes ?? "");
  }, [qTopic, qNotes]);

  const [campaignId, setCampaignId] = useState<string>("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [resultKind, setResultKind] = useState<Kind>("captions");
  const [resultInput, setResultInput] = useState<Input>({ topic: "", notes: "" });
  const [busyKind, setBusyKind] = useState<Kind | null>(null);
  const busy = busyKind !== null;
  const [err, setErr] = useState<string | null>(null);
  // The disclaimer box starts ticked when the brand guidelines require a disclaimer.
  const [addDisclaimer, setAddDisclaimer] = useState(true);
  const requiredDisclaimer = brand.data?.brand.requiredDisclaimer ?? "";
  useEffect(() => {
    if (brand.data) setAddDisclaimer(Boolean(brand.data.brand.requiredDisclaimer));
  }, [brand.data]);
  const [saving, setSaving] = useState<number | null>(null);
  const [toBatch, setToBatch] = useState<Item | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Stop a running generation if the person leaves the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function generate() {
    const ac = new AbortController();
    abortRef.current = ac;
    const asked: Input = { topic, notes };
    setBusyKind(kind);
    setErr(null);
    try {
      const r = await postCancellable<{ items: Item[]; durationMs: number }>(
        "/studio/generate",
        { kind, topic, audience: audience || undefined, tone: tone || undefined, notes: notes || undefined, count, ...(kind === "captions" ? { words } : {}) },
        ac.signal,
      );
      setItems(r.items);
      setResultKind(kind);
      setResultInput(asked);
      if (!r.items.length) setErr("The model didn't return any usable ideas. Try rewording the topic.");
    } catch (e) {
      if ((e as Error).name === "AbortError") toast.ok("Stopped", "Nothing was generated.");
      else setErr((e as Error).message);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setBusyKind(null);
    }
  }

  const cancel = () => abortRef.current?.abort();

  async function saveDraft(item: Item, i: number) {
    setSaving(i);
    try {
      const message = addDisclaimer && item.suggestedDisclaimer ? `${item.caption}\n\n${item.suggestedDisclaimer}` : item.caption ?? "";
      const r = await api<{ post: { id: number } }>("/posts", {
        body: {
          title: (item.title || resultInput.topic).slice(0, 200),
          message,
          hashtags: item.hashtags ?? [],
          ai_generated: true,
          source_topic: resultInput.topic.slice(0, 300),
          campaign_id: campaignId ? Number(campaignId) : null,
        },
      });
      toast.ok("Saved as a draft", "Edit it, then send it for approval.");
      nav(`/posts/${r.post.id}`);
    } catch (e) {
      toast.err("Couldn't save the draft", (e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  async function createCampaign(item: Item, i: number) {
    setSaving(i);
    try {
      // Dates are business days in Philippine time.
      const start = bizToday();
      const end = new Date(Date.parse(`${start}T00:00:00Z`) + (item.weeks ?? 2) * 7 * 86400_000).toISOString().slice(0, 10);
      const r = await api<{ campaign: { id: number } }>("/campaigns", {
        body: {
          name: item.name ?? resultInput.topic,
          objective: item.objective ?? null,
          description: campaignText(item, false),
          start_date: start,
          end_date: end,
        },
      });
      toast.ok("Campaign created");
      nav(`/campaigns/${r.campaign.id}`);
    } catch (e) {
      toast.err("Couldn't create the campaign", (e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  const copy = (text: string) =>
    copyText(text)
      .then(() => toast.ok("Copied"))
      .catch(() => toast.err("Couldn't copy", "Your browser blocked the clipboard. Select the text and copy it yourself."));
  const ai = status.data?.ai;
  const canBatch = can("content.generate") && can("posts.edit");

  return (
    <>
      <PageHead
        title="AI content studio"
        sub={`Original captions, campaign ideas, hashtags and image prompts${ai ? ` from ${ai.label}` : ""}, written to your brand guidelines. Everything is saved as a draft for a person to check and approve.`}
      />
      <p className="note mt0 studio-scope">
        The studio is for quick ideas, a few at a time. To plan and caption a whole set of posts, use <Link to="/bots">AI bots</Link> batches.
      </p>
      {ai && !ai.ready && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warn" title={`${ai.label} isn't ready`}>
            {ai.problem} {ai.fix}
          </Alert>
        </div>
      )}

      <div className="grid g-side">
        <div className="stackv" style={{ gap: 20 }}>
          {err && <Alert tone="bad" title="Nothing was generated">{err}</Alert>}
          {busyKind && (
            <div className="stackv" style={{ gap: 10 }}>
              <Generating what={KIND_LABEL[busyKind].toLowerCase()} />
              <div className="row studio-cancel">
                <Button size="sm" variant="quiet" icon="x" onClick={cancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {!busy && !items && (
            <div className="board">
              <Empty title="Nothing generated yet">Pick what you need, describe the topic, and press Generate. Trending topics can be sent here with one click.</Empty>
            </div>
          )}
          {!busy && items && resultKind === "captions" && (
            <>
              <div className="spread">
                <p className="label mb0">{items.length} captions</p>
                {items.some((it) => it.suggestedDisclaimer) && (
                  <Check label={requiredDisclaimer ? "Add the brand disclaimer when saving (your guidelines require it)" : "Add the brand disclaimer when saving"} checked={addDisclaimer} onChange={setAddDisclaimer} />
                )}
              </div>
              {items.map((it, i) => (
                <div key={i} className="card soft">
                  <div className="spread">
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{it.title || `Option ${i + 1}`}</h3>
                    <Tag tone="info">AI draft</Tag>
                  </div>
                  <p className="pre" style={{ margin: "10px 0" }}>
                    {it.caption}
                  </p>
                  {addDisclaimer && it.suggestedDisclaimer && <p className="note mt0">+ {it.suggestedDisclaimer}</p>}
                  <div className="row" style={{ gap: 6 }}>
                    {it.hashtags?.map((h, j) => (
                      <Tag key={j} tone="outline">
                        {h}
                      </Tag>
                    ))}
                  </div>
                  {it.issues.length > 0 && (
                    <div className="mt16">
                      <Alert tone="warn" title="Check before using">
                        {it.issues.join(" ")}
                      </Alert>
                    </div>
                  )}
                  <div className="row mt16">
                    {can("posts.edit") && (
                      <Button size="sm" variant="primary" loading={saving === i} onClick={() => saveDraft(it, i)}>
                        Save as draft
                      </Button>
                    )}
                    {canBatch && (
                      <Button size="sm" variant="soft" onClick={() => setToBatch(it)}>
                        Add to a bots batch
                      </Button>
                    )}
                    <Button size="sm" variant="quiet" onClick={() => copy(`${it.caption}\n\n${(it.hashtags ?? []).join(" ")}`)}>
                      Copy
                    </Button>
                  </div>
                </div>
              ))}
            </>
          )}
          {!busy && items && resultKind === "campaign_ideas" &&
            items.map((it, i) => (
              <div key={i} className="card soft">
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{it.name}</h3>
                <p className="note mt8">
                  {it.objective} {it.weeks ? `· about ${it.weeks} weeks` : ""}
                </p>
                <p style={{ margin: "10px 0" }}>{it.description}</p>
                {it.posts && (
                  <ul style={{ margin: "0 0 0 18px", padding: 0 }}>
                    {it.posts.map((p, j) => (
                      <li key={j}>{p}</li>
                    ))}
                  </ul>
                )}
                {it.issues.length > 0 && (
                  <div className="mt16">
                    <Alert tone="warn">{it.issues.join(" ")}</Alert>
                  </div>
                )}
                <div className="row mt16">
                  {can("campaigns.manage") && (
                    <Button size="sm" variant="primary" loading={saving === i} onClick={() => createCampaign(it, i)}>
                      Create this campaign
                    </Button>
                  )}
                  <Button size="sm" variant={can("campaigns.manage") ? "quiet" : "soft"} onClick={() => copy(campaignText(it, true))}>
                    Copy
                  </Button>
                </div>
                {!can("campaigns.manage") && <p className="note">Copy the idea and share it with a marketing manager, who can turn it into a campaign.</p>}
              </div>
            ))}
          {!busy && items && resultKind === "hashtags" && (
            <div className="card soft">
              {["broad", "niche", "branded"].map((g) => {
                const tags = items.filter((t) => (t.group ?? "broad") === g);
                if (!tags.length) return null;
                return (
                  <div key={g} style={{ marginBottom: 14 }}>
                    <p className="label">{g}</p>
                    <div className="row" style={{ gap: 6 }}>
                      {tags.map((t, j) => (
                        <Tag key={j} tone="outline">
                          {t.tag}
                        </Tag>
                      ))}
                    </div>
                  </div>
                );
              })}
              <Button size="sm" variant="soft" onClick={() => copy(items.map((t) => t.tag).filter(Boolean).join(" "))}>
                Copy all
              </Button>
            </div>
          )}
          {!busy && items && resultKind === "image_prompts" &&
            items.map((it, i) => (
              <div key={i} className="card soft">
                <p className="pre" style={{ margin: 0 }}>
                  {it.prompt}
                </p>
                {it.alt_text && <p className="note">Alt text: {it.alt_text}</p>}
                <div className="row mt16">
                  <Button size="sm" variant="quiet" onClick={() => copy(it.prompt ?? "")}>
                    Copy prompt
                  </Button>
                </div>
              </div>
            ))}
        </div>

        <aside className="board stackv first-on-mobile" style={{ gap: 16 }}>
          <div>
            <p className="label">What do you need?</p>
            <Seg
              grid
              label="Content type"
              value={kind}
              onChange={setKind}
              options={(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
            />
          </div>
          <TextField label="Topic" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} placeholder="e.g. World Cancer Day screening awareness" />
          <TextField label="Audience" optional value={audience} onChange={(e) => setAudience(e.target.value)} maxLength={200} placeholder="e.g. caregivers of cancer patients" />
          <TextField label="Tone" optional value={tone} onChange={(e) => setTone(e.target.value)} maxLength={100} />
          <TextArea label="Notes for the AI" optional value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={800} rows={3} placeholder="Facts to include, things to avoid" />
          <SelectField
            label="How many"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))}
          />
          {kind === "captions" && <SelectField label="Length of each caption" value={words} onChange={(e) => setWords(Number(e.target.value))} options={LENGTHS} />}
          {kind === "captions" && words >= 300 && <p className="note mt0">Long pieces take the local AI a few minutes. Generate 1 or 2 at a time.</p>}
          {kind === "captions" && (
            <SelectField
              label="Campaign"
              optional
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              options={[{ value: "", label: "None" }, ...(campaigns.data?.campaigns ?? []).filter((c) => c.status !== "archived").map((c) => ({ value: c.id, label: c.name }))]}
            />
          )}
          <Button variant="primary" icon="spark" loading={busy} disabled={topic.trim().length < 3} onClick={generate}>
            Generate
          </Button>
          <p className="note mt0">
            Your brand guidelines (voice, words to avoid, disclaimer) are applied automatically.{" "}
            {can("settings.brand") ? (
              <>
                Change them in <Link to="/settings?tab=brand">Settings</Link>.
              </>
            ) : (
              "Administrators and marketing managers can change them."
            )}
          </p>
        </aside>
      </div>
      {toBatch && <AddToBatch item={toBatch} input={resultInput} onClose={() => setToBatch(null)} />}
    </>
  );
}

function campaignText(item: Item, withHeader: boolean): string {
  return [
    withHeader ? item.name : "",
    withHeader && item.objective ? `Objective: ${item.objective}` : "",
    withHeader && item.weeks ? `About ${item.weeks} weeks` : "",
    item.description,
    item.posts?.length ? `Post ideas:\n- ${item.posts.join("\n- ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface BatchSummary {
  id: number;
  name: string;
  items: number;
  handed_off_at?: string | null;
}

/** Sends a caption's topic and notes to an AI bots batch as a brief, so the bot writes it with the rest of the batch. */
function AddToBatch({ item, input, onClose }: { item: Item; input: Input; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const overview = useLoad(() => api<{ batches: BatchSummary[] }>("/bots/overview"), []);
  const [choice, setChoice] = useState<string>("new");
  const [name, setName] = useState(input.topic.slice(0, 120));
  const [busy, setBusy] = useState(false);
  const batches = (overview.data?.batches ?? []).filter((b) => !b.handed_off_at);
  useEffect(() => {
    if (overview.data && batches.length && choice === "new") setChoice(String(batches[0].id));
    // Only pick a default once the list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview.data]);

  const brief = [
    input.topic,
    input.notes ? `Notes: ${input.notes}` : "",
    item.title ? `Angle: ${item.title}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 3000);

  async function add() {
    setBusy(true);
    try {
      let id = Number(choice);
      if (choice === "new") {
        const r = await api<{ batch: { id: number } }>("/bots/batches", { body: { name: name.trim() } });
        id = r.batch.id;
      }
      await api(`/bots/batches/${id}/items`, { body: { items: [{ title: (item.title || input.topic).slice(0, 200), brief, media_type: "none" }] } });
      toast.ok("Added to the batch", "The bot writes its caption when the batch runs.");
      onClose();
      nav("/bots");
    } catch (e) {
      toast.err("Couldn't add it to the batch", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add to a bots batch"
      onClose={onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={overview.loading || (choice === "new" && !name.trim())} onClick={add}>
            Add
          </Button>
        </>
      }
    >
      <div className="stackv" style={{ gap: 14 }}>
        <p className="muted mt0 mb0">The topic and notes go to the batch as what the post is about; the bot writes the caption with the batch's rules and style.</p>
        {overview.error && <Alert tone="bad">{overview.error}</Alert>}
        <SelectField
          label="Batch"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          options={[...batches.map((b) => ({ value: String(b.id), label: `${b.name} (${b.items} post${b.items === 1 ? "" : "s"})` })), { value: "new", label: "New batch…" }]}
        />
        {choice === "new" && <TextField label="New batch name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
        <div className="studio-brief">
          <p className="label">Brief</p>
          <p className="pre mt0 mb0">{brief}</p>
        </div>
      </div>
    </Modal>
  );
}
