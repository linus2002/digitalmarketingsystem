import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http.js";
import { ollamaChat, ollamaStatus, ollamaWarm } from "./ollama.js";

/** Gets the AI ready before someone needs it (loads the local model into memory). */
export async function warmUp(): Promise<void> {
  if (env.AI_PROVIDER === "ollama") await ollamaWarm().catch(() => undefined);
}

// One entry point for every AI feature. AI_PROVIDER picks Claude (Anthropic API) or a local Ollama model.

export interface ChatOptions {
  system: string;
  prompt: string;
  json?: boolean;
  /** Claude: how much reasoning to spend. Low for sorting/short tasks, medium for writing. */
  effort?: "low" | "medium" | "high";
  /** Ollama only (Claude's current models don't take sampling parameters). */
  temperature?: number;
  timeoutMs?: number;
  /** Ollama only: upper bound on answer length, which keeps CPU generation time in check. */
  maxTokens?: number;
}

const claude = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: env.AI_TIMEOUT_MS, maxRetries: 2 }) : null;

/** Health-related inquiry text only goes to a cloud AI if AI_FOR_INQUIRIES=true is set explicitly. */
export function aiAllowedForInquiries(): boolean {
  if (env.AI_FOR_INQUIRIES === "true") return true;
  if (env.AI_FOR_INQUIRIES === "false") return false;
  return env.AI_PROVIDER === "ollama";
}

export interface AiStatus {
  provider: "anthropic" | "ollama";
  label: string;
  model: string;
  ready: boolean;
  problem?: string;
  fix?: string;
  inquiriesAllowed: boolean;
}

export async function aiStatus(): Promise<AiStatus> {
  const inquiriesAllowed = aiAllowedForInquiries();
  if (env.AI_PROVIDER === "anthropic") {
    if (!claude)
      return {
        provider: "anthropic",
        label: "Claude",
        model: env.CLAUDE_MODEL,
        ready: false,
        problem: "No Anthropic API key is set.",
        fix: "Create a key at console.anthropic.com, put it in .env as ANTHROPIC_API_KEY, then restart the app.",
        inquiriesAllowed,
      };
    return { provider: "anthropic", label: "Claude", model: env.CLAUDE_MODEL, ready: true, inquiriesAllowed };
  }
  const o = await ollamaStatus();
  if (!o.reachable)
    return { provider: "ollama", label: "Local AI (Ollama)", model: o.model, ready: false, problem: `Ollama isn't running (${o.error}).`, fix: `Start Ollama, then run: ollama pull ${o.model}`, inquiriesAllowed };
  if (!o.modelInstalled)
    return { provider: "ollama", label: "Local AI (Ollama)", model: o.model, ready: false, problem: `The model "${o.model}" isn't installed.`, fix: `Run: ollama pull ${o.model}`, inquiriesAllowed };
  return { provider: "ollama", label: "Local AI (Ollama)", model: o.model, ready: true, inquiriesAllowed };
}

async function claudeChat({ system, prompt, json, effort = "medium", timeoutMs }: ChatOptions): Promise<string> {
  if (!claude) throw new HttpError(503, "Claude isn't set up yet: add ANTHROPIC_API_KEY to .env and restart the app.");
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await claude.beta.messages.create(
      {
        model: env.CLAUDE_MODEL,
        max_tokens: 16000,
        // If a safety classifier declines, the API retries on a suitable model within the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort },
        system: json ? `${system}\n\nRespond with a single JSON object only: no prose before or after it, no code fences.` : system,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: timeoutMs ?? env.AI_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(503, "Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.");
    if (err instanceof Anthropic.PermissionDeniedError) throw new HttpError(503, "This API key isn't allowed to use that model. Check CLAUDE_MODEL and your Anthropic account.");
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, "Claude is rate-limiting requests right now. Wait a minute and try again.");
    if (err instanceof Anthropic.BadRequestError) throw new HttpError(502, `Claude couldn't process the request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionTimeoutError) throw new HttpError(504, "Claude took too long to answer. Please try again.");
    if (err instanceof Anthropic.APIConnectionError) throw new HttpError(503, "Can't reach Claude. Check the internet connection.");
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `Claude returned an error (${err.status ?? "unknown"}). Please try again.`);
    throw err;
  }
  if (response.stop_reason === "refusal") throw new HttpError(422, "Claude declined this request. Try rewording it.");
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (response.stop_reason === "max_tokens" && !text) throw new HttpError(502, "Claude's answer was cut off. Try asking for fewer items.");
  return text;
}

export async function chat(opts: ChatOptions): Promise<string> {
  if (env.AI_PROVIDER === "anthropic") return claudeChat(opts);
  return ollamaChat({ ...opts, temperature: opts.temperature ?? 0.7, timeoutMs: opts.timeoutMs ?? env.OLLAMA_TIMEOUT_MS });
}

/** Ask for JSON and parse it, tolerating answers wrapped in prose or code fences. */
export async function chatJson<T>(opts: Omit<ChatOptions, "json">): Promise<T> {
  const raw = await chat({ ...opts, json: true });
  const cleaned = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        /* fall through */
      }
    }
    throw new HttpError(502, "The AI answered in an unexpected format. Please try again.");
  }
}
