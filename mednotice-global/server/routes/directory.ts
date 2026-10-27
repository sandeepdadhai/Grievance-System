import { Router } from "express";
import { z } from "zod";
import { get, nowIso, run } from "../db.js";
import { audit } from "../audit.js";
import { asyncHandler, HttpError, meta, parseBody } from "../http.js";
import { requireAuth, requirePermission, requireRole, STAFF_ROLES } from "../auth.js";
import {
  caseCountForAuthority,
  caseCountForFacility,
  facilityCountForAuthority,
  getAuthority,
  getFacility,
  listAuthorities,
  listFacilities,
} from "../registry.js";

/**
 * Directory administration: the health authorities and facilities that patients
 * can select during intake. Reads are open to staff; changes need the
 * `registry.manage` capability, which a super administrator holds by default
 * and can be granted to a custom role.
 */
export const directoryRouter = Router();

directoryRouter.use(requireAuth, requireRole(...STAFF_ROLES));

const authorityIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/, "Use 3-40 letters, digits or dashes");

const authorityBody = z.object({
  id: authorityIdSchema,
  name: z.string().trim().min(3, "Authority name must be at least 3 characters").max(160),
  region: z.string().trim().min(2, "Region is required").max(80),
  adapter: z.string().trim().toUpperCase().min(2).max(40),
  contactEmail: z.string().trim().toLowerCase().email().max(200),
  webhook: z.string().trim().url().max(500),
  country: z.string().trim().length(2).toUpperCase().default("IN"),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});

const authorityPatch = z.object({
  name: z.string().trim().min(3).max(160).optional(),
  region: z.string().trim().min(2).max(80).optional(),
  adapter: z.string().trim().toUpperCase().min(2).max(40).optional(),
  contactEmail: z.string().trim().toLowerCase().email().max(200).optional(),
  webhook: z.string().trim().url().max(500).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const facilityBody = z.object({
  id: authorityIdSchema,
  name: z.string().trim().min(3, "Facility name must be at least 3 characters").max(160),
  authorityId: z.string().trim().toUpperCase().min(2).max(40),
  city: z.string().trim().max(120).optional().default(""),
  letterheadKeywords: z.array(z.string().trim().min(2).max(120)).max(20).optional().default([]),
  status: z.enum(["VERIFIED", "PENDING", "CLOSED"]).default("VERIFIED"),
});

const facilityPatch = z.object({
  name: z.string().trim().min(3).max(160).optional(),
  authorityId: z.string().trim().toUpperCase().min(2).max(40).optional(),
  city: z.string().trim().max(120).optional(),
  letterheadKeywords: z.array(z.string().trim().min(2).max(120)).max(20).optional(),
  status: z.enum(["VERIFIED", "PENDING", "CLOSED"]).optional(),
});

function requireAdapter(code: string): void {
  if (!get("SELECT code FROM adapters WHERE code = ?", code)) {
    throw new HttpError(400, `Adapter ${code} is not configured. Create it under Adapters first.`);
  }
}

function requireActiveAuthority(id: string): void {
  const authority = getAuthority(id);
  if (!authority) throw new HttpError(400, "Unknown health authority");
  if (authority.status !== "ACTIVE") throw new HttpError(400, "That health authority is inactive");
}

function authorityDto(id: string) {
  const authority = getAuthority(id)!;
  return {
    ...authority,
    facilityCount: facilityCountForAuthority(authority.id),
    caseCount: caseCountForAuthority(authority.id),
  };
}

/* ------------------------------- authorities ------------------------------ */

directoryRouter.get(
  "/authorities",
  asyncHandler((_req, res) => {
    const authorities = listAuthorities({ includeInactive: true }).map((a) => authorityDto(a.id));
    res.json({ authorities });
  }),
);

directoryRouter.post(
  "/authorities",
  requirePermission("registry.manage"),
  asyncHandler((req, res) => {
    const body = parseBody(authorityBody, req.body);
    if (getAuthority(body.id)) throw new HttpError(409, "That authority reference already exists");
    requireAdapter(body.adapter);
    const now = nowIso();
    run(
      `INSERT INTO authorities (id, name, country, region, adapter, contact_email, webhook, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      body.id,
      body.name,
      body.country,
      body.region,
      body.adapter,
      body.contactEmail,
      body.webhook,
      body.status,
      now,
      now,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "AUTHORITY_CREATED",
      entityType: "authority",
      entityId: body.id,
      ...meta(req),
      details: { name: body.name, region: body.region, adapter: body.adapter, status: body.status },
    });
    res.status(201).json({ authority: authorityDto(body.id) });
  }),
);

directoryRouter.patch(
  "/authorities/:id",
  requirePermission("registry.manage"),
  asyncHandler((req, res) => {
    const body = parseBody(authorityPatch, req.body);
    const authority = getAuthority(req.params.id);
    if (!authority) throw new HttpError(404, "Authority not found");
    if (body.adapter) requireAdapter(body.adapter);
    run(
      `UPDATE authorities SET name = ?, region = ?, adapter = ?, contact_email = ?, webhook = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      body.name ?? authority.name,
      body.region ?? authority.region,
      body.adapter ?? authority.adapter,
      body.contactEmail ?? authority.contactEmail,
      body.webhook ?? authority.webhook,
      body.status ?? authority.status,
      nowIso(),
      authority.id,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "AUTHORITY_UPDATED",
      entityType: "authority",
      entityId: authority.id,
      ...meta(req),
      details: {
        changes: body,
        previous: { name: authority.name, region: authority.region, adapter: authority.adapter, status: authority.status },
      },
    });
    res.json({ authority: authorityDto(authority.id) });
  }),
);

directoryRouter.delete(
  "/authorities/:id",
  requirePermission("registry.manage"),
  asyncHandler((req, res) => {
    const authority = getAuthority(req.params.id);
    if (!authority) throw new HttpError(404, "Authority not found");
    const facilities = facilityCountForAuthority(authority.id);
    if (facilities > 0) {
      throw new HttpError(409, `${facilities} facility/facilities are still registered under this authority. Move or remove them first.`);
    }
    const cases = caseCountForAuthority(authority.id);
    if (cases > 0) {
      throw new HttpError(409, `${cases} case(s) reference this authority. Mark it inactive instead of deleting it.`);
    }
    run("DELETE FROM authorities WHERE id = ?", authority.id);
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "AUTHORITY_DELETED",
      entityType: "authority",
      entityId: authority.id,
      ...meta(req),
      details: { name: authority.name, region: authority.region },
    });
    res.json({ ok: true });
  }),
);

/* -------------------------------- facilities ------------------------------ */

directoryRouter.get(
  "/facilities",
  asyncHandler((_req, res) => {
    res.json({ facilities: listFacilities({ includeInactive: true }) });
  }),
);

directoryRouter.post(
  "/facilities",
  requirePermission("registry.manage"),
  asyncHandler((req, res) => {
    const body = parseBody(facilityBody, req.body);
    if (getFacility(body.id)) throw new HttpError(409, "That facility reference already exists");
    const authority = getAuthority(body.authorityId);
    if (!authority) throw new HttpError(400, "Unknown health authority");
    run(
      `INSERT INTO facilities (id, name, authority_id, country, city, letterhead_keywords, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      body.id,
      body.name,
      body.authorityId,
      authority.country,
      body.city || null,
      JSON.stringify(body.letterheadKeywords),
      body.status,
      nowIso(),
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "FACILITY_CREATED",
      entityType: "facility",
      entityId: body.id,
      ...meta(req),
      details: { name: body.name, authority: body.authorityId, city: body.city || null, status: body.status },
    });
    res.status(201).json({ facility: getFacility(body.id) });
  }),
);

directoryRouter.patch(
  "/facilities/:id",
  requirePermission("registry.manage"),
  asyncHandler((req, res) => {
    const body = parseBody(facilityPatch, req.body);
    const facility = getFacility(req.params.id);
    if (!facility) throw new HttpError(404, "Facility not found");
    if (body.authorityId) requireActiveAuthority(body.authorityId);
    const authorityId = body.authorityId ?? facility.authorityId;
    const authority = getAuthority(authorityId)!;
    run(
      `UPDATE facilities SET name = ?, authority_id = ?, country = ?, city = ?, letterhead_keywords = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      body.name ?? facility.name,
      authorityId,
      authority.country,
      body.city === undefined ? facility.city : body.city || null,
      body.letterheadKeywords ? JSON.stringify(body.letterheadKeywords) : JSON.stringify(facility.letterheadKeywords),
      body.status ?? facility.status,
      nowIso(),
      facility.id,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "FACILITY_UPDATED",
      entityType: "facility",
      entityId: facility.id,
      ...meta(req),
      details: {
        changes: body,
        previous: { name: facility.name, authority: facility.authorityId, city: facility.city, status: facility.status },
      },
    });
    res.json({ facility: getFacility(facility.id) });
  }),
);

directoryRouter.delete(
  "/facilities/:id",
  requirePermission("registry.manage"),
  asyncHandler((req, res) => {
    const facility = getFacility(req.params.id);
    if (!facility) throw new HttpError(404, "Facility not found");
    const cases = caseCountForFacility(facility.id);
    if (cases > 0) {
      throw new HttpError(409, `${cases} case(s) reference this facility. Mark it closed instead of deleting it.`);
    }
    run("DELETE FROM facilities WHERE id = ?", facility.id);
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "FACILITY_DELETED",
      entityType: "facility",
      entityId: facility.id,
      ...meta(req),
      details: { name: facility.name, authority: facility.authorityId },
    });
    res.json({ ok: true });
  }),
);
