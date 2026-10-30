import { Router } from "express";
import { z } from "zod";
import { get, nowIso, run } from "../db.js";
import { decryptField, encryptField, hashPassword, maskEmail, randomCode, verifyPassword } from "../crypto.js";
import { OTP_TTL_SECONDS } from "../config.js";
import { checkAadhaar, hashAadhaar, maskAadhaar } from "../aadhaar.js";
import {
  createChallenge,
  findUserIdByMobile,
  hashMobile,
  maskMobile,
  normaliseMobile,
  recentChallengeCount,
  verifyChallenge,
  type OtpChannel,
} from "../otp.js";
import { smsStatus } from "../sms.js";
import { emailStatus } from "../email.js";
import { maskWhatsAppNumber, normalizeWhatsAppNumber, whatsappStatus } from "../whatsapp.js";
import { attachUser, createSession, destroySession, identityFor, requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { asyncHandler, createRateLimiter, HttpError, meta, parseBody } from "../http.js";
import { resolveRole } from "../roles.js";
import { getFacility } from "../registry.js";
import type { UserRow } from "../models.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});

const strongPassword = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(200)
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[0-9]/, "Include a digit")
  .regex(/[^A-Za-z0-9]/, "Include a symbol");

function whatsappSession(user: UserRow) {
  const stored = decryptField(user.phone_enc);
  const digits = stored ? normalizeWhatsAppNumber(stored) : null;
  return {
    number: digits ? maskWhatsAppNumber(digits) : null,
    optIn: Boolean(user.whatsapp_opt_in),
    /** True when the server holds live WhatsApp Business credentials. */
    connected: whatsappStatus().configured,
  };
}

function sessionUser(user: UserRow) {
  const resolved = resolveRole(user.role);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    roleName: resolved.name,
    baseRole: resolved.baseRole,
    permissions: resolved.permissions,
    country: user.country,
    organisation: user.organisation,
    facilityId: user.facility_id ?? null,
    facilityName: user.facility_id ? (getFacility(user.facility_id)?.name ?? null) : null,
    mfaEnabled: Boolean(user.mfa_enabled),
    whatsapp: whatsappSession(user),
    ...identityFor(user),
  };
}

const signupSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  password: strongPassword,
  /** Mobile number, optional at signup but needed for OTP sign-in and Aadhaar. */
  phone: z.string().trim().max(20).optional().default(""),
  consent: z.boolean().refine((v) => v, "Consent to data processing is required"),
});

/**
 * Patient self-registration. Accounts created here are always PATIENT scoped:
 * staff and custom-role accounts remain administrator-provisioned only.
 */
authRouter.post(
  "/signup",
  createRateLimiter({ bucket: "signup", windowMs: 10 * 60_000, max: 6 }),
  asyncHandler(async (req, res) => {
    const body = parseBody(signupSchema, req.body);
    if (get("SELECT id FROM users WHERE email = ?", body.email)) {
      throw new HttpError(409, "An account with that email already exists. Sign in instead.");
    }
    const mobile = body.phone ? normaliseMobile(body.phone) : null;
    if (body.phone && !mobile) {
      throw new HttpError(400, "Enter a mobile number with its country code, for example +91 98100 01000.");
    }
    if (mobile && findUserIdByMobile(mobile)) {
      throw new HttpError(409, "That mobile number is already registered. Sign in with a one-time password instead.");
    }
    const id = `USR-${randomCode(8)}`;
    const now = nowIso();
    run(
      "INSERT INTO users (id, email, name, password_hash, role, country, organisation, active, mfa_enabled, consent_at, phone_enc, phone_hash, whatsapp_opt_in, created_at) VALUES (?, ?, ?, ?, 'PATIENT', 'IN', NULL, 1, 0, ?, ?, ?, 0, ?)",
      id,
      body.email,
      body.name,
      await hashPassword(body.password),
      now,
      mobile ? encryptField(mobile) : null,
      mobile ? hashMobile(mobile) : null,
      now,
    );
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", id)!;
    createSession(user, req, res);
    audit({
      actor: { id: user.id, role: "PATIENT" },
      action: "PATIENT_SIGNUP",
      entityType: "user",
      entityId: user.id,
      ...meta(req),
      details: { email: user.email, consentAt: now, mobileOnFile: mobile ? maskMobile(mobile) : null },
    });
    res.status(201).json({ user: sessionUser(user) });
  }),
);

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
    res.json({ user: sessionUser(user) });
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

/* --------------------------- SMS OTP patient login -------------------------- */

/**
 * Sign-in identifier: the mobile number or email address on the account.
 * `phone` is still accepted so an older client keeps working.
 */
const otpRequestSchema = z.object({
  identifier: z.string().trim().min(5).max(200).optional(),
  phone: z.string().trim().min(5).max(200).optional(),
});
const otpVerifySchema = z.object({
  challengeId: z.string().trim().min(4).max(40),
  code: z.string().trim().min(4).max(8),
});

function otpMessage(code: string): string {
  const minutes = Math.max(1, Math.round(OTP_TTL_SECONDS / 60));
  return `MedNotice India: ${code} is your one-time sign-in code. It expires in ${minutes} minute(s). Do not share it with anyone.`;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Issue a sign-in code to a patient account.
 *
 * One field takes either a registered mobile number or the email address on the
 * account, and the code always goes by the matching channel: an SMS to the
 * number, an email to the mailbox. Codes are only sent to identifiers that
 * belong to an active patient account, so this endpoint cannot be used to
 * message arbitrary numbers or inboxes. The code itself is stored as a digest
 * and is surfaced in the response only while the channel runs in simulation
 * (no provider credentials configured).
 */
authRouter.post(
  "/otp/request",
  createRateLimiter({ bucket: "otp-request", windowMs: 10 * 60_000, max: 6 }),
  asyncHandler(async (req, res) => {
    const body = parseBody(otpRequestSchema, req.body);
    const raw = (body.identifier ?? body.phone ?? "").trim();
    if (!raw) throw new HttpError(400, "Enter the mobile number or email address on your account.");
    const channel: OtpChannel = raw.includes("@") ? "EMAIL" : "SMS";

    let identifier: string;
    if (channel === "EMAIL") {
      const email = raw.toLowerCase();
      if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address, for example you@example.org.");
      if (!emailStatus().enabled) throw new HttpError(503, "Email sign-in is disabled on this deployment.");
      identifier = email;
    } else {
      const mobile = normaliseMobile(raw);
      if (!mobile) throw new HttpError(400, "Enter a valid mobile number, for example +91 98100 01000.");
      if (!smsStatus().enabled) throw new HttpError(503, "SMS sign-in is disabled on this deployment.");
      identifier = mobile;
    }

    if (recentChallengeCount("LOGIN", identifier, 10 * 60_000, channel) >= 5) {
      throw new HttpError(429, "Too many codes requested for this account. Wait ten minutes and try again.");
    }
    const userId = channel === "SMS" ? findUserIdByMobile(identifier) : null;
    const user =
      channel === "EMAIL"
        ? get<UserRow>("SELECT * FROM users WHERE email = ?", identifier)
        : userId
          ? get<UserRow>("SELECT * FROM users WHERE id = ?", userId)
          : undefined;
    if (!user || !user.active || resolveRole(user.role).baseRole !== "PATIENT") {
      audit({
        actor: { id: user?.id ?? null, role: user?.role ?? null },
        action: "LOGIN_OTP_DENIED",
        entityType: "user",
        entityId: user?.id ?? identifier,
        ...meta(req),
        details: { channel, reason: "no active patient account for this identifier" },
      });
      throw new HttpError(
        404,
        channel === "EMAIL"
          ? "No active patient account uses that email address. Create an account to get started."
          : "No active patient account uses that mobile number. Create an account, or add the number under WhatsApp notifications first.",
      );
    }
    const challenge = await createChallenge({
      purpose: "LOGIN",
      identifier,
      channel,
      userId: user.id,
      subject: "Your MedNotice India sign-in code",
      message: otpMessage,
    });
    const masked = channel === "EMAIL" ? maskEmail(identifier) : maskMobile(identifier);
    audit({
      actor: { id: user.id, role: user.role },
      action: "LOGIN_OTP_REQUESTED",
      entityType: "user",
      entityId: user.id,
      ...meta(req),
      details: { channel, identifier: masked, simulated: challenge.simulated },
    });
    res.json({
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel,
      masked,
      sentTo: masked,
      simulated: challenge.simulated,
      devCode: challenge.simulated ? challenge.code : null,
    });
  }),
);

/** Exchange a valid one-time password for a patient session. */
authRouter.post(
  "/otp/verify",
  createRateLimiter({ bucket: "otp-verify", windowMs: 10 * 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    const body = parseBody(otpVerifySchema, req.body);
    const challenge = verifyChallenge(body.challengeId, "LOGIN", body.code);
    const user = challenge.user_id ? get<UserRow>("SELECT * FROM users WHERE id = ?", challenge.user_id) : undefined;
    if (!user || !user.active) throw new HttpError(401, "This account is no longer available.");
    run("UPDATE users SET phone_verified_at = COALESCE(phone_verified_at, ?) WHERE id = ?", nowIso(), user.id);
    createSession(user, req, res);
    audit({
      actor: { id: user.id, role: user.role },
      action: "LOGIN_OTP_SUCCESS",
      entityType: "user",
      entityId: user.id,
      ...meta(req),
      details: { channel: "sms", challengeId: challenge.id },
    });
    res.json({ user: sessionUser(get<UserRow>("SELECT * FROM users WHERE id = ?", user.id)!) });
  }),
);

/* ------------------------------ Aadhaar identity ---------------------------- */

const aadhaarRequestSchema = z.object({ aadhaar: z.string().trim().min(12).max(20) });

/**
 * Start Aadhaar verification for the signed-in patient.
 *
 * The number is validated structurally (12 digits plus the Verhoeff check
 * digit), then a one-time password is sent to the mobile already on the
 * account. Control of that handset is what proves the identity claim, because
 * the UIDAI OTP API itself is only available to licensed AUA/ASA agencies.
 */
authRouter.post(
  "/aadhaar/request",
  attachUser,
  requireAuth,
  createRateLimiter({ bucket: "aadhaar-request", windowMs: 10 * 60_000, max: 6 }),
  asyncHandler(async (req, res) => {
    if (!smsStatus().enabled) throw new HttpError(503, "SMS delivery is disabled, so Aadhaar cannot be verified right now.");
    const body = parseBody(aadhaarRequestSchema, req.body);
    const check = checkAadhaar(body.aadhaar);
    if (!check.ok) throw new HttpError(400, check.reason);
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", req.user!.id)!;
    if (resolveRole(user.role).baseRole !== "PATIENT") {
      throw new HttpError(403, "Aadhaar verification is only required for patient accounts.");
    }
    const stored = decryptField(user.phone_enc);
    const mobile = stored ? normaliseMobile(stored) : null;
    if (!mobile) {
      throw new HttpError(400, "Add a mobile number to your account first — the verification code is sent to that number.");
    }
    const taken = get<{ id: string }>("SELECT id FROM users WHERE aadhaar_hash = ? AND id <> ?", hashAadhaar(check.digits), user.id);
    if (taken) throw new HttpError(409, "That Aadhaar number is already linked to another MedNotice account.");
    if (recentChallengeCount("AADHAAR", mobile, 10 * 60_000) >= 5) {
      throw new HttpError(429, "Too many verification codes requested. Wait ten minutes and try again.");
    }
    const challenge = await createChallenge({
      purpose: "AADHAAR",
      identifier: mobile,
      userId: user.id,
      payload: check.digits,
      message: (code) =>
        `MedNotice India: ${code} is your Aadhaar verification code. It expires in ${Math.max(1, Math.round(OTP_TTL_SECONDS / 60))} minute(s). Never share it.`,
    });
    audit({
      actor: { id: user.id, role: user.role },
      action: "AADHAAR_OTP_REQUESTED",
      entityType: "user",
      entityId: user.id,
      ...meta(req),
      details: { aadhaar: maskAadhaar(check.digits), sentTo: maskMobile(mobile), simulated: challenge.simulated },
    });
    res.json({
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      masked: maskAadhaar(check.digits),
      sentTo: maskMobile(mobile),
      simulated: challenge.simulated,
      devCode: challenge.simulated ? challenge.code : null,
    });
  }),
);

/** Confirm the Aadhaar one-time password and store the verified identity. */
authRouter.post(
  "/aadhaar/verify",
  attachUser,
  requireAuth,
  createRateLimiter({ bucket: "aadhaar-verify", windowMs: 10 * 60_000, max: 20 }),
  asyncHandler((req, res) => {
    const body = parseBody(otpVerifySchema, req.body);
    const challenge = verifyChallenge(body.challengeId, "AADHAAR", body.code);
    const digits = challenge.payload_enc ? decryptField(challenge.payload_enc) : null;
    if (!digits) throw new HttpError(400, "This verification session is no longer valid. Start again.");
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", req.user!.id)!;
    const now = nowIso();
    run(
      "UPDATE users SET aadhaar_enc = ?, aadhaar_hash = ?, aadhaar_masked = ?, aadhaar_verified_at = ?, phone_verified_at = COALESCE(phone_verified_at, ?) WHERE id = ?",
      encryptField(digits),
      hashAadhaar(digits),
      maskAadhaar(digits),
      now,
      now,
      user.id,
    );
    audit({
      actor: { id: user.id, role: user.role },
      action: "AADHAAR_VERIFIED",
      entityType: "user",
      entityId: user.id,
      ...meta(req),
      details: { aadhaar: maskAadhaar(digits), method: "mobile-otp" },
    });
    res.json({ user: sessionUser(get<UserRow>("SELECT * FROM users WHERE id = ?", user.id)!) });
  }),
);

const whatsappSchema = z.object({
  phone: z.string().trim().max(40).optional().default(""),
  optIn: z.boolean(),
});

/**
 * WhatsApp notification preference for the signed-in user.
 *
 * The number is stored encrypted and only ever read back masked. Sending
 * { optIn: false } stops messages without deleting the number, which is what a
 * patient replying STOP expects.
 */
authRouter.post(
  "/whatsapp",
  attachUser,
  requireAuth,
  asyncHandler((req, res) => {
    const body = parseBody(whatsappSchema, req.body);
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", req.user!.id)!;
    const current = decryptField(user.phone_enc);

    if (!body.optIn) {
      run("UPDATE users SET whatsapp_opt_in = 0 WHERE id = ?", user.id);
      audit({
        actor: { id: user.id, role: user.role },
        action: "WHATSAPP_OPT_OUT",
        entityType: "user",
        entityId: user.id,
        ...meta(req),
        details: { number: current ? maskWhatsAppNumber(current) : null },
      });
      res.json({ ok: true, whatsapp: whatsappSession(get<UserRow>("SELECT * FROM users WHERE id = ?", user.id)!) });
      return;
    }

    const digits = normalizeWhatsAppNumber(body.phone ?? "");
    if (!digits) {
      throw new HttpError(400, "Enter a valid WhatsApp number with its country code, for example +91 98100 01000.");
    }
    run("UPDATE users SET phone_enc = ?, phone_hash = ?, whatsapp_opt_in = 1 WHERE id = ?", encryptField(digits), hashMobile(digits), user.id);
    audit({
      actor: { id: user.id, role: user.role },
      action: "WHATSAPP_OPT_IN",
      entityType: "user",
      entityId: user.id,
      ...meta(req),
      details: { number: maskWhatsAppNumber(digits), replaced: Boolean(current) },
    });
    res.json({ ok: true, whatsapp: whatsappSession(get<UserRow>("SELECT * FROM users WHERE id = ?", user.id)!) });
  }),
);
