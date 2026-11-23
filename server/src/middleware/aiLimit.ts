import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { HttpError } from "../lib/http.js";

// Limits for endpoints that start AI work. The global concurrency cap lives in services/ai.ts (chat());
// these stop one person from queueing up a pile of slow requests.

/** At most `limit` AI requests per person per window (counted per signed-in user). */
export function aiRateLimit(limit = 12, windowMinutes = 15) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user?.id ?? "anon"}`,
    message: { error: `You've asked the AI for a lot in a short time. Wait a few minutes and try again (limit: ${limit} every ${windowMinutes} minutes).` },
  });
}

const running = new Set<string>();

/** One AI request at a time per person per feature: a second one is refused until the first finishes or is cancelled. */
export function oneAtATime(feature: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${feature}:${req.user?.id ?? "anon"}`;
    if (running.has(key)) throw new HttpError(409, "You already have one of these being written. Wait for it to finish or cancel it first.");
    running.add(key);
    // "close" fires when the response is sent or when the connection drops, so the slot is always freed.
    res.on("close", () => running.delete(key));
    next();
  };
}

/** An AbortSignal that fires if the person disconnects (closes the page or presses Cancel) before the answer is sent. */
export function abortOnDisconnect(res: Response): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}
