import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CasePayload } from "../server/adapters/types.js";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-adapters-"));

const { fhirAdapter } = await import("../server/adapters/fhir.js");
const { hl7Adapter } = await import("../server/adapters/hl7v2.js");
const { restAdapter, renderTemplate } = await import("../server/adapters/rest.js");
const { soapAdapter } = await import("../server/adapters/soap.js");
const { maskPayload } = await import("../server/crypto.js");

const payload: CasePayload = {
  caseId: "CASE-2026-ABC123",
  createdAt: "2026-10-21T10:00:00.000Z",
  priority: "P1",
  priorityScore: 92,
  category: "Negligence",
  categoryConfidence: 0.88,
  complaint: "Patient | deteriorated <after> delay & pain.\nSecond line.",
  symptoms: "Chest pain",
  country: "IN",
  region: "Delhi",
  authorityId: "IN-MOHFW",
  facilityName: "All India Institute of Medical Sciences",
  incidentDate: "2026-10-20",
  verificationStatus: "VERIFIED",
  patient: { name: "M**** S*****", email: "m*****@e***.in", phone: "***4567" },
  documents: [{ filename: "record.pdf", sha256: "a".repeat(64), status: "VERIFIED", score: 92, kind: "PDF", extractedSummary: "ICD I21.4" }],
  triageSummary: ["Patient death reported (+22)"],
  masked: true,
  language: "en",
};

const baseConfig = { code: "IN-FHIR", kind: "FHIR" as const, endpoint: "https://example.test/fhir", authType: "NONE", mapping: {}, simulate: true };

test("FHIR bundle maps priority and includes patient, task and document entries", () => {
  const built = fhirAdapter.build(payload, baseConfig);
  assert.equal(built.contentType, "application/fhir+json");
  const bundle = JSON.parse(String(built.payload));
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.type, "transaction");
  assert.equal(bundle.entry.length, 3);
  const task = bundle.entry.find((e: { resource: { resourceType: string } }) => e.resource.resourceType === "Task");
  assert.equal(task.resource.priority, "stat");
  assert.equal(task.resource.for.reference, bundle.entry[0].fullUrl);
  const ack = fhirAdapter.parseAck(201, JSON.stringify({ resourceType: "Bundle", id: "abc" }), false);
  assert.equal(ack.ok, true);
  assert.equal(ack.ackId, "abc");
});

test("FHIR acknowledgement treats 4xx as failure", () => {
  const ack = fhirAdapter.parseAck(422, JSON.stringify({ resourceType: "OperationOutcome" }), false);
  assert.equal(ack.ok, false);
  assert.equal(ack.httpStatus, 422);
});

test("HL7 v2 message escapes delimiters and maps priority to patient class", () => {
  const built = hl7Adapter.build(payload, { ...baseConfig, kind: "HL7v2", code: "IN-HL7-MH" });
  const message = String(built.payload);
  assert.ok(message.startsWith("MSH|^~\\&|MEDNOTICE|INDIA|IN-MOHFW"));
  assert.ok(message.includes("\\F\\"));
  assert.ok(message.includes("\\X0D\\"));
  assert.ok(message.includes("OBX|1|ST|PRIORITY"));
  assert.ok(message.includes("PV1|1|E"));
  const ack = hl7Adapter.parseAck(200, "MSH|^~\\&|A|B|C|D|20260101||ACK|1|P|2.5\rMSA|AA|CASE-1\r", false);
  assert.equal(ack.ok, true);
  assert.equal(hl7Adapter.parseAck(200, "MSA|AE|CASE-1", false).ok, false);
});

test("REST adapter renders nested mapping templates", () => {
  const mapping = {
    envelope: {
      ref: "{{caseId}}",
      severity: { code: "{{priority}}", score: "{{priorityScore}}" },
      facility: "{{facilityName}}",
      documents: "{{documentCount}}",
      masked: "{{masked}}",
    },
  };
  const built = restAdapter.build(payload, { ...baseConfig, kind: "REST", code: "IN-REST", mapping });
  const body = JSON.parse(String(built.payload));
  assert.equal(body.ref, "CASE-2026-ABC123");
  assert.equal(body.severity.code, "P1");
  assert.equal(body.severity.score, 92);
  assert.equal(body.documents, 1);
  assert.equal(body.masked, true);
  assert.equal(renderTemplate("Hello {{caseId}}", { caseId: "X" }), "Hello X");
});

test("SOAP adapter produces an escaped envelope with operation and fields", () => {
  const built = soapAdapter.build(payload, { ...baseConfig, kind: "SOAP", code: "IN-SOAP", mapping: { operation: "RegisterGrievance", namespace: "urn:india:grievance:v2" } });
  const xml = String(built.payload);
  assert.ok(built.contentType.startsWith("application/soap+xml"));
  assert.ok(xml.includes("<mn:RegisterGrievance>"));
  assert.ok(xml.includes("<mn:CaseReference>CASE-2026-ABC123</mn:CaseReference>"));
  assert.ok(xml.includes("&lt;after&gt;"));
  assert.ok(xml.includes("&amp;"));
  const ack = soapAdapter.parseAck(200, "<Envelope><Body><SubmitComplaintResponse><CaseReference>CASE-1</CaseReference></SubmitComplaintResponse></Body></Envelope>", false);
  assert.equal(ack.ok, true);
  assert.equal(ack.ackId, "CASE-1");
});

test("masked payload keeps identifiers out of the outbound text", () => {
  const fhir = fhirAdapter.build(payload, baseConfig);
  const masked = maskPayload(`${String(fhir.payload)} Meera Sharma meera.sharma@example.in`, ["Meera Sharma"]);
  assert.ok(!masked.includes("Meera Sharma"));
  assert.ok(!masked.includes("meera.sharma@example.in"));
  assert.ok(!masked.includes("Sharma"));
});
