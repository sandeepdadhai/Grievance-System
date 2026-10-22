import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Project root. `npm start` and `npm run dev` both run from the repository root. */
export const ROOT = process.env.PROJECT_ROOT ? path.resolve(process.env.PROJECT_ROOT) : process.cwd();
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
export const STORAGE_DIR = path.join(DATA_DIR, "storage");
export const OUTBOX_DIR = path.join(DATA_DIR, "outbox");
export const PORT = Number(process.env.PORT ?? 4000);
export const IS_PROD = process.env.NODE_ENV === "production";
export const SESSION_COOKIE = "mn_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

for (const dir of [DATA_DIR, STORAGE_DIR, OUTBOX_DIR]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Master key for field-level encryption at rest (AES-256-GCM).
 * In production supply MASTER_KEY (base64, 32 bytes) from a KMS/secret store.
 * For local/demo runs a key is generated once with 0600 permissions.
 */
function loadMasterKey(): Buffer {
  const fromEnv = process.env.MASTER_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length !== 32) throw new Error("MASTER_KEY must be base64-encoded 32 bytes");
    return key;
  }
  const keyFile = path.join(DATA_DIR, ".master.key");
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  return key;
}

export const MASTER_KEY = loadMasterKey();

export type Priority = "P1" | "P2" | "P3" | "P4";

export type Authority = {
  id: string;
  name: string;
  region: string;
  adapter: string;
  contactEmail: string;
  webhook: string;
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
  authorities: Authority[];
  complaintCategories: string[];
};

const UNIVERSAL_CATEGORIES = [
  "Negligence",
  "Billing Fraud",
  "Denial of Care",
  "Infrastructure/Facility Issue",
  "Prescription Error",
  "Data Privacy",
  "Discrimination",
  "Other",
];

/** Tenancy registry. Adding a jurisdiction/authority is configuration-only. */
export const JURISDICTIONS: Jurisdiction[] = [
  {
    code: "US",
    name: "United States",
    flag: "🇺🇸",
    regulator: "HHS Office for Civil Rights",
    frameworks: ["HIPAA", "HITECH", "EMTALA", "42 CFR Part 2"],
    locale: "en-US",
    languages: ["en"],
    retentionDays: 2555,
    slaHours: { P1: 1, P2: 4, P3: 24, P4: 72 },
    crossBorderRestricted: true,
    complaintCategories: UNIVERSAL_CATEGORIES,
    authorities: [
      {
        id: "US-CMS",
        name: "Centers for Medicare & Medicaid Services",
        region: "Federal",
        adapter: "US-FHIR",
        contactEmail: "complaints@cms.hhs.gov",
        webhook: "https://sandbox.mednotice.local/cms/cases",
      },
      {
        id: "US-NY-DOH",
        name: "New York State Department of Health",
        region: "New York",
        adapter: "US-REST",
        contactEmail: "patientcomplaints@health.ny.gov",
        webhook: "https://sandbox.mednotice.local/ny-doh/cases",
      },
    ],
  },
  {
    code: "DE",
    name: "Germany",
    flag: "🇩🇪",
    regulator: "Bundesministerium für Gesundheit",
    frameworks: ["GDPR", "BDSG", "SGB V"],
    locale: "de-DE",
    languages: ["de", "en"],
    retentionDays: 1825,
    slaHours: { P1: 2, P2: 8, P3: 48, P4: 120 },
    crossBorderRestricted: true,
    complaintCategories: UNIVERSAL_CATEGORIES,
    authorities: [
      {
        id: "DE-BMG",
        name: "Bundesministerium für Gesundheit",
        region: "Bund",
        adapter: "DE-REST",
        contactEmail: "beschwerden@bundesgesundheitsministerium.de",
        webhook: "https://sandbox.mednotice.local/bmg/cases",
      },
      {
        id: "DE-BERLIN",
        name: "Senatsverwaltung für Wissenschaft, Gesundheit (Berlin)",
        region: "Berlin",
        adapter: "EU-FHIR",
        contactEmail: "patientenbeauftragte@senwgpg.berlin.de",
        webhook: "https://sandbox.mednotice.local/berlin/cases",
      },
    ],
  },
  {
    code: "GB",
    name: "United Kingdom",
    flag: "🇬🇧",
    regulator: "Care Quality Commission",
    frameworks: ["UK GDPR", "Data Protection Act 2018", "NHS Constitution"],
    locale: "en-GB",
    languages: ["en"],
    retentionDays: 2190,
    slaHours: { P1: 1, P2: 4, P3: 24, P4: 96 },
    crossBorderRestricted: true,
    complaintCategories: UNIVERSAL_CATEGORIES,
    authorities: [
      {
        id: "GB-CQC",
        name: "Care Quality Commission",
        region: "England",
        adapter: "UK-FHIR",
        contactEmail: "enquiries@cqc.org.uk",
        webhook: "https://sandbox.mednotice.local/cqc/cases",
      },
    ],
  },
  {
    code: "IN",
    name: "India",
    flag: "🇮🇳",
    regulator: "National Health Authority (ABDM)",
    frameworks: ["DPDP Act 2023", "Clinical Establishments Act"],
    locale: "en-IN",
    languages: ["en", "hi"],
    retentionDays: 1095,
    slaHours: { P1: 2, P2: 12, P3: 48, P4: 168 },
    crossBorderRestricted: true,
    complaintCategories: UNIVERSAL_CATEGORIES,
    authorities: [
      {
        id: "IN-NHA",
        name: "National Health Authority",
        region: "National Capital Region",
        adapter: "IN-REST",
        contactEmail: "grievance@nha.gov.in",
        webhook: "https://sandbox.mednotice.local/nha/cases",
      },
    ],
  },
  {
    code: "SG",
    name: "Singapore",
    flag: "🇸🇬",
    regulator: "Ministry of Health",
    frameworks: ["PDPA", "Private Hospitals and Medical Clinics Act"],
    locale: "en-SG",
    languages: ["en"],
    retentionDays: 2190,
    slaHours: { P1: 1, P2: 6, P3: 36, P4: 96 },
    crossBorderRestricted: false,
    complaintCategories: UNIVERSAL_CATEGORIES,
    authorities: [
      {
        id: "SG-MOH",
        name: "Ministry of Health Singapore",
        region: "National",
        adapter: "SG-HL7",
        contactEmail: "moh_feedback@moh.gov.sg",
        webhook: "https://sandbox.mednotice.local/moh/cases",
      },
    ],
  },
  {
    code: "BR",
    name: "Brazil",
    flag: "🇧🇷",
    regulator: "Agência Nacional de Saúde Suplementar",
    frameworks: ["LGPD", "ANS Normative Resolutions"],
    locale: "pt-BR",
    languages: ["pt", "en"],
    retentionDays: 1825,
    slaHours: { P1: 2, P2: 8, P3: 48, P4: 120 },
    crossBorderRestricted: true,
    complaintCategories: UNIVERSAL_CATEGORIES,
    authorities: [
      {
        id: "BR-ANS",
        name: "Agência Nacional de Saúde Suplementar",
        region: "Nacional",
        adapter: "BR-SOAP",
        contactEmail: "gabinete@ans.gov.br",
        webhook: "https://sandbox.mednotice.local/ans/cases",
      },
    ],
  },
];

export function findJurisdiction(code: string): Jurisdiction | undefined {
  return JURISDICTIONS.find((j) => j.code === code.toUpperCase());
}

export function findAuthority(id: string): { jurisdiction: Jurisdiction; authority: Authority } | undefined {
  for (const jurisdiction of JURISDICTIONS) {
    const authority = jurisdiction.authorities.find((a) => a.id === id);
    if (authority) return { jurisdiction, authority };
  }
  return undefined;
}

export const PRIORITIES: Priority[] = ["P1", "P2", "P3", "P4"];

export const PRIORITY_LABELS: Record<Priority, string> = {
  P1: "Critical / Emergency",
  P2: "High / Urgent",
  P3: "Medium / Standard",
  P4: "Low / Informational",
};
