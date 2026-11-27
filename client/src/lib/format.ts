import type { IconName } from "../components/Icons";

export const fmtNum = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en").format(n));

export const fmtCompact = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** A date (and optionally time) in Philippine time, whatever time zone the viewer's computer is in. */
export function fmtDate(v: string | null | undefined, withTime = false) {
  if (!v) return "—";
  // A bare date ("2026-03-01") is a calendar day, not a moment: show that exact day.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    timeZone: m ? "UTC" : "Asia/Manila",
    ...(withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }),
  });
}

/** A time of day in Philippine time. */
export function fmtTime(v: string | null | undefined) {
  if (!v) return "";
  return new Date(v).toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" });
}

export function ago(v: string | null | undefined) {
  if (!v) return "—";
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  const future = s < 0;
  const a = Math.abs(s);
  const out =
    a < 60 ? "just now" : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : a < 86400 * 30 ? `${Math.round(a / 86400)} days` : fmtDate(v);
  if (out === "just now" || out === fmtDate(v)) return out;
  return future ? `in ${out}` : `${out} ago`;
}

/** Value for <input type="datetime-local"> in the browser's time zone. */
export function toLocalInput(v: string | Date | null | undefined) {
  if (!v) return "";
  const d = new Date(v);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

// ---- Business time: every date/time the team enters or sees for scheduling is Philippine time (UTC+8, no DST),
// whatever time zone the viewer's computer is in. Use these for datetime-local inputs and schedule display.
export const BUSINESS_TZ = "Asia/Manila";
export const BUSINESS_TZ_LABEL = "Philippine time";
const PH_MS = 8 * 3_600_000;

/** Value for <input type="datetime-local"> showing Philippine time. */
export function toBizInput(v: string | Date | null | undefined) {
  if (!v) return "";
  const d = new Date(new Date(v).getTime() + PH_MS);
  return d.toISOString().slice(0, 16);
}

/** Reads a datetime-local value as Philippine time and returns an ISO string (or null when empty/invalid). */
export function fromBizInput(v: string) {
  if (!v) return null;
  const d = new Date(`${v.length === 16 ? `${v}:00` : v}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Today's date (YYYY-MM-DD) in Philippine time. */
export const bizToday = () => new Date(Date.now() + PH_MS).toISOString().slice(0, 10);

/** e.g. "Mon, 24 Nov, 9:00 am" in Philippine time. */
export function fmtBiz(v: string | null | undefined, withWeekday = true) {
  if (!v) return "—";
  return new Intl.DateTimeFormat("en-PH", { timeZone: BUSINESS_TZ, ...(withWeekday ? { weekday: "short" } : {}), day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(v));
}

export const initials = (name: string | null | undefined) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";

export type Tone = "good" | "warn" | "bad" | "info" | "mute" | "outline";

export const POST_STATUS: Record<string, { label: string; tone: Tone; icon?: IconName }> = {
  draft: { label: "Draft", tone: "mute", icon: "edit" },
  in_review: { label: "In review", tone: "warn", icon: "eye" },
  changes_requested: { label: "Changes asked", tone: "bad", icon: "alert" },
  approved: { label: "Approved", tone: "good", icon: "check" },
  scheduled: { label: "Scheduled", tone: "info", icon: "clock" },
  publishing: { label: "Publishing", tone: "info", icon: "send" },
  published: { label: "Published", tone: "good", icon: "globe" },
  failed: { label: "Failed", tone: "bad", icon: "alert" },
  cancelled: { label: "Cancelled", tone: "mute", icon: "x" },
};

export const LEAD_STATUS: Record<string, { label: string; tone: Tone }> = {
  awaiting_consent: { label: "Awaiting consent", tone: "mute" },
  collecting: { label: "Assistant collecting", tone: "mute" },
  new: { label: "New", tone: "info" },
  in_progress: { label: "In progress", tone: "warn" },
  waiting_customer: { label: "Waiting on customer", tone: "mute" },
  closed: { label: "Closed", tone: "good" },
  opted_out: { label: "Opted out", tone: "bad" },
};

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: Tone }> = {
  planned: { label: "Planned", tone: "mute" },
  active: { label: "Active", tone: "good" },
  completed: { label: "Completed", tone: "info" },
  archived: { label: "Archived", tone: "mute" },
};

export const CONTACT_LABEL: Record<string, string> = { messenger: "Messenger", instagram: "Instagram", email: "Email", phone: "Phone call", whatsapp: "WhatsApp" };
export const SOURCE_LABEL: Record<string, string> = { messenger: "Messenger", instagram: "Instagram", website: "Website form", manual: "Staff entry" };
