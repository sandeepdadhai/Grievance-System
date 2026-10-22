import { get } from "../db.js";
import { analyzePdf } from "./pdf.js";
import { analyzeImage, sniffKind } from "./image.js";
import { extractFields } from "./extract.js";
import type { ExtractedFields, Finding, VerificationContext, VerificationResult } from "./types.js";
import { scoreToStatus } from "./types.js";

const GENERIC_TOKENS = new Set([
  "hospital",
  "medical",
  "center",
  "centre",
  "clinic",
  "health",
  "healthcare",
  "system",
  "the",
  "of",
  "and",
  "general",
  "regional",
  "city",
  "university",
  "universitaetsklinikum",
  "universitätsklinikum",
  "klinik",
  "krankenhaus",
  "infirmary",
  "polyclinic",
  "national",
  "institute",
  "group",
]);

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !GENERIC_TOKENS.has(t));
}

function facilityMatches(a: string, b: string): boolean {
  const ta = new Set(tokens(a));
  const tb = tokens(b);
  if (ta.size === 0 || tb.length === 0) return true;
  return tb.some((t) => ta.has(t));
}

const BASE_SCORE = 78;

export function verifyDocument(input: {
  buffer: Buffer;
  filename: string;
  mime: string;
  ctx: VerificationContext;
}): VerificationResult {
  const { buffer, filename, mime, ctx } = input;
  const kind = sniffKind(buffer, mime, filename);
  const findings: Finding[] = [];
  let pageCount: number | null = null;
  let hasTextLayer = false;
  let producer: string | null = null;
  let creator: string | null = null;
  let revisions = 0;
  let activeContent = false;
  let digitalSignature = false;
  let dimensions: { width: number; height: number } | null = null;
  let text = "";
  let extracted: ExtractedFields = { datesOfService: [], textLength: 0 };

  if (kind === "PDF") {
    const pdf = analyzePdf(buffer);
    findings.push(...pdf.findings);
    pageCount = pdf.pageCount;
    hasTextLayer = pdf.text.replace(/\s/g, "").length >= 30;
    producer = pdf.producer;
    creator = pdf.creator;
    revisions = pdf.revisions;
    activeContent = pdf.activeContent;
    digitalSignature = pdf.digitalSignature;
    text = pdf.text;
    extracted = extractFields(text, ctx.country);
  } else {
    const image = analyzeImage(buffer, mime, filename);
    findings.push(...image.findings);
    dimensions = image.dimensions;
    text = image.text;
    extracted = extractFields(text, ctx.country, image.dicomMeta);
    if (image.kind === "UNKNOWN") {
      findings.push({
        code: "UNSUPPORTED_FORMAT",
        label: "Unrecognised document format",
        severity: "critical",
        detail: "The file is not a valid PDF, JPEG, PNG, or DICOM object and cannot be verified.",
        weight: -50,
        category: "integrity",
      });
    }
  }

  if (buffer.length === 0) {
    findings.push({
      code: "EMPTY_FILE",
      label: "Empty upload",
      severity: "critical",
      detail: "The file contains no data.",
      weight: -60,
      category: "integrity",
    });
  }

  /* ------------------------- registry cross-checks ------------------------ */

  if (extracted.physicianLicense) {
    const lic = get<{ license_no: string; full_name: string; status: string; expires_at: string | null }>(
      "SELECT license_no, full_name, status, expires_at FROM physician_licenses WHERE UPPER(license_no) = ?",
      extracted.physicianLicense,
    );
    if (!lic) {
      findings.push({
        code: "LICENSE_NOT_FOUND",
        label: "Physician licence not in registry",
        severity: "medium",
        detail: `Licence "${extracted.physicianLicense}" is not present in any connected medical council registry.`,
        weight: -10,
        category: "registry",
      });
    } else if (lic.status === "REVOKED") {
      findings.push({
        code: "LICENSE_REVOKED",
        label: "Revoked physician licence",
        severity: "critical",
        detail: `Licence ${lic.license_no} (${lic.full_name}) has been revoked. A document bearing it cannot be authentic.`,
        weight: -70,
        category: "registry",
      });
    } else if (lic.status === "SUSPENDED") {
      findings.push({
        code: "LICENSE_SUSPENDED",
        label: "Suspended physician licence",
        severity: "high",
        detail: `Licence ${lic.license_no} is suspended; records signed during suspension require manual review.`,
        weight: -40,
        category: "registry",
      });
    } else if (lic.expires_at && new Date(lic.expires_at).getTime() < Date.now()) {
      findings.push({
        code: "LICENSE_EXPIRED",
        label: "Expired physician licence",
        severity: "high",
        detail: `Licence ${lic.license_no} expired on ${lic.expires_at.slice(0, 10)}.`,
        weight: -30,
        category: "registry",
      });
    } else {
      findings.push({
        code: "LICENSE_ACTIVE",
        label: "Active physician licence confirmed",
        severity: "info",
        detail: `Licence ${lic.license_no} is active and belongs to ${lic.full_name}.`,
        weight: 10,
        category: "registry",
      });
      if (extracted.physicianName && !facilityMatches(extracted.physicianName, lic.full_name)) {
        findings.push({
          code: "LICENSE_NAME_MISMATCH",
          label: "Licence holder name mismatch",
          severity: "high",
          detail: `Document names "${extracted.physicianName}" but licence ${lic.license_no} is held by ${lic.full_name}.`,
          weight: -30,
          category: "registry",
        });
      }
    }
  } else if (hasTextLayer || kind === "DICOM") {
    findings.push({
      code: "LICENSE_ABSENT",
      label: "No physician licence reference",
      severity: "low",
      detail: "No NMC registration number or equivalent licence identifier could be extracted from the document.",
      weight: -6,
      category: "registry",
    });
  }

  if (extracted.facilityName) {
    if (!facilityMatches(extracted.facilityName, ctx.facilityName)) {
      findings.push({
        code: "FACILITY_MISMATCH",
        label: "Facility on document differs from complaint target",
        severity: "medium",
        detail: `Document names "${extracted.facilityName}" while the complaint targets "${ctx.facilityName}".`,
        weight: -16,
        category: "registry",
      });
    } else {
      findings.push({
        code: "FACILITY_MATCH",
        label: "Facility matches complaint target",
        severity: "info",
        detail: `Document references ${extracted.facilityName}.`,
        weight: 6,
        category: "registry",
      });
    }
  }

  if (hasTextLayer && ctx.facilityId) {
    const facility = get<{ letterhead_keywords: string }>("SELECT letterhead_keywords FROM facilities WHERE id = ?", ctx.facilityId);
    let keywords: string[] = [];
    try {
      keywords = facility ? (JSON.parse(facility.letterhead_keywords) as string[]) : [];
    } catch {
      keywords = [];
    }
    if (keywords.length > 0) {
      const normalized = text.toLowerCase().replace(/[’']/g, "'");
      const hits = keywords.filter((keyword) => normalized.includes(keyword.toLowerCase().replace(/[’']/g, "'")));
      if (hits.length === 0) {
        findings.push({
          code: "LETTERHEAD_MISMATCH",
          label: "Hospital letterhead markers absent",
          severity: "medium",
          detail: `None of the expected letterhead markers for ${ctx.facilityName} appear in the document text (${keywords.slice(0, 2).join(", ")}…).`,
          weight: -8,
          category: "registry",
        });
      } else {
        findings.push({
          code: "LETTERHEAD_MATCH",
          label: "Hospital letterhead markers confirmed",
          severity: "info",
          detail: `Document contains expected letterhead marker(s): ${hits.slice(0, 2).join(", ")}.`,
          weight: 3,
          category: "registry",
        });
      }
    }
  }

  if (ctx.duplicateCount > 0) {
    findings.push({
      code: "DUPLICATE_DOCUMENT",
      label: "Identical document already on file",
      severity: "high",
      detail: `The same SHA-256 digest appears in ${ctx.duplicateCount} existing document record(s). Reused records are a common fraud pattern.`,
      weight: -25,
      category: "identity",
    });
  }

  /* ------------------------ content/privacy signals ----------------------- */

  if (/\b\d{4}\s\d{4}\s\d{4}\b/.test(text) || /\b\d{12}\b/.test(text)) {
    findings.push({
      code: "UNMASKED_NATIONAL_ID",
      label: "Unmasked Aadhaar number in document",
      severity: "low",
      detail: "A 12-digit Aadhaar pattern is present in clear text; DPDP Act 2023 minimisation is recommended.",
      weight: 0,
      category: "privacy",
    });
  }
  if (/\b[A-Z]{5}[0-9]{4}[A-Z]\b/.test(text)) {
    findings.push({
      code: "UNMASKED_TAX_ID",
      label: "Unmasked PAN in document",
      severity: "low",
      detail: "A permanent account number (PAN) is present in clear text; redact before transmission.",
      weight: 0,
      category: "privacy",
    });
  }
  if (/\b(?:\d[ -]?){15,16}\b/.test(text) && text.length > 60) {
    findings.push({
      code: "POSSIBLE_PAYMENT_CARD",
      label: "Possible payment card number",
      severity: "low",
      detail: "A 15–16 digit sequence consistent with a payment card was detected; it must be redacted before transmission.",
      weight: 0,
      category: "privacy",
    });
  }

  const score = Math.max(0, Math.min(100, BASE_SCORE + findings.reduce((sum, f) => sum + f.weight, 0)));
  const hasCritical = findings.some((f) => f.severity === "critical" && f.weight <= -50);
  const status = hasCritical ? "REJECTED" : scoreToStatus(score);

  findings.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  return {
    status,
    score: hasCritical ? Math.min(score, 20) : score,
    findings,
    extracted,
    meta: {
      kind,
      pageCount,
      hasTextLayer,
      producer,
      creator,
      revisions,
      activeContent,
      digitalSignature,
      dimensions,
    },
  };
}

/** Aggregate per-document results into a bundle decision. */
export function bundleStatus(results: Array<{ verification_status: string }>): {
  status: "VERIFIED" | "PENDING_MANUAL_REVIEW" | "REJECTED" | "PENDING";
  reason: string;
} {
  if (results.length === 0) return { status: "PENDING", reason: "No documents attached to the submission." };
  if (results.some((r) => r.verification_status === "REJECTED"))
    return { status: "REJECTED", reason: "At least one document was rejected as inauthentic." };
  if (results.some((r) => r.verification_status === "PENDING_MANUAL_REVIEW"))
    return { status: "PENDING_MANUAL_REVIEW", reason: "One or more documents require manual review." };
  return { status: "VERIFIED", reason: "All attached documents passed automated verification." };
}
