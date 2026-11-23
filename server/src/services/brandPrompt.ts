import type { BrandSettings } from "../lib/settings.js";

// Shared by the AI content studio and the bots, so every AI-written caption follows the same rules.

export function brandBrief(b: BrandSettings): string {
  return [
    `Brand: ${b.name}. Voice: ${b.voice}`,
    `Audience: ${b.audience}`,
    `Language: ${b.language}`,
    `Always: ${b.doList.join("; ")}`,
    `Never: ${b.dontList.join("; ")}`,
    `Never use these words or phrases: ${b.bannedPhrases.join(", ")}`,
  ].join("\n");
}

export const SAFETY =
  "You write for a licensed pharmaceutical distributor's Facebook Page. Content must be original, accurate and educational. " +
  "Never claim a medicine cures or guarantees anything, never give doses or treatment advice, never target or speculate about any individual's health, " +
  "and never use fear or urgency. Encourage people to talk to their doctor. Reply with JSON only.";
