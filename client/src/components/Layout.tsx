import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Icon, type IconName } from "./Icons";
import { TopBar } from "./TopBar";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";

interface Item {
  to: string;
  label: string;
  icon: IconName;
  /** Shown when the user has this permission */
  perm?: string;
  /** ...or any one of these */
  anyOf?: string[];
  count?: number;
  /** Where the badge goes (a filtered list of what's waiting) */
  countTo?: string;
  countLabel?: string;
  end?: boolean;
}

export const BRAND = { name: "Digital Marketing", short: "GM", org: "Department" };

/** GET /api/status */
export interface SystemStatus {
  ai: { ready: boolean; label: string; model: string; problem?: string; fix?: string };
  facebook: { connected: boolean; pageName?: string };
  publishTestMode: boolean;
  messengerTestMode: boolean;
  businessName: string;
}

const NARROW = "(max-width: 960px)";
const BADGE_POLL_MS = 60_000;

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function sessionGet(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function sessionSet(key: string, v: string) {
  try {
    sessionStorage.setItem(key, v);
  } catch {
    /* private mode etc.: the banner just comes back on reload */
  }
}

/** Slim notices about how the system is set up: Test mode, AI not ready. Each can be hidden for this browser session. */
function StatusBanner({ status, isAdmin }: { status: SystemStatus | null; isAdmin: boolean }) {
  const [hidden, setHidden] = useState<Record<string, boolean>>(() => ({
    test: sessionGet("banner.test") === "1",
    ai: sessionGet("banner.ai") === "1",
  }));
  if (!status) return null;
  const hide = (k: string) => {
    sessionSet(`banner.${k}`, "1");
    setHidden((h) => ({ ...h, [k]: true }));
  };
  const test = status.publishTestMode || status.messengerTestMode;
  const testText =
    status.publishTestMode && status.messengerTestMode
      ? "Test mode: posts and replies aren't sent to Facebook."
      : status.publishTestMode
        ? "Test mode: posts aren't sent to Facebook."
        : "Test mode: Messenger replies aren't sent to Facebook.";
  const notices: { key: string; tone: "info" | "warn"; text: string; link?: { to: string; label: string } }[] = [];
  if (test && !hidden.test) notices.push({ key: "test", tone: "info", text: testText, link: isAdmin ? { to: "/settings", label: "Settings" } : undefined });
  if (!status.ai.ready && !hidden.ai)
    notices.push({
      key: "ai",
      tone: "warn",
      text: `${status.ai.label} isn't ready${status.ai.problem ? `: ${status.ai.problem}` : "."} ${status.ai.fix ?? ""}`.trim(),
    });
  if (!notices.length) return null;
  return (
    <div className="sys-banners">
      {notices.map((n) => (
        <div key={n.key} className={`sys-banner ${n.tone}`} role="status">
          <Icon name={n.tone === "warn" ? "alert" : "info"} />
          <span className="grow">
            {n.text}
            {n.link && (
              <>
                {" "}
                <Link to={n.link.to}>{n.link.label}</Link>
              </>
            )}
          </span>
          <button type="button" className="sys-x" aria-label="Hide this notice" onClick={() => hide(n.key)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Layout() {
  const { user, can } = useAuth();
  const loc = useLocation();
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<{ review?: number; leads?: number }>({});
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const sideRef = useRef<HTMLElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  const loadBadges = useCallback(() => {
    api<{ review: number; leads: number }>("/status/badges")
      .then((r) => setCounts({ review: r.review, leads: r.leads }))
      .catch(() => undefined);
  }, []);

  // System status (Test mode, AI): once per sign-in; it only changes when the server restarts or settings change.
  useEffect(() => {
    api<SystemStatus>("/status")
      .then(setStatus)
      .catch(() => undefined);
  }, [user?.id]);

  // Badges: on every page change and every minute
  useEffect(() => {
    loadBadges();
  }, [loc.pathname, loc.search, loadBadges]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") loadBadges();
    }, BADGE_POLL_MS);
    return () => window.clearInterval(t);
  }, [loadBadges]);

  // New page: close the drawer, start at the top, and move focus to the content for keyboard users
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [loc.pathname]);

  const closeDrawer = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) menuBtn.current?.focus();
  }, []);

  // Drawer (phones and small tablets): hidden from keyboard and screen readers while closed
  const drawerHidden = narrow && !open;
  useEffect(() => {
    const el = sideRef.current;
    if (!el) return;
    if (drawerHidden) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }, [drawerHidden]);

  useEffect(() => {
    if (!open || !narrow) return;
    sideRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, narrow, closeDrawer]);

  const groups: { title?: string; items: Item[] }[] = [
    { items: [{ to: "/", label: "Home", icon: "home", end: true }] },
    {
      title: "Plan",
      items: [
        { to: "/trends", label: "Trending topics", icon: "trend", perm: "trends.view" },
        { to: "/calendar", label: "Post calendar", icon: "cal", perm: "posts.view" },
        { to: "/campaigns", label: "Campaigns", icon: "flag", perm: "posts.view" },
      ],
    },
    {
      title: "Create",
      items: [
        { to: "/studio", label: "AI studio", icon: "spark", perm: "content.generate" },
        { to: "/bots", label: "AI bots", icon: "bot", perm: "content.generate" },
        {
          to: "/posts",
          label: "Post approvals",
          icon: "doc",
          perm: "posts.view",
          count: counts.review,
          countTo: "/posts?status=in_review",
          countLabel: "waiting for your approval",
        },
      ],
    },
    {
      title: "Measure",
      items: [
        { to: "/analytics", label: "Page analytics", icon: "chart", perm: "analytics.view" },
        { to: "/reports", label: "Reports", icon: "list", perm: "reports.view" },
        { to: "/logs/publishing", label: "Publish log", icon: "clock", perm: "logs.view" },
      ],
    },
    {
      title: "Inquiries",
      items: [
        { to: "/leads", label: "Inquiries", icon: "inbox", perm: "leads.view", count: counts.leads, countTo: "/leads?filter=review", countLabel: "waiting on you" },
        { to: "/templates", label: "Reply templates", icon: "msg", perm: "templates.view" },
      ],
    },
    {
      title: "Admin",
      items: [
        { to: "/settings", label: "Settings", icon: "settings", anyOf: ["settings.manage", "settings.brand"] },
        { to: "/users", label: "Users & roles", icon: "users", perm: "users.manage" },
        { to: "/logs/audit", label: "Audit log", icon: "shield", perm: "audit.view" },
      ],
    },
  ];
  const visible = (i: Item) => (!i.perm || can(i.perm)) && (!i.anyOf || i.anyOf.some((p) => can(p)));

  return (
    <div className={`app ${open ? "nav-open" : ""}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {/* Pointer-only dismiss: keyboard users close with Escape or the Close button */}
      {open && <div className="scrim" aria-hidden="true" onClick={() => closeDrawer(true)} />}
      <aside className="side" id="side-nav" ref={sideRef} aria-hidden={drawerHidden || undefined} aria-label="Menu">
        <div className="brand">
          <span className="mark">{BRAND.short}</span>
          <div className="grow">
            <b>{BRAND.name}</b>
            <span>{BRAND.org}</span>
          </div>
          {narrow && (
            <button type="button" className="btn btn-icon side-close" aria-label="Close menu" onClick={() => closeDrawer(true)}>
              <Icon name="x" />
            </button>
          )}
        </div>
        <nav className="nav" aria-label="Main">
          {groups.map((g, gi) => {
            const items = g.items.filter(visible);
            if (!items.length) return null;
            const headId = `nav-g-${gi}`;
            return (
              <div key={gi} role={g.title ? "group" : undefined} aria-labelledby={g.title ? headId : undefined}>
                {g.title && (
                  <p className="nav-g" id={headId}>
                    {g.title}
                  </p>
                )}
                {items.map((i) => (
                  <div key={i.to} className="nav-row">
                    <NavLink to={i.to} end={i.end}>
                      <Icon name={i.icon} />
                      <span className="grow">{i.label}</span>
                    </NavLink>
                    {!!i.count &&
                      (i.countTo ? (
                        <Link to={i.countTo} className="count" aria-label={`${i.count} ${i.countLabel ?? ""}`.trim()} title={`${i.count} ${i.countLabel ?? ""}`.trim()}>
                          {i.count}
                        </Link>
                      ) : (
                        <span className="count">{i.count}</span>
                      ))}
                  </div>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="app-col">
        <TopBar
          org={status?.businessName ?? BRAND.org}
          start={
            narrow && (
              <>
                <button
                  ref={menuBtn}
                  type="button"
                  className="btn btn-icon"
                  aria-label="Open menu"
                  aria-expanded={open}
                  aria-controls="side-nav"
                  onClick={() => setOpen(true)}
                >
                  <Icon name="menu" />
                </button>
                <span className="appbar-brand">
                  <span className="mark">{BRAND.short}</span>
                  {BRAND.name}
                </span>
              </>
            )
          }
        />
        <main className="main" id="main" ref={mainRef} tabIndex={-1}>
          <StatusBanner status={status} isAdmin={user?.role === "admin"} />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
