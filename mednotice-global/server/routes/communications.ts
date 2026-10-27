import { Router } from "express";
import { nowIso } from "../db.js";
import { asyncHandler } from "../http.js";
import { requireAuth, requirePermission, requireRole, STAFF_ROLES } from "../auth.js";
import { scopeCountry } from "../access.js";
import { COMMUNICATION_KINDS, communicationStatuses, listCommunications } from "../communications.js";

/**
 * Communication audit log.
 *
 * A single chronological view of every message the platform exchanged with a
 * health authority, a duty officer or an inbound webhook, with the matching
 * hash-chained audit entry for each one.
 */
export const communicationsRouter = Router();

communicationsRouter.use(requireAuth, requireRole(...STAFF_ROLES));

const intParam = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

communicationsRouter.get(
  "/",
  requirePermission("delivery.view"),
  asyncHandler((req, res) => {
    const scope = scopeCountry(req);
    const limit = intParam(req.query.limit, 50, 200);
    const offset = intParam(req.query.offset, 0, 100_000);

    const result = listCommunications(
      {
        kind: str(req.query.kind)?.toUpperCase(),
        status: str(req.query.status)?.toUpperCase(),
        caseId: str(req.query.caseId)?.toUpperCase(),
        q: str(req.query.q),
        from: str(req.query.from),
        to: str(req.query.to),
        country: scope,
      },
      limit,
      offset,
    );

    res.json({
      ...result,
      limit,
      offset,
      kinds: COMMUNICATION_KINDS,
      statuses: communicationStatuses(),
      scope: scope ?? "GLOBAL",
      generatedAt: nowIso(),
    });
  }),
);
