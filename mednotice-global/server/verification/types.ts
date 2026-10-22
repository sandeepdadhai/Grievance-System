export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type Finding = {
  code: string;
  label: string;
  severity: Severity;
  detail: string;
  /** Points added to (positive) or subtracted from (negative) the trust score. */
  weight: number;
  category: "integrity" | "metadata" | "identity" | "content" | "registry" | "privacy";
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

export type DocumentKind = "PDF" | "JPEG" | "PNG" | "DICOM" | "UNKNOWN";

export type VerificationStatus = "VERIFIED" | "PENDING_MANUAL_REVIEW" | "REJECTED";

export type VerificationResult = {
  status: VerificationStatus;
  score: number;
  findings: Finding[];
  extracted: ExtractedFields;
  meta: {
    kind: DocumentKind;
    pageCount: number | null;
    hasTextLayer: boolean;
    producer?: string | null;
    creator?: string | null;
    revisions: number;
    activeContent: boolean;
    digitalSignature: boolean;
    dimensions?: { width: number; height: number } | null;
  };
};

export type VerificationContext = {
  facilityName: string;
  facilityId?: string | null;
  country: string;
  authorityId: string;
  duplicateCount: number;
};

export function scoreToStatus(score: number): VerificationStatus {
  if (score >= 75) return "VERIFIED";
  if (score >= 40) return "PENDING_MANUAL_REVIEW";
  return "REJECTED";
}
