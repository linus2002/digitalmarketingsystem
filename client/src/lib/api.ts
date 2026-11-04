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

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  let url = `/api${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      credentials: "same-origin",
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check that it's running.");
  }
  const data = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

/** Loads data on mount and whenever deps change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await run();
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError((e as Error).message);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}
