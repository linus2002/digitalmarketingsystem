import { one, q } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { env } from "../config/env.js";

export interface BrandSettings {
  name: string;
  voice: string;
  audience: string;
  language: string;
  doList: string[];
  dontList: string[];
  bannedPhrases: string[];
  requiredDisclaimer: string;
  alwaysHashtags: string[];
}

export interface RetentionSettings {
  leadDays: number; // closed/opted-out inquiries are anonymised after this many days of inactivity
  unconsentedDays: number; // conversations without consent are deleted after this many days
  auditDays: number;
  aiLogDays: number;
}

export interface ConsentSettings {
  version: string;
  text: string;
}

export interface MetaPageSettings {
  pageId: string;
  tokenEnc: string | null;
  pageName?: string;
}

export const DEFAULT_BRAND: BrandSettings = {
  name: env.BUSINESS_NAME,
  voice: "Warm, clear and evidence-based. Calm, never alarmist. Plain words over jargon.",
  audience: "Patients, caregivers and healthcare professionals looking for reliable access to cancer and specialty medicines.",
  language: "English",
  doList: [
    "Cite reputable sources (WHO, FDA, NIH, peer-reviewed journals) when sharing health news",
    "Encourage people to talk to their doctor",
    "Keep captions under 120 words",
  ],
  dontList: [
    "Promise outcomes or cures",
    "Give dosing or treatment advice",
    "Name prescription-only medicines in promotional posts unless local rules allow it",
    "Use fear, urgency or before/after claims",
  ],
  bannedPhrases: ["cure", "cures", "miracle", "guaranteed", "100% effective", "no side effects", "risk-free", "best treatment", "instant results"],
  requiredDisclaimer: "For information only, not medical advice. Please talk to your doctor.",
  alwaysHashtags: ["#GetMeds"],
};

export const DEFAULT_RETENTION: RetentionSettings = { leadDays: 365, unconsentedDays: 7, auditDays: 730, aiLogDays: 180 };

export const DEFAULT_CONSENT: ConsentSettings = {
  version: "2026-11",
  text:
    "I agree that {{business}} may keep the details I give here (medicine name, destination country and how to contact me) " +
    "only to answer my inquiry and follow up on it. I can ask for them to be deleted at any time.",
};

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await one<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
  if (!row) return fallback;
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) return { ...fallback, ...row.value };
  return row.value;
}

export async function setSetting(key: string, value: unknown, userId: number | null) {
  await q(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId],
  );
}

export const getBrand = () => getSetting<BrandSettings>("brand", DEFAULT_BRAND);
export const getRetention = () => getSetting<RetentionSettings>("retention", DEFAULT_RETENTION);
export const getConsent = () => getSetting<ConsentSettings>("consent", DEFAULT_CONSENT);

/** Page credentials: settings (encrypted) take precedence over .env. */
export async function getMetaPage(): Promise<{ pageId: string; token: string; pageName?: string; source: "settings" | "env" | "none" }> {
  const s = await getSetting<MetaPageSettings | null>("meta.page", null);
  if (s?.pageId && s.tokenEnc) {
    return { pageId: s.pageId, token: decrypt(s.tokenEnc) ?? "", pageName: s.pageName, source: "settings" };
  }
  if (env.META_PAGE_ID && env.META_PAGE_ACCESS_TOKEN) {
    return { pageId: env.META_PAGE_ID, token: env.META_PAGE_ACCESS_TOKEN, source: "env" };
  }
  return { pageId: "", token: "", source: "none" };
}

export async function saveMetaPage(pageId: string, token: string | null, pageName: string | undefined, userId: number) {
  const current = await getSetting<MetaPageSettings | null>("meta.page", null);
  const tokenEnc = token ? encrypt(token) : current?.tokenEnc ?? null;
  await setSetting("meta.page", { pageId, tokenEnc, pageName }, userId);
}

export function fillTemplate(body: string, vars: Record<string, string | null | undefined>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}
