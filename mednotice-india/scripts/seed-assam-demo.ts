/**
 * Assam-only demonstration dataset.
 *
 * The platform ships with a multi-state catalogue so the registry can be
 * demonstrated end to end. For a presentation to the Health & Family Welfare
 * Department, Government of Assam, the console must show Assam casework only —
 * no Delhi, Karnataka, Tamil Nadu or Maharashtra records.
 *
 * This script:
 *   1. brands the Assam authority correctly;
 *   2. removes every case (and its dependent rows) that does not belong to it;
 *   3. seeds a spread of Assam cases across facilities, categories, priorities
 *      and statuses so the dashboard, analytics and queue look like a live
 *      department;
 *   4. seeds community posts and comments from Assam patients.
 *
 * Run on the server:  npx tsx scripts/seed-assam-demo.ts
 */
import { all, get, nowIso, run } from "../server/db.js";
import { audit } from "../server/audit.js";
import { encryptField, hashToken, maskEmail, maskName, randomCode } from "../server/crypto.js";
import { triage } from "../server/triage.js";

const ASSAM = "IN-SHA-MH"; // registry id backing the Assam directorate in this deployment

type CaseSeed = {
  facilityId: string;
  category: string;
  complaint: string;
  symptoms: string;
  daysAgo: number;
  status: string;
  verification: string;
  patientName: string;
  patientEmail: string;
};

const FACILITIES: Record<string, string> = {
  "FAC-IN-008": "Gauhati Medical College & Hospital (GMCH)",
  "FAC-AM-02": "State Cancer Institute",
  "FAC-AM-03": "District Hospital, Sonapur",
  "FAC-AS-04": "Khetri CHC",
  "FAC-AS-05": "RANI CHC",
  "FAC-AM-06": "Khanapara State Dispensary",
  "FAC-AM-07": "Panikhaity PHC",
  "FAC-AM-08": "Sub Health Centre Mariapatty",
  "FAC-AM-09": "Jawaharnagar Ayushman Arogya Mandir",
};

const CASES: CaseSeed[] = [
  {
    facilityId: "FAC-IN-008",
    category: "Negligence",
    complaint:
      "My father was admitted to the emergency ward at GMCH with chest pain on 18 October. He waited nearly four hours without a doctor reviewing him, and by the time an ECG was done the damage had progressed. We were told the duty doctor was busy in another block. I want the department to examine the triage records and the duty roster for that night.",
    symptoms: "Chest pain, breathlessness, delay in ECG and specialist review",
    daysAgo: 1,
    status: "UNDER_REVIEW",
    verification: "VERIFIED",
    patientName: "Meera Sharma",
    patientEmail: "meera.sharma@example.in",
  },
  {
    facilityId: "FAC-AM-02",
    category: "Billing Fraud",
    complaint:
      "The State Cancer Institute charged us 18,400 rupees for chemotherapy consumables that were supplied under the Ayushman Bharat scheme. We were given a handwritten receipt with no GST number and no itemised bill. Another family in the same ward was charged nothing for the identical cycle, so I believe the billing is arbitrary.",
    symptoms: "No clinical symptoms; billing dispute",
    daysAgo: 2,
    status: "PENDING_REVIEW",
    verification: "PENDING_MANUAL_REVIEW",
    patientName: "Rekha Bora",
    patientEmail: "rekha.bora@example.in",
  },
  {
    facilityId: "FAC-AM-03",
    category: "Denial of Care",
    complaint:
      "I accompanied my sister to the District Hospital at Sonapur with severe abdominal pain. The staff refused to register her because our address falls in a different block, even though the hospital is the nearest emergency facility. She was sent away at 11 pm and we had to travel to Guwahati. This refusal needs to be investigated.",
    symptoms: "Severe abdominal pain, vomiting",
    daysAgo: 3,
    status: "RESOLVED",
    verification: "VERIFIED",
    patientName: "Anjali Das",
    patientEmail: "anjali.das@example.in",
  },
  {
    facilityId: "FAC-AS-04",
    category: "Infrastructure/Facility Issue",
    complaint:
      "The Khetri CHC has had no running water in the labour room for three weeks. Staff are carrying buckets from the outdoor tap. Hand hygiene is impossible and my wife, who delivered there last week, developed an infection afterwards. The overhead tank appears to be broken and nobody has repaired it.",
    symptoms: "Post-delivery infection, fever",
    daysAgo: 4,
    status: "UNDER_REVIEW",
    verification: "VERIFIED",
    patientName: "Bikash Kalita",
    patientEmail: "bikash.kalita@example.in",
  },
  {
    facilityId: "FAC-AM-06",
    category: "Prescription Error",
    complaint:
      "The dispensary gave my mother a five-times overdose of metformin for two days. The strip label and the prescription slip disagree, and the pharmacist told us to follow the slip. She became severely hypoglycaemic and we had to rush her to hospital on the second night. I have photographs of the strip and the slip.",
    symptoms: "Hypoglycaemia, dizziness, sweating",
    daysAgo: 5,
    status: "RESOLVED",
    verification: "VERIFIED",
    patientName: "Pranab Deka",
    patientEmail: "pranab.deka@example.in",
  },
  {
    facilityId: "FAC-AM-08",
    category: "Data Privacy",
    complaint:
      "The sub health centre has a register on the open counter where anyone can read patient names, phone numbers and diagnoses, including HIV and TB records. I saw a visitor photographing pages last Tuesday. Patient records must not be left in public view under the DPDP Act.",
    symptoms: "No clinical symptoms; privacy breach",
    daysAgo: 7,
    status: "UNDER_REVIEW",
    verification: "VERIFIED",
    patientName: "Ritu Choudhury",
    patientEmail: "ritu.choudhury@example.in",
  },
  {
    facilityId: "FAC-AM-07",
    category: "Discrimination",
    complaint:
      "My husband and I were spoken to differently at Panikhaity PHC once the staff saw our Bengali names. We waited while three other families were called before us, though we had registered first. When I asked, the attendant told us to come back tomorrow. This is not the first time and it should be recorded formally.",
    symptoms: "No clinical symptoms; discriminatory treatment",
    daysAgo: 8,
    status: "PENDING_REVIEW",
    verification: "PENDING_MANUAL_REVIEW",
    patientName: "Sabita Mondal",
    patientEmail: "sabita.mondal@example.in",
  },
  {
    facilityId: "FAC-AM-09",
    category: "Billing Fraud",
    complaint:
      "At the Ayushman Arogya Mandir we were asked to pay 350 rupees in cash for a free diagnostic test under the scheme. The staff said the machine was not working and the money was for a private lab. No receipt was given. Several families in the queue paid the same amount.",
    symptoms: "No clinical symptoms; informal charge",
    daysAgo: 9,
    status: "REJECTED",
    verification: "REJECTED",
    patientName: "Nayan Baruah",
    patientEmail: "nayan.baruah@example.in",
  },
  {
    facilityId: "FAC-IN-008",
    category: "Infrastructure/Facility Issue",
    complaint:
      "The orthopaedic ward of GMCH has no working lift for patients on the third floor, and the generator failed for two hours during a storm last week. Patients on oxygen support had to be manually ventilated. The electrical panel appeared to trip repeatedly and nobody from maintenance responded.",
    symptoms: "Oxygen dependency during power outage",
    daysAgo: 10,
    status: "UNDER_REVIEW",
    verification: "VERIFIED",
    patientName: "Deepak Nath",
    patientEmail: "deepak.nath@example.in",
  },
  {
    facilityId: "FAC-AS-05",
    category: "Negligence",
    complaint:
      "My mother's post-operative dressing was not changed for four days at RANI CHC. The wound became septic and she needed a second admission. The duty nurse said dressings are only done on Tuesdays and Fridays. There is no written record of the dressing schedule.",
    symptoms: "Surgical site infection, fever, pain",
    daysAgo: 12,
    status: "RESOLVED",
    verification: "VERIFIED",
    patientName: "Runumi Deka",
    patientEmail: "runumi.deka@example.in",
  },
  {
    facilityId: "FAC-AM-02",
    category: "Denial of Care",
    complaint:
      "The cancer institute refused to give my father his fifth cycle report unless we paid an outstanding amount from a disputed bill. He needs the report for a referral file and we have been going back for ten days. Withholding clinical records over billing is not acceptable.",
    symptoms: "Fatigue, low blood pressure",
    daysAgo: 6,
    status: "UNDER_REVIEW",
    verification: "VERIFIED",
    patientName: "Haren Saikia",
    patientEmail: "haren.saikia@example.in",
  },
  {
    facilityId: "FAC-AM-03",
    category: "Other",
    complaint:
      "No ambulance was available at the Sonapur facility when my neighbour collapsed at the market. The one vehicle was parked without a driver and we were told to arrange private transport. He reached Guwahati nearly forty minutes later. I would like the ambulance roster and availability checked.",
    symptoms: "Collapse, delay in emergency transport",
    daysAgo: 13,
    status: "SUBMITTED",
    verification: "VERIFIED",
    patientName: "Gita Rabha",
    patientEmail: "gita.rabha@example.in",
  },
];

function deleteCaseRow(id: string): void {
  run("DELETE FROM documents WHERE case_id = ?", id);
  run("DELETE FROM notifications WHERE case_id = ?", id);
  run("DELETE FROM transmissions WHERE case_id = ?", id);
  run("DELETE FROM case_reviews WHERE case_id = ?", id);
  try {
    run("DELETE FROM case_status_syncs WHERE case_id = ?", id);
  } catch {
    /* table absent on older schemas */
  }
  try {
    run("DELETE FROM webhook_events WHERE source = ?", `mednotice:${id}`);
  } catch {
    /* ignore */
  }
  run("DELETE FROM cases WHERE id = ?", id);
}

/** Idempotent reset: drop the previously seeded Assam rows before re-seeding. */
function purgeAssamCases(): number {
  const victims = all<{ id: string }>("SELECT id FROM cases WHERE authority_id = ?", ASSAM);
  for (const { id } of victims) deleteCaseRow(id);
  return victims.length;
}

function purgeNonAssamCases(): number {
  const victims = all<{ id: string }>("SELECT id FROM cases WHERE authority_id != ?", ASSAM);
  for (const { id } of victims) deleteCaseRow(id);
  return victims.length;
}

function seedCases(): string[] {
  const created: string[] = [];
  const hospitalOfficer = get<{ id: string }>(
    "SELECT id FROM users WHERE role = 'HOSPITAL_COMPLIANCE' AND active = 1 LIMIT 1",
  );

  for (const seed of CASES) {
    const facilityName = FACILITIES[seed.facilityId];
    if (!facilityName) continue;
    const createdAt = new Date(Date.now() - seed.daysAgo * 86_400_000 - 3 * 3_600_000).toISOString();
    const incidentDate = new Date(Date.now() - (seed.daysAgo + 2) * 86_400_000).toISOString().slice(0, 10);
    const t = triage({
      complaint: seed.complaint,
      symptoms: seed.symptoms,
      category: seed.category,
      incidentDate,
      country: "IN",
    });
    const id = `CASE-${new Date(createdAt).getUTCFullYear()}-${randomCode(6)}`;
    const accessCode = randomCode(10);
    const resolved = seed.status === "RESOLVED";
    const timeline = [
      { date: createdAt.slice(0, 10), event: "Complaint submitted via patient portal" },
      { date: createdAt.slice(0, 10), event: "Automated document verification passed" },
      { date: createdAt.slice(0, 10), event: "Routed to the Directorate of Health Services, Assam" },
    ];
    if (seed.daysAgo <= 4)
      timeline.push({ date: new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10), event: "Assigned to the district compliance officer" });
    if (resolved)
      timeline.push({
        date: new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10),
        event: "Resolved — corrective action recorded by the facility",
      });

    run(
      `INSERT INTO cases (id, access_code_hash, patient_user_id, patient_name_enc, patient_email_enc, patient_phone_enc,
        patient_name_masked, patient_email_masked, country, region, authority_id, facility_id, facility_name,
        category, category_confidence, priority, priority_score, triage_json, complaint_enc, symptoms_enc, timeline_json,
        incident_date, status, verification_status, assigned_to, consent_data_sharing, cross_border_allowed, language,
        source, created_at, updated_at, sla_due_at, resolved_at, authority_status, authority_status_at)
       VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, 'IN', 'Assam', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'en', 'PORTAL', ?, ?, ?, ?, ?, ?)`,
      id,
      hashToken(accessCode),
      encryptField(seed.patientName),
      encryptField(seed.patientEmail),
      maskName(seed.patientName),
      maskEmail(seed.patientEmail),
      ASSAM,
      seed.facilityId,
      facilityName,
      t.category,
      t.categoryConfidence,
      t.priority,
      t.score,
      JSON.stringify(t),
      encryptField(seed.complaint),
      encryptField(seed.symptoms),
      JSON.stringify(timeline),
      incidentDate,
      seed.status,
      seed.verification,
      hospitalOfficer?.id ?? null,
      createdAt,
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
      t.dueAt,
      resolved ? new Date(Date.now() - 3 * 3_600_000).toISOString() : null,
      resolved ? "RESOLVED" : "UNDER_REVIEW",
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
    );
    // Seeded rows still go through the hash-chained audit writer, so the chain
    // stays valid and the console's audit view shows where the data came from.
    audit({
      actor: { id: null, role: "SYSTEM" },
      action: "CASE_IMPORTED",
      entityType: "case",
      entityId: id,
      details: { source: "assam-demo-seed", priority: t.priority, status: seed.status, facility: facilityName },
    });
    created.push(id);
    // The access code is written to the console only so the presenter can track
    // a guest-style case during the walk-through; it is never stored in clear.
    console.log(`  seeded ${id}  ${seed.status.padEnd(14)} ${t.priority}  ${facilityName}`);
  }
  return created;
}

function seedCommunity(): void {
  const posts = [
    {
      title: "Long waits at the GMCH emergency ward at night",
      body:
        "Filed a grievance last week about a four-hour wait in the emergency ward. The department acknowledged it within two days and the hospital called to explain the duty roster. Sharing this so others know the tracking code works even without an account.",
      topic: "General",
      author: "Meera S.",
    },
    {
      title: "What documents help a billing complaint?",
      body:
        "For a billing dispute, attach the itemised bill, the payment receipt and any scheme card. My grievance about an informal charge was reviewed faster once the receipt was attached, even though it was only a photo.",
      topic: "Billing",
      author: "Rekha B.",
    },
    {
      title: "Privacy of records at sub health centres",
      body:
        "Patient registers should not sit on an open counter. If you see this, note the date and the centre and file it as a data privacy grievance — the department has to respond within the priority clock.",
      topic: "Privacy",
      author: "Ritu C.",
    },
  ];
  for (const p of posts) {
    const exists = get<{ id: string }>("SELECT id FROM community_posts WHERE title = ?", p.title);
    if (exists) continue;
    const id = `POST-${randomCode(8)}`;
    const now = new Date(Date.now() - Math.floor(Math.random() * 5) * 86_400_000).toISOString();
    run(
      `INSERT INTO community_posts (id, author_user_id, author_name, is_guest, title, body, topic, status, pinned, created_at, updated_at)
       VALUES (?, NULL, ?, 1, ?, ?, ?, 'VISIBLE', 0, ?, ?)`,
      id,
      p.author,
      p.title,
      p.body,
      p.topic,
      now,
      now,
    );
    run(
      `INSERT INTO community_comments (id, post_id, author_user_id, author_name, is_guest, body, status, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 1, ?, 'VISIBLE', ?, ?)`,
      `CMT-${randomCode(8)}`,
      id,
      "Department moderator",
      "Thank you for sharing this. The case has been linked to the facility review and the outcome will appear in the case timeline.",
      now,
      now,
    );
  }
}

const now = nowIso();
run(
  "UPDATE authorities SET name = ?, region = ?, contact_email = ?, webhook = ?, adapter = ?, updated_at = ? WHERE id = ?",
  "Directorate of Health Services, Assam",
  "Assam",
  "grievance.hfw@assam.gov.in",
  "https://sandbox.mednotice.in/as/health/cases",
  "IN-REST",
  now,
  ASSAM,
);

const othersremoved = purgeNonAssamCases();
const reset = purgeAssamCases();
const seeded = seedCases();
seedCommunity();
const total = get<{ n: number }>("SELECT COUNT(*) AS n FROM cases WHERE authority_id = ?", ASSAM)?.n ?? 0;
console.log(
  `\nremoved ${othersremoved} non-Assam case(s); reset ${reset} Assam case(s); seeded ${seeded.length}; Assam cases now ${total}`,
);
