import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http.js";
import { errMsg, log } from "../lib/logger.js";
import { isProd } from "../config/env.js";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  // body-parser errors (bad JSON, too large)
  const status = (err as { status?: number })?.status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: status === 413 ? "That request is too large." : "The request couldn't be read." });
    return;
  }
  // Postgres constraint violations
  const code = (err as { code?: string })?.code;
  if (code === "23505") {
    res.status(409).json({ error: "That already exists." });
    return;
  }
  if (code === "23503") {
    res.status(400).json({ error: "That refers to a record that doesn't exist." });
    return;
  }
  log.error("Unhandled error", { path: req.path, method: req.method, error: errMsg(err), stack: isProd ? undefined : (err as Error)?.stack });
  res.status(500).json({ error: "Something went wrong on our side. It has been logged." });
}
