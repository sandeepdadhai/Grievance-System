import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodSchema } from "zod";

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function meta(req: Request): { ip: string | null; userAgent: string | null } {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
  const ua = req.headers["user-agent"];
  return { ip, userAgent: Array.isArray(ua) ? ua[0] : (ua ?? null) };
}

export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, "Validation failed", result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return result.data;
}

export function zodMessage(err: unknown): string | null {
  return err instanceof ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : null;
}

type Bucket = { count: number; resetAt: number };

export function createRateLimiter(opts: { windowMs: number; max: number; bucket: string; key?: (req: Request) => string }): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return (req, _res, next) => {
    const identity = opts.key ? opts.key(req) : `${meta(req).ip ?? "unknown"}`;
    const key = `${opts.bucket}:${identity}`;
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || existing.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }
    existing.count += 1;
    if (existing.count > opts.max) {
      next(new HttpError(429, "Too many requests — please wait and try again."));
      return;
    }
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    }
    next();
  };
}

/**
 * CSRF hardening for cookie-authenticated mutations: when an Origin header is
 * present it must match the request host. Requests without Origin (server-side
 * clients, tests) are handled by the session cookie's SameSite policy.
 */
export function sameOriginOnly(req: Request, _res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }
  try {
    const host = new URL(origin).host;
    const target = req.headers.host;
    if (host !== target) {
      next(new HttpError(403, "Cross-origin request blocked"));
      return;
    }
  } catch {
    next(new HttpError(400, "Malformed Origin header"));
    return;
  }
  next();
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = err instanceof HttpError ? err.status : zodMessage(err) ? 400 : 500;
  const message = err instanceof HttpError ? err.message : zodMessage(err) ?? (err as Error)?.message ?? "Internal server error";
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : message,
    details: err instanceof HttpError ? err.details : undefined,
  });
}
