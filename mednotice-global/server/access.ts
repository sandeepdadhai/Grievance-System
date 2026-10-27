import type { Request } from "express";
import { HttpError } from "./http.js";
import type { CaseRow } from "./models.js";

export function assertCaseAccess(req: Request, row: CaseRow, mode: "read" | "write" = "read"): void {
  const user = req.user;
  if (!user) throw new HttpError(401, "Authentication required");
  if (user.baseRole === "SUPER_ADMIN") return;
  if (user.baseRole === "PATIENT") {
    if (row.patient_user_id !== user.id) throw new HttpError(403, "This case belongs to another patient");
    if (mode === "write") throw new HttpError(403, "Patients cannot modify case records directly");
    return;
  }
  if (user.baseRole === "SYSTEM_AUDITOR") {
    if (mode === "write") throw new HttpError(403, "Auditor accounts are read-only");
    return;
  }
  if (user.facilityId && row.facility_id !== user.facilityId) {
    throw new HttpError(403, "This case was filed against another facility");
  }
  if (!user.country || user.country !== row.country) {
    throw new HttpError(403, "Case is outside your assigned scope");
  }
}

/**
 * Facility scope for list, count and metrics queries. Accounts bound to a
 * facility only ever see the cases filed against that facility; staff without
 * a facility binding keep their country-wide scope.
 */
export function scopeFacility(req: Request): string | null {
  return req.user?.facilityId ?? null;
}

/** Country scope applied to list/metrics queries for state- and hospital-scoped roles. */
export function scopeCountry(req: Request): string | null {
  const user = req.user;
  if (!user) return null;
  if (user.baseRole === "SUPER_ADMIN" || user.baseRole === "SYSTEM_AUDITOR") return null;
  return user.country;
}
