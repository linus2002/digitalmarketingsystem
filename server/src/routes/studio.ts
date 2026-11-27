import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { one, q } from "../lib/db.js";
import { HttpError, intParam, notFound, parse } from "../lib/http.js";
import { getBrand } from "../lib/settings.js";
import { requirePerm, userCan } from "../middleware/auth.js";
import { abortOnDisconnect, aiRateLimit, oneAtATime } from "../middleware/aiLimit.js";
import { aiStatus, cancelledError, chat, chatJson, publicAiError, publicAiStatus, warmUp } from "../services/ai.js";
import { brandBrief, SAFETY } from "../services/brandPrompt.js";
import { checkCompliance } from "../services/guardrails.js";

export const studioRouter = Router();

/** Only administrators see how to fix the AI (.env, ollama pull); everyone else is told to ask one. */
const isAdmin = (req: Parameters<typeof userCan>[0]) => userCan(req, "settings.manage");

studioRouter.get("/status", requirePerm("content.generate"), async (req, res) => {
  res.json({ ai: publicAiStatus(await aiStatus(), isAdmin(req)) });
});

/** Called when the studio opens, so the local model is already loaded by the time someone presses Generate. */
studioRouter.post("/warm", requirePerm("content.generate"), (_req, res) => {
  void warmUp();
  res.json({ ok: true });
});

const KINDS = ["captions", "campaign_ideas", "hashtags", "image_prompts"] as const;

// Posts hold at most 5,000 characters including the disclaimer, so captions are kept to ~600 words / 4,500 characters.
export const MAX_CAPTION_WORDS = 600;
const MAX_CAPTION_CHARS = 4500;

/** Cuts an over-long caption at the last full sentence that fits. */
function fitCaption(text: string): string {
  if (text.length <= MAX_CAPTION_CHARS) return text;
  const cut = text.slice(0, MAX_CAPTION_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf(".\n"));
  return (end > MAX_CAPTION_CHARS * 0.6 ? cut.slice(0, end + 1) : cut).trim();
}

/** Caption length instruction. Small local models undershoot word counts, so long pieces get explicit structure. */
function lengthRule(words: number): string {
  const lo = Math.round(words * 0.9);
  const hi = Math.round(words * 1.1);
  if (words <= 120) return `${lo}-${hi} words each`;
  const paras = Math.max(3, Math.round(words / 90));
  return (
    `${lo}-${hi} words EACH (this is a long-form post, not a short caption). ` +
    `Write about ${paras} paragraphs of 70-110 words, separated by a blank line (use \\n\\n inside the JSON string): ` +
    `a hook, then educational detail, practical everyday tips, and a closing line encouraging people to talk to their doctor. ` +
    `Do not stop early; a caption under ${lo} words is wrong`
  );
}

function prompt(kind: (typeof KINDS)[number], topic: string, extra: { audience?: string; tone?: string; count: number; notes?: string; words: number }) {
  const ctx = `Topic: ${topic}\n${extra.audience ? `Audience for this piece: ${extra.audience}\n` : ""}${extra.tone ? `Tone: ${extra.tone}\n` : ""}${extra.notes ? `Notes: ${extra.notes}\n` : ""}`;
  switch (kind) {
    case "captions":
      return `${ctx}\nWrite exactly ${extra.count} different Facebook captions, ${lengthRule(extra.words)}. Each has a short internal title and 3-5 relevant hashtags (hashtags go in the hashtags list, not in the caption). Don't cite studies or statistics you aren't sure of.\nReturn {"items":[{"title":"...","caption":"...","hashtags":["#..."]}]}`;
    case "campaign_ideas":
      return `${ctx}\nPropose exactly ${extra.count} campaign ideas. Each: a name, a one-sentence objective, a two-sentence description, 3 one-line post ideas, and a suggested duration in weeks.\nReturn {"items":[{"name":"...","objective":"...","description":"...","posts":["..."],"weeks":2}]}`;
    case "hashtags":
      return `${ctx}\nSuggest 12 relevant, non-misleading hashtags, grouped as broad, niche and branded.\nReturn {"items":[{"group":"broad|niche|branded","tag":"#..."}]}`;
    case "image_prompts":
      return `${ctx}\nWrite exactly ${extra.count} prompts (2-3 sentences each) for an image generator to make an original, on-brand illustration or photo for this post. No real people's likenesses, no logos of other companies, no medical imagery that could alarm. Include style, composition and colour notes (brand colours: primary blue #1f5fd6 with accents of green #1e9e57, yellow #f2b01e and red #d93a32, on white).\nReturn {"items":[{"prompt":"...","alt_text":"..."}]}`;
  }
}

const SECTION_WORDS = 100;

/**
 * Small local models ignore word counts: inside a JSON answer they write one or two sentences, and in plain text
 * they stop around 250-300 words. So on a local model we plan the posts first (titles, hashtags, section points),
 * then write each ~100-word section as plain text in its own request and join them.
 */
async function localCaptions(
  system: string,
  b: { topic: string; audience?: string; tone?: string; notes?: string; count: number; words: number },
  signal: AbortSignal,
) {
  // A cancelled request must not be retried.
  const retry = <T,>(first: () => Promise<T>, again: () => Promise<T>) =>
    first().catch(() => {
      if (signal.aborted) throw cancelledError();
      return again();
    });
  const sections = Math.max(1, Math.round(b.words / SECTION_WORDS));
  const perSection = Math.round(b.words / sections);
  const ctx = `Topic: ${b.topic}\n${b.audience ? `Audience: ${b.audience}\n` : ""}${b.tone ? `Tone: ${b.tone}\n` : ""}${b.notes ? `Notes: ${b.notes}\n` : ""}`;
  const makePlan = (temperature: number) => chatJson<{ items?: { title?: string; hashtags?: unknown; sections?: unknown }[] }>({
    system,
    prompt:
      `${ctx}\nPlan exactly ${b.count} different Facebook posts on this topic, each taking a different angle. ` +
      (sections === 1
        ? `For each: a short internal title, 3-5 relevant hashtags, and exactly 1 section point (one sentence) describing what the post says.\n`
        : `For each: a short internal title, 3-5 relevant hashtags, and exactly ${sections} section points (one sentence each) that flow in order: ` +
          `an opening hook, educational detail, practical everyday tips, and a closing that encourages people to talk to their doctor.\n`) +
      `Return {"items":[{"title":"...","hashtags":["#..."],"sections":["..."]}]}`,
    temperature,
    effort: "medium",
    maxTokens: 250 + b.count * (100 + sections * 70),
    signal,
  });
  // A cut-off or malformed plan is retried once before giving up.
  const plan = await retry(() => makePlan(0.8), () => makePlan(0.6));
  const items: Record<string, unknown>[] = [];
  for (const p of (Array.isArray(plan.items) ? plan.items : []).slice(0, b.count)) {
    const title = String(p.title ?? b.topic);
    const points = (Array.isArray(p.sections) ? p.sections.map(String) : []).slice(0, sections);
    while (points.length < sections) points.push(points.length === sections - 1 ? "Closing: encourage readers to talk to their doctor" : `More practical detail on ${b.topic}`);
    const parts: string[] = [];
    for (let i = 0; i < points.length; i++) {
      if (signal.aborted) throw cancelledError();
      const prev = parts.length ? parts[parts.length - 1].split(/(?<=[.!?])\s+/).slice(-2).join(" ") : "";
      const ask = (temperature: number) => chat({
        system,
        prompt:
          (points.length === 1
            ? `${ctx}\nYou are writing a Facebook post titled "${title}".\n`
            : `${ctx}\nYou are writing part ${i + 1} of ${points.length} of a Facebook post titled "${title}".\n`) +
          (prev ? `The previous part ended: "${prev}"\n` : "") +
          // Small models write ~25% short, so ask for a bit more than the target.
          `Write this part in at least ${perSection} words (aim for ${Math.round(perSection * 1.3)}), covering: ${points[i]}\n` +
          `Don't repeat points already made. Don't state specific ages, percentages, statistics or screening schedules; say a doctor can advise on these.\n` +
          `Plain text only: one or two paragraphs, no heading, no part number, no hashtags, no JSON.` +
          (i === 0 ? "" : " Continue naturally; don't greet the reader or restate the title.") +
          (i === points.length - 1 ? " End by encouraging readers to talk to their doctor or pharmacist." : " Don't wrap up the post yet."),
        temperature,
        effort: "medium",
        maxTokens: Math.round(perSection * 2.2) + 60,
        signal,
      });
      // If the model gets stuck (e.g. "token repeat limit reached"), try once more with a little more variety.
      const raw = await retry(() => ask(0.75), () => ask(0.9));
      const text = raw
        .replace(/^\s*(?:part\s*\d+[^\n]*|#+[^\n]*|\*\*[^\n]*\*\*)\s*\n/i, "")
        .replace(/(?:^|\s)#\w+/g, "")
        .trim();
      if (text) parts.push(text);
    }
    items.push({ title, caption: parts.join("\n\n"), hashtags: p.hashtags });
  }
  return { items };
}

studioRouter.post("/generate", requirePerm("content.generate"), aiRateLimit(12, 15), oneAtATime("studio"), async (req, res) => {
  const b = parse(
    z.object({
      kind: z.enum(KINDS),
      topic: z.string().min(3).max(300),
      audience: z.string().max(200).optional(),
      tone: z.string().max(100).optional(),
      notes: z.string().max(800).optional(),
      count: z.number().int().min(1).max(6).default(2),
      // Target length per caption, in words (captions only).
      words: z.number().int().min(30).max(MAX_CAPTION_WORDS, `Captions can be at most ${MAX_CAPTION_WORDS} words so they fit in a post`).default(80),
    }),
    req.body,
  );
  const brand = await getBrand();
  const started = Date.now();
  // Per-item token budgets: enough for the requested length plus JSON (~1.5 tokens per word), short enough to stop rambling.
  const captionTokens = Math.round(b.words * 1.6) + 110;
  const maxTokens = b.kind === "hashtags" ? 450 : 120 + b.count * (b.kind === "campaign_ideas" ? 280 : b.kind === "captions" ? captionTokens : 180);
  const system = `${SAFETY}\n\n${brandBrief(brand)}`;
  // Stop writing as soon as the person cancels or leaves the page.
  const signal = abortOnDisconnect(res);
  try {
    const out: { items?: Record<string, unknown>[] } =
      b.kind === "captions" && env.AI_PROVIDER === "ollama"
        ? await localCaptions(system, b, signal)
        : await chatJson<{ items?: Record<string, unknown>[] }>({
            system,
            prompt: prompt(b.kind, b.topic, b),
            temperature: 0.8,
            effort: "medium",
            maxTokens,
            signal,
            // Long pieces take a local model a while: allow ~150 ms per token on top of the normal limit (at most 10 minutes).
            // Claude is fast, so it keeps the normal limit.
            timeoutMs: env.AI_PROVIDER === "ollama" ? Math.min(600_000, Math.max(env.OLLAMA_TIMEOUT_MS, maxTokens * 150)) : env.AI_TIMEOUT_MS,
          });
    // Local models sometimes return more than asked; keep the requested number (hashtags come as a longer list).
    const limit = b.kind === "hashtags" ? 30 : b.count;
    const items = (Array.isArray(out.items) ? out.items : []).slice(0, limit).map((item) => {
      const text = Object.values(item).flat().filter((v) => typeof v === "string").join(" ");
      const issues = checkCompliance(text, brand, { brandDisclaimer: false }).map((i) => i.text);
      if (b.kind === "captions") {
        const caption = fitCaption(String(item.caption ?? ""));
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
    const message = signal.aborted ? "Cancelled" : (err as Error).message;
    await q("INSERT INTO ai_generations (user_id, kind, input, error, duration_ms) VALUES ($1,$2,$3,$4,$5)", [req.user!.id, b.kind, b, message, Date.now() - started]);
    if (signal.aborted) return; // nobody is waiting for the answer
    if (err instanceof HttpError) throw new HttpError(err.status, publicAiError(err.message, isAdmin(req)), err.details);
    throw err;
  }
});

/** Checks text against the brand and compliance rules (used live in the post editor, before saving). */
studioRouter.post("/check", requirePerm("posts.view"), async (req, res) => {
  const { text } = parse(z.object({ text: z.string().max(10000) }), req.body);
  const brand = await getBrand();
  const issues = checkCompliance(text, brand);
  res.json({ issues, blocking: issues.filter((i) => i.level === "block").length, disclaimer: brand.requiredDisclaimer, hasDisclaimer: !issues.some((i) => i.rule === "disclaimer") });
});

studioRouter.get("/history", requirePerm("content.generate"), async (req, res) => {
  const rows = await q(
    "SELECT id, kind, input, output, duration_ms, error, created_at FROM ai_generations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20",
    [req.user!.id],
  );
  res.json({ history: rows });
});

studioRouter.get("/history/:id", requirePerm("content.generate"), async (req, res) => {
  const item = await one("SELECT * FROM ai_generations WHERE id=$1 AND user_id=$2", [intParam(req.params.id), req.user!.id]);
  if (!item) throw notFound("That generation");
  res.json({ item });
});
