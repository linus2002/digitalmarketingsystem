type Level = "debug" | "info" | "warn" | "error";

const SECRET_KEY = /token|secret|password|authorization|cookie|access_token|apikey|api_key/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") {
    if (typeof value === "string") return value.replace(/access_token=[^&\s"]+/gi, "access_token=[redacted]");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(meta ? (scrub(meta) as object) : {}) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => process.env.LOG_DEBUG && write("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
};

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
