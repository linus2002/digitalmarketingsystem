import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Icon, type IconName } from "./Icons";
import { TopBar } from "./TopBar";
import { useAuth } from "../lib/auth";
import { api, serverOffline } from "../lib/api";
import { readCollapsed, saveCollapsed } from "../lib/theme";

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

type BadgeKind = "test" | "ai";

/** A small outlined icon with overlapping colored dots (brand blue, green and a yellow-to-red blend) for the notices. */
function BannerBadge({ kind }: { kind: BadgeKind }) {
  const grad = `sysb-${useId().replace(/:/g, "")}`;
  return (
    <svg className="sys-badge" viewBox="0 0 36 36" aria-hidden="true">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--yellow)" />
          <stop offset="1" stopColor="var(--red)" />
        </linearGradient>
      </defs>
      <g fill="#fff" stroke="var(--ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {kind === "test" ? (
          <>
            <path d="M19.5 4v9l-6.8 12.4A3 3 0 0 0 15.3 30h13.4a3 3 0 0 0 2.6-4.6L24.5 13V4" />
            <path d="M17.5 4h9M15.6 21h12.8" fill="none" />
          </>
        ) : (
          <path d="M23 4.5c1 5.6 3.4 8 9 9-5.6 1-8 3.4-9 9-1-5.6-3.4-8-9-9 5.6-1 8-3.4 9-9z" />
        )}
      </g>
      <circle cx="8" cy="15" r="5" fill="var(--blue)" />
      <circle cx="9" cy="24" r="5" fill="var(--green)" />
      <circle cx="15.5" cy="27.5" r="4.5" fill={`url(#${grad})`} stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * Shown while the server can't be reached (stopped, restarting, network down). Pages keep what they already show
 * and reload on their own; this checks every few seconds and disappears, with a short "back" note, once it answers.
 */
function ConnectionBanner() {
  const [down, setDown] = useState(serverOffline);
  const [back, setBack] = useState(false);
  useEffect(() => {
    const off = () => {
      setDown(true);
      setBack(false);
    };
    const on = () => {
      setDown(false);
      setBack(true);
      window.setTimeout(() => setBack(false), 4000);
    };
    window.addEventListener("server-offline", off);
    window.addEventListener("server-online", on);
    return () => {
      window.removeEventListener("server-offline", off);
      window.removeEventListener("server-online", on);
    };
  }, []);
  // While down, knock every few seconds so everything recovers as soon as the server is back.
  useEffect(() => {
    if (!down) return;
    const t = window.setInterval(() => void api("/health").catch(() => undefined), 4000);
    return () => window.clearInterval(t);
  }, [down]);
  if (!down && !back) return null;
  return (
    <div className="sys-banners">
      <div className={`sys-banner ${down ? "warn" : "info"}`} role="status" aria-live="polite">
        <span className="grow sys-body">
          <strong className="sys-title">{down ? "Reconnecting to the server…" : "Connected again"}</strong>
          <span className="sys-text">
            {down ? "The server isn't answering right now. Your work on this page stays put, and everything reloads by itself when it's back." : "Everything is up to date."}
          </span>
        </span>
      </div>
    </div>
  );
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
      ? "Posts aren't sent to any social platform, and Messenger replies aren't sent."
      : status.publishTestMode
        ? "Posts aren't sent to any social platform."
        : "Messenger replies aren't sent.";
  const notices: { key: string; tone: "info" | "warn"; badge: BadgeKind; title: string; text: string; link?: { to: string; label: string } }[] = [];
  if (test && !hidden.test)
    notices.push({ key: "test", tone: "info", badge: "test", title: "Test mode is on", text: testText, link: isAdmin ? { to: "/settings", label: "Settings" } : undefined });
  if (!status.ai.ready && !hidden.ai)
    notices.push({
      key: "ai",
      tone: "warn",
      badge: "ai",
      title: `${status.ai.label} isn't ready`,
      text: `${status.ai.problem ?? ""} ${status.ai.fix ?? ""}`.trim() || "The bots can't write until it's running.",
    });
  if (!notices.length) return null;
  return (
    <div className="sys-banners">
      {notices.map((n) => (
        <div key={n.key} className={`sys-banner ${n.tone}`} role="status">
          <BannerBadge kind={n.badge} />
          <span className="grow sys-body">
            <strong className="sys-title">{n.title}</strong>
            <span className="sys-text">
              {n.text}
              {n.link && (
                <>
                  {" "}
                  <Link to={n.link.to}>{n.link.label}</Link>
                </>
              )}
            </span>
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
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const mini = collapsed && !narrow;
  // Label shown beside an icon in the collapsed rail. Fixed-position so the sidebar's scroll box doesn't clip it.
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const showTip = (label: string) => (e: { currentTarget: HTMLElement }) => {
    if (!mini) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2, left: r.right + 10 });
  };
  const hideTip = () => setTip(null);
  useEffect(() => {
    if (!mini) setTip(null);
  }, [mini]);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      saveCollapsed(!c);
      return !c;
    });
  const [counts, setCounts] = useState<{ review?: number; leads?: number; comments?: number }>({});
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const sideRef = useRef<HTMLElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  const loadBadges = useCallback(() => {
    api<{ review: number; leads: number; comments?: number }>("/status/badges")
      .then((r) => setCounts({ review: r.review, leads: r.leads, comments: r.comments }))
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
          label: "Posts and approvals",
          icon: "doc",
          perm: "posts.view",
          count: counts.review,
          countTo: "/posts?status=in_review&for=me",
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
        { to: "/comments", label: "Comments", icon: "msg", perm: "leads.view", count: counts.comments, countTo: "/comments", countLabel: "questions in comments" },
        { to: "/templates", label: "Reply templates", icon: "doc", perm: "templates.view" },
      ],
    },
    {
      title: "Admin",
      items: [
        { to: "/settings", label: "Settings", icon: "settings", anyOf: ["settings.manage", "settings.brand"] },
        { to: "/users", label: "Users", icon: "users", perm: "users.manage" },
        { to: "/logs/audit", label: "Audit log", icon: "shield", perm: "audit.view" },
      ],
    },
  ];
  const visible = (i: Item) => (!i.perm || can(i.perm)) && (!i.anyOf || i.anyOf.some((p) => can(p)));

  return (
    <div className={`app ${open ? "nav-open" : ""} ${mini ? "side-collapsed" : ""}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {/* Pointer-only dismiss: keyboard users close with Escape or the Close button */}
      {open && <div className="scrim" aria-hidden="true" onClick={() => closeDrawer(true)} />}
      <aside className="side" id="side-nav" ref={sideRef} aria-hidden={drawerHidden || undefined} aria-label="Menu" onScroll={hideTip}>
        <div className="brand">
          <span className="mark">{BRAND.short}</span>
          <div className="grow">
            <b>{BRAND.name}</b>
            <span>{BRAND.org}</span>
          </div>
          {narrow ? (
            <button type="button" className="btn btn-icon side-close" aria-label="Close menu" onClick={() => closeDrawer(true)}>
              <Icon name="x" />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-icon side-toggle"
              aria-label={mini ? "Expand menu" : "Collapse menu"}
              title={mini ? "Expand menu" : "Collapse menu"}
              aria-expanded={!mini}
              aria-controls="side-nav"
              onClick={toggleCollapsed}
            >
              <Icon name={mini ? "chev-r" : "chev-l"} />
            </button>
          )}
        </div>
        {can("posts.edit") && (
          <Link
            to="/posts/new"
            className="btn btn-primary side-create"
            aria-current={loc.pathname === "/posts/new" ? "page" : undefined}
            onMouseEnter={showTip("Create post")}
            onMouseLeave={hideTip}
            onFocus={showTip("Create post")}
            onBlur={hideTip}
            onClick={hideTip}
          >
            <Icon name="plus" />
            <span>Create post</span>
          </Link>
        )}
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
                    <NavLink
                      to={i.to}
                      end={i.end}
                      onMouseEnter={showTip(i.label)}
                      onMouseLeave={hideTip}
                      onFocus={showTip(i.label)}
                      onBlur={hideTip}
                      onClick={hideTip}
                    >
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
      {mini && tip && (
        <div className="side-tip" style={{ top: tip.top, left: tip.left }} aria-hidden="true">
          {tip.label}
        </div>
      )}
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
          <ConnectionBanner />
          <StatusBanner status={status} isAdmin={user?.role === "admin"} />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
