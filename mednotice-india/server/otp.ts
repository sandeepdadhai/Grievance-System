import crypto from "node:crypto";
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  SMS_DEFAULT_COUNTRY,
} from "./config.js";
import { get, nowIso, run } from "./db.js";
import { encryptField, hashToken, randomCode, sha256Hex, timingSafeEqualStr } from "./crypto.js";
import { HttpError } from "./http.js";
import { sendSms } from "./sms.js";
import { sendEmail } from "./email.js";

/** Why a one-time password was issued. */
export type OtpPurpose = "LOGIN" | "AADHAAR";

/** How a one-time password reaches the account holder. */
export type OtpChannel = "SMS" | "EMAIL";

export type ChallengeRow = {
  id: string;
  purpose: string;
  channel: string;
  user_id: string | null;
  phone_hash: string;
  phone_enc: string;
  code_hash: string;
  payload_enc: string | null;
  attempts: number;
  max_attempts: number;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

/**
 * Normalise a mobile number to international digits.
 *
 * A bare 10-digit Indian number gains the configured country prefix, a leading
 * trunk 0 is dropped, and anything outside E.164's 8–15 digit range is refused.
 */
export function normaliseMobile(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `${SMS_DEFAULT_COUNTRY}${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `${SMS_DEFAULT_COUNTRY}${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith(SMS_DEFAULT_COUNTRY)) return digits;
  if (digits.length >= 8 && digits.length <= 15) return digits;
  return null;
}

export function maskMobile(digits: string): string {
  if (digits.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

export function hashMobile(digits: string): string {
  return sha256Hex(`mobile:${digits}`);
}

/**
 * Deterministic lookup hash for whichever identifier was used. Mobile numbers
 * and mailboxes are namespaced so the two can never collide.
 */
export function hashIdentifier(channel: OtpChannel, identifier: string): string {
  return channel === "EMAIL" ? sha256Hex(`email:${identifier.trim().toLowerCase()}`) : hashMobile(identifier);
}

export function findUserIdByMobile(digits: string): string | null {
  const row = get<{ id: string }>("SELECT id FROM users WHERE phone_hash = ? LIMIT 1", hashMobile(digits));
  return row?.id ?? null;
}

/** Number of challenges issued to this identifier in the trailing window. */
export function recentChallengeCount(
  purpose: OtpPurpose,
  identifier: string,
  windowMs: number,
  channel: OtpChannel = "SMS",
): number {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM otp_challenges WHERE purpose = ? AND phone_hash = ? AND created_at >= ?",
    purpose,
    hashIdentifier(channel, identifier),
    since,
  );
  return Number(row?.n ?? 0);
}

function numericCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String(crypto.randomInt(0, 10));
  return out;
}

/** Codes are stored as a digest bound to the challenge id, never in clear text. */
function codeHash(challengeId: string, code: string): string {
  return hashToken(`otp:${challengeId}:${code}`);
}

export type CreatedChallenge = {
  id: string;
  /** Only returned so simulation-mode deployments can show the code. */
  code: string;
  expiresAt: string;
  simulated: boolean;
  /** Outbox filename or gateway message id. */
  reference: string | null;
  error: string | null;
};

export async function createChallenge(opts: {
  purpose: OtpPurpose;
  /** Mobile number or email address the code is delivered to. */
  identifier: string;
  /** Delivery channel; SMS unless the identifier is an email address. */
  channel?: OtpChannel;
  userId: string | null;
  /** Extra encrypted context, e.g. the pending Aadhaar number. */
  payload?: string | null;
  message: (code: string) => string;
  /** Subject line used by the email channel. */
  subject?: string;
}): Promise<CreatedChallenge> {
  const channel: OtpChannel = opts.channel ?? "SMS";
  const id = `OTP-${randomCode(10)}`;
  const code = numericCode(OTP_LENGTH);
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();
  run(
    `INSERT INTO otp_challenges (id, purpose, channel, user_id, phone_hash, phone_enc, code_hash, payload_enc, attempts, max_attempts, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)`,
    id,
    opts.purpose,
    channel,
    opts.userId,
    hashIdentifier(channel, opts.identifier),
    encryptField(opts.identifier),
    codeHash(id, code),
    opts.payload ? encryptField(opts.payload) : null,
    OTP_MAX_ATTEMPTS,
    expiresAt,
    nowIso(),
  );

  const text = opts.message(code);
  const delivery =
    channel === "EMAIL"
      ? await sendEmail({
          to: opts.identifier,
          subject: opts.subject ?? "Your MedNotice India one-time password",
          text,
          kind: opts.purpose,
        })
      : await sendSms({ to: opts.identifier, text, kind: opts.purpose });
  if (delivery.error) {
    // A challenge nobody can read is useless: retire it so a retry starts clean.
    run("UPDATE otp_challenges SET consumed_at = ? WHERE id = ?", nowIso(), id);
    throw new HttpError(502, "We could not send the one-time password. Please try again in a moment.");
  }
  return { id, code, expiresAt, simulated: delivery.simulated, reference: delivery.reference, error: null };
}

/**
 * Validate a submitted code. Increments the attempt counter on failure and
 * burns the challenge once it succeeds or runs out of attempts.
 */
export function verifyChallenge(id: string, purpose: OtpPurpose, code: string): ChallengeRow {
  const clean = (code ?? "").replace(/[^\d]/g, "");
  const row = get<ChallengeRow>("SELECT * FROM otp_challenges WHERE id = ? AND purpose = ?", id, purpose);
  if (!row) throw new HttpError(400, "This verification session is no longer valid. Start again.");
  if (row.consumed_at) throw new HttpError(400, "That one-time password has already been used. Request a new one.");
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new HttpError(400, "The one-time password has expired. Request a new one.");
  }
  if (row.attempts >= row.max_attempts) {
    throw new HttpError(429, "Too many incorrect attempts. Request a new one-time password.");
  }
  if (!clean || !timingSafeEqualStr(row.code_hash, codeHash(row.id, clean))) {
    run("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?", row.id);
    throw new HttpError(400, "That code is not correct. Check the SMS and try again.");
  }
  run("UPDATE otp_challenges SET consumed_at = ? WHERE id = ?", nowIso(), row.id);
  return row;
}
