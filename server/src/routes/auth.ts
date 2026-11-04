import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { one, q } from "../lib/db.js";
import { HttpError, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { authenticate, SESSION_COOKIE, sessionCookieOptions, signSession } from "../middleware/auth.js";
import { permissionsFor, ROLE_LABELS, type Role } from "../auth/permissions.js";

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many sign-in attempts. Wait 15 minutes." } });

const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-0", 12);
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

authRouter.post("/login", loginLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
  const user = await one("SELECT * FROM users WHERE email=$1", [body.email.toLowerCase()]);
  const generic = new HttpError(401, "That email and password don't match.");
  if (!user) {
    await bcrypt.compare(body.password, DUMMY_HASH); // same timing whether or not the email exists
    throw generic;
  }
  if (!user.is_active) throw new HttpError(403, "This account has been turned off. Ask an administrator.");
  if (user.locked_until && new Date(user.locked_until) > new Date()) throw new HttpError(429, "Too many wrong passwords. Try again in a few minutes.");
  const ok = await bcrypt.compare(body.password, user.password_hash);
  if (!ok) {
    const fails = user.failed_logins + 1;
    await q("UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1", [
      user.id,
      fails >= MAX_FAILS ? 0 : fails,
      fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
    ]);
    await audit(req, "auth.login_failed", "user", user.id);
    throw generic;
  }
  await q("UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1", [user.id]);
  const session = { id: user.id, email: user.email, name: user.name, role: user.role as Role };
  res.cookie(SESSION_COOKIE, signSession(session), sessionCookieOptions());
  req.user = session;
  await audit(req, "auth.login", "user", user.id);
  res.json({ user: { ...session, roleLabel: ROLE_LABELS[session.role], permissions: permissionsFor(session.role) } });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

authRouter.get("/me", authenticate, (req, res) => {
  const u = req.user!;
  res.json({ user: { ...u, roleLabel: ROLE_LABELS[u.role], permissions: permissionsFor(u.role) } });
});

export const passwordRule = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(200)
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), "Use letters and at least one number");

authRouter.post("/change-password", authenticate, async (req, res) => {
  const body = parse(z.object({ current: z.string(), next: passwordRule }), req.body);
  const user = await one("SELECT password_hash FROM users WHERE id=$1", [req.user!.id]);
  if (!user || !(await bcrypt.compare(body.current, user.password_hash))) throw new HttpError(400, "Your current password isn't right.");
  await q("UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1", [req.user!.id, await bcrypt.hash(body.next, 12)]);
  await audit(req, "auth.password_changed", "user", req.user!.id);
  res.json({ ok: true });
});
