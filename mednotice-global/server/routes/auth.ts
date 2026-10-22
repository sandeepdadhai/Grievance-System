import { Router } from "express";
import { z } from "zod";
import { get, nowIso, run } from "../db.js";
import { hashPassword, verifyPassword } from "../crypto.js";
import { attachUser, createSession, destroySession, requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { asyncHandler, createRateLimiter, HttpError, meta, parseBody } from "../http.js";
import type { UserRow } from "../models.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});

authRouter.post(
  "/login",
  createRateLimiter({ bucket: "login", windowMs: 5 * 60_000, max: 12 }),
  asyncHandler(async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const user = get<UserRow>("SELECT * FROM users WHERE email = ?", body.email);
    const valid = user ? await verifyPassword(body.password, user.password_hash) : false;
    if (!user || !valid || !user.active) {
      audit({
        actor: { id: user?.id ?? null, role: user?.role ?? null },
        action: "LOGIN_FAILED",
        entityType: "user",
        entityId: user?.id ?? body.email,
        ...meta(req),
        details: { email: body.email },
      });
      throw new HttpError(401, "Invalid email or password.");
    }
    createSession(user, req, res);
    audit({ actor: { id: user.id, role: user.role }, action: "LOGIN_SUCCESS", entityType: "user", entityId: user.id, ...meta(req), details: {} });
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, country: user.country, organisation: user.organisation, mfaEnabled: Boolean(user.mfa_enabled) },
    });
  }),
);

authRouter.post("/logout", attachUser, (req, res) => {
  if (req.user) {
    audit({ actor: { id: req.user.id, role: req.user.role }, action: "LOGOUT", entityType: "user", entityId: req.user.id, ...meta(req), details: {} });
  }
  destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get("/me", attachUser, (req, res) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }
  res.json({ user: req.user });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z
    .string()
    .min(12, "New password must be at least 12 characters")
    .max(200)
    .regex(/[A-Z]/, "Include an uppercase letter")
    .regex(/[a-z]/, "Include a lowercase letter")
    .regex(/[0-9]/, "Include a digit")
    .regex(/[^A-Za-z0-9]/, "Include a symbol"),
});

authRouter.post(
  "/change-password",
  attachUser,
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parseBody(passwordSchema, req.body);
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", req.user!.id)!;
    if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
      throw new HttpError(400, "Current password is incorrect.");
    }
    run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(body.newPassword), user.id);
    run("DELETE FROM sessions WHERE user_id = ?", user.id);
    destroySession(req, res);
    audit({
      actor: { id: user.id, role: user.role },
      action: "PASSWORD_CHANGED",
      entityType: "user",
      entityId: user.id,
      ...meta(req),
      details: { sessionsRevoked: true, at: nowIso() },
    });
    res.json({ ok: true, message: "Password updated. All sessions were revoked." });
  }),
);
