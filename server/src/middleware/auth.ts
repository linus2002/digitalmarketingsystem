import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { one } from "../lib/db.js";
import { HttpError, forbidden } from "../lib/http.js";
import { can, type Permission, type Role } from "../auth/permissions.js";

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export const SESSION_COOKIE = "dm_session";

/**
 * Signs a session token. `tokenVersion` is the user's current users.token_version: bumping that column
 * (sign-out, password change, admin reset, deactivation) ends every session issued before.
 */
export function signSession(user: SessionUser, tokenVersion = 0): string {
  return jwt.sign({ sub: String(user.id), role: user.role, tv: tokenVersion }, env.JWT_SECRET, {
    expiresIn: Math.round(env.SESSION_HOURS * 3600),
    issuer: "dm-hub",
  });
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "strict" as const,
    path: "/",
    maxAge: env.SESSION_HOURS * 3600 * 1000,
  };
}

/** Ends all of a user's sessions; returns the new version (to re-issue the current session if wanted). */
export async function bumpTokenVersion(userId: number): Promise<number> {
  const r = await one<{ token_version: number }>("UPDATE users SET token_version = token_version + 1 WHERE id=$1 RETURNING token_version", [userId]);
  return r?.token_version ?? 0;
}

/** Reads and verifies the session token on a request without loading the user. */
export function readSessionToken(req: Request): jwt.JwtPayload | null {
  const header = req.headers.authorization;
  const token: string | undefined = req.cookies?.[SESSION_COOKIE] ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
  if (!token) return null;
  try {
    return jwt.verify(token, env.JWT_SECRET, { issuer: "dm-hub" }) as jwt.JwtPayload;
  } catch {
    return null;
  }
}

/** A browser opening an API link directly (e.g. an export in a new tab) gets sent to the app, not raw JSON. */
function wantsPage(req: Request): boolean {
  return req.method === "GET" && req.accepts(["json", "html"]) === "html";
}

/** Loads the signed-in user (if any). Every /api route after this requires a valid session. */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const deny = (msg: string) => {
    if (wantsPage(req)) {
      res.redirect(302, "/");
      return;
    }
    throw new HttpError(401, msg);
  };
  const header = req.headers.authorization;
  const token: string | undefined = req.cookies?.[SESSION_COOKIE] ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
  if (!token) return deny("Please sign in.");
  const payload = readSessionToken(req);
  if (!payload) return deny("Your session has ended. Please sign in again.");
  const user = await one<SessionUser & { is_active: boolean; token_version: number }>(
    "SELECT id, email, name, role, is_active, token_version FROM users WHERE id = $1",
    [Number(payload.sub)],
  );
  if (!user || !user.is_active) return deny("Your account is not active.");
  // Tokens issued before token_version existed carry no "tv" and count as version 0.
  if (Number(payload.tv ?? 0) !== Number(user.token_version ?? 0)) return deny("Your session has ended. Please sign in again.");
  req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  next();
}

export function requirePerm(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new HttpError(401, "Please sign in.");
    if (!perms.every((p) => can(req.user!.role, p))) throw forbidden();
    next();
  };
}

export function userCan(req: Request, perm: Permission): boolean {
  return !!req.user && can(req.user.role, perm);
}
