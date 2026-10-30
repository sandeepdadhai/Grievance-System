import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildPdf } from "./fixtures.js";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-api-"));

const { seed } = await import("../server/seed.js");
const { createApp } = await import("../server/app.js");
const { verifyAuditChain } = await import("../server/audit.js");
const { get } = await import("../server/db.js");

await seed();
const app = createApp();
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
});

async function login(email: string, password: string): Promise<{ cookie: string; status: number }> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { cookie: setCookie.split(";")[0], status: res.status };
}

function submitForm(opts: { pdf: Buffer; complaint: string; fileName?: string }): FormData {
  const form = new FormData();
  form.set("country", "IN");
  form.set("authorityId", "IN-MOHFW");
  form.set("facilityId", "FAC-IN-001");
  form.set("category", "Negligence");
  form.set("complaint", opts.complaint);
  form.set("symptoms", "Crushing chest pain, diaphoresis, shortness of breath.");
  form.set("timeline", JSON.stringify([{ date: "2026-10-20", event: "Presented to emergency department" }]));
  form.set("incidentDate", "2026-10-20");
  form.set("patientName", "Asha Nair");
  form.set("patientEmail", "asha.nair@example.in");
  form.set("patientPhone", "+91 98100 98765");
  form.set("consentDataSharing", "true");
  form.set("crossBorderAllowed", "false");
  form.set("aadhaar", "4829 1573 2644");
  form.append("documents", new Blob([new Uint8Array(opts.pdf)], { type: "application/pdf" }), opts.fileName ?? "ed_record.pdf");
  return form;
}

test("end-to-end case lifecycle", async (t) => {
  await t.test("health endpoint reports encryption and a valid audit chain", async () => {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.encryptionAtRest, "AES-256-GCM");
    assert.equal(body.auditChain.valid, true);
    assert.equal(body.jurisdictions, 1);
  });

  await t.test("public jurisdiction metadata exposes SLA matrices without secrets", async () => {
    const res = await fetch(`${base}/api/public/jurisdictions`);
    const body = await res.json();
    assert.equal(res.status, 200);
    const india = body.jurisdictions.find((j: { code: string }) => j.code === "IN");
    assert.equal(india.slaHours.P1, 2);
    assert.ok(india.authorities.length >= 2);
    assert.ok(india.authorities.every((a: { id: string }) => a.id.startsWith("IN-")));
    assert.equal(JSON.stringify(body).includes("sandbox.mednotice.local"), false);
  });

  let caseId = "";
  let accessCode = "";

  await t.test("guest submission is verified, triaged to P1 and routed", async () => {
    const res = await fetch(`${base}/api/cases`, { method: "POST", body: submitForm({
      pdf: buildPdf({ text: "Patient Name: Asha Nair\nPhysician: Arjun Mehta\nLicense: DL-48291\nFacility: All India Institute of Medical Sciences\nDiagnosis: I21.4\nDate of Service: 2026-10-20" }),
      complaint: "My mother waited four hours in the emergency room with chest pain. She went into cardiac arrest and died before anyone treated her. The triage nurse told us to keep waiting.",
    }) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.case.priority, "P1");
    assert.equal(body.verification.status, "VERIFIED");
    assert.equal(body.case.patientName, "Asha Nair");
    assert.equal(body.accessCode.length, 10);
    assert.equal(body.transmission.status, "DELIVERED");
    assert.equal(body.transmission.simulated, true);
    assert.ok(body.case.id.startsWith("CASE-"));
    caseId = body.case.id;
    accessCode = body.accessCode;

    const stored = get<{ complaint_enc: string; patient_email_enc: string }>("SELECT complaint_enc, patient_email_enc FROM cases WHERE id = ?", caseId)!;
    assert.ok(stored.complaint_enc.startsWith("v1:"));
    assert.equal(stored.complaint_enc.includes("cardiac arrest"), false);
    assert.equal(stored.patient_email_enc.includes("asha.nair"), false);
  });

  await t.test("access-code tracking returns masked identity and rejects bad codes", async () => {
    const ok = await fetch(`${base}/api/public/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseId, accessCode }),
    });
    const body = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(body.case.patientName, "A*** N***");
    assert.equal(body.case.verificationStatus, "VERIFIED");
    assert.equal(JSON.stringify(body).includes("asha.nair@example.in"), false);

    const bad = await fetch(`${base}/api/public/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseId, accessCode: "WRONGCODE1" }),
    });
    assert.equal(bad.status, 404);
  });

  let adminCookie = "";
  await t.test("staff login, overview metrics and case detail", async () => {
    const session = await login("admin@mednotice.in", "Admin!2345");
    assert.equal(session.status, 200);
    adminCookie = session.cookie;

    const overview = await fetch(`${base}/api/admin/overview`, { headers: { cookie: adminCookie } });
    const metrics = await overview.json();
    assert.equal(overview.status, 200);
    assert.ok(metrics.totals.total >= 9);
    assert.equal(metrics.totals.openP1 >= 1, true);
    assert.equal(metrics.auditChain.valid, true);
    assert.ok(metrics.byRegion.length >= 4);
    assert.ok(metrics.byRegion.every((r: { region: string }) => r.region.length > 0));
    assert.equal(metrics.trend.length, 14);

    const detail = await fetch(`${base}/api/cases/${caseId}`, { headers: { cookie: adminCookie } });
    const body = await detail.json();
    assert.equal(detail.status, 200);
    assert.equal(body.piiVisible, true);
    assert.equal(body.case.documents.length, 1);
    assert.equal(body.transmissions.length, 1);
    assert.equal(body.transmissions[0].status, "DELIVERED");
    assert.ok(body.activity.some((a: { action: string }) => a.action === "CASE_CREATED"));
    assert.ok(body.notifications.length >= 2);

    const notice = get<{ body: string }>("SELECT body FROM notifications WHERE case_id = ? LIMIT 1", caseId)!;
    assert.ok(notice.body.includes("Document summaries"));
    assert.ok(notice.body.includes("ed_record.pdf"));
    assert.ok(notice.body.includes("trust 97/100") || notice.body.includes("trust"));
    assert.equal(notice.body.includes("Asha Nair"), false);
  });

  await t.test("routing payload stored in the audit trail is PII-masked", async () => {
    const detail = await fetch(`${base}/api/cases/${caseId}`, { headers: { cookie: adminCookie } });
    const body = await detail.json();
    const request = String(body.transmissions[0].request_json);
    assert.equal(request.includes("Asha Nair"), false);
    assert.equal(request.includes("asha.nair@example.in"), false);
    assert.ok(request.includes("A***"));
  });

  await t.test("patient cannot reach admin endpoints or another patient's case", async () => {
    const patient = await login("patient@demo.in", "Patient!2345");
    assert.equal(patient.status, 200);
    const forbidden = await fetch(`${base}/api/admin/overview`, { headers: { cookie: patient.cookie } });
    assert.equal(forbidden.status, 403);
    const foreign = await fetch(`${base}/api/cases/${caseId}`, { headers: { cookie: patient.cookie } });
    assert.equal(foreign.status, 403);
    const mine = await fetch(`${base}/api/cases/mine`, { headers: { cookie: patient.cookie } });
    assert.equal(mine.status, 200);
  });

  await t.test("suspicious bundle is held for review until a human approves it", async () => {
    const res = await fetch(`${base}/api/cases`, { method: "POST", body: submitForm({
      pdf: buildPdf({ producer: "Microsoft Word 2019", creator: "Microsoft Word", revisions: 1 }),
      complaint: "My mother waited four hours in the emergency room with chest pain. She went into cardiac arrest and died before anyone treated her.",
      fileName: "scan.pdf",
    }) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.verification.status, "PENDING_MANUAL_REVIEW");
    assert.equal(body.case.status, "PENDING_REVIEW");
    assert.equal(body.transmission, null);
    const docId = body.case.documents[0].id;

    const review = await fetch(`${base}/api/documents/${docId}/review`, {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ decision: "APPROVE", note: "Verified against EHR audit log; revisions are clinician addenda." }),
    });
    const reviewed = await review.json();
    assert.equal(review.status, 200, JSON.stringify(reviewed));
    assert.equal(reviewed.case.verificationStatus, "VERIFIED");
    assert.equal(reviewed.transmission.status, "DELIVERED");
  });

  await t.test("triage override recalculates the SLA and is recorded", async () => {
    const res = await fetch(`${base}/api/admin/cases/${caseId}/override`, {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ priority: "P2", category: "Denial of Care", note: "Reassessed after reviewing the ED triage note with the medical director." }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.case.priority, "P2");
    assert.equal(body.case.category, "Denial of Care");
    const dueHours = (new Date(body.case.slaDueAt).getTime() - new Date(body.case.createdAt).getTime()) / 3_600_000;
    assert.ok(Math.abs(dueHours - 12) < 0.01);

    const detail = await fetch(`${base}/api/cases/${caseId}`, { headers: { cookie: adminCookie } });
    const detailBody = await detail.json();
    assert.ok(detailBody.reviews.some((r: { action: string }) => r.action === "TRIAGE_OVERRIDE"));
  });

  await t.test("auditor is read-only and receives masked PII", async () => {
    const auditor = await login("auditor@mednotice.in", "Audit!2345");
    const detail = await fetch(`${base}/api/cases/${caseId}`, { headers: { cookie: auditor.cookie } });
    const body = await detail.json();
    assert.equal(body.piiVisible, false);
    assert.equal(body.case.patientName, "A*** N***");
    const override = await fetch(`${base}/api/admin/cases/${caseId}/override`, {
      method: "POST",
      headers: { cookie: auditor.cookie, "content-type": "application/json" },
      body: JSON.stringify({ priority: "P1", note: "auditor must not be able to change this record" }),
    });
    assert.equal(override.status, 403);
    const auditList = await fetch(`${base}/api/admin/audit?limit=10`, { headers: { cookie: auditor.cookie } });
    assert.equal(auditList.status, 200);
  });

  await t.test("cross-origin mutation is rejected", async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ email: "admin@mednotice.in", password: "Admin!2345" }),
    });
    assert.equal(res.status, 403);
  });

  await t.test("audit hash chain remains intact after all operations", () => {
    const chain = verifyAuditChain();
    assert.equal(chain.valid, true, `broken at ${chain.brokenAt}`);
    assert.ok(chain.checked > 30);
  });
});
