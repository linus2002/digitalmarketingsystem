import { env } from "../config/env.js";
import { HttpError } from "../lib/http.js";

// Local model backend (used when AI_PROVIDER=ollama). Callers use services/ai.ts, not this file.

export async function ollamaStatus(): Promise<{ reachable: boolean; model: string; modelInstalled: boolean; models: string[]; error?: string }> {
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name);
    const want = env.OLLAMA_MODEL.includes(":") ? env.OLLAMA_MODEL : `${env.OLLAMA_MODEL}:latest`;
    return { reachable: true, model: env.OLLAMA_MODEL, modelInstalled: models.includes(want) || models.includes(env.OLLAMA_MODEL), models };
  } catch (err) {
    return { reachable: false, model: env.OLLAMA_MODEL, modelInstalled: false, models: [], error: (err as Error).message };
  }
}

// Keep the model in memory between requests: reloading ~5 GB from disk adds seconds to every first call.
const KEEP_ALIVE = "30m";

/** Loads the model into memory ahead of time (no text is generated). Safe to call often. */
export async function ollamaWarm(): Promise<void> {
  await fetch(`${env.OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ model: env.OLLAMA_MODEL, keep_alive: KEEP_ALIVE }),
  });
}

export async function ollamaChat(opts: { system: string; prompt: string; json?: boolean; temperature: number; timeoutMs: number; maxTokens?: number }): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs),
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        stream: false,
        keep_alive: KEEP_ALIVE,
        format: opts.json ? "json" : undefined,
        // A modest context window is enough for these prompts and keeps CPU work down;
        // num_predict stops runaway answers.
        options: { temperature: opts.temperature, num_ctx: 4096, ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}) },
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.prompt },
        ],
      }),
    });
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    throw new HttpError(
      503,
      timedOut
        ? "The local AI model took too long to answer. Try a shorter request or a smaller model."
        : `The local AI (Ollama) isn't reachable at ${env.OLLAMA_URL}. Start Ollama and try again.`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 404) throw new HttpError(503, `The model "${env.OLLAMA_MODEL}" isn't installed. Run: ollama pull ${env.OLLAMA_MODEL}`);
    throw new HttpError(502, `The local AI returned an error: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}
