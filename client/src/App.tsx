import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { Empty, LinkButton, Skeleton } from "./components/ui";
import { LoginPage } from "./pages/Login";
import { HomePage } from "./pages/Home";
import { TrendsPage } from "./pages/Trends";
import { StudioPage } from "./pages/Studio";
import { PostsPage } from "./pages/Posts";
import { PostEditorPage } from "./pages/PostEditor";
import { CalendarPage } from "./pages/Calendar";
import { CampaignsPage, CampaignDetailPage } from "./pages/Campaigns";
import { AnalyticsPage } from "./pages/Analytics";
import { ReportsPage } from "./pages/Reports";
import { PublishLogPage, AuditLogPage } from "./pages/Logs";
import { LeadsPage } from "./pages/Leads";
import { LeadDetailPage } from "./pages/LeadDetail";
import { TemplatesPage } from "./pages/Templates";
import { SettingsPage } from "./pages/Settings";
import { UsersPage } from "./pages/Users";
import { PublicInquiryPage } from "./pages/PublicInquiry";

function Guard({ perm, children }: { perm?: string; children: ReactNode }) {
  const { can } = useAuth();
  if (perm && !can(perm))
    return (
      <div className="board">
        <Empty title="This area isn't part of your role" action={<LinkButton to="/">Back to home</LinkButton>}>
          Ask an administrator if you need access.
        </Empty>
      </div>
    );
  return <>{children}</>;
}

export function App() {
  const { user, ready } = useAuth();
  const loc = useLocation();

  if (loc.pathname.startsWith("/inquire")) return <PublicInquiryPage />;
  if (!ready)
    return (
      <div style={{ maxWidth: 480, margin: "20vh auto", padding: 16 }}>
        <Skeleton rows={2} />
      </div>
    );
  if (!user) return <LoginPage />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="trends" element={<Guard perm="trends.view"><TrendsPage /></Guard>} />
        <Route path="studio" element={<Guard perm="content.generate"><StudioPage /></Guard>} />
        <Route path="posts" element={<Guard perm="posts.view"><PostsPage /></Guard>} />
        <Route path="posts/new" element={<Guard perm="posts.edit"><PostEditorPage /></Guard>} />
        <Route path="posts/:id" element={<Guard perm="posts.view"><PostEditorPage /></Guard>} />
        <Route path="calendar" element={<Guard perm="posts.view"><CalendarPage /></Guard>} />
        <Route path="campaigns" element={<Guard perm="posts.view"><CampaignsPage /></Guard>} />
        <Route path="campaigns/:id" element={<Guard perm="posts.view"><CampaignDetailPage /></Guard>} />
        <Route path="analytics" element={<Guard perm="analytics.view"><AnalyticsPage /></Guard>} />
        <Route path="reports" element={<Guard perm="reports.view"><ReportsPage /></Guard>} />
        <Route path="logs/publishing" element={<Guard perm="logs.view"><PublishLogPage /></Guard>} />
        <Route path="logs/audit" element={<Guard perm="audit.view"><AuditLogPage /></Guard>} />
        <Route path="leads" element={<Guard perm="leads.view"><LeadsPage /></Guard>} />
        <Route path="leads/:id" element={<Guard perm="leads.view"><LeadDetailPage /></Guard>} />
        <Route path="templates" element={<Guard perm="templates.view"><TemplatesPage /></Guard>} />
        <Route path="settings" element={<Guard perm="settings.manage"><SettingsPage /></Guard>} />
        <Route path="users" element={<Guard perm="users.manage"><UsersPage /></Guard>} />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route
          path="*"
          element={
            <div className="board">
              <Empty title="There's no page here" action={<LinkButton to="/">Back to home</LinkButton>} />
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
