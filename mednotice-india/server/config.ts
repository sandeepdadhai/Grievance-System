import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Project root. `npm start` and `npm run dev` both run from the repository root. */
export const ROOT = process.env.PROJECT_ROOT ? path.resolve(process.env.PROJECT_ROOT) : process.cwd();
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
export const STORAGE_DIR = path.join(DATA_DIR, "storage");
export const OUTBOX_DIR = path.join(DATA_DIR, "outbox");
export const PORT = Number(process.env.PORT ?? 4100);
export const IS_PROD = process.env.NODE_ENV === "production";
export const SESSION_COOKIE = "mni_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

/**
 * Cron-style dispatch worker. `DISPATCH_CRON_ENABLED=0` turns the worker off
 * (used by the test suite, which drives the cycles explicitly).
 */
export const DISPATCH_CRON_ENABLED = process.env.DISPATCH_CRON_ENABLED !== "0";
export const DISPATCH_INTERVAL_MS = Math.max(5_000, Number(process.env.DISPATCH_INTERVAL_MS ?? 60_000));
export const STATUS_SYNC_INTERVAL_MS = Math.max(10_000, Number(process.env.STATUS_SYNC_INTERVAL_MS ?? 300_000));
/** A failed transmission is retried by the dispatcher after this delay. */
export const DISPATCH_RETRY_DELAY_MS = Math.max(30_000, Number(process.env.DISPATCH_RETRY_DELAY_MS ?? 300_000));
/** Maximum number of dispatcher attempts for a single case. */
export const DISPATCH_MAX_ATTEMPTS = Math.max(1, Number(process.env.DISPATCH_MAX_ATTEMPTS ?? 3));
/** Timeout for a single authority status request. */
export const STATUS_REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.STATUS_REQUEST_TIMEOUT_MS ?? 10_000));

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

/**
 * MedNotice India tenancy registry. The platform is India-only: every case is
 * scoped to the Indian Union and routed to a national authority or to the
 * health department of the state in which the facility is registered.
 */
export const JURISDICTIONS: Jurisdiction[] = [
  {
    code: "IN",
    name: "India",
    flag: "🇮🇳",
    regulator: "Ministry of Health and Family Welfare (MoHFW)",
    frameworks: [
      "Digital Personal Data Protection Act 2023",
      "Clinical Establishments (Registration and Regulation) Act 2010",
      "Charter of Patients' Rights 2021",
      "National Medical Commission Act 2019",
      "Consumer Protection Act 2019",
    ],
    locale: "en-IN",
    languages: ["en", "hi", "mr", "kn", "ta", "bn"],
    retentionDays: 1095,
    slaHours: { P1: 2, P2: 12, P3: 48, P4: 168 },
    crossBorderRestricted: true,
    complaintCategories: UNIVERSAL_CATEGORIES,
    authorities: [
      {
        id: "IN-MOHFW",
        name: "Ministry of Health and Family Welfare",
        region: "National",
        adapter: "IN-FHIR",
        contactEmail: "grievance-mohfw@gov.in",
        webhook: "https://sandbox.mednotice.in/mohfw/cases",
      },
      {
        id: "IN-NHA",
        name: "National Health Authority (ABDM)",
        region: "National",
        adapter: "IN-REST",
        contactEmail: "grievance@nha.gov.in",
        webhook: "https://sandbox.mednotice.in/nha/grievance",
      },
      {
        id: "IN-SHA-DL",
        name: "Directorate of Health Services, Delhi",
        region: "Delhi",
        adapter: "IN-REST-DL",
        contactEmail: "dhsdelhi@nic.in",
        webhook: "https://sandbox.mednotice.in/dl/health/cases",
      },
      {
        id: "IN-SHA-MH",
        name: "Public Health Department, Maharashtra",
        region: "Maharashtra",
        adapter: "IN-HL7-MH",
        contactEmail: "grievance.publichealth@maharashtra.gov.in",
        webhook: "https://sandbox.mednotice.in/mh/health/cases",
      },
      {
        id: "IN-SHA-KA",
        name: "Health and Family Welfare Department, Karnataka",
        region: "Karnataka",
        adapter: "IN-REST-KA",
        contactEmail: "commissioner.hfw@karnataka.gov.in",
        webhook: "https://sandbox.mednotice.in/ka/health/cases",
      },
      {
        id: "IN-SHA-TN",
        name: "Health and Family Welfare Department, Tamil Nadu",
        region: "Tamil Nadu",
        adapter: "IN-REST-TN",
        contactEmail: "dph@tn.gov.in",
        webhook: "https://sandbox.mednotice.in/tn/health/cases",
      },
    ],
  },
];

export function findJurisdiction(code: string): Jurisdiction | undefined {
  return JURISDICTIONS.find((j) => j.code === code.toUpperCase());
}

export const PRIORITIES: Priority[] = ["P1", "P2", "P3", "P4"];

export const PRIORITY_LABELS: Record<Priority, string> = {
  P1: "Critical / Emergency",
  P2: "High / Urgent",
  P3: "Medium / Standard",
  P4: "Low / Informational",
};
