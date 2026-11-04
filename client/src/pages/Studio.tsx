import { useEffect, useState } from "react";
import { Generating } from "../components/Generating";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";
import { Alert, Button, Check, Empty, PageHead, Seg, SelectField, TextArea, TextField, Tag } from "../components/ui";

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

const KIND_LABEL: Record<Kind, string> = { captions: "Captions", campaign_ideas: "Campaign ideas", hashtags: "Hashtags", image_prompts: "Image prompts" };

export function StudioPage() {
  const [params] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const status = useLoad(() => api<Status>("/studio/status"), []);
  const campaigns = useLoad(() => api<{ campaigns: { id: number; name: string; status: string }[] }>("/campaigns"), []);

  const [kind, setKind] = useState<Kind>("captions");
  const [topic, setTopic] = useState(params.get("topic") ?? "");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("Warm and informative");
  const [notes, setNotes] = useState(params.get("notes") ?? "");
  const [count, setCount] = useState(2);
  // Load the local model as soon as the studio opens, so Generate starts writing straight away.
  useEffect(() => {
    api("/studio/warm", { body: {} }).catch(() => undefined);
  }, []);
  const [campaignId, setCampaignId] = useState<string>("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [resultKind, setResultKind] = useState<Kind>("captions");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addDisclaimer, setAddDisclaimer] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ items: Item[]; durationMs: number }>("/studio/generate", {
        body: { kind, topic, audience: audience || undefined, tone: tone || undefined, notes: notes || undefined, count },
      });
      setItems(r.items);
      setResultKind(kind);
      if (!r.items.length) setErr("The model didn't return any usable ideas. Try rewording the topic.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft(item: Item, i: number) {
    setSaving(i);
    try {
      const message = addDisclaimer && item.suggestedDisclaimer ? `${item.caption}\n\n${item.suggestedDisclaimer}` : item.caption ?? "";
      const r = await api<{ post: { id: number } }>("/posts", {
        body: {
          title: item.title || topic.slice(0, 80),
          message,
          hashtags: item.hashtags ?? [],
          ai_generated: true,
          source_topic: topic,
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
      const start = new Date();
      const end = new Date(Date.now() + (item.weeks ?? 2) * 7 * 86400_000);
      const r = await api<{ campaign: { id: number } }>("/campaigns", {
        body: {
          name: item.name ?? topic,
          objective: item.objective ?? null,
          description: [item.description, item.posts?.length ? `Post ideas:\n- ${item.posts.join("\n- ")}` : ""].filter(Boolean).join("\n\n"),
          start_date: start.toISOString().slice(0, 10),
          end_date: end.toISOString().slice(0, 10),
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

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.ok("Copied"));
  const ai = status.data?.ai;

  return (
    <>
      <PageHead
        title="AI content studio"
        sub={`Original captions, campaign ideas, hashtags and image prompts${ai ? ` from ${ai.label}` : ""}, written to your brand guidelines. Everything is saved as a draft for a person to check and approve.`}
      />
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
          {busy && <Generating what={KIND_LABEL[kind].toLowerCase()} />}
          {!busy && !items && (
            <div className="board">
              <Empty title="Nothing generated yet">Pick what you need, describe the topic, and press Generate. Trending topics can be sent here with one click.</Empty>
            </div>
          )}
          {!busy && items && resultKind === "captions" && (
            <>
              <div className="spread">
                <p className="label mb0">{items.length} captions</p>
                <Check label="Add the brand disclaimer when saving" checked={addDisclaimer} onChange={setAddDisclaimer} />
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
                    {it.hashtags?.map((h) => (
                      <Tag key={h} tone="outline">
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
                {can("campaigns.manage") && (
                  <div className="row mt16">
                    <Button size="sm" variant="primary" loading={saving === i} onClick={() => createCampaign(it, i)}>
                      Create this campaign
                    </Button>
                  </div>
                )}
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
                      {tags.map((t) => (
                        <Tag key={t.tag} tone="outline">
                          {t.tag}
                        </Tag>
                      ))}
                    </div>
                  </div>
                );
              })}
              <Button size="sm" variant="soft" onClick={() => copy(items.map((t) => t.tag).join(" "))}>
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
          <TextField label="Topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. World Cancer Day screening awareness" />
          <TextField label="Audience" optional value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. caregivers of cancer patients" />
          <TextField label="Tone" optional value={tone} onChange={(e) => setTone(e.target.value)} />
          <TextArea label="Notes for the AI" optional value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Facts to include, things to avoid" />
          <SelectField
            label="How many"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))}
          />
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
          <p className="note mt0">Your brand guidelines (voice, words to avoid, disclaimer) are applied automatically. Change them in Settings.</p>
        </aside>
      </div>
    </>
  );
}
