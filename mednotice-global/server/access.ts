import type { Request } from "express";
import { HttpError } from "./http.js";
import type { CaseRow } from "./models.js";

export function assertCaseAccess(req: Request, row: CaseRow, mode: "read" | "write" = "read"): void {
  const user = req.user;
  if (!user) throw new HttpError(401, "Authentication required");
  if (user.role === "SUPER_ADMIN") return;
  if (user.role === "PATIENT") {
    if (row.patient_user_id !== user.id) throw new HttpError(403, "This case belongs to another patient");
    if (mode === "write") throw new HttpError(403, "Patients cannot modify case records directly");
    return;
  }
  if (user.role === "SYSTEM_AUDITOR") {
    if (mode === "write") throw new HttpError(403, "Auditor accounts are read-only");
    return;
  }
  if (!user.country || user.country !== row.country) {
    throw new HttpError(403, "Case is outside your jurisdiction");
  }
}

/** Country scope applied to list/metrics queries for non-global roles. */
export function scopeCountry(req: Request): string | null {
  const user = req.user;
  if (!user) return null;
  if (user.role === "SUPER_ADMIN" || user.role === "SYSTEM_AUDITOR") return null;
  return user.country;
}
