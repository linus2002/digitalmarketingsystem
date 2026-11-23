import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { Alert, Button, TextField, useDocTitle } from "../components/ui";
import { BRAND } from "../components/Layout";
import loginBg from "../../images/loginbg.png";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ email?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);
  useDocTitle("Sign in");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    // Say what's missing instead of silently disabling the button
    const fe: typeof fieldErr = {};
    if (!email.trim()) fe.email = "Enter your work email.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) fe.email = "That doesn't look like an email address.";
    if (!password) fe.password = "Enter your password.";
    setFieldErr(fe);
    if (fe.email || fe.password) {
      (document.getElementById(fe.email ? "login-email" : "login-password") as HTMLInputElement | null)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="art" style={{ backgroundImage: `url(${loginBg})` }} aria-hidden="true" />
      <div className="form">
        <form onSubmit={submit} noValidate>
          <div className="intro">
            <h1>
              <span>Plan, approve and publish,</span> <span>then answer every inquiry properly.</span>
            </h1>
            <p>Trends, content, the calendar and your Facebook Page in one place, with the pharmaceutical team in the loop.</p>
          </div>
          <div className="brand" style={{ border: 0, padding: 0, marginBottom: 8 }}>
            <span className="mark">{BRAND.short}</span>
            <div>
              <b>{BRAND.name}</b>
              <span>Sign in to continue</span>
            </div>
          </div>
          {error && <Alert tone="bad">{error}</Alert>}
          <TextField
            id="login-email"
            label="Email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldErr.email) setFieldErr((f) => ({ ...f, email: undefined }));
            }}
            error={fieldErr.email}
            required
            autoFocus
          />
          <TextField
            id="login-password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErr.password) setFieldErr((f) => ({ ...f, password: undefined }));
            }}
            error={fieldErr.password}
            required
          />
          <Button variant="primary" type="submit" loading={busy}>
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
