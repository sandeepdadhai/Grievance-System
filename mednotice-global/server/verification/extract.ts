import type { ExtractedFields } from "./types.js";

function normalizeName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\^/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 3) return undefined;
  return cleaned
    .split(" ")
    .map((p) => (p.length > 2 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toUpperCase()))
    .join(" ");
}

function normalizeDate(y: string, m: string, d: string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function extractFields(text: string, country = "US", dicom: Record<string, string> = {}): ExtractedFields {
  const flat = text.replace(/\r/g, "\n").replace(/[ \t]{2,}/g, " ").slice(0, 200_000);

  const patientRaw =
    dicom.PatientName ??
    flat.match(/(?:patient(?:'s)?[ \t]*(?:full[ \t]*)?name|patient)[ \t]*[:\-][ \t]*([A-Z][A-Za-z'’.-]+(?:[ \t]+[A-Z][A-Za-z'’.-]+){0,3})/i)?.[1];
  const physicianRaw =
    flat.match(/(?:treating|attending|responsible|consulting)?[ \t]*(?:physician|doctor|surgeon|clinician)[ \t]*[:\-][ \t]*((?:Dr\.?[ \t]+)?[A-Z][A-Za-z'’.-]+(?:[ \t]+[A-Z][A-Za-z'’.-]+){0,2})/i)?.[1] ??
    flat.match(/\bDr\.?[ \t]+([A-Z][A-Za-z'’.-]+(?:[ \t]+[A-Z][A-Za-z'’.-]+){0,2})/)?.[1];

  const licenseRaw =
    flat.match(/(?:medical\s+)?(?:license|licence|registration|reg(?:istration)?\.?)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z]{0,4}[-\s]?[A-Z0-9][A-Z0-9\-/]{3,20})/i)?.[1] ??
    flat.match(/\bNPI\s*[:\-]?\s*(\d{10})\b/i)?.[1];
  const npi = flat.match(/\bNPI\s*[:\-]?\s*(\d{10})\b/i)?.[1];

  const diagnosisRaw =
    flat.match(/(?:diagnosis|icd(?:-?\s*1[01])?|dx)\s*(?:code)?\s*[:\-]\s*([A-TV-Z0-9][A-Z0-9.]{1,10})/i)?.[1] ??
    flat.match(/\b([A-TV-Z][0-9]{2}\.[0-9A-Z]{1,4})\b/)?.[1] ??
    flat.match(/\b([1-9][0-9]?[A-Z][0-9]{2}(?:\.[0-9A-Z]{1,3})?)\b/)?.[1];

  const facilityRaw =
    dicom.InstitutionName ??
    flat.match(
      /((?:[A-Z][A-Za-z&.'’()-]+[ \t]+){0,5}(?:Hospital|Medical[ \t]+Center|Medical[ \t]+Centre|Clinic|Health[ \t]+System|Healthcare|Klinik|Krankenhaus|Infirmary|Polyclinic|Universitaetsklinikum|Universitätsklinikum))/,
    )?.[1];

  const mrn = flat.match(/\b(?:MRN|medical record(?: number)?|patient\s*id)\s*[:\s#]*([A-Z0-9][A-Z0-9-]{3,})\b/i)?.[1];

  const dates = new Set<string>();
  const labeled = [...flat.matchAll(/(?:date of service|service date|admission date|discharge date|date of visit|dos|visit date)\s*[:\-]?\s*([0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4})/gi)];
  for (const m of labeled) {
    const parts = m[1].split(/[./-]/);
    if (parts.length !== 3) continue;
    let iso: string | null = null;
    if (parts[0].length === 4) iso = normalizeDate(parts[0], parts[1], parts[2]);
    else if (country === "US") iso = normalizeDate(parts[2], parts[0], parts[1]);
    else iso = normalizeDate(parts[2], parts[1], parts[0]);
    if (iso) dates.add(iso);
  }
  for (const m of flat.matchAll(/\b(20[0-9]{2})-([01][0-9])-([0-3][0-9])\b/g)) {
    const iso = normalizeDate(m[1], m[2], m[3]);
    if (iso) dates.add(iso);
  }
  if (dicom.StudyDate && /^\d{8}$/.test(dicom.StudyDate)) {
    const iso = normalizeDate(dicom.StudyDate.slice(0, 4), dicom.StudyDate.slice(4, 6), dicom.StudyDate.slice(6, 8));
    if (iso) dates.add(iso);
  }

  return {
    patientName: normalizeName(patientRaw),
    physicianName: physicianRaw ? normalizeName(physicianRaw.replace(/^Dr\.?\s+/i, "")) : undefined,
    physicianLicense: licenseRaw?.trim().toUpperCase(),
    npi,
    diagnosisCode: diagnosisRaw?.toUpperCase(),
    facilityName: facilityRaw?.trim(),
    datesOfService: [...dates].sort(),
    mrn,
    textLength: flat.replace(/\s/g, "").length,
  };
}

export function mergeExtracted(a: ExtractedFields, b: ExtractedFields): ExtractedFields {
  return {
    patientName: a.patientName ?? b.patientName,
    physicianName: a.physicianName ?? b.physicianName,
    physicianLicense: a.physicianLicense ?? b.physicianLicense,
    npi: a.npi ?? b.npi,
    diagnosisCode: a.diagnosisCode ?? b.diagnosisCode,
    facilityName: a.facilityName ?? b.facilityName,
    datesOfService: [...new Set([...a.datesOfService, ...b.datesOfService])].sort(),
    mrn: a.mrn ?? b.mrn,
    textLength: Math.max(a.textLength, b.textLength),
  };
}
