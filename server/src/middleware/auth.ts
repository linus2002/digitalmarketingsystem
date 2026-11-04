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

export function signSession(user: SessionUser): string {
  return jwt.sign({ sub: String(user.id), role: user.role }, env.JWT_SECRET, {
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

/** Loads the signed-in user (if any). Every /api route after this requires a valid session. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token: string | undefined = req.cookies?.[SESSION_COOKIE] ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
  if (!token) throw new HttpError(401, "Please sign in.");
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { issuer: "dm-hub" }) as jwt.JwtPayload;
  } catch {
    throw new HttpError(401, "Your session has ended. Please sign in again.");
  }
  const user = await one<SessionUser & { is_active: boolean }>(
    "SELECT id, email, name, role, is_active FROM users WHERE id = $1",
    [Number(payload.sub)],
  );
  if (!user || !user.is_active) throw new HttpError(401, "Your account is not active.");
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
