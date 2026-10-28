import { sha256Hex } from "./crypto.js";

/**
 * Aadhaar structural validation.
 *
 * Aadhaar numbers are 12 digits whose last digit is a Verhoeff check digit.
 * Local validation rejects typo'd and fake-looking numbers before any identity
 * claim is attempted; the real identity proof is the one-time password sent to
 * the registered mobile, which this platform performs itself (see otp.ts)
 * because the UIDAI Aadhaar OTP API requires an AUA/ASA licence.
 */

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export const AADHAAR_LENGTH = 12;

/** Strip spaces and hyphens; returns null unless it is exactly 12 digits. */
export function normaliseAadhaar(input: string): string | null {
  const digits = (input ?? "").replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(digits)) return null;
  return digits;
}

/** True when the 12-digit string carries a correct Verhoeff check digit. */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split("").reverse().map(Number);
  for (let i = 0; i < reversed.length; i += 1) {
    c = D[c][P[i % 8][reversed[i]]];
  }
  return c === 0;
}

export type AadhaarCheck = { ok: true; digits: string } | { ok: false; reason: string };

/**
 * Full structural check. Aadhaar never begins with 0 or 1, so those prefixes
 * are rejected explicitly rather than relying on the checksum alone.
 */
export function checkAadhaar(input: string): AadhaarCheck {
  const digits = normaliseAadhaar(input);
  if (!digits) return { ok: false, reason: "Enter the 12-digit Aadhaar number exactly as printed, digits only." };
  if (digits.startsWith("0") || digits.startsWith("1")) {
    return { ok: false, reason: "An Aadhaar number never starts with 0 or 1 — check the number and try again." };
  }
  if (!verhoeffValid(digits)) return { ok: false, reason: "The Aadhaar number failed its checksum — check for a typing error." };
  return { ok: true, digits };
}

/** Display form used everywhere outside the encrypted column: XXXX XXXX 1234. */
export function maskAadhaar(digits: string): string {
  const last4 = digits.slice(-4);
  return `XXXX XXXX ${last4}`;
}

/**
 * Deterministic lookup hash. Encryption at rest is randomised, so identity
 * matching (one Aadhaar per account) needs an HMAC-free salted digest.
 */
export function hashAadhaar(digits: string): string {
  return sha256Hex(`aadhaar:${digits}`);
}
