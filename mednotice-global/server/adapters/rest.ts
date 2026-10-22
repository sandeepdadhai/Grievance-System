import crypto from "node:crypto";
import type { AdapterAck, AdapterConfig, BuiltRequest, CasePayload, RoutingAdapter } from "./types.js";

type Template = string | number | boolean | null | Template[] | { [key: string]: Template };

function flatten(payload: CasePayload): Record<string, unknown> {
  return {
    caseId: payload.caseId,
    createdAt: payload.createdAt,
    priority: payload.priority,
    priorityScore: payload.priorityScore,
    category: payload.category,
    categoryConfidence: payload.categoryConfidence,
    complaint: payload.complaint,
    symptoms: payload.symptoms ?? "",
    country: payload.country,
    region: payload.region ?? "",
    authorityId: payload.authorityId,
    facilityName: payload.facilityName,
    incidentDate: payload.incidentDate ?? "",
    verificationStatus: payload.verificationStatus,
    patientName: payload.patient.name,
    patientEmail: payload.patient.email,
    patientPhone: payload.patient.phone ?? "",
    documentCount: payload.documents.length,
    masked: payload.masked,
    language: payload.language,
  };
}

export function renderTemplate<T extends Template>(template: T, vars: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const exact = template.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (exact) return vars[exact[1]] ?? "";
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => String(vars[key] ?? ""));
  }
  if (Array.isArray(template)) return template.map((t) => renderTemplate(t, vars));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, renderTemplate(v as Template, vars)]));
  }
  return template;
}

/** Default envelope used when an adapter config supplies no mapping. */
const DEFAULT_MAPPING: Template = {
  reference: "{{caseId}}",
  jurisdiction: "{{country}}",
  authority: "{{authorityId}}",
  facility: "{{facilityName}}",
  severity: "{{priority}}",
  severityScore: "{{priorityScore}}",
  category: "{{category}}",
  narrative: "{{complaint}}",
  symptoms: "{{symptoms}}",
  verificationStatus: "{{verificationStatus}}",
  patient: { name: "{{patientName}}", email: "{{patientEmail}}", phone: "{{patientPhone}}" },
  documents: "{{documentCount}}",
  submittedAt: "{{createdAt}}",
  piiMasked: "{{masked}}",
};

export const restAdapter: RoutingAdapter = {
  kind: "REST",
  build(payload: CasePayload, config: AdapterConfig): BuiltRequest {
    const mapping = (config.mapping?.envelope as Template | undefined) ?? DEFAULT_MAPPING;
    const body = renderTemplate(mapping, flatten(payload));
    return {
      payload: JSON.stringify(body, null, 2),
      contentType: "application/json",
      summary: `REST JSON payload for ${config.code} (${Object.keys(body as object).length} top-level fields)`,
      headers: config.authType === "API_KEY" && config.authConfig?.header
        ? { [config.authConfig.header]: config.authConfig.value ?? "" }
        : config.authType === "BEARER" && config.authConfig?.token
          ? { Authorization: `Bearer ${config.authConfig.token}` }
          : {},
    };
  },
  parseAck(status: number, body: string, simulated: boolean): AdapterAck {
    if (simulated) return { ok: true, ackId: `sim-rest-${crypto.randomUUID().slice(0, 8)}`, message: "REST endpoint accepted payload (simulated 202)", httpStatus: 202 };
    let ackId: string | null = null;
    try {
      const parsed = JSON.parse(body);
      ackId = parsed.caseId ?? parsed.id ?? parsed.reference ?? parsed.ticketId ?? null;
    } catch {
      /* non-JSON acknowledgement */
    }
    return {
      ok: status >= 200 && status < 300,
      ackId,
      message: `REST endpoint responded HTTP ${status}`,
      httpStatus: status,
    };
  },
  simulate() {
    return { status: 202, body: JSON.stringify({ accepted: true, id: `sim-${crypto.randomUUID()}` }) };
  },
};
