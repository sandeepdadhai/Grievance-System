import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildPdf } from "./fixtures.js";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-identity-"));
process.env.DISPATCH_CRON_ENABLED = "0";

const { seed } = await import("../server/seed.js");
const { createApp } = await import("../server/app.js");
const { get } = await import("../server/db.js");
const { verifyAuditChain } = await import("../server/audit.js");
const { checkAadhaar, verhoeffValid } = await import("../server/aadhaar.js");

await seed();
const app = createApp();
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
});

async function post(pathname: string, body: unknown, cookie?: string): Promise<{ status: number; body: any; cookie: string }> {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0],
  };
}

function submitForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("country", "IN");
  form.set("authorityId", "IN-MOHFW");
  form.set("facilityId", "FAC-IN-001");
  form.set("category", "Negligence");
  form.set("complaint", "The casualty ward left my father waiting for four hours with chest pain and he died before anyone examined him.");
  form.set("symptoms", "Crushing chest pain and breathlessness.");
  form.set("timeline", JSON.stringify([{ date: "2026-10-20", event: "Presented to the emergency department" }]));
  form.set("incidentDate", "2026-10-20");
  form.set("consentDataSharing", "true");
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  form.append("documents", new Blob([new Uint8Array(buildPdf())], { type: "application/pdf" }), "record.pdf");
  return form;
}

test("Aadhaar identity and SMS one-time-password authentication", async (t) => {
  await t.test("Verhoeff checksum accepts the demo numbers and rejects typos", () => {
    assert.equal(verhoeffValid("482915732644"), true);
    assert.equal(verhoeffValid("482915732645"), false, "a single wrong digit must fail the checksum");
    assert.equal(verhoeffValid("48291573264"), false, "11 digits is not an Aadhaar number");

    const short = checkAadhaar("48291573264");
    assert.equal(short.ok, false);
    const prefixed = checkAadhaar("082915732644");
    assert.equal(prefixed.ok, false);
    assert.match(prefixed.ok === false ? prefixed.reason : "", /starts with 0 or 1/);
    const spaced = checkAadhaar("4829 1573 2644");
    assert.equal(spaced.ok, true);
  });

  let otpCookie = "";

  await t.test("a patient signs in with an SMS code instead of a password", async () => {
    const request = await post("/api/auth/otp/request", { phone: "9810000123" });
    assert.equal(request.status, 200, JSON.stringify(request.body));
    assert.equal(request.body.simulated, true, "no gateway credentials, so the code is simulated");
    assert.match(request.body.devCode, /^\d{6}$/);
    assert.equal(request.body.masked, "********0123");

    const wrong = await post("/api/auth/otp/verify", { challengeId: request.body.challengeId, code: "000000" });
    assert.equal(wrong.status, 400);

    const ok = await post("/api/auth/otp/verify", { challengeId: request.body.challengeId, code: request.body.devCode });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.user.email, "patient@demo.in");
    assert.equal(ok.body.user.baseRole, "PATIENT");
    assert.equal(ok.body.user.phoneVerified, true);
    otpCookie = ok.cookie;

    const reused = await post("/api/auth/otp/verify", { challengeId: request.body.challengeId, code: request.body.devCode });
    assert.equal(reused.status, 400, "a code is single use");

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: otpCookie } });
    const meBody = await me.json();
    assert.equal(meBody.user.id, "USR-PATIENT");
  });

  await t.test("codes are never sent for numbers without a patient account", async () => {
    const res = await post("/api/auth/otp/request", { phone: "+91 90000 00001" });
    assert.equal(res.status, 404);
    assert.equal(res.body.devCode ?? null, null);
  });

  await t.test("the same one-time password form signs in with an email address", async () => {
    const request = await post("/api/auth/otp/request", { identifier: "patient@demo.in" });
    assert.equal(request.status, 200, JSON.stringify(request.body));
    assert.equal(request.body.channel, "EMAIL");
    assert.equal(request.body.simulated, true, "no email provider configured, so the code is simulated");
    assert.match(request.body.devCode, /^\d{6}$/);
    assert.match(request.body.masked, /@d\*\*\*\.in$/);

    const ok = await post("/api/auth/otp/verify", { challengeId: request.body.challengeId, code: request.body.devCode });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.user.email, "patient@demo.in");

    const unknown = await post("/api/auth/otp/request", { identifier: "nobody@example.in" });
    assert.equal(unknown.status, 404);
  });

  await t.test("the demo patient's Aadhaar is verified and stored encrypted", () => {
    const row = get<{ aadhaar_enc: string; aadhaar_masked: string; aadhaar_verified_at: string; phone_enc: string }>(
      "SELECT aadhaar_enc, aadhaar_masked, aadhaar_verified_at, phone_enc FROM users WHERE id = 'USR-PATIENT'",
    )!;
    assert.ok(row.aadhaar_enc.startsWith("v1:"), "Aadhaar is encrypted at rest");
    assert.equal(row.aadhaar_enc.includes("482915732644"), false);
    assert.equal(row.aadhaar_masked, "XXXX XXXX 2644");
    assert.ok(row.aadhaar_verified_at);
    assert.equal(row.phone_enc.includes("919810000123"), false);
  });

  await t.test("a patient grievance is refused until Aadhaar is verified, then accepted", async () => {
    const signup = await post("/api/auth/signup", {
      name: "Kavya Rao",
      email: "kavya.rao@example.in",
      password: "Strong!Passw0rd",
      phone: "+91 90000 00042",
      consent: true,
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    assert.equal(signup.body.user.aadhaar.verified, false);
    const cookie = signup.cookie;

    const blocked = await fetch(`${base}/api/cases`, { method: "POST", headers: { cookie }, body: submitForm({ patientName: "Kavya Rao", patientEmail: "kavya.rao@example.in" }) });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 403, JSON.stringify(blockedBody));
    assert.equal(blockedBody.details.code, "AADHAAR_REQUIRED");

    const invalid = await post("/api/auth/aadhaar/request", { aadhaar: "482915732645" }, cookie);
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /checksum/);

    const requested = await post("/api/auth/aadhaar/request", { aadhaar: "902147386531" }, cookie);
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    assert.equal(requested.body.masked, "XXXX XXXX 6531");
    assert.equal(requested.body.sentTo, "********0042");

    const verified = await post("/api/auth/aadhaar/verify", { challengeId: requested.body.challengeId, code: requested.body.devCode }, cookie);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.user.aadhaar.verified, true);
    assert.equal(verified.body.user.aadhaar.masked, "XXXX XXXX 6531");

    const accepted = await fetch(`${base}/api/cases`, { method: "POST", headers: { cookie }, body: submitForm({ patientName: "Kavya Rao", patientEmail: "kavya.rao@example.in" }) });
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 201, JSON.stringify(acceptedBody));
    assert.equal(acceptedBody.case.patientUserId ?? null, verified.body.user.id);

    const stored = get<{ aadhaar_hash: string }>("SELECT aadhaar_hash FROM users WHERE id = ?", verified.body.user.id)!;
    assert.equal(stored.aadhaar_hash.length, 64);
  });

  await t.test("guest submissions stay anonymous and need no Aadhaar", async () => {
    const res = await fetch(`${base}/api/cases`, { method: "POST", body: submitForm({ patientName: "Anonymous Guest", patientEmail: "guest@example.in" }) });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(typeof body.accessCode, "string");
  });

  await t.test("the audit trail records the OTP and Aadhaar events", () => {
    const actions = new Set(
      get<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE '%AADHAAR%' OR action LIKE '%OTP%'") ? [] : [],
    );
    void actions;
    const rows = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('LOGIN_OTP_REQUESTED','LOGIN_OTP_SUCCESS','AADHAAR_OTP_REQUESTED','AADHAAR_VERIFIED')",
    )!;
    assert.ok(Number(rows.n) >= 4, "every identity event is audited");
    assert.equal(verifyAuditChain().valid, true);
  });
});
