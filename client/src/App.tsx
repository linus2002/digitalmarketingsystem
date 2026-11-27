import { useState, type FormEvent, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { Alert, Button, Empty, LinkButton, Modal, Skeleton, TextField, useDocTitle } from "./components/ui";
import { LoginPage } from "./pages/Login";
import { LandingPage } from "./pages/Landing";
import { HomePage } from "./pages/Home";
import { TrendsPage } from "./pages/Trends";
import { StudioPage } from "./pages/Studio";
import { PostsPage } from "./pages/Posts";
import { PostEditorPage } from "./pages/PostEditor";
import { CalendarPage } from "./pages/Calendar";
import { CampaignsPage, CampaignDetailPage } from "./pages/Campaigns";
import { AnalyticsPage } from "./pages/Analytics";
import { ReportsPage } from "./pages/Reports";
import { DigestPage } from "./pages/Digest";
import { PublishLogPage, AuditLogPage } from "./pages/Logs";
import { LeadsPage } from "./pages/Leads";
import { LeadDetailPage } from "./pages/LeadDetail";
import { TemplatesPage } from "./pages/Templates";
import { SettingsPage } from "./pages/Settings";
import { UsersPage } from "./pages/Users";
import { PublicInquiryPage } from "./pages/PublicInquiry";
import { BotsPage } from "./pages/Bots";
import { AccountPage } from "./pages/Account";
import { CommentsPage } from "./pages/Comments";

function NoAccess() {
  useDocTitle("No access");
  return (
    <div className="board">
      <Empty title="This area isn't part of your role" action={<LinkButton to="/">Back to home</LinkButton>}>
        Ask an administrator if you need access.
      </Empty>
    </div>
  );
}

function NotFound() {
  useDocTitle("Page not found");
  return (
    <div className="board">
      <Empty title="There's no page here" action={<LinkButton to="/">Back to home</LinkButton>} />
    </div>
  );
}

/** Shows the page only to roles that have `perm` (or any of `anyOf`). Pages set their own tab title through PageHead. */
function Guard({ perm, anyOf, children }: { perm?: string; anyOf?: string[]; children: ReactNode }) {
  const { can } = useAuth();
  const allowed = (!perm || can(perm)) && (!anyOf || anyOf.some((p) => can(p)));
  if (!allowed) return <NoAccess />;
  return <>{children}</>;
}

/** Shown over the current page when the session ends, so nothing typed into it is lost. */
function SessionExpiredDialog() {
  const { user, login, logout } = useAuth();
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ email?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const fe: typeof fieldErr = {};
    if (!email.trim()) fe.email = "Enter your email.";
    if (!password) fe.password = "Enter your password.";
    setFieldErr(fe);
    if (fe.email || fe.password) return;
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
    <Modal
      title="Your session ended, sign in again"
      onClose={() => undefined}
      actions={
        <>
          <Button variant="quiet" onClick={() => void logout()}>
            Sign out
          </Button>
          <Button variant="primary" type="submit" form="relogin-form" loading={busy}>
            Sign in
          </Button>
        </>
      }
    >
      <form id="relogin-form" className="stackv" onSubmit={submit} noValidate>
        <p className="muted" style={{ margin: 0 }}>
          For your security you were signed out. Sign in to carry on: this page and anything you typed stay as they are. Anything you were saving when this
          happened wasn't saved, so try it again afterwards.
        </p>
        {error && <Alert tone="bad">{error}</Alert>}
        <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} error={fieldErr.email} />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErr.password}
          autoFocus
        />
      </form>
    </Modal>
  );
}

export function App() {
  const { user, ready, sessionExpired } = useAuth();
  const loc = useLocation();

  if (loc.pathname.startsWith("/inquire")) return <PublicInquiryPage />;
  if (!ready)
    return (
      <div style={{ maxWidth: 480, margin: "20vh auto", padding: 16 }}>
        <Skeleton rows={2} />
      </div>
    );
  // Signed out: the home address shows the one-page overview, every other address asks to sign in.
  if (!user) return loc.pathname === "/" ? <LandingPage /> : <LoginPage />;

  return (
    <>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="trends" element={<Guard perm="trends.view"><TrendsPage /></Guard>} />
        <Route path="studio" element={<Guard perm="content.generate"><StudioPage /></Guard>} />
        <Route path="bots" element={<Guard perm="content.generate"><BotsPage /></Guard>} />
        <Route path="posts" element={<Guard perm="posts.view"><PostsPage /></Guard>} />
        <Route path="posts/new" element={<Guard perm="posts.edit"><PostEditorPage /></Guard>} />
        <Route path="posts/:id" element={<Guard perm="posts.view"><PostEditorPage /></Guard>} />
        <Route path="calendar" element={<Guard perm="posts.view"><CalendarPage /></Guard>} />
        <Route path="campaigns" element={<Guard perm="posts.view"><CampaignsPage /></Guard>} />
        <Route path="campaigns/:id" element={<Guard perm="posts.view"><CampaignDetailPage /></Guard>} />
        <Route path="analytics" element={<Guard perm="analytics.view"><AnalyticsPage /></Guard>} />
        <Route path="reports" element={<Guard perm="reports.view"><ReportsPage /></Guard>} />
        <Route path="reports/digest" element={<Guard perm="reports.view"><DigestPage /></Guard>} />
        <Route path="reports/digest/:id" element={<Guard perm="reports.view"><DigestPage /></Guard>} />
        <Route path="logs/publishing" element={<Guard perm="logs.view"><PublishLogPage /></Guard>} />
        <Route path="logs/audit" element={<Guard perm="audit.view"><AuditLogPage /></Guard>} />
        <Route path="leads" element={<Guard perm="leads.view"><LeadsPage /></Guard>} />
        <Route path="leads/:id" element={<Guard perm="leads.view"><LeadDetailPage /></Guard>} />
        <Route path="comments" element={<Guard perm="leads.view"><CommentsPage /></Guard>} />
        <Route path="templates" element={<Guard perm="templates.view"><TemplatesPage /></Guard>} />
        <Route path="settings" element={<Guard anyOf={["settings.manage", "settings.brand"]}><SettingsPage /></Guard>} />
        <Route path="users" element={<Guard perm="users.manage"><UsersPage /></Guard>} />
        <Route path="account" element={<AccountPage />} />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    {sessionExpired && <SessionExpiredDialog />}
    </>
  );
}
