import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPdf, buildPng } from "./fixtures.js";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-verify-"));

const { run } = await import("../server/db.js");
const { verifyDocument } = await import("../server/verification/index.js");
const { extractFields } = await import("../server/verification/extract.js");

run("INSERT INTO physician_licenses (license_no, full_name, jurisdiction, status, expires_at, facility_id) VALUES (?, ?, 'US', 'ACTIVE', '2028-05-01', 'FAC-US-001')", "NY-48291", "Alan Reyes");
run("INSERT INTO physician_licenses (license_no, full_name, jurisdiction, status, expires_at, facility_id) VALUES (?, ?, 'US', 'REVOKED', '2026-01-15', 'FAC-US-001')", "NY-11902", "Miriam Cole");
run(
  "INSERT INTO facilities (id, name, authority_id, country, city, letterhead_keywords, status) VALUES (?, ?, ?, ?, ?, ?, 'VERIFIED')",
  "FAC-US-001",
  "St. Mary's General Hospital",
  "US-CMS",
  "US",
  "New York",
  JSON.stringify(["St. Mary's General Hospital", "500 West 42nd Street", "Joint Commission"]),
);
run("INSERT INTO physician_licenses (license_no, full_name, jurisdiction, status, expires_at, facility_id) VALUES (?, ?, 'US', 'ACTIVE', '2025-02-28', 'FAC-US-001')", "NY-33017", "Peter Lang");

const ctx = { facilityName: "St. Mary's General Hospital", facilityId: "FAC-US-001", country: "US", authorityId: "US-CMS", duplicateCount: 0 };

test("clean EHR-style PDF verifies with extracted fields", () => {
  const result = verifyDocument({ buffer: buildPdf(), filename: "discharge.pdf", mime: "application/pdf", ctx });
  assert.equal(result.meta.kind, "PDF");
  assert.equal(result.status, "VERIFIED");
  assert.ok(result.score >= 75);
  assert.equal(result.extracted.physicianLicense, "NY-48291");
  assert.equal(result.extracted.diagnosisCode, "I21.4");
  assert.equal(result.extracted.patientName, "John Doe");
  assert.equal(result.extracted.facilityName, "St. Mary's General Hospital");
  assert.ok(result.extracted.datesOfService.includes("2026-10-01"));
  assert.ok(result.findings.some((f) => f.code === "LICENSE_ACTIVE"));
  assert.ok(result.findings.some((f) => f.code === "LETTERHEAD_MATCH"));
});

test("word-processor metadata plus revisions yields manual review", () => {
  const result = verifyDocument({
    buffer: buildPdf({ producer: "Microsoft Word 2019", creator: "Microsoft Word", revisions: 1 }),
    filename: "record.pdf",
    mime: "application/pdf",
    ctx,
  });
  assert.equal(result.status, "PENDING_MANUAL_REVIEW");
  assert.ok(result.findings.some((f) => f.code === "PDF_PRODUCER_MISMATCH"));
  assert.ok(result.findings.some((f) => f.code === "PDF_INCREMENTAL_UPDATES"));
});

test("image-editor provenance on a PDF is rejected", () => {
  const result = verifyDocument({
    buffer: buildPdf({ producer: "Adobe Photoshop 25.0", creator: "Adobe Photoshop", revisions: 2 }),
    filename: "letterhead.pdf",
    mime: "application/pdf",
    ctx,
  });
  assert.equal(result.status, "REJECTED");
  assert.ok(result.score < 40);
});

test("revoked licence hard-fails verification regardless of other signals", () => {
  const buffer = buildPdf({ text: "Patient Name: John Doe\nPhysician: Miriam Cole\nLicense: NY-11902\nFacility: St. Mary's General Hospital\nDiagnosis: I21.4" });
  const result = verifyDocument({ buffer, filename: "receita.pdf", mime: "application/pdf", ctx });
  assert.equal(result.status, "REJECTED");
  assert.ok(result.findings.some((f) => f.code === "LICENSE_REVOKED" && f.severity === "critical"));
  assert.ok(result.score <= 20);
});

test("expired licence downgrades to manual review", () => {
  const buffer = buildPdf({ text: "Patient Name: John Doe\nPhysician: Peter Lang\nLicense: NY-33017\nFacility: St. Mary's General Hospital" });
  const result = verifyDocument({ buffer, filename: "note.pdf", mime: "application/pdf", ctx });
  assert.equal(result.status, "PENDING_MANUAL_REVIEW");
  assert.ok(result.findings.some((f) => f.code === "LICENSE_EXPIRED"));
});

test("facility mismatch is flagged", () => {
  const buffer = buildPdf({ text: "Patient Name: John Doe\nPhysician: Alan Reyes\nLicense: NY-48291\nFacility: Cedars-Sinai Medical Center" });
  const result = verifyDocument({ buffer, filename: "record.pdf", mime: "application/pdf", ctx });
  assert.ok(result.findings.some((f) => f.code === "FACILITY_MISMATCH"));
  assert.ok(result.findings.some((f) => f.code === "LETTERHEAD_MISMATCH"));
});

test("renamed image is detected via magic bytes", () => {
  const result = verifyDocument({ buffer: buildPng(), filename: "scan.pdf", mime: "application/pdf", ctx });
  assert.equal(result.meta.kind, "PNG");
  assert.ok(result.findings.some((f) => f.code === "MAGIC_MISMATCH"));
  assert.equal(result.status, "PENDING_MANUAL_REVIEW");
});

test("duplicate digest across cases is penalised", () => {
  const result = verifyDocument({ buffer: buildPdf(), filename: "copy.pdf", mime: "application/pdf", ctx: { ...ctx, duplicateCount: 2 } });
  assert.ok(result.findings.some((f) => f.code === "DUPLICATE_DOCUMENT"));
  assert.ok(result.score < 75);
});

test("unsupported binary payload is rejected", () => {
  const result = verifyDocument({ buffer: Buffer.from("not a medical document at all"), filename: "payload.bin", mime: "application/octet-stream", ctx });
  assert.equal(result.status, "REJECTED");
  assert.ok(result.findings.some((f) => f.code === "UNSUPPORTED_FORMAT"));
});

test("field extraction normalises dates per locale", () => {
  const us = extractFields("Patient: Jane Roe\nDate of Service: 03/04/2026\nDiagnosis: E11.9", "US");
  const de = extractFields("Patient: Jane Roe\nDate of Service: 03/04/2026\nDiagnosis: E11.9", "DE");
  assert.deepEqual(us.datesOfService, ["2026-03-04"]);
  assert.deepEqual(de.datesOfService, ["2026-04-03"]);
  assert.equal(us.diagnosisCode, "E11.9");
});
