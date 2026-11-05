import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ADMIN_ALLOWED_IPS, ADMIN_BASIC_PASSWORD, ADMIN_BASIC_USER } from "./config.js";

/** Normalise IPv4-mapped IPv6 addresses so allowlists can use plain IPv4. */
function normaliseIp(value: string): string {
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function basicCredentialsValid(req: Request): boolean {
  // Not configured: the bind address is the only restriction.
  if (!ADMIN_BASIC_USER && !ADMIN_BASIC_PASSWORD) return true;
  // Half-configured is a mistake, and fails closed rather than opening the console.
  if (!ADMIN_BASIC_USER || !ADMIN_BASIC_PASSWORD) return false;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const userOk = constantTimeEqual(decoded.slice(0, separator), ADMIN_BASIC_USER);
  const passwordOk = constantTimeEqual(decoded.slice(separator + 1), ADMIN_BASIC_PASSWORD);
  return userOk && passwordOk;
}

/**
 * First line of defence for the staff console, applied before every route. The
 * console is bound to a private address by default, so this adds an explicit
 * network allowlist (`ADMIN_ALLOWED_IPS`) and an optional HTTP Basic challenge
 * (`ADMIN_BASIC_USER` / `ADMIN_BASIC_PASSWORD`) for when it is published through
 * a reverse proxy. Role checks on /api/admin/* remain the actual authorization.
 */
export function adminConsoleGate(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");

  if (ADMIN_ALLOWED_IPS.length > 0) {
    const ip = normaliseIp(req.ip ?? req.socket.remoteAddress ?? "");
    if (!ADMIN_ALLOWED_IPS.includes(ip)) {
      res.status(403).type("text/plain").send("This console is restricted to approved networks.");
      return;
    }
  }

  if (!basicCredentialsValid(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Health Department staff console", charset="UTF-8"');
    res.status(401).type("text/plain").send("Authentication required.");
    return;
  }

  next();
}
