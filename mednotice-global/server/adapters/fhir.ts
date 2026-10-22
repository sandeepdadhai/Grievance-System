import crypto from "node:crypto";
import type { AdapterAck, AdapterConfig, BuiltRequest, CasePayload, RoutingAdapter } from "./types.js";

const PRIORITY_MAP: Record<string, string> = { P1: "stat", P2: "urgent", P3: "asap", P4: "routine" };

export const fhirAdapter: RoutingAdapter = {
  kind: "FHIR",
  build(payload: CasePayload, config: AdapterConfig): BuiltRequest {
    const patientRef = `urn:uuid:${crypto.randomUUID()}`;
    const taskRef = `urn:uuid:${crypto.randomUUID()}`;
    const bundle = {
      resourceType: "Bundle",
      type: "transaction",
      timestamp: new Date().toISOString(),
      identifier: { system: "https://mednotice.global/case-id", value: payload.caseId },
      entry: [
        {
          fullUrl: patientRef,
          resource: {
            resourceType: "Patient",
            identifier: [{ system: "https://mednotice.global/patient-ref", value: payload.caseId }],
            name: [{ text: payload.patient.name }],
            telecom: [
              { system: "email", value: payload.patient.email, use: "home" },
              ...(payload.patient.phone ? [{ system: "phone", value: payload.patient.phone, use: "mobile" }] : []),
            ],
            managingOrganization: { display: payload.facilityName },
          },
          request: { method: "POST", url: "Patient" },
        },
        {
          fullUrl: taskRef,
          resource: {
            resourceType: "Task",
            status: "requested",
            intent: "order",
            priority: PRIORITY_MAP[payload.priority] ?? "routine",
            identifier: [{ system: "https://mednotice.global/case-id", value: payload.caseId }],
            authoredOn: payload.createdAt,
            businessStatus: { text: `${payload.category} — ${payload.verificationStatus}` },
            code: { coding: [{ system: "https://mednotice.global/categories", code: payload.category.replace(/\s+/g, "-").toLowerCase(), display: payload.category }] },
            description: payload.complaint,
            for: { reference: patientRef },
            restriction: { recipient: [{ display: payload.facilityName }] },
            input: [
              { type: { text: "clinical-priority" }, valueString: payload.priority },
              { type: { text: "priority-score" }, valueInteger: payload.priorityScore },
              { type: { text: "jurisdiction" }, valueString: payload.country },
              { type: { text: "authority" }, valueString: payload.authorityId },
              { type: { text: "triage-rationale" }, valueString: payload.triageSummary.join("; ") },
              { type: { text: "pii-masked" }, valueBoolean: payload.masked },
            ],
            note: [{ text: `Symptoms: ${payload.symptoms ?? "not provided"}` }],
          },
          request: { method: "POST", url: "Task" },
        },
        ...payload.documents.map((doc) => ({
          fullUrl: `urn:uuid:${crypto.randomUUID()}`,
          resource: {
            resourceType: "DocumentReference",
            status: "current",
            docStatus: doc.status === "VERIFIED" ? "final" : "preliminary",
            type: { text: doc.kind },
            subject: { reference: patientRef },
            date: payload.createdAt,
            description: `${doc.filename} — ${doc.status} (trust ${doc.score}/100)`,
            content: [
              {
                attachment: {
                  contentType: doc.kind === "PDF" ? "application/pdf" : "application/octet-stream",
                  hash: doc.sha256,
                  title: doc.filename,
                  size: doc.score,
                  creation: payload.createdAt,
                },
              },
            ],
            context: { related: [taskRef], facilityType: { text: payload.facilityName } },
          },
          request: { method: "POST", url: "DocumentReference" },
        })),
      ],
    };
    return {
      payload: JSON.stringify(bundle, null, 2),
      contentType: "application/fhir+json",
      summary: `FHIR R4 transaction: Patient + Task(${PRIORITY_MAP[payload.priority]}) + ${payload.documents.length} DocumentReference`,
      headers: config.authType === "BEARER" && config.authConfig?.token ? { Authorization: `Bearer ${config.authConfig.token}` } : {},
    };
  },
  parseAck(status: number, body: string, simulated: boolean): AdapterAck {
    if (simulated) return { ok: true, ackId: `sim-fhir-${crypto.randomUUID().slice(0, 8)}`, message: "FHIR transaction accepted by simulator", httpStatus: 201 };
    try {
      const parsed = JSON.parse(body);
      return {
        ok: status >= 200 && status < 300,
        ackId: parsed.id ?? parsed.identifier?.value ?? null,
        message: parsed.resourceType ? `${parsed.resourceType} ${parsed.id ?? ""}`.trim() : "FHIR response received",
        httpStatus: status,
      };
    } catch {
      return { ok: false, ackId: null, message: `Unparseable FHIR response (HTTP ${status})`, httpStatus: status };
    }
  },
  simulate(payload) {
    return {
      status: 201,
      body: JSON.stringify({
        resourceType: "Bundle",
        type: "transaction-response",
        id: `sim-${crypto.randomUUID()}`,
        entry: [{ response: { status: "201 Created", location: `Task/${payload.caseId}` } }],
      }),
    };
  },
};
