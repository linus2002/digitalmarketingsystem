import { useState } from "react";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago } from "../lib/format";
import { useToast } from "../components/Toast";
import { Alert, Button, ConfirmModal, Empty, LoadError, Modal, PageHead, SelectField, Skeleton, Switch, Tabs, Tag, TextArea, TextField } from "../components/ui";
import "../styles/inquiries.css";

interface Template {
  id: number;
  key: string | null;
  name: string;
  category: string;
  body: string;
  status: "draft" | "approved" | "retired";
  created_by: number | null;
  updated_by: number | null;
  updated_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  approved_body: string | null;
  updated_at: string;
}

export function TemplatesPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<"agent" | "assistant">("agent");
  const [showRetired, setShowRetired] = useState(false);
  const { data, error, loading, reload } = useLoad(
    () => api<{ templates: Template[]; categories: { value: string; label: string }[] }>("/templates", { query: { all: showRetired ? 1 : undefined } }),
    [showRetired],
  );
  const [edit, setEdit] = useState<Partial<Template> | null>(null);
  const [retiring, setRetiring] = useState<Template | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const categories = data?.categories ?? [];
  const catLabel = (c: string) => categories.find((x) => x.value === c)?.label ?? c.replace(/_/g, " ");
  const list = (data?.templates ?? []).filter((t) => (tab === "assistant" ? !!t.key : !t.key));
  const drafts = (data?.templates ?? []).filter((t) => t.status === "draft").length;
  /** Whoever last wrote the wording can't approve it: someone else on the pharmaceutical team must. */
  const ownEdit = (t: Template) => !!user && (t.updated_by ?? t.created_by) === user.id;

  /** Returns true when it worked, so callers only close dialogs on success. */
  async function act(label: string, fn: () => Promise<unknown>, ok: string | ((r: unknown) => string)): Promise<boolean> {
    setBusy(label);
    try {
      const r = await fn();
      toast.ok(typeof ok === "function" ? ok(r) : ok);
      await reload();
      return true;
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!edit) return;
    const original = edit.id ? data?.templates.find((t) => t.id === edit.id) : undefined;
    let done: boolean;
    if (original) {
      // Send only what changed; the category of an assistant template is fixed.
      const body: Record<string, string> = {};
      if (edit.name !== original.name) body.name = edit.name ?? "";
      if (!original.key && edit.category !== original.category) body.category = edit.category ?? "general";
      if (edit.body !== original.body) body.body = edit.body ?? "";
      if (!Object.keys(body).length) {
        setEdit(null);
        return;
      }
      done = await act("save", () => api<{ needsApproval?: boolean }>(`/templates/${original.id}`, { method: "PATCH", body }), (r) =>
        (r as { needsApproval?: boolean }).needsApproval ? "Saved: the new wording needs approval" : "Saved",
      );
    } else {
      done = await act("save", () => api("/templates", { body: { name: edit.name, category: edit.category, body: edit.body } }), "Template created as a draft");
    }
    if (done) setEdit(null);
  }

  const original = edit?.id ? data?.templates.find((t) => t.id === edit.id) : undefined;
  const wordingChanged = !!original && edit?.body !== original.body;

  return (
    <>
      <PageHead
        title="Reply templates"
        sub="The only wording the assistant sends, and the starting point for team replies. Changing the wording returns a template to draft until someone else on the pharmaceutical team approves it."
        actions={can("templates.manage") && <Button variant="primary" icon="plus" onClick={() => setEdit({ name: "", category: "general", body: "" })}>New template</Button>}
      />
      {drafts > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warn" title={`${drafts} template${drafts > 1 ? "s" : ""} waiting for approval`}>
            Until approved, the assistant keeps using the last approved wording, and agents can't pick drafts.
          </Alert>
        </div>
      )}
      <div className="spread" style={{ flexWrap: "wrap", gap: 12 }}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "agent", label: "Team replies", n: (data?.templates ?? []).filter((t) => !t.key).length },
            { value: "assistant", label: "Messenger assistant", n: (data?.templates ?? []).filter((t) => t.key).length },
          ]}
        />
        {tab === "agent" && <Switch label="Show retired" checked={showRetired} onChange={setShowRetired} />}
      </div>
      <p className="note">
        Placeholders: <span className="code">{"{{ref}}"}</span> <span className="code">{"{{medicine}}"}</span> <span className="code">{"{{country}}"}</span>{" "}
        <span className="code">{"{{business}}"}</span>
        {tab === "agent" && (
          <>
            {" "}
            <span className="code">{"{{name}}"}</span>
          </>
        )}
        {tab === "assistant" && (
          <>
            {" "}
            <span className="code">{"{{privacyUrl}}"}</span> <span className="code">{"{{consentText}}"}</span>
          </>
        )}
      </p>
      {error && <LoadError error={error} retry={reload} />}
      {loading && !data && <Skeleton />}
      <div className="grid g2 mt16" aria-busy={loading || undefined}>
        {list.map((t) => (
          <div key={t.id} className="card soft" style={t.status === "retired" ? { opacity: 0.7 } : undefined}>
            <div className="spread">
              <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 600 }}>{t.name}</h3>
              <Tag tone={t.status === "approved" ? "good" : t.status === "draft" ? "warn" : "mute"} dot>
                {t.status === "approved" ? "Approved" : t.status === "draft" ? "Needs approval" : "Retired"}
              </Tag>
            </div>
            <div className="row mt8" style={{ gap: 6 }}>
              <Tag tone="outline">{t.key ?? catLabel(t.category)}</Tag>
            </div>
            <p className="pre small" style={{ margin: "12px 0" }}>
              {t.body}
            </p>
            {t.status === "draft" && t.key && t.approved_body && t.approved_body !== t.body && (
              <p className="note mt0">Until this is approved, the assistant keeps sending the previously approved wording.</p>
            )}
            <p className="note mt0">
              {t.approved_by_name
                ? `Approved by ${t.approved_by_name} ${ago(t.approved_at)}`
                : t.status === "approved"
                  ? "Approved (default wording)"
                  : `Edited${t.updated_by_name ? ` by ${t.updated_by_name}` : ""} ${ago(t.updated_at)}`}
            </p>
            <div className="row mt16">
              {can("templates.manage") && t.status !== "retired" && (
                <Button size="sm" icon="edit" onClick={() => setEdit(t)}>
                  Edit
                </Button>
              )}
              {can("templates.approve") && t.status === "draft" && !ownEdit(t) && (
                <Button size="sm" variant="primary" loading={busy === `ap${t.id}`} disabled={!!busy} onClick={() => void act(`ap${t.id}`, () => api(`/templates/${t.id}/approve`, { body: {} }), "Approved")}>
                  Approve
                </Button>
              )}
              {can("templates.approve") && t.status === "draft" && ownEdit(t) && <span className="small muted">You wrote this wording, so someone else needs to approve it.</span>}
              {can("templates.approve") && !t.key && t.status !== "retired" && (
                <Button size="sm" variant="quiet" disabled={!!busy} onClick={() => setRetiring(t)}>
                  Retire
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {data && !list.length && (
        <div className="board">
          <Empty title="No templates here" />
        </div>
      )}
      {retiring && (
        <ConfirmModal
          title={`Retire "${retiring.name}"?`}
          warning="Agents won't be able to pick it any more. It stays in the list under Show retired."
          confirmLabel="Retire template"
          busy={busy === "retire"}
          onClose={() => setRetiring(null)}
          onConfirm={() => void act("retire", () => api(`/templates/${retiring.id}/retire`, { body: {} }), "Retired").then((ok) => ok && setRetiring(null))}
        />
      )}
      {edit && (
        <Modal
          wide
          title={edit.id ? "Edit template" : "New template"}
          onClose={() => setEdit(null)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy === "save"} disabled={!edit.name?.trim() || !edit.body?.trim()} onClick={() => void save()}>
                {!edit.id || wordingChanged ? "Save as draft" : "Save"}
              </Button>
            </>
          }
        >
          <div className="stackv">
            {edit.status === "approved" && (
              <Alert tone={wordingChanged ? "warn" : "info"}>
                {wordingChanged ? "You changed the wording, so it goes back for approval by someone else." : "Renaming or recategorising doesn't need approval again. Changing the wording does."}
              </Alert>
            )}
            <TextField label="Name" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            {!edit.key && (
              <SelectField
                label="Category"
                value={edit.category ?? "general"}
                onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                options={[
                  ...categories,
                  // Keep an older, non-standard category selectable so opening the editor doesn't change it.
                  ...(edit.category && categories.length && !categories.some((c) => c.value === edit.category) ? [{ value: edit.category, label: edit.category.replace(/_/g, " ") }] : []),
                ]}
              />
            )}
            <TextArea label="Wording" value={edit.body ?? ""} onChange={(e) => setEdit({ ...edit, body: e.target.value })} rows={8} />
            <p className="note mt0">Never include doses, treatment advice, outcome claims, or promises about availability or prices.</p>
          </div>
        </Modal>
      )}
    </>
  );
}
