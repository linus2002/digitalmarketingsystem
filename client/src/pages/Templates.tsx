import { useState } from "react";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago } from "../lib/format";
import { useToast } from "../components/Toast";
import { Alert, Button, Empty, LoadError, Modal, PageHead, Skeleton, Tabs, Tag, TextArea, TextField } from "../components/ui";

interface Template {
  id: number;
  key: string | null;
  name: string;
  category: string;
  body: string;
  status: "draft" | "approved" | "retired";
  approved_by_name: string | null;
  approved_at: string | null;
  updated_at: string;
}

export function TemplatesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<"agent" | "assistant">("agent");
  const { data, error, loading, reload } = useLoad(() => api<{ templates: Template[] }>("/templates"), []);
  const [edit, setEdit] = useState<Partial<Template> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const list = (data?.templates ?? []).filter((t) => (tab === "assistant" ? !!t.key : !t.key));
  const drafts = (data?.templates ?? []).filter((t) => t.status === "draft").length;

  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    try {
      await fn();
      toast.ok(ok);
      setEdit(null);
      await reload();
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function save() {
    if (!edit) return;
    const body = { name: edit.name, category: edit.category, body: edit.body };
    return act("save", () => (edit.id ? api(`/templates/${edit.id}`, { method: "PATCH", body }) : api("/templates", { body })), edit.id ? "Saved: needs approval again" : "Template created as a draft");
  }

  return (
    <>
      <PageHead
        title="Response templates"
        sub="The only wording the assistant sends, and the starting point for team replies. Any edit returns a template to draft until the pharmaceutical team approves it."
        actions={can("templates.manage") && <Button variant="primary" icon="plus" onClick={() => setEdit({ name: "", category: "general", body: "" })}>New template</Button>}
      />
      {drafts > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warn" title={`${drafts} template${drafts > 1 ? "s" : ""} waiting for approval`}>
            Until approved, the assistant keeps using the last approved wording, and agents can't pick drafts.
          </Alert>
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "agent", label: "Team replies", n: (data?.templates ?? []).filter((t) => !t.key).length },
          { value: "assistant", label: "Messenger assistant", n: (data?.templates ?? []).filter((t) => t.key).length },
        ]}
      />
      <p className="note">
        Placeholders: <span className="code">{"{{ref}}"}</span> <span className="code">{"{{medicine}}"}</span> <span className="code">{"{{country}}"}</span>{" "}
        <span className="code">{"{{business}}"}</span>
        {tab === "assistant" && (
          <>
            {" "}
            <span className="code">{"{{privacyUrl}}"}</span> <span className="code">{"{{consentText}}"}</span>
          </>
        )}
      </p>
      {error && <LoadError error={error} retry={reload} />}
      {loading && !data && <Skeleton />}
      <div className="grid g2 mt16">
        {list.map((t) => (
          <div key={t.id} className="card soft">
            <div className="spread">
              <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 600 }}>{t.name}</h3>
              <Tag tone={t.status === "approved" ? "good" : t.status === "draft" ? "warn" : "mute"} dot>
                {t.status === "approved" ? "Approved" : t.status === "draft" ? "Needs approval" : "Retired"}
              </Tag>
            </div>
            <div className="row mt8" style={{ gap: 6 }}>
              <Tag tone="outline">{t.key ?? t.category.replace(/_/g, " ")}</Tag>
            </div>
            <p className="pre small" style={{ margin: "12px 0" }}>
              {t.body}
            </p>
            <p className="note mt0">
              {t.approved_by_name ? `Approved by ${t.approved_by_name} ${ago(t.approved_at)}` : t.status === "approved" ? "Approved (default wording)" : `Edited ${ago(t.updated_at)}`}
            </p>
            <div className="row mt16">
              {can("templates.manage") && (
                <Button size="sm" icon="edit" onClick={() => setEdit(t)}>
                  Edit
                </Button>
              )}
              {can("templates.approve") && t.status === "draft" && (
                <Button size="sm" variant="primary" loading={busy === `ap${t.id}`} onClick={() => act(`ap${t.id}`, () => api(`/templates/${t.id}/approve`, { body: {} }), "Approved")}>
                  Approve
                </Button>
              )}
              {can("templates.approve") && !t.key && t.status !== "retired" && (
                <Button size="sm" variant="quiet" loading={busy === `rt${t.id}`} onClick={() => act(`rt${t.id}`, () => api(`/templates/${t.id}/retire`, { body: {} }), "Retired")}>
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
              <Button variant="primary" loading={busy === "save"} disabled={!edit.name?.trim() || !edit.body?.trim()} onClick={save}>
                Save as draft
              </Button>
            </>
          }
        >
          <div className="stackv">
            {edit.status === "approved" && <Alert tone="warn">Changing the wording sends it back for approval.</Alert>}
            <TextField label="Name" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            {!edit.key && (
              <TextField label="Category" value={edit.category ?? ""} onChange={(e) => setEdit({ ...edit, category: e.target.value })} hint="e.g. product_availability, prescription, pricing_quote, general" />
            )}
            <TextArea label="Wording" value={edit.body ?? ""} onChange={(e) => setEdit({ ...edit, body: e.target.value })} rows={8} />
            <p className="note mt0">Never include doses, treatment advice, outcome claims, or promises about availability or prices.</p>
          </div>
        </Modal>
      )}
    </>
  );
}
