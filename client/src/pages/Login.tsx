import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { Alert, Button, TextField } from "../components/ui";
import { BRAND } from "../components/Layout";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="art">
        <div>
          <svg width="220" height="150" viewBox="0 0 220 150" aria-hidden="true">
            <ellipse cx="110" cy="140" rx="90" ry="7" fill="#d9e6fd" />
            <rect x="30" y="20" width="160" height="108" rx="14" fill="#fff" stroke="#1f5fd6" strokeWidth="2" />
            <path d="M30 44h160" stroke="#1f5fd6" strokeWidth="2" />
            <circle cx="44" cy="32" r="3.5" fill="#d93a32" />
            <circle cx="55" cy="32" r="3.5" fill="#f2b01e" />
            <circle cx="66" cy="32" r="3.5" fill="#1e9e57" />
            <path d="M50 104l26-26 18 18 34-34" fill="none" stroke="#1f5fd6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="150" cy="62" r="13" fill="#1e9e57" />
            <path d="M150 56v12M144 62h12" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            <path d="M196 40c10 6 12 18 5 26" fill="none" stroke="#6c9cf0" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 5" />
          </svg>
          <h2>Plan, approve and publish, then answer every inquiry properly.</h2>
          <p>Trends, content, the calendar and your Facebook Page in one place, with the pharmaceutical team in the loop.</p>
        </div>
      </div>
      <div className="form">
        <form onSubmit={submit} noValidate>
          <div className="brand" style={{ border: 0, padding: 0, marginBottom: 8 }}>
            <span className="mark">{BRAND.short}</span>
            <div>
              <b>{BRAND.name}</b>
              <span>Sign in to continue</span>
            </div>
          </div>
          {error && <Alert tone="bad">{error}</Alert>}
          <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Button variant="primary" type="submit" loading={busy} disabled={!email || !password}>
            Sign in
          </Button>
          <p className="note" style={{ textAlign: "center" }}>
            Forgot your password? Ask an administrator to reset it.
          </p>
        </form>
      </div>
    </div>
  );
}
