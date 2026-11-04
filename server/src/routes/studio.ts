import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { one, q } from "../lib/db.js";
import { parse } from "../lib/http.js";
import { getBrand, type BrandSettings } from "../lib/settings.js";
import { requirePerm } from "../middleware/auth.js";
import { aiStatus, chatJson, warmUp } from "../services/ai.js";
import { checkContent } from "../services/guardrails.js";

export const studioRouter = Router();

studioRouter.get("/status", requirePerm("content.generate"), async (_req, res) => {
  res.json({ ai: await aiStatus() });
});

/** Called when the studio opens, so the local model is already loaded by the time someone presses Generate. */
studioRouter.post("/warm", requirePerm("content.generate"), (_req, res) => {
  void warmUp();
  res.json({ ok: true });
});

const KINDS = ["captions", "campaign_ideas", "hashtags", "image_prompts"] as const;

function brandBrief(b: BrandSettings): string {
  return [
    `Brand: ${b.name}. Voice: ${b.voice}`,
    `Audience: ${b.audience}`,
    `Language: ${b.language}`,
    `Always: ${b.doList.join("; ")}`,
    `Never: ${b.dontList.join("; ")}`,
    `Never use these words or phrases: ${b.bannedPhrases.join(", ")}`,
  ].join("\n");
}

const SAFETY =
  "You write for a licensed pharmaceutical distributor's Facebook Page. Content must be original, accurate and educational. " +
  "Never claim a medicine cures or guarantees anything, never give doses or treatment advice, never target or speculate about any individual's health, " +
  "and never use fear or urgency. Encourage people to talk to their doctor. Reply with JSON only.";

function prompt(kind: (typeof KINDS)[number], topic: string, extra: { audience?: string; tone?: string; count: number; notes?: string }) {
  const ctx = `Topic: ${topic}\n${extra.audience ? `Audience for this piece: ${extra.audience}\n` : ""}${extra.tone ? `Tone: ${extra.tone}\n` : ""}${extra.notes ? `Notes: ${extra.notes}\n` : ""}`;
  switch (kind) {
    case "captions":
      return `${ctx}\nWrite exactly ${extra.count} different Facebook captions (50-90 words each), each with a short internal title and 3-5 relevant hashtags. Don't cite studies or statistics you aren't sure of.\nReturn {"items":[{"title":"...","caption":"...","hashtags":["#..."]}]}`;
    case "campaign_ideas":
      return `${ctx}\nPropose exactly ${extra.count} campaign ideas. Each: a name, a one-sentence objective, a two-sentence description, 3 one-line post ideas, and a suggested duration in weeks.\nReturn {"items":[{"name":"...","objective":"...","description":"...","posts":["..."],"weeks":2}]}`;
    case "hashtags":
      return `${ctx}\nSuggest 12 relevant, non-misleading hashtags, grouped as broad, niche and branded.\nReturn {"items":[{"group":"broad|niche|branded","tag":"#..."}]}`;
    case "image_prompts":
      return `${ctx}\nWrite exactly ${extra.count} prompts (2-3 sentences each) for an image generator to make an original, on-brand illustration or photo for this post. No real people's likenesses, no logos of other companies, no medical imagery that could alarm. Include style, composition and colour notes (brand colours: primary blue #1f5fd6 with accents of green #1e9e57, yellow #f2b01e and red #d93a32, on white).\nReturn {"items":[{"prompt":"...","alt_text":"..."}]}`;
  }
}

studioRouter.post("/generate", requirePerm("content.generate"), async (req, res) => {
  const b = parse(
    z.object({
      kind: z.enum(KINDS),
      topic: z.string().min(3).max(300),
      audience: z.string().max(200).optional(),
      tone: z.string().max(100).optional(),
      notes: z.string().max(800).optional(),
      count: z.number().int().min(1).max(6).default(2),
    }),
    req.body,
  );
  const brand = await getBrand();
  const started = Date.now();
  try {
    const out = await chatJson<{ items?: Record<string, unknown>[] }>({
      system: `${SAFETY}\n\n${brandBrief(brand)}`,
      prompt: prompt(b.kind, b.topic, b),
      temperature: 0.8,
      effort: "medium",
      // Generous per-item token budgets: enough for the requested length plus JSON, short enough to stop rambling.
      maxTokens: b.kind === "hashtags" ? 450 : 120 + b.count * (b.kind === "campaign_ideas" ? 280 : b.kind === "captions" ? 230 : 180),
    });
    // Local models sometimes return more than asked; keep the requested number (hashtags come as a longer list).
    const limit = b.kind === "hashtags" ? 30 : b.count;
    const items = (Array.isArray(out.items) ? out.items : []).slice(0, limit).map((item) => {
      const text = Object.values(item).flat().filter((v) => typeof v === "string").join(" ");
      const issues = checkContent(text, brand.bannedPhrases);
      if (b.kind === "captions") {
        const caption = String(item.caption ?? "");
        const tags = Array.isArray(item.hashtags) ? (item.hashtags as unknown[]).map(String) : [];
        return {
          ...item,
          caption,
          hashtags: [...new Set([...tags, ...brand.alwaysHashtags])].map((t) => (t.startsWith("#") ? t : `#${t}`)).slice(0, 8),
          suggestedDisclaimer: brand.requiredDisclaimer && !caption.includes(brand.requiredDisclaimer) ? brand.requiredDisclaimer : null,
          issues,
        };
      }
      return { ...item, issues };
    });
    await q("INSERT INTO ai_generations (user_id, kind, input, output, model, duration_ms) VALUES ($1,$2,$3,$4,$5,$6)", [
      req.user!.id,
      b.kind,
      b,
      JSON.stringify(items),
      env.AI_PROVIDER === "anthropic" ? env.CLAUDE_MODEL : env.OLLAMA_MODEL,
      Date.now() - started,
    ]);
    res.json({ kind: b.kind, items, durationMs: Date.now() - started });
  } catch (err) {
    await q("INSERT INTO ai_generations (user_id, kind, input, error, duration_ms) VALUES ($1,$2,$3,$4,$5)", [req.user!.id, b.kind, b, (err as Error).message, Date.now() - started]);
    throw err;
  }
});

/** Checks any text against the brand rules (used live in the post editor). */
studioRouter.post("/check", requirePerm("posts.view"), async (req, res) => {
  const { text } = parse(z.object({ text: z.string().max(5000) }), req.body);
  const brand = await getBrand();
  res.json({ issues: checkContent(text, brand.bannedPhrases), disclaimer: brand.requiredDisclaimer, hasDisclaimer: !brand.requiredDisclaimer || text.includes(brand.requiredDisclaimer) });
});

studioRouter.get("/history", requirePerm("content.generate"), async (req, res) => {
  const rows = await q(
    "SELECT id, kind, input, output, duration_ms, error, created_at FROM ai_generations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20",
    [req.user!.id],
  );
  res.json({ history: rows });
});

studioRouter.get("/history/:id", requirePerm("content.generate"), async (req, res) => {
  res.json({ item: await one("SELECT * FROM ai_generations WHERE id=$1 AND user_id=$2", [Number(req.params.id), req.user!.id]) });
});
