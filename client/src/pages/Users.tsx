import { useState } from "react";
import { api, useLoad } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago } from "../lib/format";
import { useToast } from "../components/Toast";
import { Alert, Avatar, Button, LoadError, Modal, PageHead, SelectField, Skeleton, Tag, TextField } from "../components/ui";

interface U {
  id: number;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
}

const ROLE_HELP: Record<string, string> = {
  admin: "Everything, including users, settings and deleting personal data.",
  marketing_manager: "Approves, schedules and publishes posts; campaigns; analytics.",
  marketer: "Writes posts and uses the AI studio; can't approve or publish.",
  pharma_team: "Sees all inquiries, reviews sensitive ones, approves replies and templates.",
  lead_agent: "Handles their own and unassigned inquiries; sensitive replies need approval.",
  viewer: "Read-only marketing dashboards and reports.",
};

export function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api<{ users: U[]; roles: { value: string; label: string }[] }>("/users"), []);
  const [edit, setEdit] = useState<(Partial<U> & { password?: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!edit) return;
    setBusy(true);
    setErr(null);
    try {
      if (edit.id) await api(`/users/${edit.id}`, { method: "PATCH", body: { name: edit.name, role: edit.role, is_active: edit.is_active, password: edit.password || undefined } });
      else await api("/users", { body: { email: edit.email, name: edit.name, role: edit.role, password: edit.password } });
      toast.ok(edit.id ? "User updated" : "User added", edit.id ? undefined : "Share the password with them privately.");
      setEdit(null);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const roleLabel = (r: string) => data?.roles.find((x) => x.value === r)?.label ?? r;
  return (
    <>
      <PageHead title="Users and roles" sub="Each person gets the least access their job needs." actions={<Button variant="primary" icon="plus" onClick={() => { setErr(null); setEdit({ role: "marketer", is_active: true }); }}>Add user</Button>} />
      {error && <LoadError error={error} retry={reload} />}
      {loading && !data && <Skeleton />}
      {data && (
        <div className="table-wrap">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="cell-who">
                        <Avatar name={u.name} white={!u.is_active} />
                        <div>
                          <span className="name">{u.name}</span>
                          <span className="sub">{u.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Tag tone="outline">{roleLabel(u.role)}</Tag>
                    </td>
                    <td>{u.is_active ? <Tag tone="good" dot>Active</Tag> : <Tag tone="mute" dot>Off</Tag>}</td>
                    <td>{u.last_login_at ? ago(u.last_login_at) : <span className="muted">Never</span>}</td>
                    <td className="right">
                      <Button size="sm" variant="quiet" icon="edit" onClick={() => { setErr(null); setEdit({ ...u }); }}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {edit && (
        <Modal
          title={edit.id ? `Edit ${edit.name}` : "Add user"}
          onClose={() => setEdit(null)}
          actions={
            <>
              <Button variant="quiet" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy} onClick={save}>
                Save
              </Button>
            </>
          }
        >
          <div className="stackv">
            {err && <Alert tone="bad">{err}</Alert>}
            {!edit.id && <TextField label="Email" type="email" value={edit.email ?? ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} autoFocus />}
            <TextField label="Name" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <SelectField label="Role" value={edit.role ?? "marketer"} onChange={(e) => setEdit({ ...edit, role: e.target.value })} options={data?.roles ?? []} hint={ROLE_HELP[edit.role ?? "marketer"]} disabled={edit.id === me?.id} />
            <TextField
              label={edit.id ? "New password" : "Password"}
              optional={!!edit.id}
              type="password"
              autoComplete="new-password"
              value={edit.password ?? ""}
              onChange={(e) => setEdit({ ...edit, password: e.target.value })}
              hint="At least 12 characters, with letters and a number."
            />
            {edit.id && edit.id !== me?.id && (
              <SelectField
                label="Account"
                value={edit.is_active ? "1" : "0"}
                onChange={(e) => setEdit({ ...edit, is_active: e.target.value === "1" })}
                options={[
                  { value: "1", label: "Active" },
                  { value: "0", label: "Turned off (can't sign in)" },
                ]}
              />
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
