import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Icon, type IconName } from "./Icons";
import { Avatar } from "./ui";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";

interface Item {
  to: string;
  label: string;
  icon: IconName;
  perm?: string;
  count?: number;
  end?: boolean;
}

export const BRAND = { name: "Digital Marketing", short: "GM", org: "Department" };

export function Layout() {
  const { user, can, logout } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<{ review?: number; leads?: number }>({});

  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0); // each page starts at the top
    // Badges: something waits on you
    const jobs: Promise<void>[] = [];
    if (can("posts.approve")) jobs.push(api<{ counts: Record<string, number> }>("/posts/counts").then((r) => setCounts((c) => ({ ...c, review: r.counts.in_review ?? 0 }))));
    if (can("leads.view")) jobs.push(api<{ stats: { needs_review: number; pending_replies: number } }>("/leads/stats").then((r) => setCounts((c) => ({ ...c, leads: r.stats.needs_review + r.stats.pending_replies }))));
    Promise.all(jobs).catch(() => undefined);
  }, [loc.pathname, can]);

  const groups: { title?: string; items: Item[] }[] = [
    { items: [{ to: "/", label: "Home", icon: "home", end: true }] },
    {
      title: "Marketing",
      items: [
        { to: "/trends", label: "Trending topics", icon: "trend", perm: "trends.view" },
        { to: "/studio", label: "AI content studio", icon: "spark", perm: "content.generate" },
        { to: "/posts", label: "Posts and approvals", icon: "doc", perm: "posts.view", count: counts.review },
        { to: "/calendar", label: "Content calendar", icon: "cal", perm: "posts.view" },
        { to: "/campaigns", label: "Campaigns", icon: "flag", perm: "posts.view" },
        { to: "/analytics", label: "Facebook analytics", icon: "chart", perm: "analytics.view" },
        { to: "/reports", label: "Reports", icon: "list", perm: "reports.view" },
        { to: "/logs/publishing", label: "Publishing log", icon: "clock", perm: "logs.view" },
      ],
    },
    {
      title: "Inquiries",
      items: [
        { to: "/leads", label: "Inquiries", icon: "inbox", perm: "leads.view", count: counts.leads },
        { to: "/templates", label: "Response templates", icon: "msg", perm: "templates.view" },
      ],
    },
    {
      title: "Admin",
      items: [
        { to: "/settings", label: "Settings", icon: "settings", perm: "settings.manage" },
        { to: "/users", label: "Users and roles", icon: "users", perm: "users.manage" },
        { to: "/logs/audit", label: "Audit log", icon: "shield", perm: "audit.view" },
      ],
    },
  ];

  return (
    <div className={`app ${open ? "nav-open" : ""}`}>
      <div className="topbar">
        <button className="btn btn-icon" aria-label="Open menu" onClick={() => setOpen(true)}>
          <Icon name="menu" />
        </button>
        <span className="mark" style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--primary)", color: "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700 }}>
          {BRAND.short}
        </span>
        <b style={{ fontSize: 14 }}>{BRAND.name}</b>
      </div>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className="side">
        <div className="brand">
          <span className="mark">{BRAND.short}</span>
          <div>
            <b>{BRAND.name}</b>
            <span>{BRAND.org}</span>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          {groups.map((g, gi) => {
            const items = g.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return null;
            return (
              <div key={gi}>
                {g.title && <p className="nav-g">{g.title}</p>}
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end}>
                    <Icon name={i.icon} />
                    {i.label}
                    {!!i.count && <span className="count">{i.count}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="side-foot">
          <Avatar name={user?.name} size="sm" />
          <div className="who">
            <b>{user?.name}</b>
            <span>{user?.roleLabel}</span>
          </div>
          <button className="btn btn-icon" aria-label="Sign out" title="Sign out" onClick={() => void logout()}>
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
