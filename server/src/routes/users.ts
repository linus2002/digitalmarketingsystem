import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { one, q } from "../lib/db.js";
import { badRequest, intParam, notFound, parse } from "../lib/http.js";
import { audit } from "../lib/audit.js";
import { bumpTokenVersion, requirePerm, SESSION_COOKIE, sessionCookieOptions, signSession } from "../middleware/auth.js";
import type { Role } from "../auth/permissions.js";
import { ROLE_LABELS, ROLES } from "../auth/permissions.js";
import { passwordRule } from "./auth.js";

export const usersRouter = Router();

// A light list everyone signed in can use, for "assign to" pickers.
usersRouter.get("/directory", async (_req, res) => {
  res.json({ users: await q("SELECT id, name, role FROM users WHERE is_active ORDER BY name") });
});

usersRouter.get("/", requirePerm("users.manage"), async (_req, res) => {
  const users = await q("SELECT id, email, name, role, is_active, last_login_at, created_at FROM users ORDER BY created_at");
  res.json({ users, roles: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) });
});

usersRouter.post("/", requirePerm("users.manage"), async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), name: z.string().min(1).max(100), role: z.enum(ROLES), password: passwordRule }), req.body);
  const user = await one(
    "INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role, is_active, created_at",
    [b.email.toLowerCase(), b.name, b.role, await bcrypt.hash(b.password, 12)],
  );
  await audit(req, "user.created", "user", user!.id, { role: b.role });
  res.status(201).json({ user });
});

usersRouter.patch("/:id", requirePerm("users.manage"), async (req, res) => {
  const id = intParam(req.params.id);
  const b = parse(
    z.object({ name: z.string().min(1).max(100).optional(), role: z.enum(ROLES).optional(), is_active: z.boolean().optional(), password: passwordRule.optional() }),
    req.body,
  );
  if (id === req.user!.id && (b.role && b.role !== "admin" || b.is_active === false)) throw badRequest("You can't remove your own admin access or turn off your own account.");
  const existing = await one("SELECT id FROM users WHERE id=$1", [id]);
  if (!existing) throw notFound("User");
  await q(
    `UPDATE users SET name=COALESCE($2,name), role=COALESCE($3,role), is_active=COALESCE($4,is_active),
       password_hash=COALESCE($5,password_hash), failed_logins=CASE WHEN $5 IS NULL THEN failed_logins ELSE 0 END,
       locked_until=CASE WHEN $5 IS NULL THEN locked_until END, updated_at=now() WHERE id=$1`,
    [id, b.name ?? null, b.role ?? null, b.is_active ?? null, b.password ? await bcrypt.hash(b.password, 12) : null],
  );
  // A password reset or turning the account off signs the person out everywhere.
  if (b.password || b.is_active === false) {
    const tv = await bumpTokenVersion(id);
    if (id === req.user!.id) {
      // An admin resetting their own password stays signed in here.
      const name = b.name ?? req.user!.name;
      res.cookie(SESSION_COOKIE, signSession({ ...req.user!, name, role: (b.role ?? req.user!.role) as Role }, tv), sessionCookieOptions());
    }
  }
  await audit(req, "user.updated", "user", id, { role: b.role, is_active: b.is_active, passwordReset: !!b.password, nameChanged: b.name !== undefined });
  res.json({ ok: true });
});
