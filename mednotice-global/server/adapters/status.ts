import type { AdapterConfig, AdapterKind } from "./types.js";
import type { CaseRow } from "../models.js";

/**
 * Authority status polling.
 *
 * Every routed case can be polled for the latest status reported by the
 * receiving department. The endpoint is either configured on the adapter row
 * (`adapters.status_endpoint`, with `{{caseId}}` / `{caseId}` placeholders) or
 * derived from the adapter's delivery endpoint.
 */

export type RemoteStatus = {
  /** Normalised status reported by the department, e.g. UNDER_REVIEW. */
  status: string | null;
  /** The department's own ticket/reference for the case, when it reports one. */
  reference: string | null;
  /** Free-text remark from the department. */
  message: string | null;
  /** When the department last updated the case. */
  updatedAt: string | null;
};

export type StatusRequest = {
  url: string;
  headers: Record<string, string>;
  method: "GET";
};

export type StatusResponse = RemoteStatus & {
  ok: boolean;
  httpStatus: number | null;
  raw: unknown;
};

const STATUS_KEYS = ["status", "caseStatus", "case_status", "state", "grievanceStatus", "grievance_status", "stage"];
const REFERENCE_KEYS = ["reference", "ticketId", "ticket_id", "complaintId", "complaint_id", "grievanceId", "grievance_id", "id", "identifier"];
const MESSAGE_KEYS = ["message", "remark", "remarks", "note", "notes", "comment", "description", "reason", "statusMessage"];
const UPDATED_KEYS = ["updatedAt", "updated_at", "lastUpdated", "last_updated", "modifiedAt", "modified_at", "statusDate", "status_date", "timestamp"];

function substitute(template: string, caseId: string, reference: string | null): string {
  return template
    .replace(/\{\{\s*caseId\s*\}\}/g, encodeURIComponent(caseId))
    .replace(/\{\{\s*reference\s*\}\}/g, encodeURIComponent(reference ?? ""))
    .replace(/\{caseId\}/g, encodeURIComponent(caseId))
    .replace(/\{reference\}/g, encodeURIComponent(reference ?? ""));
}

/**
 * Derive the status endpoint for a case. An explicitly configured endpoint
 * wins; otherwise the delivery endpoint is rewritten to a per-case status
 * resource (…/cases → …/cases/{id}/status).
 */
export function statusEndpointFor(config: AdapterConfig, caseRow: CaseRow, reference: string | null = null): string | null {
  const configured = config.statusEndpoint?.trim();
  if (configured) return substitute(configured, caseRow.id, reference);
  const base = config.endpoint?.trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length && /cases|complaints|grievance/i.test(segments[segments.length - 1])) {
      segments[segments.length - 1] = `${segments[segments.length - 1]}/${encodeURIComponent(caseRow.id)}/status`;
    } else {
      segments.push(caseRow.id, "status");
    }
    url.pathname = `/${segments.join("/")}`;
    url.searchParams.set("caseId", caseRow.id);
    if (reference) url.searchParams.set("reference", reference);
    return url.toString();
  } catch {
    return null;
  }
}

export function buildStatusRequest(config: AdapterConfig, caseRow: CaseRow, reference: string | null = null): StatusRequest | null {
  const url = statusEndpointFor(config, caseRow, reference);
  if (!url) return null;
  const headers: Record<string, string> = { accept: "application/json, application/xml;q=0.9, */*;q=0.5" };
  if (config.authType === "BEARER" && config.authConfig?.token) headers.authorization = `Bearer ${config.authConfig.token}`;
  if (config.authType === "API_KEY" && config.authConfig?.apiKey) headers["x-api-key"] = config.authConfig.apiKey;
  if (config.authType === "API_KEY" && config.authConfig?.header && config.authConfig?.value) {
    headers[config.authConfig.header] = config.authConfig.value;
  }
  return { url, headers, method: "GET" };
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function firstValue(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return null;
}

function normaliseStatus(value: string | null): string | null {
  if (!value) return null;
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .slice(0, 60) || null;
}

/** Pull the interesting fields out of a flat or lightly nested JSON body. */
function fromJson(body: unknown): RemoteStatus {
  if (!body || typeof body !== "object") return { status: null, reference: null, message: null, updatedAt: null };
  const root = body as Record<string, unknown>;

  // Common envelopes: { data: {...} }, { result: {...} }, { case: {...} }.
  const candidates: Record<string, unknown>[] = [root];
  for (const key of ["data", "result", "case", "grievance", "complaint", "task", "resource"]) {
    const nested = root[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) candidates.push(nested as Record<string, unknown>);
  }

  for (const candidate of candidates) {
    const status = firstString(candidate, STATUS_KEYS);
    if (status) {
      return {
        status: normaliseStatus(status),
        reference: firstString(candidate, REFERENCE_KEYS),
        message: firstString(candidate, MESSAGE_KEYS),
        updatedAt: firstString(candidate, UPDATED_KEYS),
      };
    }
  }
  return {
    status: null,
    reference: firstString(root, REFERENCE_KEYS),
    message: firstString(root, MESSAGE_KEYS),
    updatedAt: firstString(root, UPDATED_KEYS),
  };
}

/** FHIR: a Task/Case/Bundle resource carries the status. */
function fromFhir(body: unknown): RemoteStatus {
  const root = body as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return { status: null, reference: null, message: null, updatedAt: null };
  const resources: unknown[] = [];
  if (Array.isArray(root.entry)) {
    for (const entry of root.entry as Array<{ resource?: unknown }>) {
      if (entry?.resource) resources.push(entry.resource);
    }
  }
  if (root.resourceType) resources.push(root);
  for (const resource of resources) {
    const r = resource as Record<string, unknown>;
    if (r.status) {
      const identifier = Array.isArray(r.identifier) ? (r.identifier[0] as { value?: string } | undefined) : undefined;
      return {
        status: normaliseStatus(String(r.status)),
        reference: identifier?.value ?? firstString(r, REFERENCE_KEYS),
        message: firstString(r, MESSAGE_KEYS),
        updatedAt: firstString(r, UPDATED_KEYS),
      };
    }
  }
  return fromJson(root);
}

/** HL7 v2: the order status is carried in an OBX observation. */
function fromHl7(text: string): RemoteStatus {
  const segments = text.split(/\r\n|\r|\n/).filter(Boolean);
  let reference: string | null = null;
  let status: string | null = null;
  let message: string | null = null;
  const observations: Array<{ identifier: string; value: string }> = [];

  for (const segment of segments) {
    const fields = segment.split("|");
    const name = fields[0];
    if (name === "ORC") {
      reference = fields[2]?.split("^")[0] || fields[3]?.split("^")[0] || reference;
    }
    if (name === "MSA" && fields[3]) message = fields[3] || message;
    if (name === "OBX") {
      const identifier = (fields[3] ?? "").trim();
      // OBX|setId|type|identifier|subId|value — some feeds omit the sub-id.
      const value = ((fields[5] ?? "").trim() || (fields[4] ?? "").trim());
      if (identifier) observations.push({ identifier, value });
    }
  }

  const statusObservation = observations.find((o) => /status|state|stage|disposition|progress|phase/i.test(o.identifier));
  if (statusObservation) {
    status = statusObservation.value;
  } else if (observations.length === 1) {
    status = observations[0].value;
  }
  if (!message) {
    const remark = observations.find((o) => /remark|note|comment|message/i.test(o.identifier));
    message = remark?.value || null;
  }

  return { status: normaliseStatus(status), reference, message, updatedAt: null };
}

/** SOAP: read the first *Status element in the body. */
function fromXml(text: string): RemoteStatus {
  const status = text.match(/<[^>]*Status[^>]*>([^<]{1,120})<\/[^>]*Status>/i);
  const reference = text.match(/<[^>]*Reference[^>]*>([^<]{1,120})<\/[^>]*Reference>/i);
  const message = text.match(/<[^>]*Message[^>]*>([^<]{1,240})<\/[^>]*Message>/i);
  return {
    status: normaliseStatus(status?.[1] ?? null),
    reference: reference?.[1]?.trim() ?? null,
    message: message?.[1]?.trim() ?? null,
    updatedAt: null,
  };
}

export function parseStatusResponse(kind: AdapterKind, httpStatus: number, text: string): StatusResponse {
  const trimmed = text.trim();
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      httpStatus,
      status: null,
      reference: null,
      message: trimmed.slice(0, 300) || `HTTP ${httpStatus}`,
      updatedAt: null,
      raw: trimmed.slice(0, 2000),
    };
  }
  let remote: RemoteStatus = { status: null, reference: null, message: null, updatedAt: null };
  let raw: unknown = trimmed;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      raw = parsed;
      remote = kind === "FHIR" ? fromFhir(parsed) : fromJson(parsed);
    } catch {
      remote = { status: null, reference: null, message: "Response was not valid JSON", updatedAt: null };
    }
  } else if (kind === "HL7v2") {
    remote = fromHl7(trimmed);
  } else if (trimmed.startsWith("<")) {
    remote = fromXml(trimmed);
  } else {
    remote = { status: normaliseStatus(trimmed.slice(0, 60)), reference: null, message: null, updatedAt: null };
  }
  return {
    ok: Boolean(remote.status),
    httpStatus,
    status: remote.status,
    reference: remote.reference,
    message: remote.message,
    updatedAt: remote.updatedAt,
    raw,
  };
}

/**
 * Offline simulation. The sandbox behaves like a department that acknowledges
 * the case, works on it, and eventually closes it — the progression depends on
 * how long the case has been with the authority, so it is deterministic.
 */
export function simulatedStatus(caseRow: CaseRow, reference: string | null, routedAt: string | null): RemoteStatus & { simulated: true } {
  const since = routedAt ? Date.now() - new Date(routedAt).getTime() : 0;
  const minutes = Math.max(0, Math.round(since / 60_000));
  let status: string;
  let message: string;
  if (minutes < 2) {
    status = "ACKNOWLEDGED";
    message = "Received by the department and queued for registration.";
  } else if (minutes < 30) {
    status = "UNDER_REVIEW";
    message = "Case registered and under preliminary review.";
  } else if (minutes < 240) {
    status = "ACTION_TAKEN";
    message = "The facility has been asked to respond; the case is being monitored.";
  } else {
    status = "UNDER_REVIEW";
    message = "Escalated to the principal officer; a response has been sought from the facility.";
  }
  return {
    status,
    reference: reference ?? `SIM-${caseRow.id}`,
    message,
    updatedAt: new Date().toISOString(),
    simulated: true,
  };
}
