import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-directory-"));

const { seed } = await import("../server/seed.js");
const { createApp } = await import("../server/app.js");
const { verifyAuditChain } = await import("../server/audit.js");

await seed();
const app = createApp();
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
});

async function call(pathname: string, init: RequestInit = {}, cookie?: string): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${base}${pathname}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function submitCase(cookie: string, authorityId: string, facilityId: string): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.set("country", "IN");
  form.set("authorityId", authorityId);
  form.set("facilityId", facilityId);
  form.set("category", "Other");
  form.set("complaint", "The patient portal must accept grievances filed against facilities added by an administrator.");
  form.set("patientName", "Test Complainant");
  form.set("patientEmail", "test.complainant@example.in");
  form.set("consentDataSharing", "true");
  const res = await fetch(`${base}/api/cases`, { method: "POST", body: form, headers: { cookie } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("authority and facility directory", async (t) => {
  const admin = await login("admin@mednotice.demo", "Admin!2345");
  const reviewer = await login("reviewer@ministry.demo", "Review!2345");
  const patient = await login("patient@demo.io", "Patient!2345");
  const newAuthorityId = "IN-SHA-GJ";
  const newFacilityId = "FAC-IN-012";

  await t.test("the seeded catalogue is exposed to patients", async () => {
    const res = await call("/api/public/jurisdictions");
    assert.equal(res.status, 200);
    const india = res.body.jurisdictions.find((j: { code: string }) => j.code === "IN");
    assert.ok(india.authorities.length >= 6);
    assert.ok(india.authorities.every((a: { id: string }) => a.id.startsWith("IN-")));

    const facilities = await call(`/api/public/facilities?authority=${newAuthorityId}`);
    assert.equal(facilities.status, 200);
    assert.deepEqual(facilities.body.facilities, []);
  });

  await t.test("a reviewer without the capability cannot change the directory", async () => {
    const res = await call(
      "/api/admin/directory/authorities",
      { method: "POST", body: JSON.stringify({ id: "IN-SHA-XX", name: "Unauthorised Authority", region: "Test", adapter: "IN-REST", contactEmail: "x@example.gov.in", webhook: "https://sandbox.mednotice.in/x" }) },
      reviewer,
    );
    assert.equal(res.status, 403);
  });

  await t.test("an administrator adds an authority and a facility", async () => {
    const created = await call(
      "/api/admin/directory/authorities",
      {
        method: "POST",
        body: JSON.stringify({
          id: newAuthorityId,
          name: "Health and Family Welfare Department, Gujarat",
          region: "Gujarat",
          adapter: "IN-REST",
          contactEmail: "grievance.hfw@gujarat.gov.in",
          webhook: "https://sandbox.mednotice.in/in/gj/health/cases",
        }),
      },
      admin,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.authority.status, "ACTIVE");
    assert.equal(created.body.authority.facilityCount, 0);

    const duplicate = await call(
      "/api/admin/directory/authorities",
      { method: "POST", body: JSON.stringify({ id: newAuthorityId, name: "Duplicate", region: "Gujarat", adapter: "IN-REST", contactEmail: "d@example.gov.in", webhook: "https://sandbox.mednotice.in/d" }) },
      admin,
    );
    assert.equal(duplicate.status, 409);

    const unknownAdapter = await call(
      "/api/admin/directory/authorities",
      { method: "POST", body: JSON.stringify({ id: "IN-SHA-XX", name: "Unknown Adapter Authority", region: "Test", adapter: "NO-SUCH-ADAPTER", contactEmail: "x@example.gov.in", webhook: "https://sandbox.mednotice.in/x" }) },
      admin,
    );
    assert.equal(unknownAdapter.status, 400);
    assert.match(unknownAdapter.body.error, /adapter/i);

    const facility = await call(
      "/api/admin/directory/facilities",
      {
        method: "POST",
        body: JSON.stringify({
          id: newFacilityId,
          name: "Civil Hospital, Ahmedabad",
          authorityId: newAuthorityId,
          city: "Ahmedabad",
          letterheadKeywords: ["Civil Hospital", "Ahmedabad Civil"],
        }),
      },
      admin,
    );
    assert.equal(facility.status, 201, JSON.stringify(facility.body));
    assert.equal(facility.body.facility.authorityId, newAuthorityId);
    assert.equal(facility.body.facility.status, "VERIFIED");
  });

  await t.test("patients can select the new authority and facility", async () => {
    const jurisdictions = await call("/api/public/jurisdictions");
    const india = jurisdictions.body.jurisdictions.find((j: { code: string }) => j.code === "IN");
    const authority = india.authorities.find((a: { id: string }) => a.id === newAuthorityId);
    assert.ok(authority, "the new authority is offered at intake");
    assert.equal(authority.region, "Gujarat");

    const facilities = await call(`/api/public/facilities?authority=${newAuthorityId}`);
    assert.equal(facilities.body.facilities.length, 1);
    assert.equal(facilities.body.facilities[0].name, "Civil Hospital, Ahmedabad");

    const filed = await submitCase(patient, newAuthorityId, newFacilityId);
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    assert.equal(filed.body.case.authorityId, newAuthorityId);
    assert.equal(filed.body.case.facilityName, "Civil Hospital, Ahmedabad");
    assert.equal(filed.body.transmission.status, "DELIVERED");
  });

  await t.test("edits and retirement are reflected at intake", async () => {
    const renamed = await call(
      `/api/admin/directory/authorities/${newAuthorityId}`,
      { method: "PATCH", body: JSON.stringify({ name: "Gujarat Health and Family Welfare Department" }) },
      admin,
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.authority.name, "Gujarat Health and Family Welfare Department");

    const jurisdictions = await call("/api/public/jurisdictions");
    const india = jurisdictions.body.jurisdictions.find((j: { code: string }) => j.code === "IN");
    assert.ok(india.authorities.some((a: { name: string }) => a.name === "Gujarat Health and Family Welfare Department"));

    const retired = await call(`/api/admin/directory/facilities/${newFacilityId}`, { method: "PATCH", body: JSON.stringify({ status: "PENDING" }) }, admin);
    assert.equal(retired.status, 200);
    const facilities = await call(`/api/public/facilities?authority=${newAuthorityId}`);
    assert.deepEqual(facilities.body.facilities, [], "unverified facilities are not offered");

    const blocked = await submitCase(patient, newAuthorityId, newFacilityId);
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /facility/i);

    const restored = await call(`/api/admin/directory/facilities/${newFacilityId}`, { method: "PATCH", body: JSON.stringify({ status: "VERIFIED" }) }, admin);
    assert.equal(restored.status, 200);

    const deactivated = await call(`/api/admin/directory/authorities/${newAuthorityId}`, { method: "PATCH", body: JSON.stringify({ status: "INACTIVE" }) }, admin);
    assert.equal(deactivated.status, 200);
    const afterDeactivate = await call("/api/public/jurisdictions");
    const indiaAfter = afterDeactivate.body.jurisdictions.find((j: { code: string }) => j.code === "IN");
    assert.equal(indiaAfter.authorities.some((a: { id: string }) => a.id === newAuthorityId), false);
    const blockedByAuthority = await submitCase(patient, newAuthorityId, newFacilityId);
    assert.equal(blockedByAuthority.status, 400);
    assert.match(blockedByAuthority.body.error, /authority/i);

    await call(`/api/admin/directory/authorities/${newAuthorityId}`, { method: "PATCH", body: JSON.stringify({ status: "ACTIVE" }) }, admin);
  });

  await t.test("deletion is blocked while cases or facilities reference the entry", async () => {
    const removeFacility = await call(`/api/admin/directory/facilities/${newFacilityId}`, { method: "DELETE" }, admin);
    assert.equal(removeFacility.status, 409);
    assert.match(removeFacility.body.error, /case/i);

    const removeAuthority = await call(`/api/admin/directory/authorities/${newAuthorityId}`, { method: "DELETE" }, admin);
    assert.equal(removeAuthority.status, 409);
    assert.match(removeAuthority.body.error, /facilit/i);
  });

  await t.test("unreferenced entries are deleted and audited", async () => {
    const authority = await call(
      "/api/admin/directory/authorities",
      { method: "POST", body: JSON.stringify({ id: "IN-SHA-TMP", name: "Temporary Authority", region: "Test", adapter: "IN-REST", contactEmail: "tmp@example.gov.in", webhook: "https://sandbox.mednotice.in/tmp" }) },
      admin,
    );
    assert.equal(authority.status, 201);

    const facility = await call(
      "/api/admin/directory/facilities",
      { method: "POST", body: JSON.stringify({ id: "FAC-IN-TMP", name: "Temporary Facility", authorityId: "IN-SHA-TMP" }) },
      admin,
    );
    assert.equal(facility.status, 201);

    const facilityRemoved = await call("/api/admin/directory/facilities/FAC-IN-TMP", { method: "DELETE" }, admin);
    assert.equal(facilityRemoved.status, 200);

    const authorityRemoved = await call("/api/admin/directory/authorities/IN-SHA-TMP", { method: "DELETE" }, admin);
    assert.equal(authorityRemoved.status, 200);

    const missing = await call("/api/admin/directory/authorities/IN-SHA-TMP", { method: "DELETE" }, admin);
    assert.equal(missing.status, 404);

    const chain = verifyAuditChain();
    assert.equal(chain.valid, true, `audit chain broken at ${chain.brokenAt}`);

    const audit = await call("/api/admin/audit?limit=200", {}, admin);
    const actions = new Set(audit.body.rows.map((r: { action: string }) => r.action));
    for (const action of ["AUTHORITY_CREATED", "AUTHORITY_UPDATED", "AUTHORITY_DELETED", "FACILITY_CREATED", "FACILITY_UPDATED", "FACILITY_DELETED"]) {
      assert.ok(actions.has(action), `missing audit action ${action}`);
    }
  });
});
