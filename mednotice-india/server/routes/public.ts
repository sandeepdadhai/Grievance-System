import { Router } from "express";
import { z } from "zod";
import { JURISDICTIONS } from "../config.js";
import { findAuthority, listAuthorities, listFacilities } from "../registry.js";
import { all, get } from "../db.js";
import { sha256Hex, timingSafeEqualStr } from "../crypto.js";
import { audit } from "../audit.js";
import { asyncHandler, createRateLimiter, HttpError, meta, parseBody } from "../http.js";
import type { CaseRow } from "../models.js";

export const publicRouter = Router();

publicRouter.get("/jurisdictions", (_req, res) => {
  res.json({
    jurisdictions: JURISDICTIONS.map((j) => ({
      code: j.code,
      name: j.name,
      flag: j.flag,
      regulator: j.regulator,
      frameworks: j.frameworks,
      locale: j.locale,
      languages: j.languages,
      retentionDays: j.retentionDays,
      slaHours: j.slaHours,
      crossBorderRestricted: j.crossBorderRestricted,
      complaintCategories: j.complaintCategories,
      authorities: listAuthorities({ country: j.code }).map((a) => ({ id: a.id, name: a.name, region: a.region, adapter: a.adapter, contactEmail: a.contactEmail })),
    })),
  });
});

publicRouter.get(
  "/facilities",
  asyncHandler((req, res) => {
    const authorityId = typeof req.query.authority === "string" ? req.query.authority : undefined;
    const facilities = listFacilities({
      authorityId,
      patientVisibleOnly: true,
    }).map((f) => ({
      id: f.id,
      name: f.name,
      authorityId: f.authorityId,
      country: f.country,
      city: f.city,
      status: f.status,
    }));
    res.json({ facilities });
  }),
);

const trackSchema = z.object({
  caseId: z.string().trim().min(4).max(40),
  accessCode: z.string().trim().min(4).max(64),
});

publicRouter.post(
  "/track",
  createRateLimiter({ bucket: "track", windowMs: 60_000, max: 20 }),
  asyncHandler((req, res) => {
    const body = parseBody(trackSchema, req.body);
    const row = get<CaseRow>("SELECT * FROM cases WHERE id = ?", body.caseId.toUpperCase());
    const presented = sha256Hex(body.accessCode.toUpperCase());
    if (!row || !row.access_code_hash || !timingSafeEqualStr(row.access_code_hash, presented)) {
      audit({
        actor: { id: null, role: "PUBLIC" },
        action: "CASE_TRACK_DENIED",
        entityType: "case",
        entityId: body.caseId,
        ...meta(req),
        details: { reason: "invalid reference or access code" },
      });
      throw new HttpError(404, "No case matches that reference and access code.");
    }
    const docs = all<{ verification_status: string; filename: string; score: number }>(
      "SELECT verification_status, filename, score FROM documents WHERE case_id = ?",
      row.id,
    );
    audit({
      actor: { id: null, role: "PUBLIC" },
      action: "CASE_TRACKED",
      entityType: "case",
      entityId: row.id,
      ...meta(req),
      details: { channel: "access-code" },
    });
    res.json({
      case: {
        id: row.id,
        status: row.status,
        priority: row.priority,
        priorityScore: row.priority_score,
        category: row.category,
        facilityName: row.facility_name,
        country: row.country,
        region: row.region,
        authorityId: row.authority_id,
        authorityName: findAuthority(row.authority_id)?.authority.name ?? null,
        verificationStatus: row.verification_status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        slaDueAt: row.sla_due_at,
        resolvedAt: row.resolved_at,
        patientName: row.patient_name_masked,
        timeline: JSON.parse(row.timeline_json || "[]"),
        triage: (() => {
          const t = JSON.parse(row.triage_json || "{}");
          return { regulatoryBasis: t.regulatoryBasis ?? [], signals: (t.signals ?? []).slice(0, 4).map((s: { label: string }) => s.label) };
        })(),
        documents: docs.map((d) => ({ filename: d.filename, status: d.verification_status, score: d.score })),
      },
    });
  }),
);
