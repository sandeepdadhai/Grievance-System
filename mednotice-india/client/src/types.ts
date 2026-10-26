export type BuiltinRole = "SUPER_ADMIN" | "MINISTRY_REVIEWER" | "HOSPITAL_COMPLIANCE" | "SYSTEM_AUDITOR" | "PATIENT";
export type Role = BuiltinRole;
export type Priority = "P1" | "P2" | "P3" | "P4";

export type User = {
  id: string;
  email: string;
  name: string;
  /** Stored role key — built-in or administrator-defined. */
  role: string;
  roleName?: string;
  baseRole: BuiltinRole;
  permissions: string[];
  country: string | null;
  organisation: string | null;
  /** Facility this account is bound to; null means state-wide scope. */
  facilityId?: string | null;
  facilityName?: string | null;
  /**
   * WhatsApp notification preference. `number` is always masked, and
   * `connected` reports whether the server holds live WhatsApp Business
   * credentials (otherwise messages are simulated into the outbox).
   */
  whatsapp?: { number: string | null; optIn: boolean; connected: boolean };
};

export type PermissionDefinition = {
  key: string;
  label: string;
  group: string;
  description: string;
};

export type RoleDefinition = {
  key: string;
  name: string;
  description: string;
  baseRole: BuiltinRole;
  permissions: string[];
  builtin: boolean;
  userCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CommunityPost = {
  id: string;
  authorName: string;
  isGuest: boolean;
  isMine: boolean;
  title: string;
  body: string;
  topic: string;
  status: "VISIBLE" | "HIDDEN" | "REMOVED" | string;
  pinned: boolean;
  commentCount: number;
  hiddenComments?: number;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CommunityComment = {
  id: string;
  postId: string;
  authorName: string;
  isGuest: boolean;
  isMine: boolean;
  body: string;
  status: string;
  editedAt: string | null;
  createdAt: string;
};

export type ChatCaseStatus = {
  id: string;
  status: string;
  priority: Priority;
  verificationStatus: string;
  category: string;
  facilityName: string | null;
  authorityName: string | null;
  createdAt: string;
  slaDueAt: string;
  resolvedAt: string | null;
  lastEvent: string | null;
  documents: number;
};

export type ChatResponse = {
  reply: string;
  intent: string;
  suggestions: Array<{ label: string; href: string }>;
  emergency?: boolean;
  caseStatus?: ChatCaseStatus;
  disclaimer?: string;
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
  authorityId: string;
  country: string;
  city: string | null;
  status: string;
};

export type AuthorityDto = {
  id: string;
  name: string;
  country: string;
  region: string;
  adapter: string;
  contactEmail: string;
  webhook: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  facilityCount: number;
  caseCount: number;
};

export type FacilityCase = CaseDto & {
  documentCount: number;
  pendingDocuments: number;
  documents: DocumentDto[];
};

export type FacilityWorkspace = {
  facility: FacilityDto;
  counts: {
    total: number;
    open: number;
    awaitingVerification: number;
    resolved: number;
    overdue: number;
  };
  cases: FacilityCase[];
};

export type FacilityDto = {
  id: string;
  name: string;
  authorityId: string;
  country: string;
  city: string | null;
  letterheadKeywords: string[];
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
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
  /** Latest status reported by the receiving health authority. */
  authorityStatus: string | null;
  authorityStatusAt: string | null;
  authorityReference: string | null;
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
    reference?: string | null;
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
  authorityStatus: {
    status: string | null;
    checkedAt: string | null;
    reference: string | null;
    history: Array<{
      id: string;
      case_id: string;
      transmission_id: string | null;
      authority_id: string;
      adapter_code: string;
      endpoint: string;
      status: string;
      remote_status: string | null;
      remote_reference: string | null;
      message: string | null;
      http_status: number | null;
      latency_ms: number | null;
      applied: number;
      simulated: number;
      checked_at: string;
    }>;
  };
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
  byRegion: Array<{ region: string; n: number }>;
  byCategory: Array<{ category: string; n: number }>;
  byStatus: Array<{ status: string; n: number }>;
  verification: Array<{ verification_status: string; n: number }>;
  trend: Array<{ date: string; count: number }>;
  recent: Array<{
    id: string;
    patientName: string;
    country: string;
    region: string | null;
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
  /** Per-adapter endpoint polled for the department's latest case status. */
  statusEndpoint: string | null;
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
