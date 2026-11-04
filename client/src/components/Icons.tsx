// Line icons from the components sheet, drawn once and reused through <use>.
export type IconName =
  | "home" | "users" | "pin" | "doc" | "deal" | "cal" | "mail" | "search" | "plus" | "edit" | "trash" | "bell"
  | "clock" | "alert" | "info" | "check" | "filter" | "more" | "phone" | "spark" | "chart" | "inbox" | "settings"
  | "logout" | "shield" | "trend" | "send" | "refresh" | "list" | "menu" | "download" | "eye" | "eye-off" | "x" | "chev-l" | "chev-r" | "msg" | "globe" | "flag";

export function Icon({ name, size, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <symbol id="i-home" viewBox="0 0 24 24" {...S}><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" /></symbol>
        <symbol id="i-users" viewBox="0 0 24 24" {...S}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.8 3 2.5 3.5 5.2" /></symbol>
        <symbol id="i-pin" viewBox="0 0 24 24" {...S}><path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z" /><circle cx="12" cy="9" r="2.6" /></symbol>
        <symbol id="i-doc" viewBox="0 0 24 24" {...S}><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></symbol>
        <symbol id="i-deal" viewBox="0 0 24 24" {...S}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></symbol>
        <symbol id="i-cal" viewBox="0 0 24 24" {...S}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></symbol>
        <symbol id="i-mail" viewBox="0 0 24 24" {...S}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></symbol>
        <symbol id="i-search" viewBox="0 0 24 24" {...S}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></symbol>
        <symbol id="i-plus" viewBox="0 0 24 24" {...S} strokeWidth={2}><path d="M12 5v14M5 12h14" /></symbol>
        <symbol id="i-edit" viewBox="0 0 24 24" {...S}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></symbol>
        <symbol id="i-trash" viewBox="0 0 24 24" {...S}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></symbol>
        <symbol id="i-bell" viewBox="0 0 24 24" {...S}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></symbol>
        <symbol id="i-clock" viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></symbol>
        <symbol id="i-alert" viewBox="0 0 24 24" {...S}><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4.2M12 17h.01" /></symbol>
        <symbol id="i-info" viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24" {...S} strokeWidth={2.2}><path d="m5 12.5 4.5 4.5L19 7.5" /></symbol>
        <symbol id="i-filter" viewBox="0 0 24 24" {...S}><path d="M4 6h16M7 12h10M10 18h4" /></symbol>
        <symbol id="i-more" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></symbol>
        <symbol id="i-phone" viewBox="0 0 24 24" {...S}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z" /></symbol>
        <symbol id="i-spark" viewBox="0 0 24 24" {...S}><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="M12 8.5 13.2 11l2.3 1-2.3 1L12 15.5 10.8 13l-2.3-1 2.3-1z" /></symbol>
        <symbol id="i-chart" viewBox="0 0 24 24" {...S}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></symbol>
        <symbol id="i-inbox" viewBox="0 0 24 24" {...S}><path d="M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M3 13h5l1.5 3h5L16 13h5" /></symbol>
        <symbol id="i-settings" viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></symbol>
        <symbol id="i-logout" viewBox="0 0 24 24" {...S}><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3" /></symbol>
        <symbol id="i-shield" viewBox="0 0 24 24" {...S}><path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z" /><path d="m9 12 2 2 4-4" /></symbol>
        <symbol id="i-trend" viewBox="0 0 24 24" {...S}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></symbol>
        <symbol id="i-send" viewBox="0 0 24 24" {...S}><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z" /></symbol>
        <symbol id="i-refresh" viewBox="0 0 24 24" {...S}><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4" /></symbol>
        <symbol id="i-list" viewBox="0 0 24 24" {...S}><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></symbol>
        <symbol id="i-menu" viewBox="0 0 24 24" {...S}><path d="M4 7h16M4 12h16M4 17h16" /></symbol>
        <symbol id="i-download" viewBox="0 0 24 24" {...S}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></symbol>
        <symbol id="i-eye" viewBox="0 0 24 24" {...S}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></symbol>
        <symbol id="i-eye-off" viewBox="0 0 24 24" {...S}><path d="M3 3l18 18" /><path d="M10.6 5.6A10.5 10.5 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.3-1.1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></symbol>
        <symbol id="i-x"viewBox="0 0 24 24" {...S} strokeWidth={2}><path d="M6 6l12 12M18 6 6 18" /></symbol>
        <symbol id="i-chev-l" viewBox="0 0 24 24" {...S} strokeWidth={2}><path d="m15 5-7 7 7 7" /></symbol>
        <symbol id="i-chev-r" viewBox="0 0 24 24" {...S} strokeWidth={2}><path d="m9 5 7 7-7 7" /></symbol>
        <symbol id="i-msg" viewBox="0 0 24 24" {...S}><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" /></symbol>
        <symbol id="i-globe" viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.5 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.5-3.5-8.5s1-5.9 3.5-8.5z" /></symbol>
        <symbol id="i-flag" viewBox="0 0 24 24" {...S}><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></symbol>
      </defs>
    </svg>
  );
}
