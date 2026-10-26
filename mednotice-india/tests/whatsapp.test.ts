import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildPdf } from "./fixtures.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "mn-wa-"));
process.env.DATA_DIR = dataDir;

const { seed } = await import("../server/seed.js");
const { createApp } = await import("../server/app.js");
const { all, get } = await import("../server/db.js");
const { drainNotifications } = await import("../server/notifications.js");
const { normalizeWhatsAppNumber, maskWhatsAppNumber, whatsappStatus } = await import("../server/whatsapp.js");
const { verifyAuditChain } = await import("../server/audit.js");

await seed();
const app = createApp();
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
});

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

function caseForm(complaint: string, opts: { guestPhone?: string } = {}): FormData {
  const form = new FormData();
  form.set("country", "IN");
  form.set("authorityId", "IN-MOHFW");
  form.set("facilityId", "FAC-IN-001");
  form.set("category", "Negligence");
  form.set("complaint", complaint);
  form.set("symptoms", "Chest pain and breathlessness after discharge.");
  form.set("consentDataSharing", "true");
  form.set("crossBorderAllowed", "false");
  if (opts.guestPhone) {
    form.set("patientName", "Guest Complainant");
    form.set("patientEmail", "guest@example.in");
    form.set("patientPhone", opts.guestPhone);
  }
  form.append("documents", new Blob([new Uint8Array(buildPdf())], { type: "application/pdf" }), "record.pdf");
  return form;
}

function whatsappRows(caseId: string) {
  return all<{ id: string; channel: string; target: string; subject: string; body: string; status: string; provider_ref: string | null }>(
    "SELECT id, channel, target, subject, body, status, provider_ref FROM notifications WHERE case_id = ? AND channel = 'WHATSAPP' ORDER BY created_at",
    caseId,
  );
}

test("whatsapp channel", async (t) => {
  await t.test("numbers normalise to the international digits the Cloud API expects", () => {
    assert.equal(normalizeWhatsAppNumber("+91 98100 01000"), "919810001000");
    assert.equal(normalizeWhatsAppNumber("9810001000"), "919810001000");
    assert.equal(normalizeWhatsAppNumber("098100 01000"), "919810001000");
    assert.equal(normalizeWhatsAppNumber("+44 7700 900123"), "447700900123");
    assert.equal(normalizeWhatsAppNumber("0091 98100 01000"), "919810001000");
    assert.equal(normalizeWhatsAppNumber("12ab"), null);
    assert.equal(normalizeWhatsAppNumber(""), null);
    assert.equal(maskWhatsAppNumber("919810001000"), "+91 ******1000");
  });

  await t.test("the channel reports simulation when no Business credentials exist", () => {
    const status = whatsappStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.configured, false);
    assert.equal(status.simulated, true);
  });

  const patientEmail = "whatsapp.patient@example.in";
  let patientCookie = "";
  let caseId = "";
  let guestCaseId = "";

  await t.test("a patient registers a number and opts in", async () => {
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Meera Rao", email: patientEmail, password: "Strong!Passw0rd", consent: true }),
    });
    assert.equal(res.status, 201);
    patientCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];

    const save = await fetch(`${base}/api/auth/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: patientCookie },
      body: JSON.stringify({ phone: "+91 98100 01000", optIn: true }),
    });
    const body = await save.json();
    assert.equal(save.status, 200);
    assert.equal(body.whatsapp.optIn, true);
    assert.equal(body.whatsapp.connected, false);
    assert.match(body.whatsapp.number, /^\+91 \*+1000$/);

    const stored = get<{ phone_enc: string; whatsapp_opt_in: number }>(
      "SELECT phone_enc, whatsapp_opt_in FROM users WHERE email = ?",
      patientEmail,
    );
    assert.equal(stored?.whatsapp_opt_in, 1);
    assert.ok(stored?.phone_enc.startsWith("v1:"), "the number is encrypted at rest");
    assert.equal(stored?.phone_enc.includes("9810001000"), false, "the number is not stored in clear text");
  });

  await t.test("submitting a case queues a WhatsApp receipt for the patient", async () => {
    const res = await fetch(`${base}/api/cases`, { method: "POST", body: caseForm("Discharged without a discharge summary after chest pain treatment."), headers: { cookie: patientCookie } });
    const body = await res.json();
    assert.equal(res.status, 201);
    caseId = body.case.id;

    const rows = whatsappRows(caseId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "QUEUED");
    assert.equal(rows[0].target, "919810001000");
    assert.match(rows[0].body, /grievance has been received/);
    assert.match(rows[0].body, new RegExp(caseId));

    const auditRow = get<{ details_json: string }>(
      "SELECT details_json FROM audit_log WHERE action = 'NOTIFICATION_QUEUED' AND details_json LIKE ? ORDER BY id DESC LIMIT 1",
      `%${rows[0].id}%`,
    );
    assert.ok(auditRow, "queueing is written to the audit chain");
    assert.equal(auditRow?.details_json.includes("9810001000"), false, "the audit trail holds the masked number only");
  });

  await t.test("the queue delivers it and records what happened", async () => {
    await drainNotifications();
    const [row] = whatsappRows(caseId);
    assert.equal(row.status, "SENT");
    assert.match(row.provider_ref ?? "", /^OUTBOX:/);

    const file = path.join(dataDir, "outbox", (row.provider_ref ?? "").replace("OUTBOX:", ""));
    assert.ok(existsSync(file), "simulation writes the exact payload to the outbox");
    const payload = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(payload.channel, "WHATSAPP");
    assert.equal(payload.to, "+919810001000");
    assert.equal(payload.simulated, true);
    assert.match(payload.body, new RegExp(caseId));
  });

  await t.test("a status change sends a second message with the outcome but not the internal note", async () => {
    const admin = await login("admin@mednotice.in", "Admin!2345");
    const res = await fetch(`${base}/api/admin/cases/${caseId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin },
      body: JSON.stringify({ note: "Internal: reviewer verified the discharge register at AIIMS.", outcome: "Hospital asked to issue the discharge summary within 7 days" }),
    });
    assert.equal(res.status, 200);

    const rows = whatsappRows(caseId);
    assert.equal(rows.length, 2);
    const update = rows[1];
    assert.match(update.subject, /is now Resolved/);
    assert.match(update.body, /New status: Resolved/);
    assert.match(update.body, /issue the discharge summary/);
    assert.equal(update.body.includes("reviewer verified the discharge register"), false, "internal reviewer notes stay internal");

    await drainNotifications();
    assert.equal(whatsappRows(caseId)[1].status, "SENT");
  });

  await t.test("opting out stops further messages", async () => {
    const off = await fetch(`${base}/api/auth/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: patientCookie },
      body: JSON.stringify({ optIn: false }),
    });
    assert.equal(off.status, 200);
    assert.equal((await off.json()).whatsapp.optIn, false);

    const admin = await login("admin@mednotice.in", "Admin!2345");
    const before = whatsappRows(caseId).length;
    const reopen = await fetch(`${base}/api/admin/cases/${caseId}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin },
      body: JSON.stringify({ note: "Patient supplied the missing discharge summary." }),
    });
    assert.equal(reopen.status, 200);
    assert.equal(whatsappRows(caseId).length, before, "no message is queued for an opted-out patient");
  });

  await t.test("guest submissions are not messaged even with a phone number on the form", async () => {
    const res = await fetch(`${base}/api/cases`, { method: "POST", body: caseForm("Guest complaint about an unexpected bill after an outpatient visit.", { guestPhone: "+91 90000 11112" }) });
    const body = await res.json();
    assert.equal(res.status, 201);
    guestCaseId = body.case.id;
    assert.equal(whatsappRows(guestCaseId).length, 0);
  });

  await t.test("the audit chain still verifies", () => {
    assert.equal(verifyAuditChain().valid, true);
    assert.ok(readdirSync(path.join(dataDir, "outbox")).some((f) => f.endsWith(".wa.json")));
  });
});
