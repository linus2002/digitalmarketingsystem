import { createHash } from "node:crypto";
import type { BrandSettings } from "../lib/settings.js";

// Rules that keep content and conversations safe. Keyword rules always run;
// the local AI may *add* review flags, but can never remove one a rule set.

export const INQUIRY_CATEGORIES = [
  "product_availability",
  "pricing_quote",
  "prescription",
  "medical_question",
  "regulatory_import",
  "shipping_logistics",
  "order_status",
  "privacy_request",
  "general",
] as const;
export type InquiryCategory = (typeof INQUIRY_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<InquiryCategory, string> = {
  product_availability: "Availability",
  pricing_quote: "Price or quote",
  prescription: "Prescription",
  medical_question: "Medical question",
  regulatory_import: "Regulatory / import",
  shipping_logistics: "Shipping",
  order_status: "Order status",
  privacy_request: "Privacy request",
  general: "General",
};

/** Categories that always go to the pharmaceutical team before anyone replies. */
export const REVIEW_CATEGORIES: InquiryCategory[] = ["prescription", "medical_question", "regulatory_import", "product_availability"];

const RULES: { category: InquiryCategory; pattern: RegExp }[] = [
  { category: "privacy_request", pattern: /\b(delete my (data|details|info)|remove my (data|details)|erase|gdpr|data privacy|forget me)\b/i },
  {
    category: "medical_question",
    pattern:
      /\b(dose|dosage|dosing|how (much|many) (should|to) take|side ?effects?|symptoms?|diagnos\w*|is it safe|interact\w*|pregnan\w*|stage [1-4iv]+|my (doctor|oncologist) said|should i (take|stop|start)|treatment plan|chemo cycle|instead of)\b/i,
  },
  { category: "prescription", pattern: /\b(prescription|prescribed|rx\b|doctor'?s? (note|order)|without (a )?prescription|refill)\b/i },
  {
    category: "regulatory_import",
    pattern: /\b(import|customs|permit|fda|ema|regulator\w*|registered|registration|approv\w+ in|legal (to|in)|license|licence|compassionate use|named patient)\b/i,
  },
  { category: "product_availability", pattern: /\b(available|availability|in stock|stock|supply|source|do you (have|carry|sell)|can you get|where (can|to) (i )?(buy|get))\b/i },
  { category: "pricing_quote", pattern: /\b(price|cost|how much|quote|quotation|discount|payment|pay)\b/i },
  { category: "shipping_logistics", pattern: /\b(ship|shipping|deliver\w*|courier|cold chain|tracking)\b/i },
  { category: "order_status", pattern: /\b(order (status|number)|my order|where is my)\b/i },
];

const URGENT = /\b(urgent|emergency|asap|immediately|today|running out|ran out|last dose)\b/i;

export interface Classification {
  category: InquiryCategory;
  matched: InquiryCategory[];
  needsReview: boolean;
  reviewReasons: string[];
  priority: "normal" | "high";
}

export function classifyInquiry(text: string): Classification {
  const matched = RULES.filter((r) => r.pattern.test(text)).map((r) => r.category);
  const category = matched[0] ?? "general";
  const reviewReasons = [...new Set(matched.filter((c) => REVIEW_CATEGORIES.includes(c)))].map((c) => CATEGORY_LABELS[c]);
  return {
    category,
    matched,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    priority: URGENT.test(text) ? "high" : "normal",
  };
}

// ---------------------------------------------------------------- compliance check for posts

/**
 * One problem the compliance check found. "block" stops approval until it's fixed or the pharmaceutical team signs
 * the post off; "warn" is for the reviewer to judge. `match` is the wording that triggered it, `add` a missing
 * disclaimer the editor can add with one click.
 */
export interface ComplianceIssue {
  rule: string;
  level: "block" | "warn";
  text: string;
  match?: string;
  fix?: string;
  add?: string;
}

type ComplianceBrand = Pick<BrandSettings, "bannedPhrases" | "requiredDisclaimer"> & Partial<Pick<BrandSettings, "restrictedMedicines" | "topicDisclaimers">>;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole word or phrase, any case; also works for phrases that start or end with a symbol ("100%", "#1"). */
const found = (text: string, phrase: string) => text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(phrase.trim())}(?![\\p{L}\\p{N}])`, "iu"))?.[0] ?? null;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const CLAIM_EFFECT = /\b(promising results|clinically proven|proven to|breakthrough|highly effective|more effective|life[- ]saving|shown to (improve|extend|reduce|cure|work))\b/i;
const CLAIM_TREAT =
  /\b(treats?|heals?|prevents?|eliminates?|reverses?|kills?|stops?|fights?) (cancer|tumou?rs?|diabetes|hypertension|infections?|the virus|covid|diseases?|illness(es)?)\b/i;
const CLAIM_SAFE = /\b(100% safe|completely safe|totally safe|perfectly safe|safe for everyone|harmless|without (any )?side effects|no side effects)(?![\p{L}\p{N}])/iu;
const DOSING = /\b(dose|dosage|\d+ ?mg|take \d)\b/i;
const PRESSURE = /\b(buy now|order now|limited time|act fast|don'?t wait|while supplies last|last chance|hurry)\b/i;
const STAT = /\b\d{1,3}(\.\d+)?% (success|effective|effectiveness|survival|response|cure|recovery)\b/i;
const COMPARE = /\b(better than|more effective than|stronger than|safer than|cheaper than|number one|the best)\b|#1(?!\d)/i;
const TESTIMONIAL = /\b(i was cured|it cured|worked for me|my (mother|mom|father|dad|wife|husband|son|daughter|friend|patient) (got better|recovered|was cured|is cured|is cancer[- ]free))\b/i;
const BEFORE_AFTER = /\bbefore (and|&|\/) after\b/i;
const FDA = /\bfda[- ]approved\b/i;
const DRUG = /\b[a-z]{4,}(?:mab|nib|ciclib|parib|platin|taxel|rubicin|lisib|leucel)\b/gi;

/**
 * Checks post wording against the brand rules and the usual rules for advertising medicines to the public.
 * Pass everything that gets published (title, caption with hashtags). `brandDisclaimer: false` skips the
 * brand-disclaimer check, for callers that report it themselves.
 */
export function checkCompliance(text: string, brand: ComplianceBrand, opts: { brandDisclaimer?: boolean } = {}): ComplianceIssue[] {
  const out: ComplianceIssue[] = [];
  const push = (i: ComplianceIssue) => {
    // The same words caught by two rules (a banned phrase that is also a claim): keep the first, the stricter one.
    if (i.match && out.some((o) => o.match?.toLowerCase() === i.match!.toLowerCase())) return;
    if (!i.match && out.some((o) => o.rule === i.rule)) return;
    out.push(i);
  };
  const hit = (re: RegExp) => text.match(re)?.[0] ?? null;

  for (const phrase of brand.bannedPhrases) {
    if (!phrase.trim()) continue;
    const m = found(text, phrase);
    if (m) push({ rule: "banned", level: "block", match: m, text: `Uses "${m}", which the brand guidelines don't allow.`, fix: "Remove it or say it another way." });
  }
  const restricted = new Set<string>();
  for (const name of brand.restrictedMedicines ?? []) {
    if (!name.trim()) continue;
    const m = found(text, name);
    if (!m) continue;
    restricted.add(m.toLowerCase());
    push({
      rule: "restricted",
      level: "block",
      match: m,
      text: `Names ${m}, which is on the restricted medicines list. Promoting it to the public may not be allowed.`,
      fix: "Take the name out, or ask the pharmaceutical team to sign the post off.",
    });
  }
  let m = hit(CLAIM_EFFECT);
  if (m)
    push({ rule: "claim", level: "block", match: m, text: `Makes an effectiveness claim ("${m}"). Claims about medicines need approved, sourced wording.`, fix: "Remove it, or ask the pharmaceutical team to sign off the exact wording." });
  m = hit(CLAIM_TREAT);
  if (m)
    push({ rule: "treat", level: "block", match: m, text: `Says something treats or prevents a disease ("${m}"). That's a medical claim.`, fix: "Talk about access and support instead, and encourage people to see their doctor." });
  m = hit(CLAIM_SAFE);
  if (m) push({ rule: "safety", level: "block", match: m, text: `Promises safety ("${m}"). Every medicine can have side effects.`, fix: "Remove it." });
  m = hit(STAT);
  if (m) push({ rule: "stat", level: "warn", match: m, text: `Quotes an effectiveness figure ("${m}").`, fix: "Add the source (the study or the regulator), or remove it." });
  m = hit(DOSING);
  if (m) push({ rule: "dosing", level: "warn", match: m, text: `Mentions dosing ("${m}"). Dosing advice belongs with a doctor or pharmacist.`, fix: "Remove it, or have the pharmaceutical team check it." });
  m = hit(PRESSURE);
  if (m) push({ rule: "pressure", level: "warn", match: m, text: `Uses pressure wording ("${m}"), which isn't appropriate for medicines.`, fix: 'Use a calm call to action, like "Message us to ask about availability".' });
  m = hit(COMPARE);
  if (m) push({ rule: "compare", level: "warn", match: m, text: `Compares or ranks ("${m}"). Comparative claims need evidence.`, fix: "Remove it, or add the source." });
  m = hit(TESTIMONIAL);
  if (m) push({ rule: "testimonial", level: "warn", match: m, text: `Reads like a patient testimonial ("${m}"). Personal results can't be shown as typical.`, fix: "Remove it, or have the pharmaceutical team check it." });
  m = hit(BEFORE_AFTER);
  if (m) push({ rule: "before_after", level: "warn", match: m, text: "Uses a before-and-after comparison, which isn't allowed for medicines.", fix: "Remove it." });
  m = hit(FDA);
  if (m)
    push({ rule: "fda", level: "warn", match: m, text: `Says "${m}". Make sure the product is registered for this use in the country you post to.`, fix: "Check the registration, and add the registration number if your regulator asks for it." });
  const drugs = [...new Set((text.match(DRUG) ?? []).filter((d) => !restricted.has(d.toLowerCase())))];
  if (drugs.length)
    push({
      rule: "medicine",
      level: "warn",
      match: drugs[0],
      text: `Names what looks like a prescription medicine (${drugs.join(", ")}). Promoting prescription medicines to the public may not be allowed.`,
      fix: "Check with the pharmaceutical team. Add it to the restricted medicines list in Settings to make this a blocking rule.",
    });
  else if (/\bour (product|medicine|drug)s?\b/i.test(text))
    push({ rule: "medicine", level: "warn", text: "Promotes a product. Promoting prescription medicines to the public may not be allowed.", fix: "Check with the pharmaceutical team first." });

  const t = norm(text);
  for (const d of brand.topicDisclaimers ?? []) {
    const topic = d.when.map((w) => found(text, w)).find(Boolean);
    if (topic && d.text.trim() && !t.includes(norm(d.text)))
      push({ rule: "topic_disclaimer", level: "block", match: topic, text: `Mentions "${topic}", so it must carry: "${d.text.trim()}"`, add: d.text.trim() });
  }
  if (opts.brandDisclaimer !== false && brand.requiredDisclaimer.trim() && !t.includes(norm(brand.requiredDisclaimer)))
    push({ rule: "disclaimer", level: "warn", text: "The brand disclaimer isn't in this post.", add: brand.requiredDisclaimer.trim() });

  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));
}

/** Fingerprint of the wording a compliance sign-off covers. Any change to it needs a new sign-off. */
export function complianceSig(post: { title?: unknown; message?: unknown; hashtags?: unknown; link_url?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([post.title ?? "", post.message ?? "", post.hashtags ?? [], post.link_url ?? null]))
    .digest("hex");
}

// Opt-out: a short whole-message keyword ("STOP", "unsubscribe", "please stop"), or a clear phrase anywhere in the
// message ("please stop messaging me", "unsubscribe me"). Phrases need an object ("me"/"us") or a messaging verb,
// so ordinary sentences like "I want to stop smoking" or "should I stop taking it" don't count.
export const OPT_OUT =
  /^\s*(please\s+)?(stop|unsubscribe|opt[ -]?out|stop messaging( me)?|don'?t message me)(\s+please)?\s*[.!]*\s*$|\b(stop (messaging|texting|contacting|sending (me )?messages( to me)?|emailing|calling) (me|us)\b|unsubscribe me\b|opt me out\b|(do not|don'?t) (message|contact|text|email) (me|us)( again| anymore| any more)?\b|no more messages\b|remove me from (your|this|the) (list|messages|mailing list)\b)/i;
export const DELETE_REQUEST = /^\s*(delete|delete my (data|details|info))\s*[.!]*\s*$/i;
export const HUMAN_REQUEST = /\b(human|real person|agent|talk to (someone|a person)|pharmacist)\b/i;
export const YES = /^\s*(yes|y|yeah|yep|ok|okay|i agree|agree|sure|oo|opo)\b/i;
export const NO = /^\s*(no|n|nope|no thanks|don'?t|hindi)\b/i;

const EMAIL_IN_TEXT = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi;
// 7+ digits, optionally with a leading + and separators: phone numbers, not doses ("100 mg") or years.
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{5,}\d/g;
const digitCount = (v: string) => v.replace(/\D/g, "").length;

/** True when the text contains something that looks like an email address or phone number. */
export function hasContactData(text: string | null | undefined): boolean {
  if (!text) return false;
  return (text.match(EMAIL_IN_TEXT)?.length ?? 0) > 0 || (text.match(PHONE_IN_TEXT) ?? []).some((m) => digitCount(m) >= 7);
}

/** Replaces email addresses and phone numbers in free text (for masking, and before text goes to the AI). */
export function redactContactData(text: string, replacer: { email?: (v: string) => string; phone?: (v: string) => string } = {}): string {
  return text
    .replace(EMAIL_IN_TEXT, (m) => (replacer.email ? replacer.email(m) : "[email removed]"))
    .replace(PHONE_IN_TEXT, (m) => (digitCount(m) >= 7 ? (replacer.phone ? replacer.phone(m) : "[phone removed]") : m));
}
