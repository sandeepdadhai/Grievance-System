export type Role = "SUPER_ADMIN" | "MINISTRY_REVIEWER" | "HOSPITAL_COMPLIANCE" | "SYSTEM_AUDITOR" | "PATIENT";
export type Priority = "P1" | "P2" | "P3" | "P4";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  country: string | null;
  organisation: string | null;
};

export type Authority = {
  id: string;
  name: string;
  region: string;
  adapter: string;
  contactEmail: string;
};

export type Jurisdiction = {
  code: string;
  name: string;
  flag: string;
  regulator: string;
  frameworks: string[];
  locale: string;
  languages: string[];
  retentionDays: number;
  slaHours: Record<Priority, number>;
  crossBorderRestricted: boolean;
  complaintCategories: string[];
  authorities: Authority[];
};

export type Facility = {
  id: string;
  name: string;
  authority_id: string;
  country: string;
  city: string | null;
  status: string;
};

export type Finding = {
  code: string;
  label: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  detail: string;
  weight: number;
  category: string;
};

export type ExtractedFields = {
  patientName?: string;
  physicianName?: string;
  physicianLicense?: string;
  npi?: string;
  diagnosisCode?: string;
  facilityName?: string;
  datesOfService: string[];
  mrn?: string;
  textLength: number;
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
  verificationStatus: "VERIFIED" | "PENDING_MANUAL_REVIEW" | "REJECTED" | string;
  score: number;
  findings: Finding[];
  extracted: ExtractedFields;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  uploadedAt: string;
  downloadUrl: string | null;
};

export type TriageSignal = { code: string; label: string; weight: number; detail: string };

export type TriageResult = {
  priority: Priority;
  score: number;
  category: string;
  categoryConfidence: number;
  signals: TriageSignal[];
  categoryScores: Record<string, number>;
  slaHours: number;
  dueAt: string;
  regulatoryBasis: string[];
  humanReviewRecommended: boolean;
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
  triage: TriageResult;
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
  documentCount?: number;
};

export type CaseDetail = {
  case: CaseDto;
  reviews: Array<{ id: string; action: string; note: string; reviewer_id: string; created_at: string; previous_json: string; new_json: string }>;
  transmissions: Array<{
    id: string;
    adapter_code: string;
    status: string;
    request_json: string;
    response_json: string;
    http_status: number | null;
    latency_ms: number | null;
    created_at: string;
  }>;
  notifications: Array<{
    id: string;
    channel: string;
    target: string;
    subject: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
    sent_at: string | null;
  }>;
  activity: Array<{ ts: string; actor_id: string | null; actor_role: string | null; action: string; details: Record<string, unknown> }>;
  piiVisible: boolean;
};

export type Overview = {
  totals: {
    total: number;
    open: number;
    resolved: number;
    rejected: number;
    pendingVerification: number;
    openP1: number;
    overdue: number;
    avgResolutionHours: number | null;
    slaCompliance: number | null;
  };
  byPriority: Array<{ priority: Priority; n: number }>;
  byCountry: Array<{ country: string; n: number }>;
  byCategory: Array<{ category: string; n: number }>;
  byStatus: Array<{ status: string; n: number }>;
  verification: Array<{ verification_status: string; n: number }>;
  trend: Array<{ date: string; count: number }>;
  recent: Array<{
    id: string;
    patientName: string;
    country: string;
    facilityName: string;
    category: string;
    priority: Priority;
    status: string;
    verificationStatus: string;
    createdAt: string;
    slaDueAt: string;
  }>;
  notifications: { queued: number; sent: number; failed: number };
  transmissions: { delivered: number; failed: number; avgLatencyMs: number | null };
  auditChain: { valid: boolean; checked: number; brokenAt: number | null };
  scope: string;
  generatedAt: string;
};

export type AdapterDto = {
  code: string;
  name: string;
  country: string;
  kind: string;
  endpoint: string;
  authType: string;
  mapping: Record<string, unknown>;
  enabled: boolean;
  simulate: boolean;
  hasCredentials: boolean;
  createdAt: string;
  deliveries: Array<{ status: string; count: number }>;
};

export type NotificationRow = {
  id: string;
  case_id: string;
  channel: string;
  target: string;
  subject: string;
  body: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
};
