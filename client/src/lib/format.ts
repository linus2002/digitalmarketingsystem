export const fmtNum = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en").format(n));

export const fmtCompact = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

export function fmtDate(v: string | null | undefined, withTime = false) {
  if (!v) return "—";
  const d = new Date(v);
  return d.toLocaleString("en-GB", withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" });
}

export function fmtTime(v: string | null | undefined) {
  if (!v) return "";
  return new Date(v).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
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

export const initials = (name: string | null | undefined) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";

export type Tone = "good" | "warn" | "bad" | "info" | "mute" | "outline";

export const POST_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "mute" },
  in_review: { label: "In review", tone: "warn" },
  changes_requested: { label: "Changes asked", tone: "bad" },
  approved: { label: "Approved", tone: "good" },
  scheduled: { label: "Scheduled", tone: "info" },
  publishing: { label: "Publishing", tone: "info" },
  published: { label: "Published", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "mute" },
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

export const CONTACT_LABEL: Record<string, string> = { messenger: "Messenger", email: "Email", phone: "Phone call", whatsapp: "WhatsApp" };
export const SOURCE_LABEL: Record<string, string> = { messenger: "Messenger", website: "Website form", manual: "Staff entry" };
