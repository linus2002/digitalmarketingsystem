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

/** Promotional content checks against brand rules. Returns human-readable issues. */
export function checkContent(text: string, bannedPhrases: string[]): string[] {
  const issues: string[] = [];
  for (const phrase of bannedPhrases) {
    if (!phrase.trim()) continue;
    const re = new RegExp(`\\b${phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) issues.push(`Uses "${phrase}", which the brand guidelines don't allow.`);
  }
  if (/\b(dose|dosage|mg\b|take \d)/i.test(text)) issues.push("Mentions dosing. Remove it, or have the pharmaceutical team check it.");
  if (/\b(buy now|order now|limited time|act fast|don'?t wait)\b/i.test(text)) issues.push("Uses pressure wording, which isn't appropriate for medicines.");
  if (/\b(\d{2,3}% (success|effective|survival))\b/i.test(text)) issues.push("Quotes an effectiveness figure. Add a source, or remove it.");
  if (/\b(promising results|clinically proven|proven to|breakthrough|highly effective|more effective|life[- ]saving|shown to (improve|extend|reduce|cure|work))\b/i.test(text))
    issues.push("Makes an effectiveness claim. Claims about medicines need approved, sourced wording: remove it or have the pharmaceutical team check it.");
  const drugs = [...new Set(text.match(/\b[a-z]{4,}(?:mab|nib|ciclib|parib|platin|taxel|rubicin|lisib|leucel)\b/gi) ?? [])];
  if (drugs.length || /\bour (product|medicine|drug)s?\b/i.test(text))
    issues.push(
      `${drugs.length ? `Names a medicine (${drugs.join(", ")})` : "Promotes a product"}. Promoting prescription medicines to the public may not be allowed: check with the pharmaceutical team first.`,
    );
  return issues;
}

export const OPT_OUT = /^\s*(stop|unsubscribe|opt[ -]?out|stop messaging|don'?t message me)\s*[.!]*\s*$/i;
export const DELETE_REQUEST = /^\s*(delete|delete my (data|details|info))\s*[.!]*\s*$/i;
export const HUMAN_REQUEST = /\b(human|real person|agent|talk to (someone|a person)|pharmacist)\b/i;
export const YES = /^\s*(yes|y|yeah|yep|ok|okay|i agree|agree|sure|oo|opo)\b/i;
export const NO = /^\s*(no|n|nope|no thanks|don'?t|hindi)\b/i;
