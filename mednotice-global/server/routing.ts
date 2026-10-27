import { all, get, nowIso, run } from "./db.js";
import { audit } from "./audit.js";
import { findJurisdiction } from "./config.js";
import { findAuthority } from "./registry.js";
import { decryptField, maskEmail, maskName, maskPayload, maskText, randomCode } from "./crypto.js";
import { caseToDto, type CaseRow, type DocumentRow } from "./models.js";
import { implementationFor, resolveAdapter } from "./adapters/index.js";
import type { AdapterAck, CasePayload, TransmissionDocument } from "./adapters/types.js";
import { queueCaseNotifications } from "./notifications.js";
import type { TriageResult } from "./triage.js";

export type TransmissionResult = {
  transmissionId: string;
  adapterCode: string;
  status: "DELIVERED" | "FAILED";
  ackId: string | null;
  message: string;
  httpStatus: number | null;
  latencyMs: number;
  simulated: boolean;
  requestSummary: string;
  requestPreview: string;
};

export function buildTransmissionDocuments(documents: DocumentRow[], knownNames: string[]): TransmissionDocument[] {
  return documents.map((doc) => {
    const extracted = JSON.parse(doc.extracted_json || "{}") as Record<string, unknown>;
    const summaryParts = [
      extracted.diagnosisCode ? `ICD ${String(extracted.diagnosisCode)}` : null,
      extracted.facilityName ? String(extracted.facilityName) : null,
      Array.isArray(extracted.datesOfService) && extracted.datesOfService.length ? `DOS ${extracted.datesOfService.slice(0, 2).join(", ")}` : null,
    ].filter(Boolean);
    return {
      filename: doc.filename,
      sha256: doc.sha256,
      status: doc.verification_status,
      score: doc.score,
      kind: doc.kind,
      extractedSummary: maskText(summaryParts.join(" · ") || "no structured fields extracted", knownNames),
    };
  });
}

export function buildCasePayload(caseRow: CaseRow, documents: DocumentRow[], opts: { forceMask?: boolean } = {}): CasePayload {
  const jurisdiction = findJurisdiction(caseRow.country);
  const authority = findAuthority(caseRow.authority_id);
  const patientName = decryptField(caseRow.patient_name_enc) ?? caseRow.patient_name_masked;
  const patientEmail = decryptField(caseRow.patient_email_enc) ?? caseRow.patient_email_masked;
  const phone = decryptField(caseRow.patient_phone_enc);
  const complaint = decryptField(caseRow.complaint_enc) ?? "";
  const symptoms = decryptField(caseRow.symptoms_enc);
  const masked = opts.forceMask || Boolean(jurisdiction?.crossBorderRestricted);
  const knownNames = [patientName, ...documents.map((d) => (JSON.parse(d.extracted_json || "{}") as { patientName?: string }).patientName ?? "")].filter(Boolean);

  const triage = JSON.parse(caseRow.triage_json || "{}") as Partial<TriageResult>;
  const triageSummary = (triage.signals ?? []).slice(0, 4).map((s) => `${s.label} (+${s.weight})`);

  return {
    caseId: caseRow.id,
    createdAt: caseRow.created_at,
    priority: caseRow.priority,
    priorityScore: caseRow.priority_score,
    category: caseRow.category,
    categoryConfidence: caseRow.category_confidence,
    complaint: masked ? maskText(complaint, knownNames) : complaint,
    symptoms: masked ? (symptoms ? maskText(symptoms, knownNames) : null) : symptoms,
    country: caseRow.country,
    region: caseRow.region,
    authorityId: caseRow.authority_id,
    facilityName: caseRow.facility_name ?? authority?.authority.name ?? "Unknown facility",
    incidentDate: caseRow.incident_date,
    verificationStatus: caseRow.verification_status,
    patient: {
      name: masked ? maskName(patientName) : patientName,
      email: masked ? maskEmail(patientEmail) : patientEmail,
      phone: masked && phone ? `***${phone.slice(-4)}` : phone,
    },
    documents: buildTransmissionDocuments(documents, knownNames),
    triageSummary,
    masked,
    language: caseRow.language,
  };
}

async function deliver(
  endpoint: string,
  body: string,
  contentType: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(endpoint, { method: "POST", headers: { "content-type": contentType, ...headers }, body, signal: controller.signal });
    return { status: res.status, text: (await res.text()).slice(0, 20_000) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Route a case to its jurisdictional authority through the configured adapter.
 * Simulation mode produces a realistic acknowledgement without external I/O.
 */
export async function transmitCase(
  caseId: string,
  opts: { adapterCode?: string; actor?: { id: string | null; role: string | null }; ip?: string | null; userAgent?: string | null } = {},
): Promise<TransmissionResult> {
  const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", caseId);
  if (!caseRow) throw Object.assign(new Error("Case not found"), { status: 404 });
  const documents = all<DocumentRow>("SELECT * FROM documents WHERE case_id = ? ORDER BY uploaded_at", caseId);

  const adapterCode = opts.adapterCode ?? findAuthority(caseRow.authority_id)?.authority.adapter ?? "IN-FHIR";
  const { config } = resolveAdapter(adapterCode);
  const impl = implementationFor(config.kind);
  const payload = buildCasePayload(caseRow, documents);

  if (caseRow.verification_status === "REJECTED") {
    throw Object.assign(new Error("Case bundle was rejected as inauthentic and cannot be routed"), { status: 409 });
  }

  const built = impl.build(payload, config);
  const builtText = typeof built.payload === "string" ? built.payload : Buffer.from(built.payload).toString("base64");
  const started = Date.now();
  let ack: AdapterAck;
  let simulated = config.simulate;

  if (config.simulate) {
    const sim = impl.simulate(payload, config);
    ack = impl.parseAck(sim.status, sim.body, true);
  } else {
    try {
      const res = await deliver(config.endpoint, builtText, built.contentType, built.headers ?? {});
      ack = impl.parseAck(res.status, res.text, false);
      simulated = false;
    } catch (err) {
      ack = { ok: false, ackId: null, message: `Transport error: ${(err as Error).message}`, httpStatus: null };
    }
  }

  const latencyMs = Date.now() - started;
  const transmissionId = `TRX-${randomCode(10)}`;
  const safeRequest = maskPayload(builtText, [payload.patient.name]);

  run(
    `INSERT INTO transmissions (id, case_id, adapter_code, status, request_json, response_json, http_status, latency_ms, attempts, created_at, reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    transmissionId,
    caseId,
    adapterCode,
    ack.ok ? "DELIVERED" : "FAILED",
    safeRequest.slice(0, 20_000),
    String(JSON.stringify({ ackId: ack.ackId, message: ack.message, simulated })).slice(0, 4000),
    ack.httpStatus,
    latencyMs,
    1,
    nowIso(),
    ack.ackId,
  );

  const currentStatus = caseRow.status;
  const nextStatus = ack.ok
    ? currentStatus === "RESOLVED" || currentStatus === "REJECTED"
      ? currentStatus
      : "ROUTED"
    : currentStatus === "RESOLVED"
      ? currentStatus
      : "ROUTE_FAILED";

  run(
    "UPDATE cases SET status = ?, authority_reference = COALESCE(?, authority_reference), updated_at = ? WHERE id = ?",
    nextStatus,
    ack.ackId,
    nowIso(),
    caseId,
  );

  audit({
    actor: opts.actor ?? { id: null, role: "SYSTEM" },
    action: ack.ok ? "CASE_ROUTED" : "CASE_ROUTE_FAILED",
    entityType: "case",
    entityId: caseId,
    ip: opts.ip,
    userAgent: opts.userAgent,
    details: {
      transmissionId,
      adapter: adapterCode,
      kind: config.kind,
      simulated,
      httpStatus: ack.httpStatus,
      latencyMs,
      ackId: ack.ackId,
      message: ack.message,
      maskedPayload: payload.masked,
    },
  });

  if (ack.ok) {
    try {
      queueCaseNotifications(caseRow, documents, { adapterCode, transmissionId });
    } catch (err) {
      audit({
        actor: { id: null, role: "SYSTEM" },
        action: "NOTIFICATION_ENQUEUE_FAILED",
        entityType: "case",
        entityId: caseId,
        details: { error: (err as Error).message },
      });
    }
  }

  return {
    transmissionId,
    adapterCode,
    status: ack.ok ? "DELIVERED" : "FAILED",
    ackId: ack.ackId,
    message: ack.message,
    httpStatus: ack.httpStatus,
    latencyMs,
    simulated,
    requestSummary: built.summary,
    requestPreview: maskPayload(builtText.slice(0, 4000), [payload.patient.name]),
  };
}

export function caseDtoFor(row: CaseRow, actor: { role: "SUPER_ADMIN" | "MINISTRY_REVIEWER" | "HOSPITAL_COMPLIANCE" | "SYSTEM_AUDITOR" | "PATIENT"; id: string }) {
  const documents = all<DocumentRow>("SELECT * FROM documents WHERE case_id = ? ORDER BY uploaded_at", row.id);
  return caseToDto(row, { ...actor, isOwner: row.patient_user_id === actor.id }, documents);
}
