import { decryptField } from "./crypto.js";
import type { Priority } from "./config.js";
import type { Finding, ExtractedFields } from "./verification/types.js";

export type Role = "SUPER_ADMIN" | "MINISTRY_REVIEWER" | "HOSPITAL_COMPLIANCE" | "SYSTEM_AUDITOR" | "PATIENT";

export type UserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  /** Built-in role key or administrator-defined custom role key. */
  role: string;
  country: string | null;
  organisation: string | null;
  active: number;
  mfa_enabled: number;
  last_login_at: string | null;
  created_at: string;
};

export type CaseRow = {
  id: string;
  access_code_hash: string | null;
  patient_user_id: string | null;
  patient_name_enc: string | null;
  patient_email_enc: string | null;
  patient_phone_enc: string | null;
  patient_name_masked: string;
  patient_email_masked: string;
  country: string;
  region: string | null;
  authority_id: string;
  facility_id: string | null;
  facility_name: string | null;
  category: string;
  category_confidence: number;
  priority: Priority;
  priority_score: number;
  triage_json: string;
  complaint_enc: string;
  symptoms_enc: string | null;
  timeline_json: string;
  incident_date: string | null;
  status: string;
  verification_status: string;
  assigned_to: string | null;
  consent_data_sharing: number;
  cross_border_allowed: number;
  language: string;
  source: string;
  created_at: string;
  updated_at: string;
  sla_due_at: string;
  resolved_at: string | null;
};

export type DocumentRow = {
  id: string;
  case_id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  storage_path: string | null;
  kind: string;
  page_count: number | null;
  has_text_layer: number | null;
  verification_status: string;
  score: number;
  findings_json: string;
  extracted_json: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  uploaded_at: string;
};

export type DocumentDto = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  kind: string;
  pageCount: number | null;
  hasTextLayer: boolean;
  verificationStatus: string;
  score: number;
  findings: Finding[];
  extracted: ExtractedFields;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  uploadedAt: string;
  downloadUrl: string | null;
};

export type CaseDto = {
  id: string;
  patientUserId: string | null;
  patientName: string;
  patientEmail: string;
  patientPhone: string | null;
  country: string;
  region: string | null;
  authorityId: string;
  facilityId: string | null;
  facilityName: string | null;
  category: string;
  categoryConfidence: number;
  priority: Priority;
  priorityScore: number;
  triage: Record<string, unknown>;
  complaint: string;
  symptoms: string | null;
  timeline: Array<{ date: string; event: string }>;
  incidentDate: string | null;
  status: string;
  verificationStatus: string;
  assignedTo: string | null;
  consentDataSharing: boolean;
  crossBorderAllowed: boolean;
  language: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  slaDueAt: string;
  resolvedAt: string | null;
  documents?: DocumentDto[];
};

export type PiiActor = { role: Role; id: string; isOwner?: boolean };

export function canSeePii(actor: PiiActor): boolean {
  if (actor.isOwner) return true;
  return actor.role === "SUPER_ADMIN" || actor.role === "MINISTRY_REVIEWER" || actor.role === "HOSPITAL_COMPLIANCE";
}

export function documentToDto(row: DocumentRow): DocumentDto {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    kind: row.kind,
    pageCount: row.page_count,
    hasTextLayer: Boolean(row.has_text_layer),
    verificationStatus: row.verification_status,
    score: row.score,
    findings: JSON.parse(row.findings_json || "[]") as Finding[],
    extracted: JSON.parse(row.extracted_json || "{}") as ExtractedFields,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    uploadedAt: row.uploaded_at,
    downloadUrl: row.storage_path ? `/api/documents/${row.id}/file` : null,
  };
}

export function caseToDto(row: CaseRow, actor: PiiActor, documents?: DocumentRow[]): CaseDto {
  const full = canSeePii(actor);
  const dto: CaseDto = {
    id: row.id,
    patientUserId: row.patient_user_id,
    patientName: full ? (decryptField(row.patient_name_enc) ?? row.patient_name_masked) : row.patient_name_masked,
    patientEmail: full ? (decryptField(row.patient_email_enc) ?? row.patient_email_masked) : row.patient_email_masked,
    patientPhone: full ? decryptField(row.patient_phone_enc) : null,
    country: row.country,
    region: row.region,
    authorityId: row.authority_id,
    facilityId: row.facility_id,
    facilityName: row.facility_name,
    category: row.category,
    categoryConfidence: row.category_confidence,
    priority: row.priority,
    priorityScore: row.priority_score,
    triage: JSON.parse(row.triage_json || "{}"),
    complaint: decryptField(row.complaint_enc) ?? "",
    symptoms: decryptField(row.symptoms_enc),
    timeline: JSON.parse(row.timeline_json || "[]"),
    incidentDate: row.incident_date,
    status: row.status,
    verificationStatus: row.verification_status,
    assignedTo: row.assigned_to,
    consentDataSharing: Boolean(row.consent_data_sharing),
    crossBorderAllowed: Boolean(row.cross_border_allowed),
    language: row.language,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    slaDueAt: row.sla_due_at,
    resolvedAt: row.resolved_at,
  };
  if (documents) dto.documents = documents.map(documentToDto);
  return dto;
}
