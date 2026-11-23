import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";
import { Alert, Avatar, Button, PageHead, TextField } from "../components/ui";

/** The signed-in person's own account: who they are, and changing their password. */
export function AccountPage() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errs, setErrs] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const fe: typeof errs = {};
    if (!current) fe.current = "Enter your current password.";
    if (next.length < 12) fe.next = "Use at least 12 characters.";
    else if (!/[a-zA-Z]/.test(next) || !/\d/.test(next)) fe.next = "Use letters and at least one number.";
    else if (next === current) fe.next = "Choose a password you haven't been using.";
    if (!fe.next && confirm !== next) fe.confirm = "The two new passwords don't match.";
    setErrs(fe);
    if (fe.current || fe.next || fe.confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api("/auth/change-password", { body: { current, next } });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.ok("Password changed", "You've been signed out on your other devices.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="Your account" sub="Your details and password." />
      <div className="grid g2">
        <section className="card soft" aria-labelledby="acct-who">
          <h2 id="acct-who" className="section" style={{ marginBottom: 14 }}>
            You
          </h2>
          <div className="cell-who">
            <Avatar name={user?.name} size="lg" />
            <div>
              <span className="name" style={{ display: "block", fontWeight: 600 }}>
                {user?.name}
              </span>
              <span className="sub">{user?.email}</span>
            </div>
          </div>
          <dl className="kv mt16">
            <dt>Role</dt>
            <dd>{user?.roleLabel}</dd>
          </dl>
          <p className="note">To change your name, email or role, ask an administrator.</p>
          <div className="row mt16">
            <Button variant="secondary" icon="logout" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </section>

        <section className="card soft" aria-labelledby="acct-pw">
          <h2 id="acct-pw" className="section" style={{ marginBottom: 14 }}>
            Change password
          </h2>
          <form className="stackv" onSubmit={submit} noValidate>
            {error && <Alert tone="bad">{error}</Alert>}
            <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={errs.current} />
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              error={errs.next}
              hint="At least 12 characters, with letters and a number."
            />
            <TextField label="New password again" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errs.confirm} />
            <p className="note mt0">Changing it signs you out everywhere else.</p>
            <div className="row">
              <Button variant="primary" type="submit" loading={busy}>
                Change password
              </Button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
