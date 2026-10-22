import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { all, get, nowIso, run } from "../db.js";
import { decryptBuffer, randomCode } from "../crypto.js";
import { audit } from "../audit.js";
import { assertCaseAccess } from "../access.js";
import { asyncHandler, HttpError, meta, parseBody } from "../http.js";
import { requireAuth, requirePermission, requireRole, REVIEWER_ROLES } from "../auth.js";
import { caseToDto, type CaseRow, type DocumentRow, type Role } from "../models.js";
import { bundleStatus } from "../verification/index.js";
import { transmitCase } from "../routing.js";

export const documentsRouter = Router();

documentsRouter.get(
  "/:id/file",
  requireAuth,
  asyncHandler((req, res) => {
    const doc = get<DocumentRow>("SELECT * FROM documents WHERE id = ?", req.params.id);
    if (!doc) throw new HttpError(404, "Document not found");
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", doc.case_id);
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow);
    if (!doc.storage_path || !fs.existsSync(doc.storage_path)) {
      throw new HttpError(410, "The original file is not retained for this demo record.");
    }
    const plain = decryptBuffer(fs.readFileSync(doc.storage_path));
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "DOCUMENT_ACCESSED",
      entityType: "document",
      entityId: doc.id,
      ...meta(req),
      details: { caseId: doc.case_id, filename: doc.filename, sha256: doc.sha256, bytes: plain.length },
    });
    res.setHeader("Content-Type", doc.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.filename.replace(/["\\]/g, "_")}"`);
    res.setHeader("Content-Length", String(plain.length));
    res.send(plain);
  }),
);

const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().min(8, "Provide a review rationale of at least 8 characters").max(2000),
  routeIfVerified: z.boolean().optional().default(true),
});

documentsRouter.post(
  "/:id/review",
  requireAuth,
  requireRole(...REVIEWER_ROLES),
  requirePermission("cases.review"),
  asyncHandler(async (req, res) => {
    const body = parseBody(reviewSchema, req.body);
    const doc = get<DocumentRow>("SELECT * FROM documents WHERE id = ?", req.params.id);
    if (!doc) throw new HttpError(404, "Document not found");
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", doc.case_id);
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow, "write");
    if (doc.verification_status === "VERIFIED" && body.decision === "APPROVE") {
      throw new HttpError(409, "Document is already verified");
    }

    const previous = { documentStatus: doc.verification_status, caseVerification: caseRow.verification_status, caseStatus: caseRow.status };
    const newStatus = body.decision === "APPROVE" ? "VERIFIED" : "REJECTED";
    run(
      "UPDATE documents SET verification_status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?",
      newStatus,
      req.user!.id,
      nowIso(),
      body.note,
      doc.id,
    );

    const docs = all<DocumentRow>("SELECT * FROM documents WHERE case_id = ?", caseRow.id);
    const bundle = bundleStatus(docs.map((d) => ({ verification_status: d.verification_status })));
    let nextVerification = bundle.status;
    let nextStatus = caseRow.status;
    if (bundle.status === "REJECTED") {
      nextStatus = "REJECTED";
    } else if (bundle.status === "VERIFIED") {
      if (caseRow.status === "PENDING_REVIEW" || caseRow.status === "SUBMITTED" || caseRow.status === "ROUTE_FAILED") nextStatus = "SUBMITTED";
    } else {
      nextStatus = "PENDING_REVIEW";
    }
    run("UPDATE cases SET verification_status = ?, status = ?, updated_at = ? WHERE id = ?", nextVerification, nextStatus, nowIso(), caseRow.id);

    run(
      `INSERT INTO case_reviews (id, case_id, reviewer_id, action, previous_json, new_json, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      `REV-${randomCode(9)}`,
      caseRow.id,
      req.user!.id,
      body.decision === "APPROVE" ? "DOCUMENT_APPROVED" : "DOCUMENT_REJECTED",
      JSON.stringify({ ...previous, documentId: doc.id }),
      JSON.stringify({ documentStatus: newStatus, caseVerification: nextVerification, caseStatus: nextStatus }),
      body.note,
      nowIso(),
    );

    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: body.decision === "APPROVE" ? "DOCUMENT_APPROVED" : "DOCUMENT_REJECTED",
      entityType: "document",
      entityId: doc.id,
      ...meta(req),
      details: { caseId: caseRow.id, note: body.note, bundle: nextVerification },
    });

    let transmission = null;
    if (body.routeIfVerified && nextVerification === "VERIFIED" && nextStatus === "SUBMITTED") {
      try {
        transmission = await transmitCase(caseRow.id, { actor: { id: req.user!.id, role: req.user!.role }, ...meta(req) });
      } catch (err) {
        audit({
          actor: { id: null, role: "SYSTEM" },
          action: "AUTO_ROUTE_FAILED",
          entityType: "case",
          entityId: caseRow.id,
          details: { error: (err as Error).message },
        });
      }
    }

    const fresh = get<CaseRow>("SELECT * FROM cases WHERE id = ?", caseRow.id)!;
    const freshDocs = all<DocumentRow>("SELECT * FROM documents WHERE case_id = ? ORDER BY uploaded_at", caseRow.id);
    res.json({
      case: caseToDto(fresh, { role: req.user!.baseRole as Role, id: req.user!.id }, freshDocs),
      bundleReason: bundle.reason,
      transmission,
    });
  }),
);

documentsRouter.get(
  "/case/:caseId",
  requireAuth,
  asyncHandler((req, res) => {
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", req.params.caseId.toUpperCase());
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow);
    const docs = all<DocumentRow>("SELECT * FROM documents WHERE case_id = ? ORDER BY uploaded_at", caseRow.id);
    res.json({ documents: docs.map((d) => ({ ...d, storage_path: undefined, findings: JSON.parse(d.findings_json), extracted: JSON.parse(d.extracted_json) })) });
  }),
);
