import type { Priority } from "../config.js";

export type AdapterKind = "FHIR" | "HL7v2" | "REST" | "SOAP";

export type TransmissionDocument = {
  filename: string;
  sha256: string;
  status: string;
  score: number;
  kind: string;
  extractedSummary: string;
};

export type CasePayload = {
  caseId: string;
  createdAt: string;
  priority: Priority;
  priorityScore: number;
  category: string;
  categoryConfidence: number;
  complaint: string;
  symptoms: string | null;
  country: string;
  region: string | null;
  authorityId: string;
  facilityName: string;
  incidentDate: string | null;
  verificationStatus: string;
  patient: { name: string; email: string; phone: string | null };
  documents: TransmissionDocument[];
  triageSummary: string[];
  masked: boolean;
  language: string;
};

export type AdapterConfig = {
  code: string;
  kind: AdapterKind;
  endpoint: string;
  authType: string;
  authConfig?: Record<string, string> | null;
  mapping: Record<string, unknown>;
  simulate: boolean;
};

export type BuiltRequest = {
  payload: string | Uint8Array;
  contentType: string;
  summary: string;
  headers?: Record<string, string>;
};

export type AdapterAck = {
  ok: boolean;
  ackId: string | null;
  message: string;
  httpStatus: number | null;
};

export interface RoutingAdapter {
  kind: AdapterKind;
  build(payload: CasePayload, config: AdapterConfig): BuiltRequest;
  parseAck(status: number, body: string, simulated: boolean): AdapterAck;
  simulate(payload: CasePayload, config: AdapterConfig): { status: number; body: string };
}
