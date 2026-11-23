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
  /** Stops the request (e.g. when the person closes the page or presses Cancel). */
  signal?: AbortSignal;
  /** How long to wait for a free AI slot before giving up (background jobs can wait longer). */
  queueTimeoutMs?: number;
}

// ---------------- Concurrency limit ----------------
// Every AI call in the app goes through chat(), so one limit covers the studio, bots, inquiries and trend summaries.
// A CPU-only local model gets slower for everyone when several answers are written at once, so it gets few slots.
const MAX_CONCURRENT = Math.max(1, Number(process.env.AI_MAX_CONCURRENT) || (env.AI_PROVIDER === "ollama" ? 2 : 4));
const MAX_WAITING = 30;
const DEFAULT_QUEUE_WAIT_MS = 180_000;
// Upper bounds on a single request, whatever the caller asks for.
const MAX_TIMEOUT_MS = env.AI_PROVIDER === "ollama" ? 15 * 60_000 : 5 * 60_000;

let active = 0;
const waiting: { grant: () => void }[] = [];

const busyError = () => new HttpError(503, "The AI is busy with other requests right now. Please try again in a minute.");
export const cancelledError = () => new HttpError(499, "The request was cancelled.");

function acquireSlot(waitMs: number, signal?: AbortSignal): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) next.grant();
    else active--;
  };
  if (signal?.aborted) return Promise.reject(cancelledError());
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve(release);
  }
  if (waiting.length >= MAX_WAITING) return Promise.reject(busyError());
  return new Promise((resolve, reject) => {
    const entry = {
      grant: () => {
        // The slot passes straight to this waiter, so `active` stays the same.
        cleanup();
        resolve(release);
      },
    };
    const drop = () => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
    };
    const timer = setTimeout(() => {
      drop();
      cleanup();
      reject(busyError());
    }, waitMs);
    const onAbort = () => {
      drop();
      cleanup();
      reject(cancelledError());
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.push(entry);
  });
}

/** How busy the AI is (for status displays). */
export const aiLoad = () => ({ active, waiting: waiting.length, max: MAX_CONCURRENT });

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

/** Developer instructions (.env, ollama pull) are only for administrators; everyone else is told who can fix it. */
export function publicAiStatus(status: AiStatus, isAdmin: boolean): AiStatus {
  if (isAdmin || status.ready) return status;
  return { ...status, problem: status.problem ? stripDevAdvice(status.problem) : status.problem, fix: "Ask your administrator to start the AI." };
}

const DEV_ADVICE = /\.env|ollama pull|Run:|ANTHROPIC_API_KEY|CLAUDE_MODEL|OLLAMA_|https?:\/\/(?:127\.|localhost)/i;
function stripDevAdvice(msg: string): string {
  return DEV_ADVICE.test(msg) ? "The AI isn't available right now." : msg;
}

/** Error text for an AI failure, without developer instructions unless the person is an administrator. */
export function publicAiError(message: string, isAdmin: boolean): string {
  if (isAdmin || !DEV_ADVICE.test(message)) return message;
  return "The AI isn't available right now. Ask your administrator to start the AI.";
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

async function claudeChat({ system, prompt, json, effort = "medium", timeoutMs, signal }: ChatOptions): Promise<string> {
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
      { timeout: timeoutMs ?? env.AI_TIMEOUT_MS, signal },
    );
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) throw cancelledError();
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
  const release = await acquireSlot(opts.queueTimeoutMs ?? DEFAULT_QUEUE_WAIT_MS, opts.signal);
  try {
    if (opts.signal?.aborted) throw cancelledError();
    if (env.AI_PROVIDER === "anthropic") return await claudeChat({ ...opts, timeoutMs: Math.min(MAX_TIMEOUT_MS, opts.timeoutMs ?? env.AI_TIMEOUT_MS) });
    return await ollamaChat({
      ...opts,
      temperature: opts.temperature ?? 0.7,
      timeoutMs: Math.min(MAX_TIMEOUT_MS, opts.timeoutMs ?? env.OLLAMA_TIMEOUT_MS),
    });
  } finally {
    release();
  }
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
