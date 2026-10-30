import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { all, get, nowIso, run } from "../db.js";
import { STORAGE_DIR } from "../config.js";
import { encryptBuffer, encryptField, maskEmail, maskName, randomCode, sha256Hex } from "../crypto.js";
import { audit } from "../audit.js";
import { assertCaseAccess } from "../access.js";
import { asyncHandler, createRateLimiter, HttpError, meta, parseBody } from "../http.js";
import { requireAuth } from "../auth.js";
import { canSeePii, caseToDto, type CaseRow, type DocumentRow, type UserRow } from "../models.js";
import { AADHAAR_REQUIRED, findJurisdiction } from "../config.js";
import { checkAadhaar } from "../aadhaar.js";
import { findAuthority, getAuthority, getFacility } from "../registry.js";
import { triage } from "../triage.js";
import { verifyDocument, bundleStatus } from "../verification/index.js";
import { transmitCase } from "../routing.js";
import { listStatusSyncs } from "../authority-status.js";
import { queueWhatsAppNotice } from "../notifications.js";

export const casesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 8, fields: 40 },
});

const boolish = z
  .union([z.boolean(), z.enum(["true", "false", "on", "off", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "on" || v === "1");

const submitSchema = z.object({
  country: z.string().trim().length(2).transform((c) => c.toUpperCase()),
  authorityId: z.string().trim().min(2).max(60),
  facilityId: z.string().trim().min(2).max(60),
  category: z.string().trim().min(2).max(60),
  complaint: z.string().trim().min(40, "Please describe the grievance in at least 40 characters").max(20_000),
  symptoms: z.string().trim().max(5_000).optional().default(""),
  timeline: z.string().max(20_000).optional().default("[]"),
  incidentDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").or(z.literal("")).optional().default(""),
  patientName: z.string().trim().min(2).max(120).optional(),
  patientEmail: z.string().trim().toLowerCase().email().max(200).optional(),
  patientPhone: z.string().trim().max(40).optional().default(""),
  consentDataSharing: boolish,
  crossBorderAllowed: boolish.optional().default(false),
  language: z.string().trim().min(2).max(8).optional().default("en"),
  /**
   * Aadhaar number supplied at Submit by an anonymous guest. Signed-in patients
   * use the identity verified on their account instead, so this is ignored for
   * them and never stored either way.
   */
  aadhaar: z.string().trim().max(20).optional().default(""),
});

const timelineSchema = z
  .array(z.object({ date: z.string().max(40), event: z.string().max(400) }))
  .max(40);

function newCaseId(): string {
  const year = new Date().getUTCFullYear();
  for (let i = 0; i < 10; i += 1) {
    const id = `CASE-${year}-${randomCode(6)}`;
    if (!get("SELECT id FROM cases WHERE id = ?", id)) return id;
  }
  throw new HttpError(500, "Unable to allocate a case reference");
}

casesRouter.post(
  "/",
  createRateLimiter({ bucket: "submit", windowMs: 10 * 60_000, max: 12 }),
  upload.array("documents", 8),
  asyncHandler(async (req, res) => {
    const body = parseBody(submitSchema, req.body);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    const jurisdiction = findJurisdiction(body.country);
    if (!jurisdiction) throw new HttpError(400, "Unsupported jurisdiction");
    const authorityRecord = getAuthority(body.authorityId);
    if (!authorityRecord || authorityRecord.country !== body.country) {
      throw new HttpError(400, "Selected health authority does not belong to the selected country");
    }
    if (authorityRecord.status !== "ACTIVE") {
      throw new HttpError(400, "The selected health authority is not currently accepting grievances");
    }
    const authorityMatch = findAuthority(body.authorityId);
    if (!authorityMatch) throw new HttpError(400, "Selected health authority is not configured");
    if (!jurisdiction.complaintCategories.includes(body.category)) {
      throw new HttpError(400, "Category is not valid for this jurisdiction");
    }
    const facility = getFacility(body.facilityId);
    if (!facility || facility.authorityId !== body.authorityId) {
      throw new HttpError(400, "Selected facility is not registered with that health authority");
    }
    if (facility.status !== "VERIFIED") {
      throw new HttpError(400, "Selected facility is not open for new grievances");
    }
    if (!body.consentDataSharing) {
      throw new HttpError(400, "Data-processing consent is required to submit a grievance");
    }

    const patientUser = req.user?.role === "PATIENT" ? get<UserRow>("SELECT * FROM users WHERE id = ?", req.user.id) : null;
    const patientName = patientUser?.name ?? body.patientName;
    const patientEmail = patientUser?.email ?? body.patientEmail;
    if (!patientName || !patientEmail) throw new HttpError(400, "Patient name and email are required");
    // Identity gate: a grievance carries clinical and personal data, so the
    // complainant must be a verified natural person. Signed-in patients prove
    // ownership with a code on their registered mobile; guests have no account
    // to prove against, so the number is validated structurally here and then
    // discarded — nothing about it is persisted with the case.
    if (AADHAAR_REQUIRED) {
      if (patientUser && !patientUser.aadhaar_verified_at) {
        throw new HttpError(
          403,
          "Verify your Aadhaar number before filing a grievance. Send the verification code from your patient portal, then submit again.",
          { code: "AADHAAR_REQUIRED" },
        );
      }
      if (!patientUser) {
        const guestAadhaar = body.aadhaar ?? "";
        const check = checkAadhaar(guestAadhaar);
        if (!check.ok) {
          throw new HttpError(
            400,
            guestAadhaar ? `Not a valid Aadhaar number. ${check.reason}` : "Enter your 12-digit Aadhaar number to file a grievance.",
            { code: "AADHAAR_REQUIRED" },
          );
        }
      }
    }

    const timeline = body.timeline ? timelineSchema.parse(JSON.parse(body.timeline)) : [];
    if (timeline.length === 0) {
      timeline.push({ date: new Date().toISOString().slice(0, 10), event: "Complaint submitted via patient portal" });
    }

    const t = triage({
      complaint: body.complaint,
      symptoms: body.symptoms,
      category: body.category,
      incidentDate: body.incidentDate || null,
      country: body.country,
    });

    const caseId = newCaseId();
    const createdAt = nowIso();
    const accessCode = patientUser ? null : randomCode(10);
    const assigned = get<{ id: string }>(
      "SELECT id FROM users WHERE role = 'HOSPITAL_COMPLIANCE' AND country = ? AND active = 1 LIMIT 1",
      body.country,
    );

    const verifiedDocs: Array<{
      id: string;
      filename: string;
      mime: string;
      size: number;
      sha: string;
      kind: string;
      pageCount: number | null;
      hasTextLayer: boolean;
      status: string;
      score: number;
      findingsJson: string;
      extractedJson: string;
      storagePath: string;
      original: Buffer;
    }> = [];

    for (const file of files) {
      const safeName = path.basename(file.originalname).replace(/[^\w.\- ()]/g, "_").slice(0, 180) || "document";
      const sha = sha256Hex(file.buffer);
      const duplicateCount = Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM documents WHERE sha256 = ?", sha)?.n ?? 0);
      const result = verifyDocument({
        buffer: file.buffer,
        filename: safeName,
        mime: file.mimetype,
        ctx: {
          facilityName: facility.name,
          facilityId: facility.id,
          country: body.country,
          authorityId: body.authorityId,
          duplicateCount,
        },
      });
      const docId = `DOC-${randomCode(10)}`;
      const dir = path.join(STORAGE_DIR, caseId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const storagePath = path.join(dir, `${docId}.enc`);
      fs.writeFileSync(storagePath, encryptBuffer(file.buffer), { mode: 0o600 });
      verifiedDocs.push({
        id: docId,
        filename: safeName,
        mime: file.mimetype || "application/octet-stream",
        size: file.size,
        sha,
        kind: result.meta.kind,
        pageCount: result.meta.pageCount,
        hasTextLayer: result.meta.hasTextLayer,
        status: result.status,
        score: result.score,
        findingsJson: JSON.stringify(result.findings),
        extractedJson: JSON.stringify(result.extracted),
        storagePath,
        original: file.buffer,
      });
    }

    const bundle = bundleStatus(verifiedDocs.map((d) => ({ verification_status: d.status })));
    const status = bundle.status === "REJECTED" ? "REJECTED" : bundle.status === "PENDING_MANUAL_REVIEW" ? "PENDING_REVIEW" : "SUBMITTED";

    run(
      `INSERT INTO cases (id, access_code_hash, patient_user_id, patient_name_enc, patient_email_enc, patient_phone_enc,
        patient_name_masked, patient_email_masked, country, region, authority_id, facility_id, facility_name,
        category, category_confidence, priority, priority_score, triage_json, complaint_enc, symptoms_enc, timeline_json,
        incident_date, status, verification_status, assigned_to, consent_data_sharing, cross_border_allowed, language,
        source, created_at, updated_at, sla_due_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PORTAL', ?, ?, ?, NULL)`,
      caseId,
      accessCode ? sha256Hex(accessCode) : null,
      patientUser?.id ?? null,
      encryptField(patientName),
      encryptField(patientEmail),
      encryptField(body.patientPhone || null),
      maskName(patientName),
      maskEmail(patientEmail),
      body.country,
      authorityMatch.authority.region,
      body.authorityId,
      facility.id,
      facility.name,
      t.category,
      t.categoryConfidence,
      t.priority,
      t.score,
      JSON.stringify(t),
      encryptField(body.complaint),
      encryptField(body.symptoms || null),
      JSON.stringify(timeline),
      body.incidentDate || null,
      status,
      bundle.status,
      assigned?.id ?? null,
      body.consentDataSharing ? 1 : 0,
      body.crossBorderAllowed ? 1 : 0,
      body.language,
      createdAt,
      createdAt,
      t.dueAt,
    );

    for (const doc of verifiedDocs) {
      run(
        `INSERT INTO documents (id, case_id, filename, mime, size, sha256, storage_path, kind, page_count, has_text_layer,
          verification_status, score, findings_json, extracted_json, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        doc.id,
        caseId,
        doc.filename,
        doc.mime,
        doc.size,
        doc.sha,
        doc.storagePath,
        doc.kind,
        doc.pageCount,
        doc.hasTextLayer ? 1 : 0,
        doc.status,
        doc.score,
        doc.findingsJson,
        doc.extractedJson,
        createdAt,
      );
    }

    audit({
      actor: patientUser ? { id: patientUser.id, role: "PATIENT" } : { id: null, role: "PUBLIC" },
      action: "CASE_CREATED",
      entityType: "case",
      entityId: caseId,
      ...meta(req),
      details: {
        country: body.country,
        authority: body.authorityId,
        facility: facility.name,
        priority: t.priority,
        score: t.score,
        category: t.category,
        verification: bundle.status,
        documentCount: verifiedDocs.length,
        accessCodeIssued: Boolean(accessCode),
      },
    });

    for (const doc of verifiedDocs) {
      audit({
        actor: { id: null, role: "SYSTEM" },
        action: "DOCUMENT_VERIFIED",
        entityType: "document",
        entityId: doc.id,
        ...meta(req),
        details: { caseId, filename: doc.filename, status: doc.status, score: doc.score, kind: doc.kind },
      });
    }

    if (bundle.status === "PENDING_MANUAL_REVIEW") {
      audit({
        actor: { id: null, role: "SYSTEM" },
        action: "MANUAL_REVIEW_REQUIRED",
        entityType: "case",
        entityId: caseId,
        details: { reason: bundle.reason },
      });
    }
    if (bundle.status === "REJECTED") {
      audit({
        actor: { id: null, role: "SYSTEM" },
        action: "BUNDLE_REJECTED",
        entityType: "case",
        entityId: caseId,
        details: { reason: bundle.reason },
      });
    }

    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", caseId)!;
    const docRows = all<DocumentRow>("SELECT * FROM documents WHERE case_id = ? ORDER BY uploaded_at", caseId);

    let transmission = null;
    if (status === "SUBMITTED") {
      try {
        transmission = await transmitCase(caseId, { actor: patientUser ? { id: patientUser.id, role: "PATIENT" } : { id: null, role: "SYSTEM" }, ...meta(req) });
      } catch (err) {
        audit({
          actor: { id: null, role: "SYSTEM" },
          action: "AUTO_ROUTE_FAILED",
          entityType: "case",
          entityId: caseId,
          details: { error: (err as Error).message },
        });
      }
    }

    const fresh = get<CaseRow>("SELECT * FROM cases WHERE id = ?", caseId)!;
    // The patient's WhatsApp receipt does not depend on authority routing: it is
    // queued even when the transmission fails, and the queue retries on its own.
    queueWhatsAppNotice(fresh, "CASE_SUBMITTED");
    const actor = patientUser ? { role: "PATIENT" as const, id: patientUser.id } : { role: "PATIENT" as const, id: "guest" };
    res.status(201).json({
      case: caseToDto(fresh, { ...actor, isOwner: true }, docRows),
      accessCode,
      transmission,
      bundleReason: bundle.reason,
      verification: {
        status: bundle.status,
        documents: verifiedDocs.map((d) => ({ filename: d.filename, status: d.status, score: d.score })),
      },
    });
  }),
);

casesRouter.get(
  "/mine",
  requireAuth,
  asyncHandler((req, res) => {
    if (req.user!.baseRole !== "PATIENT") throw new HttpError(403, "Patient endpoint");
    const rows = all<CaseRow>("SELECT * FROM cases WHERE patient_user_id = ? ORDER BY created_at DESC", req.user!.id);
    const docs = all<DocumentRow>("SELECT * FROM documents WHERE case_id IN (SELECT id FROM cases WHERE patient_user_id = ?)", req.user!.id);
    res.json({
      cases: rows.map((row) =>
        caseToDto(
          row,
          { role: "PATIENT", id: req.user!.id, isOwner: true },
          docs.filter((d) => d.case_id === row.id),
        ),
      ),
    });
  }),
);

casesRouter.get(
  "/:id",
  requireAuth,
  asyncHandler((req, res) => {
    const row = get<CaseRow>("SELECT * FROM cases WHERE id = ?", req.params.id.toUpperCase());
    if (!row) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, row);
    const documents = all<DocumentRow>("SELECT * FROM documents WHERE case_id = ? ORDER BY uploaded_at", row.id);
    const dto = caseToDto(row, { role: req.user!.baseRole, id: req.user!.id, isOwner: row.patient_user_id === req.user!.id }, documents);
    const reviews = all("SELECT * FROM case_reviews WHERE case_id = ? ORDER BY created_at", row.id);
    const transmissions = all("SELECT * FROM transmissions WHERE case_id = ? ORDER BY created_at DESC", row.id);
    const notifications = all("SELECT id, channel, target, subject, status, attempts, last_error, created_at, sent_at FROM notifications WHERE case_id = ? ORDER BY created_at", row.id);
    const activity = all<{ ts: string; actor_id: string; actor_role: string; action: string; details_json: string }>(
      "SELECT ts, actor_id, actor_role, action, details_json FROM audit_log WHERE entity_type = 'case' AND entity_id = ? ORDER BY ts DESC LIMIT 200",
      row.id,
    );
    res.json({
      case: dto,
      reviews,
      transmissions,
      notifications,
      authorityStatus: {
        status: row.authority_status ?? null,
        checkedAt: row.authority_status_at ?? null,
        reference: row.authority_reference ?? null,
        history: listStatusSyncs(row.id, 20),
      },
      activity: activity.map((a) => ({ ...a, details: JSON.parse(a.details_json) })),
      piiVisible: canSeePii({ role: req.user!.baseRole, id: req.user!.id, isOwner: row.patient_user_id === req.user!.id }),
    });
  }),
);
