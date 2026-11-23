import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { one, q } from "../lib/db.js";
import { HttpError, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { authenticate, bumpTokenVersion, readSessionToken, SESSION_COOKIE, sessionCookieOptions, signSession } from "../middleware/auth.js";
import { permissionsFor, ROLE_LABELS, type Role } from "../auth/permissions.js";

export const authRouter = Router();

const tooMany = { error: "Too many sign-in attempts. Wait 15 minutes and try again." };

// Per IP address. These counters live in this process's memory (they reset on restart and aren't shared
// between several app processes). Behind a reverse proxy set TRUST_PROXY=true, or every visitor shares the proxy's IP.
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: tooMany });

// Per account (email), so one address can't be guessed at from many IPs.
const accountLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: false,
  legacyHeaders: false,
  message: tooMany,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 200) : "";
    return `acct:${email || "-"}`;
  },
  // Successful sign-ins don't use up the account's allowance.
  skipSuccessfulRequests: true,
});

const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-0", 12);
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

authRouter.post("/login", loginLimiter, accountLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
  const user = await one("SELECT * FROM users WHERE email=$1", [body.email.toLowerCase()]);
  // One answer for unknown email, wrong password and turned-off account, so the form can't be used to find accounts.
  const generic = new HttpError(401, "That email and password don't match.");
  if (!user) {
    await bcrypt.compare(body.password, DUMMY_HASH); // same timing whether or not the email exists
    throw generic;
  }
  const ok = await bcrypt.compare(body.password, user.password_hash);
  const locked = !!user.locked_until && new Date(user.locked_until) > new Date();
  if (!ok) {
    if (user.is_active && !locked) {
      // Atomic: two parallel wrong guesses can't both read the same old count.
      await q(
        `UPDATE users SET
           failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
           locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE id=$1 RETURNING failed_logins, locked_until`,
        [user.id, MAX_FAILS, LOCK_MINUTES],
      );
    }
    await audit(req, "auth.login_failed", "user", user.id);
    throw generic;
  }
  if (!user.is_active) {
    await audit(req, "auth.login_failed", "user", user.id, { reason: "inactive" });
    throw generic;
  }
  // Only someone who knows the password learns the account is locked.
  if (locked) throw new HttpError(429, "Too many wrong passwords on this account. Try again in a few minutes.");
  await q("UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1", [user.id]);
  const session = { id: user.id, email: user.email, name: user.name, role: user.role as Role };
  res.cookie(SESSION_COOKIE, signSession(session, Number(user.token_version ?? 0)), sessionCookieOptions());
  req.user = session;
  await audit(req, "auth.login", "user", user.id);
  res.json({ user: { ...session, roleLabel: ROLE_LABELS[session.role], permissions: permissionsFor(session.role) } });
});

authRouter.post("/logout", async (req, res) => {
  // Signing out ends this session everywhere it was copied, not just in this browser.
  const payload = readSessionToken(req);
  if (payload?.sub) {
    const id = Number(payload.sub);
    await q("UPDATE users SET token_version = token_version + 1 WHERE id=$1 AND token_version = $2", [id, Number(payload.tv ?? 0)]);
  }
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
  // End every other session, then keep this one signed in with a fresh token.
  const tv = await bumpTokenVersion(req.user!.id);
  res.cookie(SESSION_COOKIE, signSession(req.user!, tv), sessionCookieOptions());
  await audit(req, "auth.password_changed", "user", req.user!.id);
  res.json({ ok: true });
});
