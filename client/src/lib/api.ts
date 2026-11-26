import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** status 0: the server couldn't be reached at all (stopped, restarting, or the network is down). */
export const OFFLINE_MESSAGE = "Can't reach the server right now. It may be restarting; this page keeps trying and fills in when it's back.";
export const isOffline = (e: unknown) => e instanceof ApiError && e.status === 0;
/** Worth trying again later: the server was unreachable or had a temporary problem. */
export const isTransient = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status >= 500);

// The app-wide "can't reach the server" banner (Layout) listens for these.
let offline = false;
function setOffline(v: boolean) {
  if (v === offline) return;
  offline = v;
  window.dispatchEvent(new Event(v ? "server-offline" : "server-online"));
}
export const serverOffline = () => offline;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function once<T>(url: string, path: string, opts: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      credentials: "same-origin",
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    setOffline(true);
    throw new ApiError(0, OFFLINE_MESSAGE);
  }
  const json = res.headers.get("content-type")?.includes("application/json");
  // The API always answers in JSON. A 5xx without JSON comes from in between (the dev server's proxy, a gateway)
  // when the API itself is down: that's "unreachable", not an error in the request.
  if (!json && (res.status >= 500 || res.status === 0)) {
    setOffline(true);
    throw new ApiError(0, OFFLINE_MESSAGE);
  }
  setOffline(false);
  const data = json ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(res.status, data?.error ?? `Something went wrong on the server (error ${res.status}). Try again in a moment.`, data?.details);
  }
  return data as T;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  let url = `/api${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const read = (opts.method ?? (opts.body !== undefined ? "POST" : "GET")) === "GET";
  // Reads are safe to repeat: if the server was unreachable, try twice more (1 s, then 3 s) before giving up.
  // Changes (POST/PATCH/DELETE) are never repeated automatically.
  for (let attempt = 0; ; attempt++) {
    try {
      return await once<T>(url, path, opts);
    } catch (e) {
      if (!read || !isOffline(e) || attempt >= 2) throw e;
      await wait(attempt === 0 ? 1000 : 3000);
    }
  }
}

/**
 * Loads data on mount and whenever deps change. If loading fails because the server was unreachable or had a
 * temporary problem, it tries again on its own (5 s, 10 s, 20 s … every 30 s at most) and as soon as the
 * server is reachable again, keeping whatever was already shown.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const retryDelay = useRef(5000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    const id = ++seq.current;
    if (retryTimer.current) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
    setLoading(true);
    try {
      const d = await run();
      if (id === seq.current) {
        setData(d);
        setError(null);
        retryDelay.current = 5000;
      }
    } catch (e) {
      if (id === seq.current) {
        setError((e as Error).message);
        if (isTransient(e)) {
          const ms = retryDelay.current;
          retryDelay.current = Math.min(ms * 2, 30_000);
          retryTimer.current = window.setTimeout(() => {
            if (id === seq.current) void reload();
          }, ms);
        }
      }
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Back online: reload straight away instead of waiting for the next retry.
  const errorRef = useRef(error);
  errorRef.current = error;
  useEffect(() => {
    const on = () => {
      if (errorRef.current) {
        retryDelay.current = 5000;
        void reload();
      }
    };
    window.addEventListener("server-online", on);
    return () => {
      window.removeEventListener("server-online", on);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
    };
  }, [reload]);
  return { data, error, loading, reload, setData };
}
