import { all, count, get, nowIso, run, tx } from "./db.js";
import { audit } from "./audit.js";
import { encryptField, hashPassword, maskEmail, maskName, randomCode, sha256Hex } from "./crypto.js";
import { findJurisdiction } from "./config.js";
import { findAuthority, getFacility, seedAuthorities } from "./registry.js";
import { triage } from "./triage.js";
import { seedRoles } from "./roles.js";
import type { Finding } from "./verification/types.js";

type SeedUser = {
  id: string;
  email: string;
  name: string;
  password: string;
  role: string;
  country: string | null;
  organisation: string | null;
};

const USERS: SeedUser[] = [
  { id: "USR-ADMIN", email: "admin@mednotice.demo", name: "Ava Lindqvist", password: "Admin!2345", role: "SUPER_ADMIN", country: null, organisation: "MedNotice-Global" },
  { id: "USR-MINISTRY", email: "reviewer@ministry.demo", name: "Dr. Jonas Brandt", password: "Review!2345", role: "MINISTRY_REVIEWER", country: "DE", organisation: "Bundesministerium für Gesundheit" },
  { id: "USR-HOSPITAL", email: "compliance@hospital.demo", name: "Nadia Okafor", password: "Comply!2345", role: "HOSPITAL_COMPLIANCE", country: "US", organisation: "St. Mary's General Hospital" },
  { id: "USR-AUDITOR", email: "auditor@mednotice.demo", name: "Kenji Watanabe", password: "Audit!2345", role: "SYSTEM_AUDITOR", country: null, organisation: "MedNotice-Global" },
  { id: "USR-PATIENT", email: "patient@demo.io", name: "Maria Santos", password: "Patient!2345", role: "PATIENT", country: "US", organisation: null },
  { id: "USR-PATIENT-DE", email: "lena.hoffmann@demo.io", name: "Lena Hoffmann", password: "Patient!2345", role: "PATIENT", country: "DE", organisation: null },
];

type FacilityAccount = {
  id: string;
  email: string;
  name: string;
  password: string;
  facilityId: string;
};

/**
 * Facility-bound compliance logins. Each account is tied to exactly one
 * facility: it only sees the cases filed against that facility and can verify
 * the uploaded evidence and resolve those cases. Seeded idempotently so
 * existing databases pick the accounts up on the next boot.
 */
const FACILITY_ACCOUNTS: FacilityAccount[] = [
  { id: "USR-FAC-STMARYS", email: "facility.stmarys@mednotice.global", name: "Nadia Okafor", password: "Facility!2345", facilityId: "FAC-US-001" },
  { id: "USR-FAC-CHARITE", email: "facility.charite@mednotice.global", name: "Lukas Weber", password: "Facility!2345", facilityId: "FAC-DE-001" },
  { id: "USR-FAC-AIIMS", email: "facility.aiims@mednotice.global", name: "Priya Nair", password: "Facility!2345", facilityId: "FAC-IN-001" },
];

export async function seedFacilityAccounts(): Promise<void> {
  for (const account of FACILITY_ACCOUNTS) {
    if (get("SELECT id FROM users WHERE email = ? OR id = ?", account.email, account.id)) continue;
    const facility = getFacility(account.facilityId);
    if (!facility) continue;
    run(
      `INSERT INTO users (id, email, name, password_hash, role, country, organisation, facility_id, active, mfa_enabled, created_at)
       VALUES (?, ?, ?, ?, 'HOSPITAL_COMPLIANCE', ?, ?, ?, 1, 0, ?)`,
      account.id,
      account.email,
      account.name,
      await hashPassword(account.password),
      facility.country,
      facility.name,
      facility.id,
      nowIso(),
    );
  }
}

const FACILITIES: Array<{ id: string; name: string; authorityId: string; country: string; city: string; keywords: string[]; status?: string }> = [
  { id: "FAC-US-001", name: "St. Mary's General Hospital", authorityId: "US-CMS", country: "US", city: "New York", keywords: ["St. Mary's General Hospital", "500 West 42nd Street", "Joint Commission"] },
  { id: "FAC-US-002", name: "Mount Sinai Medical Center", authorityId: "US-NY-DOH", country: "US", city: "New York", keywords: ["Mount Sinai Medical Center", "One Gustave L. Levy Place"] },
  { id: "FAC-US-003", name: "Cedars-Sinai Medical Center", authorityId: "US-CMS", country: "US", city: "Los Angeles", keywords: ["Cedars-Sinai Medical Center", "8700 Beverly Boulevard"] },
  { id: "FAC-DE-001", name: "Charité Universitätsmedizin Berlin", authorityId: "DE-BERLIN", country: "DE", city: "Berlin", keywords: ["Charité", "Charitéplatz 1", "Universitätsmedizin Berlin"] },
  { id: "FAC-DE-002", name: "Klinikum rechts der Isar", authorityId: "DE-BMG", country: "DE", city: "München", keywords: ["Klinikum rechts der Isar", "Ismaninger Straße 22"] },
  { id: "FAC-GB-001", name: "St Thomas' Hospital", authorityId: "GB-CQC", country: "GB", city: "London", keywords: ["St Thomas' Hospital", "Westminster Bridge Road", "Guy's and St Thomas'"] },
  { id: "FAC-IN-001", name: "All India Institute of Medical Sciences", authorityId: "IN-MOHFW", country: "IN", city: "New Delhi", keywords: ["All India Institute of Medical Sciences", "AIIMS", "Ansari Nagar"] },
  { id: "FAC-IN-002", name: "Safdarjung Hospital", authorityId: "IN-SHA-DL", country: "IN", city: "New Delhi", keywords: ["Safdarjung Hospital", "Vardhman Mahavir Medical College", "Ansari Nagar West"] },
  { id: "FAC-IN-003", name: "King Edward Memorial Hospital", authorityId: "IN-SHA-MH", country: "IN", city: "Mumbai", keywords: ["King Edward Memorial Hospital", "KEM Hospital", "Parel"] },
  { id: "FAC-IN-004", name: "National Institute of Mental Health and Neurosciences", authorityId: "IN-SHA-KA", country: "IN", city: "Bengaluru", keywords: ["National Institute of Mental Health and Neurosciences", "NIMHANS", "Hosur Road"] },
  { id: "FAC-IN-005", name: "Apollo Hospitals", authorityId: "IN-SHA-TN", country: "IN", city: "Chennai", keywords: ["Apollo Hospitals", "Greams Road", "Apollo"] },
  { id: "FAC-SG-001", name: "Singapore General Hospital", authorityId: "SG-MOH", country: "SG", city: "Singapore", keywords: ["Singapore General Hospital", "Outram Road"] },
  { id: "FAC-BR-001", name: "Hospital das Clínicas da FMUSP", authorityId: "BR-ANS", country: "BR", city: "São Paulo", keywords: ["Hospital das Clínicas", "Av. Dr. Enéas de Carvalho Aguiar"] },
];

const LICENSES: Array<{ no: string; name: string; jurisdiction: string; status: string; expires: string; facility: string }> = [
  { no: "NY-48291", name: "Alan Reyes", jurisdiction: "US", status: "ACTIVE", expires: "2028-05-01", facility: "FAC-US-001" },
  { no: "NY-11902", name: "Miriam Cole", jurisdiction: "US", status: "REVOKED", expires: "2026-01-15", facility: "FAC-US-001" },
  { no: "DE-77120", name: "Katharina Vogel", jurisdiction: "DE", status: "ACTIVE", expires: "2027-09-30", facility: "FAC-DE-001" },
  { no: "GMC-7712345", name: "Simon Whitaker", jurisdiction: "GB", status: "ACTIVE", expires: "2027-03-31", facility: "FAC-GB-001" },
  { no: "IN-KA-99112", name: "Rohan Mehta", jurisdiction: "IN", status: "ACTIVE", expires: "2026-12-31", facility: "FAC-IN-001" },
  { no: "SG-MBBS-44120", name: "Wei Lin Tan", jurisdiction: "SG", status: "ACTIVE", expires: "2028-01-31", facility: "FAC-SG-001" },
  { no: "CRM-88231", name: "Beatriz Almeida", jurisdiction: "BR", status: "SUSPENDED", expires: "2027-06-30", facility: "FAC-BR-001" },
  { no: "NY-33017", name: "Peter Lang", jurisdiction: "US", status: "EXPIRED", expires: "2025-02-28", facility: "FAC-US-002" },
];

const ADAPTERS: Array<{ code: string; name: string; country: string; kind: string; endpoint: string; mapping?: Record<string, unknown> }> = [
  { code: "US-FHIR", name: "CMS FHIR R4 ingestion", country: "US", kind: "FHIR", endpoint: "https://sandbox.mednotice.local/us/fhir/R4" },
  {
    code: "US-REST",
    name: "New York DOH REST intake",
    country: "US",
    kind: "REST",
    endpoint: "https://sandbox.mednotice.local/us/ny-doh/complaints",
    mapping: {
      envelope: {
        case_reference: "{{caseId}}",
        received_at: "{{createdAt}}",
        jurisdiction: "US-NY",
        facility: { name: "{{facilityName}}" },
        severity: { code: "{{priority}}", score: "{{priorityScore}}" },
        classification: "{{category}}",
        narrative: "{{complaint}}",
        verification: "{{verificationStatus}}",
        complainant: { name: "{{patientName}}", email: "{{patientEmail}}" },
        attachments: "{{documentCount}}",
        pii_masked: "{{masked}}",
      },
    },
  },
  {
    code: "DE-REST",
    name: "BMG Beschwerde-Schnittstelle",
    country: "DE",
    kind: "REST",
    endpoint: "https://sandbox.mednotice.local/de/bmg/beschwerden",
    mapping: {
      envelope: {
        Fallreferenz: "{{caseId}}",
        Jurisdiktion: "{{country}}",
        Einrichtung: "{{facilityName}}",
        Prioritaet: "{{priority}}",
        Kategorie: "{{category}}",
        Sachverhalt: "{{complaint}}",
        Symptome: "{{symptoms}}",
        Verifikationsstatus: "{{verificationStatus}}",
        Beschwerdefuehrer: { Name: "{{patientName}}", "E-Mail": "{{patientEmail}}" },
        Dokumente: "{{documentCount}}",
        Zeitstempel: "{{createdAt}}",
        PII_maskiert: "{{masked}}",
      },
    },
  },
  { code: "EU-FHIR", name: "Berlin Senate FHIR endpoint", country: "DE", kind: "FHIR", endpoint: "https://sandbox.mednotice.local/eu/fhir/R4" },
  { code: "UK-FHIR", name: "CQC FHIR endpoint", country: "GB", kind: "FHIR", endpoint: "https://sandbox.mednotice.local/uk/fhir/R4" },
  {
    code: "IN-REST",
    name: "NHA grievance API",
    country: "IN",
    kind: "REST",
    endpoint: "https://sandbox.mednotice.local/in/nha/grievance",
    mapping: {
      envelope: {
        grievance_id: "{{caseId}}",
        facility_name: "{{facilityName}}",
        priority: "{{priority}}",
        category: "{{category}}",
        details: "{{complaint}}",
        patient: { name: "{{patientName}}", contact: "{{patientEmail}}" },
        submitted_at: "{{createdAt}}",
      },
    },
  },
  { code: "SG-HL7", name: "MOH HL7 v2 feed", country: "SG", kind: "HL7v2", endpoint: "https://sandbox.mednotice.local/sg/hl7/inbound" },
  {
    code: "BR-SOAP",
    name: "ANS reclamação SOAP",
    country: "BR",
    kind: "SOAP",
    endpoint: "https://sandbox.mednotice.local/br/ans/soap",
    mapping: { operation: "RegistrarReclamacao", namespace: "urn:ans:reclamacao:v2" },
  },
];

type SeedFinding = Finding;

type SeedDoc = {
  filename: string;
  mime: string;
  kind: string;
  size: number;
  status: string;
  score: number;
  findings: SeedFinding[];
  extracted: Record<string, unknown>;
  note?: string;
};

type SeedCase = {
  daysAgo: number;
  country: string;
  authorityId: string;
  facilityId: string;
  patientName: string;
  patientEmail: string;
  complaint: string;
  symptoms: string;
  category: string;
  declaredPriority?: string;
  status: string;
  verification: string;
  incidentDaysAgo: number;
  assignedTo?: string;
  resolvedDaysAgo?: number;
  docs: SeedDoc[];
  language?: string;
};

const finding = (code: string, label: string, severity: SeedFinding["severity"], detail: string, weight: number, category: SeedFinding["category"] = "integrity"): SeedFinding => ({
  code,
  label,
  severity,
  detail,
  weight,
  category,
});

const SEED_CASES: SeedCase[] = [
  {
    daysAgo: 1.2,
    country: "US",
    authorityId: "US-CMS",
    facilityId: "FAC-US-001",
    patientName: "Maria Santos",
    patientEmail: "patient@demo.io",
    complaint:
      "My husband was brought to the emergency department with crushing chest pain at 21:40. He waited more than three hours without an ECG. At 01:15 he went into cardiac arrest and could not be resuscitated. The triage nurse told us the emergency room was short-staffed and to keep waiting. He died the same night.",
    symptoms: "Crushing substernal chest pain, diaphoresis, shortness of breath; patient became unresponsive in the waiting room.",
    category: "Negligence",
    status: "ROUTED",
    verification: "VERIFIED",
    incidentDaysAgo: 2,
    assignedTo: "USR-HOSPITAL",
    docs: [
      {
        filename: "ed_triage_record.pdf",
        mime: "application/pdf",
        kind: "PDF",
        size: 482_119,
        status: "VERIFIED",
        score: 92,
        findings: [finding("PDF_SIGNED", "Digital signature container present", "info", "Hospital EHR signature dictionary present.", 8), finding("LICENSE_ACTIVE", "Active physician licence confirmed", "info", "Licence NY-48291 verified against NY State registry.", 10, "registry")],
        extracted: { patientName: "Daniel Santos", physicianName: "Alan Reyes", physicianLicense: "NY-48291", diagnosisCode: "I21.4", facilityName: "St. Mary's General Hospital", datesOfService: ["2026-10-19"], mrn: "MRN-882134", textLength: 4210 },
      },
      {
        filename: "discharge_summary.pdf",
        mime: "application/pdf",
        kind: "PDF",
        size: 221_400,
        status: "VERIFIED",
        score: 88,
        findings: [finding("FACILITY_MATCH", "Facility matches complaint target", "info", "Letterhead matches St. Mary's General Hospital.", 6, "registry")],
        extracted: { patientName: "Daniel Santos", physicianName: "Alan Reyes", physicianLicense: "NY-48291", diagnosisCode: "I21.4", facilityName: "St. Mary's General Hospital", datesOfService: ["2026-10-19", "2026-10-20"], textLength: 2890 },
      },
    ],
  },
  {
    daysAgo: 0.4,
    country: "DE",
    authorityId: "DE-BERLIN",
    facilityId: "FAC-DE-001",
    patientName: "Lena Hoffmann",
    patientEmail: "lena.hoffmann@demo.io",
    complaint:
      "Ich war in der 34. Schwangerschaftswoche und hatte starke Blutungen. Die Notaufnahme der Charité hat mich abgewiesen und an eine andere Klinik verwiesen, obwohl ich dort vorstellig war. Die Blutung hielt über eine Stunde an, ich wurde erst nach zwei Stunden in einem anderen Krankenhaus behandelt. Es bestand Lebensgefahr für mich und das Kind.",
    symptoms: "Starke vaginale Blutung in der 34. Schwangerschaftswoche, Schwindel, Kreislaufbeschwerden.",
    category: "Denial of Care",
    status: "PENDING_REVIEW",
    verification: "PENDING_MANUAL_REVIEW",
    incidentDaysAgo: 1,
    assignedTo: "USR-MINISTRY",
    language: "de",
    docs: [
      {
        filename: "notaufnahme_bericht.pdf",
        mime: "application/pdf",
        kind: "PDF",
        size: 318_000,
        status: "PENDING_MANUAL_REVIEW",
        score: 61,
        findings: [
          finding("PDF_PRODUCER_MISMATCH", "Non-clinical authoring software", "high", 'Metadata names "Microsoft Word 2019" rather than a clinical records system.', -18, "metadata"),
          finding("PDF_INCREMENTAL_UPDATES", "3 incremental revisions detected", "high", "Document was re-saved twice after issuance.", -24),
          finding("LICENSE_ACTIVE", "Active physician licence confirmed", "info", "Licence DE-77120 verified.", 10, "registry"),
        ],
        extracted: { patientName: "Lena Hoffmann", physicianName: "Katharina Vogel", physicianLicense: "DE-77120", diagnosisCode: "O44.1", facilityName: "Charité Universitätsmedizin Berlin", datesOfService: ["2026-10-20"], textLength: 3120 },
        note: "Manual review requested: word-processor provenance and multiple revisions.",
      },
      {
        filename: "aufnahme_foto.jpg",
        mime: "image/jpeg",
        kind: "JPEG",
        size: 1_940_220,
        status: "PENDING_MANUAL_REVIEW",
        score: 58,
        findings: [finding("IMAGE_EDITOR_METADATA", "Image-editing software detected", "high", 'Metadata references "Adobe Photoshop", an image manipulation tool.', -30, "metadata")],
        extracted: { patientName: "Lena Hoffmann", facilityName: "Charité", datesOfService: ["2026-10-20"], textLength: 0 },
        note: "Screenshot was re-encoded before upload.",
      },
    ],
  },
  {
    daysAgo: 3.5,
    country: "US",
    authorityId: "US-NY-DOH",
    facilityId: "FAC-US-002",
    patientName: "Andre Whitfield",
    patientEmail: "andre.whitfield@example.com",
    complaint:
      "I was billed twice for the same MRI and charged for a consultation I never received. The invoice shows $12,400 for a procedure that my insurance already paid in full. The billing office keeps sending the account to a debt collector and refuses to provide an itemised statement.",
    symptoms: "No clinical symptoms; billing dispute following an outpatient MRI.",
    category: "Billing Fraud",
    status: "ROUTED",
    verification: "VERIFIED",
    incidentDaysAgo: 21,
    docs: [
      {
        filename: "itemised_invoice.pdf",
        mime: "application/pdf",
        kind: "PDF",
        size: 88_500,
        status: "VERIFIED",
        score: 84,
        findings: [finding("FACILITY_MATCH", "Facility matches complaint target", "info", "Invoice header matches Mount Sinai Medical Center.", 6, "registry")],
        extracted: { patientName: "Andre Whitfield", facilityName: "Mount Sinai Medical Center", diagnosisCode: "Z12.31", datesOfService: ["2026-09-29"], textLength: 1560 },
      },
    ],
  },
  {
    daysAgo: 5.1,
    country: "GB",
    authorityId: "GB-CQC",
    facilityId: "FAC-GB-001",
    patientName: "Priya Nair",
    patientEmail: "priya.nair@example.co.uk",
    complaint:
      "I was given ten times my prescribed insulin dose by the ward nurse. I became severely hypoglycaemic and was unconscious for several hours before treatment. I now have ongoing memory problems and have been signed off work. The trust has not explained how the medication error happened.",
    symptoms: "Severe hypoglycaemia, loss of consciousness, ongoing cognitive impairment.",
    category: "Prescription Error",
    status: "UNDER_REVIEW",
    verification: "VERIFIED",
    incidentDaysAgo: 12,
    docs: [
      {
        filename: "medication_chart.pdf",
        mime: "application/pdf",
        kind: "PDF",
        size: 190_220,
        status: "VERIFIED",
        score: 90,
        findings: [finding("LICENSE_ACTIVE", "Active physician licence confirmed", "info", "GMC licence verified.", 10, "registry")],
        extracted: { patientName: "Priya Nair", physicianName: "Simon Whitaker", physicianLicense: "GMC-7712345", diagnosisCode: "E11.649", facilityName: "St Thomas' Hospital", datesOfService: ["2026-10-08", "2026-10-09"], textLength: 2200 },
      },
    ],
  },
  {
    daysAgo: 7.8,
    country: "IN",
    authorityId: "IN-NHA",
    facilityId: "FAC-IN-001",
    patientName: "Arjun Patel",
    patientEmail: "arjun.patel@example.in",
    complaint:
      "The ward my father was admitted to had no working ventilator and the staff said the equipment had been broken for two weeks. There was no clean bedding and the toilet was overflowing. He developed a severe infection during the stay and had to be moved to intensive care.",
    symptoms: "Hospital-acquired infection, respiratory distress requiring ICU transfer.",
    category: "Infrastructure/Facility Issue",
    status: "ROUTED",
    verification: "VERIFIED",
    incidentDaysAgo: 16,
    docs: [
      {
        filename: "ward_photo.png",
        mime: "image/png",
        kind: "PNG",
        size: 2_400_120,
        status: "VERIFIED",
        score: 80,
        findings: [finding("IMAGE_TRAILING_DATA", "No appended data", "info", "PNG structure is clean.", 0)],
        extracted: { facilityName: "All India Institute of Medical Sciences", datesOfService: ["2026-10-03"], textLength: 0 },
      },
    ],
  },
  {
    daysAgo: 12.4,
    country: "SG",
    authorityId: "SG-MOH",
    facilityId: "FAC-SG-001",
    patientName: "Grace Lim",
    patientEmail: "grace.lim@example.sg",
    complaint:
      "My medical records were shared with my employer's HR department without my consent. I never signed any authorisation and the clinic has not explained who accessed my file. I am worried my diagnosis is now known at my workplace.",
    symptoms: "No physical symptoms; unauthorised disclosure of psychiatric diagnosis.",
    category: "Data Privacy",
    status: "RESOLVED",
    verification: "VERIFIED",
    incidentDaysAgo: 45,
    resolvedDaysAgo: 2,
    docs: [],
  },
  {
    daysAgo: 2.2,
    country: "BR",
    authorityId: "BR-ANS",
    facilityId: "FAC-BR-001",
    patientName: "Carlos Mendes",
    patientEmail: "carlos.mendes@example.br",
    complaint:
      "Recebi uma prescrição com dosagem dez vezes maior do medicamento e tive uma reação grave. O documento foi assinado por uma médica com registro suspenso. Preciso de uma investigação urgente.",
    symptoms: "Reação adversa grave, tontura e desmaio após a medicação.",
    category: "Prescription Error",
    status: "REJECTED",
    verification: "REJECTED",
    incidentDaysAgo: 4,
    language: "pt",
    docs: [
      {
        filename: "receita_medica.pdf",
        mime: "application/pdf",
        kind: "PDF",
        size: 64_100,
        status: "REJECTED",
        score: 12,
        findings: [
          finding("LICENSE_SUSPENDED", "Suspended physician licence", "critical", "Licence CRM-88231 is suspended; the prescription cannot be authentic.", -70, "registry"),
          finding("PDF_PRODUCER_MISMATCH", "Non-clinical authoring software", "high", 'Metadata names "Canva" rather than a clinical system.', -30, "metadata"),
        ],
        extracted: { patientName: "Carlos Mendes", physicianName: "Beatriz Almeida", physicianLicense: "CRM-88231", facilityName: "Hospital das Clínicas da FMUSP", datesOfService: ["2026-10-17"], textLength: 640 },
      },
    ],
  },
  {
    daysAgo: 18.6,
    country: "DE",
    authorityId: "DE-BMG",
    facilityId: "FAC-DE-002",
    patientName: "Tobias Krüger",
    patientEmail: "tobias.krueger@example.de",
    complaint: "Die Beschilderung zur neuen Ambulanz ist unklar und ich habe 40 Minuten den richtigen Eingang gesucht. Ein Hinweisschild wäre hilfreich.",
    symptoms: "Keine.",
    category: "Other",
    status: "ROUTED",
    verification: "VERIFIED",
    incidentDaysAgo: 20,
    language: "de",
    docs: [],
  },
];

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export async function seed(): Promise<void> {
  seedRoles();
  seedAuthorities();
  await seedFacilityAccounts();
  if (count("SELECT COUNT(*) AS n FROM users") > 0) {
    seedCommunity();
    return;
  }

  for (const u of USERS) {
    run(
      "INSERT INTO users (id, email, name, password_hash, role, country, organisation, active, mfa_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)",
      u.id,
      u.email,
      u.name,
      await hashPassword(u.password),
      u.role,
      u.country,
      u.organisation,
      nowIso(),
    );
  }

  for (const f of FACILITIES) {
    run(
      "INSERT INTO facilities (id, name, authority_id, country, city, letterhead_keywords, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      f.id,
      f.name,
      f.authorityId,
      f.country,
      f.city,
      JSON.stringify(f.keywords),
      f.status ?? "VERIFIED",
    );
  }

  // Facilities exist now, so the facility-bound logins can be created on the
  // very first boot instead of waiting for the next restart.
  await seedFacilityAccounts();

  for (const l of LICENSES) {
    run(
      "INSERT INTO physician_licenses (license_no, full_name, jurisdiction, status, expires_at, facility_id) VALUES (?, ?, ?, ?, ?, ?)",
      l.no,
      l.name,
      l.jurisdiction,
      l.status,
      l.expires,
      l.facility,
    );
  }

  for (const a of ADAPTERS) {
    run(
      `INSERT INTO adapters (code, name, country, kind, endpoint, auth_type, auth_config_enc, mapping_json, enabled, simulate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'NONE', NULL, ?, 1, 1, ?, ?)`,
      a.code,
      a.name,
      a.country,
      a.kind,
      a.endpoint,
      JSON.stringify(a.mapping ?? {}),
      nowIso(),
      nowIso(),
    );
  }

  let counter = 100;
  for (const c of SEED_CASES) {
    counter += 1;
    const caseId = `CASE-2026-${String(counter).padStart(6, "0")}`;
    const createdAt = new Date(Date.now() - c.daysAgo * 86_400_000).toISOString();
    const facility = FACILITIES.find((f) => f.id === c.facilityId)!;
    const incidentDate = new Date(Date.now() - c.incidentDaysAgo * 86_400_000).toISOString().slice(0, 10);
    const t = triage({ complaint: c.complaint, symptoms: c.symptoms, category: c.category, incidentDate, country: c.country });
    const priority = (c.declaredPriority as typeof t.priority) ?? t.priority;
    const jurisdiction = findJurisdiction(c.country);
    const slaHours = jurisdiction?.slaHours[priority] ?? 24;
    const dueAt = new Date(new Date(createdAt).getTime() + slaHours * 3_600_000).toISOString();
    const accessCode = c.patientEmail === "patient@demo.io" ? "DEMO-ACCESS" : randomCode(10);

    run(
      `INSERT INTO cases (id, access_code_hash, patient_user_id, patient_name_enc, patient_email_enc, patient_phone_enc,
        patient_name_masked, patient_email_masked, country, region, authority_id, facility_id, facility_name,
        category, category_confidence, priority, priority_score, triage_json, complaint_enc, symptoms_enc,
        timeline_json, incident_date, status, verification_status, assigned_to, consent_data_sharing,
        cross_border_allowed, language, source, created_at, updated_at, sla_due_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SEED', ?, ?, ?, ?)`,
      caseId,
      sha256Hex(accessCode),
      c.patientEmail === "patient@demo.io" ? "USR-PATIENT" : c.patientEmail === "lena.hoffmann@demo.io" ? "USR-PATIENT-DE" : null,
      encryptField(c.patientName),
      encryptField(c.patientEmail),
      encryptField("+1 555 0100"),
      maskName(c.patientName),
      maskEmail(c.patientEmail),
      c.country,
      jurisdiction?.authorities.find((a) => a.id === c.authorityId)?.region ?? null,
      c.authorityId,
      c.facilityId,
      facility.name,
      t.category,
      t.categoryConfidence,
      priority,
      t.score,
      JSON.stringify(t),
      encryptField(c.complaint),
      encryptField(c.symptoms),
      JSON.stringify([
        { date: incidentDate, event: "Incident occurred" },
        { date: createdAt.slice(0, 10), event: "Complaint submitted via portal" },
        { date: createdAt.slice(0, 10), event: `Triage assigned ${priority} (${t.score}/100)` },
      ]),
      incidentDate,
      c.status,
      c.verification,
      c.assignedTo ?? null,
      1,
      1,
      c.language ?? "en",
      createdAt,
      createdAt,
      dueAt,
      c.resolvedDaysAgo ? new Date(Date.now() - c.resolvedDaysAgo * 86_400_000).toISOString() : null,
    );

    audit({
      ts: createdAt,
      actor: c.patientEmail === "patient@demo.io" ? { id: "USR-PATIENT", role: "PATIENT" } : { id: null, role: "PATIENT" },
      action: "CASE_CREATED",
      entityType: "case",
      entityId: caseId,
      ip: "203.0.113.44",
      userAgent: "Mozilla/5.0 (seed)",
      details: { country: c.country, authority: c.authorityId, facility: facility.name, priority, category: t.category },
    });
    audit({
      ts: createdAt,
      actor: { id: null, role: "SYSTEM" },
      action: "TRIAGE_ASSIGNED",
      entityType: "case",
      entityId: caseId,
      details: { priority, score: t.score, category: t.category, confidence: t.categoryConfidence, signals: t.signals.map((s) => s.label) },
    });

    let index = 0;
    for (const d of c.docs) {
      index += 1;
      const docId = `DOC-${caseId.slice(-6)}-${index}`;
      const sha = sha256Hex(`${caseId}:${d.filename}:${d.kind}`);
      run(
        `INSERT INTO documents (id, case_id, filename, mime, size, sha256, storage_path, kind, page_count, has_text_layer,
          verification_status, score, findings_json, extracted_json, reviewed_by, reviewed_at, review_note, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        docId,
        caseId,
        d.filename,
        d.mime,
        d.size,
        sha,
        d.kind,
        d.kind === "PDF" ? 3 : 1,
        d.kind === "PDF" ? 1 : 0,
        d.status,
        d.score,
        JSON.stringify(d.findings),
        JSON.stringify(d.extracted),
        d.note ?? null,
        createdAt,
      );
      audit({
        ts: createdAt,
        actor: { id: null, role: "SYSTEM" },
        action: "DOCUMENT_VERIFIED",
        entityType: "document",
        entityId: docId,
        details: { caseId, filename: d.filename, status: d.status, score: d.score },
      });
    }

    if (c.status === "ROUTED" || c.status === "RESOLVED") {
      const adapter = findAuthority(c.authorityId)?.authority.adapter ?? "US-FHIR";
      const transmissionId = `TRX-${randomCode(8)}`;
      const txAt = new Date(new Date(createdAt).getTime() + 90_000).toISOString();
      const ackId = `sim-${randomCode(8)}`;
      run(
        `INSERT INTO transmissions (id, case_id, adapter_code, status, request_json, response_json, http_status, latency_ms, attempts, created_at, reference)
         VALUES (?, ?, ?, 'DELIVERED', ?, ?, 201, 142, 1, ?, ?)`,
        transmissionId,
        caseId,
        adapter,
        JSON.stringify({ caseId, priority, masked: true, adapter }),
        JSON.stringify({ simulated: true, ackId, message: "Accepted by simulated authority endpoint" }),
        txAt,
        ackId,
      );
      run("UPDATE cases SET authority_reference = ? WHERE id = ?", ackId, caseId);
      audit({
        ts: txAt,
        actor: { id: null, role: "SYSTEM" },
        action: "CASE_ROUTED",
        entityType: "case",
        entityId: caseId,
        details: { transmissionId, adapter, simulated: true, httpStatus: 201, latencyMs: 142 },
      });

      const subject = `[${priority}] ${caseId} · ${t.category} · ${facility.name}`;
      const body = `Case: ${caseId}\nAuthority: ${c.authorityId}\nPriority: ${priority}\nVerification: ${c.verification}\nComplainant: ${maskName(c.patientName)} <${maskEmail(c.patientEmail)}>`;
      for (const [channel, target] of [
        ["EMAIL", findAuthority(c.authorityId)?.authority.contactEmail ?? "complaints@example.gov"],
        ["WEBHOOK", findAuthority(c.authorityId)?.authority.webhook ?? "https://sandbox.mednotice.local/hook"],
      ] as const) {
        const notificationId = `NTF-${randomCode(9)}`;
        run(
          `INSERT INTO notifications (id, case_id, channel, target, subject, body, status, attempts, next_attempt_at, created_at, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, 'SENT', 1, ?, ?, ?)`,
          notificationId,
          caseId,
          channel,
          target,
          subject,
          body,
          txAt,
          txAt,
          txAt,
        );
        audit({
          ts: txAt,
          actor: { id: null, role: "SYSTEM" },
          action: "NOTIFICATION_SENT",
          entityType: "case",
          entityId: caseId,
          details: { notificationId, channel, target, transmissionId, simulated: true },
        });
      }
    }

    if (c.status === "PENDING_REVIEW") {
      run(
        `INSERT INTO case_reviews (id, case_id, reviewer_id, action, previous_json, new_json, note, created_at)
         VALUES (?, ?, 'USR-MINISTRY', 'FLAG_REVIEW', ?, ?, ?, ?)`,
        `REV-${randomCode(9)}`,
        caseId,
        JSON.stringify({ verification: "PENDING" }),
        JSON.stringify({ verification: "PENDING_MANUAL_REVIEW" }),
        "Automated pre-screen returned a suspicious bundle; routed to manual review queue.",
        new Date(new Date(createdAt).getTime() + 120_000).toISOString(),
      );
    }
  }

  tx(() => {
    run("UPDATE cases SET updated_at = sla_due_at WHERE status = 'ROUTE_FAILED'");
  });

  seedCommunity();
  console.log(`[seed] ${USERS.length} users, ${FACILITIES.length} facilities, ${SEED_CASES.length} cases`);
}

export function seedDemoAccessCodes(): Array<{ caseId: string; code: string }> {
  // Access codes are hashed; the demo code below is stable and documented for the seeded patient case.
  return [{ caseId: "CASE-2026-000101", code: "DEMO-ACCESS" }];
}

export function hoursFromNowExport(hours: number): string {
  return hoursFromNow(hours);
}

export function seededCaseCount(): number {
  return count("SELECT COUNT(*) AS n FROM cases WHERE source = 'SEED'");
}

export function firstCaseId(): string | undefined {
  return get<{ id: string }>("SELECT id FROM cases ORDER BY created_at DESC LIMIT 1")?.id;
}

export function allCaseIds(): string[] {
  return all<{ id: string }>("SELECT id FROM cases ORDER BY created_at DESC").map((r) => r.id);
}

/**
 * Community starter content: a mix of patient and guest voices plus one
 * moderated post so the review workflow is visible on first boot.
 */
export function seedCommunity(): void {
  if (count("SELECT COUNT(*) AS n FROM community_posts") > 0) return;
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const posts: Array<{
    id: string;
    userId: string | null;
    author: string;
    guest: boolean;
    title: string;
    body: string;
    topic: string;
    status: string;
    hoursAgo: number;
  }> = [
    {
      id: "POST-SEED-1",
      userId: "USR-PATIENT",
      author: "Maria Santos",
      guest: false,
      title: "Billing desk added charges after discharge — is this normal?",
      body: "I was discharged from a hospital in New York and the final bill included a 'consumables' line that was never explained. I have the itemised bill and the discharge summary. Filing a grievance through the portal took about ten minutes, and I attached both documents. Sharing here in case others are unsure whether small charges are worth reporting.",
      topic: "Billing",
      status: "VISIBLE",
      hoursAgo: 30,
    },
    {
      id: "POST-SEED-2",
      userId: null,
      author: "Guest from Manchester",
      guest: true,
      title: "How long does the manual document review usually take?",
      body: "My upload came back as pending manual review because the scan had no text layer. The tracking page still shows the same status after a day. Does the review happen within the SLA shown on the case, or separately?",
      topic: "Documents",
      status: "VISIBLE",
      hoursAgo: 18,
    },
    {
      id: "POST-SEED-3",
      userId: "USR-PATIENT-DE",
      author: "Lena Hoffmann",
      guest: false,
      title: "Appreciation for the multilingual narrative intake option",
      body: "Writing the complaint in German made it much easier to describe what happened to my father at the emergency department in Berlin. The summary I received afterwards was clear, and the case was routed to the state health authority the same evening.",
      topic: "Feedback",
      status: "VISIBLE",
      hoursAgo: 6,
    },
    {
      id: "POST-SEED-4",
      userId: null,
      author: "Anonymous",
      guest: true,
      title: "Post held for review",
      body: "This submission named individual staff members and included a phone number, which the community guidelines do not allow. A moderator has hidden it pending review.",
      topic: "General",
      status: "HIDDEN",
      hoursAgo: 40,
    },
  ];

  for (const p of posts) {
    const createdAt = at(p.hoursAgo);
    run(
      `INSERT INTO community_posts (id, author_user_id, author_name, is_guest, title, body, topic, status, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      p.id,
      p.userId,
      p.author,
      p.guest ? 1 : 0,
      p.title,
      p.body,
      p.topic,
      p.status,
      createdAt,
      createdAt,
    );
    audit({
      ts: createdAt,
      actor: p.userId ? { id: p.userId, role: "PATIENT" } : { id: null, role: "PUBLIC" },
      action: "COMMUNITY_POST_CREATED",
      entityType: "community_post",
      entityId: p.id,
      details: { topic: p.topic, guest: p.guest, seeded: true },
    });
  }

  const comments: Array<{ id: string; postId: string; userId: string | null; author: string; guest: boolean; body: string; hoursAgo: number }> = [
    {
      id: "CMT-SEED-1",
      postId: "POST-SEED-1",
      userId: null,
      author: "Guest from Lisbon",
      guest: true,
      body: "Itemised bills are exactly what the grievance needs. Keep the discharge summary too — it shows what was clinically expected.",
      hoursAgo: 24,
    },
    {
      id: "CMT-SEED-2",
      postId: "POST-SEED-1",
      userId: "USR-PATIENT",
      author: "Maria Santos",
      guest: false,
      body: "Thank you. The compliance officer has already asked for the pharmacy receipts, so it seems to be moving.",
      hoursAgo: 20,
    },
    {
      id: "CMT-SEED-3",
      postId: "POST-SEED-2",
      userId: "USR-MINISTRY",
      author: "Dr. Jonas Brandt",
      guest: false,
      body: "Manual review is separate from the SLA clock and is worked in submission order. Uploading a text-based PDF usually clears it automatically.",
      hoursAgo: 12,
    },
  ];

  for (const c of comments) {
    const createdAt = at(c.hoursAgo);
    run(
      `INSERT INTO community_comments (id, post_id, author_user_id, author_name, is_guest, body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'VISIBLE', ?, ?)`,
      c.id,
      c.postId,
      c.userId,
      c.author,
      c.guest ? 1 : 0,
      c.body,
      createdAt,
      createdAt,
    );
    audit({
      ts: createdAt,
      actor: c.userId ? { id: c.userId, role: "PATIENT" } : { id: null, role: "PUBLIC" },
      action: "COMMUNITY_COMMENT_CREATED",
      entityType: "community_comment",
      entityId: c.id,
      details: { postId: c.postId, guest: c.guest, seeded: true },
    });
  }
}
