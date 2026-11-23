import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "./Toast";
import { Icon } from "./Icons";
import { Alert, Button, Check, Modal, SelectField, Switch, TextArea, TextField } from "./ui";
import { BotFace } from "./BotArt";
import "../styles/editor.css";

// The Editor Bot in the browser: the creator's standards, and the revision window (before/after with the
// changes highlighted, how each version scores, feedback, accept/reject).

export interface Standards {
  minWords: number;
  maxWords: number;
  maxEmojis: number;
  requireHook: boolean;
  requireCta: boolean;
  mustInclude: string[];
  mustAvoid: string[];
  language: "" | "English" | "Filipino" | "Taglish";
  tone: string;
  customRules: string[];
  autoRevise: boolean;
  maxTries: number;
}
export interface RuleResult {
  key: string;
  label: string;
  pass: boolean | null;
  detail: string;
}
interface Revision {
  id: number;
  before_text: string;
  after_text: string;
  results_before: RuleResult[];
  results_after: RuleResult[];
  status: string;
  feedback?: string | null;
}

export const passCount = (r: RuleResult[]) => ({ ok: r.filter((x) => x.pass === true).length, total: r.filter((x) => x.pass !== null).length });

// ---------------------------------------------------------------- word diff

type Part = { t: string; k: "same" | "add" | "del" };
/** Word-level difference between two texts (longest common subsequence on words and spaces). */
export function diffWords(a: string, b: string): Part[] {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  if (A.length * B.length > 400_000) return [{ t: a, k: "del" }, { t: b, k: "add" }]; // very long: show whole versions
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Part[] = [];
  const push = (t: string, k: Part["k"]) => (out.length && out[out.length - 1].k === k ? (out[out.length - 1].t += t) : out.push({ t, k }));
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      push(A[i++], "same");
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push(A[i++], "del");
    else push(B[j++], "add");
  }
  while (i < A.length) push(A[i++], "del");
  while (j < B.length) push(B[j++], "add");
  return out;
}

function Scores({ results }: { results: RuleResult[] }) {
  return (
    <ul className="ed-rules">
      {results.map((r) => (
        <li key={r.key} className={r.pass === true ? "ok" : r.pass === false ? "bad" : "info"}>
          <span className="ed-mark" aria-hidden="true">{r.pass === true ? "✓" : r.pass === false ? "✕" : "•"}</span>
          <span>
            <b>{r.label}</b> <span className="ed-detail">{r.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The revision window. Opens on a pending suggestion (`revisionId`), or checks `text` and lets the person ask for one.
 * `onAccept` receives the accepted text (for a bot batch item the server has already saved it).
 */
export function RevisionModal({
  text,
  postId,
  itemId,
  revisionId,
  onAccept,
  onClose,
}: {
  text: string;
  postId?: number | null;
  itemId?: number | null;
  revisionId?: number | null;
  onAccept: (text: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [checked, setChecked] = useState<RuleResult[] | null>(null);
  const [rev, setRev] = useState<Revision | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"check" | "revise" | "accept" | "reject" | null>("check");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (revisionId && itemId) {
          const r = await api<{ revisions: Revision[] }>("/editor/revisions", { query: { item_id: itemId } });
          const found = r.revisions.find((x) => x.id === revisionId && x.status === "pending");
          if (live && found) setRev(found);
        }
        const c = await api<{ results: RuleResult[] }>("/editor/check", { body: { text } });
        if (live) setChecked(c.results);
      } catch (e) {
        if (live) setErr((e as Error).message);
      } finally {
        if (live) setBusy(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [text, itemId, revisionId]);

  async function doRevise(from: string) {
    setBusy("revise");
    setErr(null);
    try {
      // Asking again replaces the current suggestion: reject it first so it doesn't linger as pending.
      if (rev && rev.status === "pending") await api(`/editor/revisions/${rev.id}/decide`, { body: { accepted: false } }).catch(() => undefined);
      const r = await api<{ revision: Revision }>("/editor/revise", { body: { text: from, feedback: feedback.trim() || null, post_id: postId ?? null, item_id: itemId ?? null } });
      setRev(r.revision);
      setFeedback("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function decide(accepted: boolean) {
    if (!rev) return;
    setBusy(accepted ? "accept" : "reject");
    setErr(null);
    try {
      await api(`/editor/revisions/${rev.id}/decide`, { body: { accepted } });
      if (accepted) {
        onAccept(rev.after_text);
        toast.ok("Revision accepted", itemId ? "The caption was updated." : "It's in the post text now. Save to keep it.");
      } else toast.ok("Revision rejected");
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  const parts = useMemo(() => (rev ? diffWords(rev.before_text, rev.after_text) : []), [rev]);
  const before = rev?.results_before?.length ? rev.results_before : checked ?? [];
  const sb = passCount(before);
  const sa = rev ? passCount(rev.results_after) : null;

  return (
    <Modal
      wide
      title="Editor Bot"
      onClose={onClose}
      actions={
        rev ? (
          <>
            <Button variant="quiet" loading={busy === "reject"} disabled={!!busy} onClick={() => void decide(false)}>
              Reject
            </Button>
            <Button variant="primary" icon="check" loading={busy === "accept"} disabled={!!busy} onClick={() => void decide(true)}>
              Accept revision
            </Button>
          </>
        ) : (
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="stackv" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <BotFace bot="editor" mood={busy === "revise" ? "focus" : rev ? "happy" : "determined"} size={54} />
          <p className="grow mt0 mb0">
            {busy === "revise"
              ? "Revising to your standards… this takes about 20 seconds on this computer."
              : rev
                ? "Here's my revision. Changes are highlighted: green is new, red is removed."
                : sb.total && sb.ok === sb.total
                  ? "This already meets your standards. You can still ask me to revise it with your own feedback."
                  : "This doesn't meet all your standards yet. Want me to revise it?"}
          </p>
        </div>
        {err && <Alert tone="bad">{err}</Alert>}

        {rev ? (
          <>
            <div className="ed-diff" aria-label="Changes">
              {parts.map((p, i) => (p.k === "same" ? <span key={i}>{p.t}</span> : p.k === "add" ? <ins key={i}>{p.t}</ins> : <del key={i}>{p.t}</del>))}
            </div>
            <div className="grid g2 ed-compare">
              <div>
                <p className="label">
                  Before · {sb.ok}/{sb.total} standards met
                </p>
                <Scores results={before} />
              </div>
              <div>
                <p className="label">
                  After · {sa!.ok}/{sa!.total} standards met
                </p>
                <Scores results={rev.results_after} />
              </div>
            </div>
          </>
        ) : checked ? (
          <div>
            <p className="label">
              Your standards · {sb.ok}/{sb.total} met
            </p>
            <Scores results={checked} />
          </div>
        ) : (
          <p className="muted">Checking…</p>
        )}

        <TextField
          label={rev ? "Not quite right? Tell me what to change" : "Anything else I should change?"}
          optional
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="e.g. shorter and friendlier, mention our team replies Mon–Sat"
          maxLength={600}
        />
        <div>
          <Button icon="spark" variant={rev ? "soft" : "primary"} loading={busy === "revise"} disabled={!!busy || !text.trim()} onClick={() => void doRevise(rev ? rev.after_text : text)}>
            {rev ? "Revise again" : "Revise to my standards"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- standards panel

const lines = (s: string) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean);

export function StandardsPanel({ canEdit, onSaved, onDirty }: { canEdit: boolean; onSaved?: () => void; onDirty?: (d: boolean) => void }) {
  const toast = useToast();
  const [s, setS] = useState<Standards | null>(null);
  const [orig, setOrig] = useState<string>("");
  const [include, setInclude] = useState("");
  const [avoid, setAvoid] = useState("");
  const [rules, setRules] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const r = await api<{ standards: Standards }>("/editor/standards");
    setS(r.standards);
    setInclude(r.standards.mustInclude.join(", "));
    setAvoid(r.standards.mustAvoid.join(", "));
    setRules(r.standards.customRules.join("\n"));
    setOrig(JSON.stringify(r.standards));
  };
  useEffect(() => {
    load().catch((e) => setErr((e as Error).message));
  }, []);

  const current: Standards | null = s && { ...s, mustInclude: lines(include), mustAvoid: lines(avoid), customRules: rules.split("\n").map((x) => x.trim()).filter(Boolean) };
  const dirty = !!current && JSON.stringify(current) !== orig;
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);

  if (!s || !current) return err ? <Alert tone="bad">{err}</Alert> : <p className="muted">Loading your standards…</p>;
  const lenErr = current.maxWords < current.minWords ? "The maximum must be at least the minimum." : null;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api("/editor/standards", { method: "PUT", body: current });
      await load();
      toast.ok("Standards saved", "The Editor Bot uses them from now on.");
      onSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dis = !canEdit;
  return (
    <div className="stackv" style={{ gap: 12 }}>
      <p className="label mb0">Creator standards</p>
      {!canEdit && <p className="note mt0">These are team-wide. Ask a marketing manager or an administrator to change them.</p>}
      {err && <Alert tone="bad">{err}</Alert>}
      <div className="grid g2">
        <TextField label="Min words" type="number" min={5} max={1000} value={s.minWords} disabled={dis} onChange={(e) => setS({ ...s, minWords: Number(e.target.value) || 0 })} />
        <TextField label="Max words" type="number" min={10} max={1000} value={s.maxWords} disabled={dis} error={lenErr} onChange={(e) => setS({ ...s, maxWords: Number(e.target.value) || 0 })} />
      </div>
      <TextField label="Most emojis allowed" type="number" min={0} max={30} value={s.maxEmojis} disabled={dis} onChange={(e) => setS({ ...s, maxEmojis: Math.max(0, Number(e.target.value) || 0) })} />
      <Check label="Start with a hook (a question or a surprising fact)" checked={s.requireHook} onChange={(v) => !dis && setS({ ...s, requireHook: v })} />
      <Check label="End with a call to action" checked={s.requireCta} onChange={(v) => !dis && setS({ ...s, requireCta: v })} />
      <SelectField
        label="Language"
        value={s.language}
        disabled={dis}
        onChange={(e) => setS({ ...s, language: e.target.value as Standards["language"] })}
        options={[
          { value: "", label: "Any" },
          { value: "English", label: "English" },
          { value: "Filipino", label: "Filipino" },
          { value: "Taglish", label: "Taglish" },
        ]}
      />
      <TextField label="Tone" optional value={s.tone} disabled={dis} onChange={(e) => setS({ ...s, tone: e.target.value })} placeholder="e.g. Warm, clear and simple" />
      <TextField label="Must include" optional value={include} disabled={dis} onChange={(e) => setInclude(e.target.value)} placeholder="e.g. ask your pharmacist, #GetMeds" hint="Separate with commas." />
      <TextField label="Must avoid" optional value={avoid} disabled={dis} onChange={(e) => setAvoid(e.target.value)} placeholder="e.g. amazing, game-changer" hint="Separate with commas." />
      <TextArea label="Your own rules" optional rows={3} value={rules} disabled={dis} onChange={(e) => setRules(e.target.value)} placeholder={"One per line, e.g.\nMention the family or caregiver\nNo exclamation mark in the first line"} />
      <Switch label="Auto-revise in batch runs (no review step)" checked={s.autoRevise} onChange={(v) => !dis && setS({ ...s, autoRevise: v })} />
      {s.autoRevise && (
        <SelectField
          label="Tries before leaving it to you"
          value={s.maxTries}
          disabled={dis}
          onChange={(e) => setS({ ...s, maxTries: Number(e.target.value) })}
          options={[1, 2, 3].map((n) => ({ value: n, label: String(n) }))}
        />
      )}
      <p className="note mt0">
        <Icon name="info" size={13} /> Off: the Editor Bot suggests revisions and waits for you to accept them. On: it applies them in batch runs, before the Checker Bot.
      </p>
      {canEdit && (
        <Button variant="primary" loading={busy} disabled={!dirty || !!lenErr} onClick={() => void save()}>
          Save standards
        </Button>
      )}
    </div>
  );
}
