import type { NextFunction, Request, Response } from "express";
import { get, nowIso, run } from "./db.js";
import { decryptField, hashToken, randomToken } from "./crypto.js";
import { AADHAAR_REQUIRED, SESSION_COOKIE, SESSION_TTL_MS } from "./config.js";
import { maskMobile, normaliseMobile } from "./otp.js";
import { smsStatus } from "./sms.js";
import { HttpError, meta } from "./http.js";
import type { Role, UserRow } from "./models.js";
import { audit } from "./audit.js";
import { resolveRole, type PermissionKey } from "./roles.js";
import { getFacility } from "./registry.js";

export type SessionUser = NonNullable<Request["user"]>;

/**
 * Identity state shared by the session DTO and `/api/auth/me`.
 *
 * Both surfaces must expose the same shape: the client decides whether to offer
 * Aadhaar verification and mobile sign-in from these fields, and a page reload
 * (which reads `/api/auth/me`) must not report a verified account as unverified.
 */
export function identityFor(user: UserRow) {
  const stored = decryptField(user.phone_enc);
  const digits = stored ? normaliseMobile(stored) : null;
  const sms = smsStatus();
  return {
    phone: digits ? maskMobile(digits) : null,
    phoneVerified: Boolean(user.phone_verified_at),
    sms: { connected: sms.configured, simulated: sms.simulated, provider: sms.provider },
    aadhaar: {
      verified: Boolean(user.aadhaar_verified_at),
      masked: user.aadhaar_verified_at ? (user.aadhaar_masked ?? null) : null,
      verifiedAt: user.aadhaar_verified_at ?? null,
      required: AADHAAR_REQUIRED,
    },
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function createSession(user: UserRow, req: Request, res: Response): string {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  run(
    "INSERT INTO sessions (id, user_id, token_hash, ip, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    `SES-${randomToken(8)}`,
    user.id,
    hashToken(token),
    meta(req).ip,
    meta(req).userAgent,
    expiresAt,
    nowIso(),
  );
  run("UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), user.id);
  // Only mark the cookie Secure when the request really arrived over TLS. A
  // plain-HTTP deployment (the EC2 default, TLS at the edge) would otherwise
  // get its session cookie dropped by the browser and sign-in would silently
  // fail after a successful login response.
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  const secure = req.secure || forwardedProto === "https" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
  );
  return token;
}

export function destroySession(req: Request, res: Response): void {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) {
    next();
    return;
  }
  const row = get<UserRow & { expires_at: string; session_id: string }>(
    `SELECT u.*, s.expires_at AS expires_at, s.id AS session_id
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    hashToken(token),
  );
  if (!row) {
    next();
    return;
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run("DELETE FROM sessions WHERE id = ?", row.session_id);
    next();
    return;
  }
  if (!row.active) {
    next(new HttpError(403, "Account is deactivated"));
    return;
  }
  const resolved = resolveRole(row.role);
  req.user = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    roleName: resolved.name,
    baseRole: resolved.baseRole,
    permissions: resolved.permissions,
    country: row.country,
    organisation: row.organisation,
    facilityId: row.facility_id ?? null,
    facilityName: row.facility_id ? (getFacility(row.facility_id)?.name ?? null) : null,
    ...identityFor(row),
  };
  req.sessionId = row.session_id;
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new HttpError(401, "Authentication required"));
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new HttpError(401, "Authentication required"));
      return;
    }
    if (!roles.includes(req.user.baseRole)) {
      audit({
        actor: { id: req.user.id, role: req.user.role },
        action: "AUTHORIZATION_DENIED",
        entityType: "endpoint",
        entityId: `${req.method} ${req.path}`,
        ...meta(req),
        details: { required: roles },
      });
      next(new HttpError(403, "Insufficient permissions"));
      return;
    }
    next();
  };
}

/**
 * Capability gate for endpoints added on top of the legacy role checks.
 * Custom roles inherit their base role's data scope and receive only the
 * permissions recorded on their role definition.
 */
export function requirePermission(...permissions: PermissionKey[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new HttpError(401, "Authentication required"));
      return;
    }
    const has = req.user.baseRole === "SUPER_ADMIN" || permissions.every((p) => req.user!.permissions.includes(p));
    if (!has) {
      audit({
        actor: { id: req.user.id, role: req.user.role },
        action: "AUTHORIZATION_DENIED",
        entityType: "endpoint",
        entityId: `${req.method} ${req.path}`,
        ...meta(req),
        details: { requiredPermissions: permissions, role: req.user.role },
      });
      next(new HttpError(403, "Missing permission for this action"));
      return;
    }
    next();
  };
}

export const STAFF_ROLES: Role[] = ["SUPER_ADMIN", "MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE", "SYSTEM_AUDITOR"];
export const REVIEWER_ROLES: Role[] = ["SUPER_ADMIN", "MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE"];
