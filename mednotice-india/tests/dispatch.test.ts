import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildPdf } from "./fixtures.js";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-dispatch-"));

const { seed } = await import("../server/seed.js");
const { createApp } = await import("../server/app.js");
const { get, run } = await import("../server/db.js");
const { parseStatusResponse, statusEndpointFor, buildStatusRequest, simulatedStatus } = await import("../server/adapters/status.js");
const { mapRemoteStatus } = await import("../server/authority-status.js");
const { runDispatchCycle, runSyncCycle, pendingDispatchCases, dispatchEligibility, schedulerState } = await import("../server/scheduler.js");
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

function submitForm(): FormData {
  const form = new FormData();
  form.set("country", "IN");
  form.set("authorityId", "IN-MOHFW");
  form.set("facilityId", "FAC-IN-001");
  form.set("category", "Negligence");
  form.set("complaint", "My mother waited four hours in the emergency room with chest pain and died before anyone treated her.");
  form.set("symptoms", "Crushing chest pain, diaphoresis, shortness of breath.");
  form.set("patientName", "Asha Nair");
  form.set("patientEmail", "asha.nair@example.in");
  form.set("consentDataSharing", "true");
  form.append("documents", new Blob([new Uint8Array(buildPdf())], { type: "application/pdf" }), "ed_record.pdf");
  return form;
}

/* ----------------------------- parser units ----------------------------- */

test("status endpoint is derived from the delivery endpoint and supports placeholders", () => {
  const caseRow = { id: "CASE-2026-000999" } as never;
  const derived = statusEndpointFor(
    { code: "IN-REST-DL", kind: "REST", endpoint: "https://authority.test/health/complaints", authType: "NONE", mapping: {}, simulate: true },
    caseRow,
  );
  assert.ok(derived);
  assert.ok(derived!.includes("CASE-2026-000999"));
  assert.ok(derived!.endsWith("/status?caseId=CASE-2026-000999"));

  const configured = statusEndpointFor(
    {
      code: "IN-REST-DL",
      kind: "REST",
      endpoint: "https://authority.test/health/complaints",
      statusEndpoint: "https://authority.test/grievance/{{caseId}}?ref={{reference}}",
      authType: "BEARER",
      authConfig: { token: "secret-token" },
      mapping: {},
      simulate: true,
    },
    caseRow,
    "REF-9",
  );
  assert.equal(configured, "https://authority.test/grievance/CASE-2026-000999?ref=REF-9");

  const request = buildStatusRequest(
    {
      code: "IN-REST-DL",
      kind: "REST",
      endpoint: "https://authority.test/health/complaints",
      statusEndpoint: "https://authority.test/grievance/{{caseId}}",
      authType: "BEARER",
      authConfig: { token: "secret-token" },
      mapping: {},
      simulate: true,
    },
    caseRow,
  );
  assert.equal(request?.method, "GET");
  assert.equal(request?.headers.authorization, "Bearer secret-token");
});

test("status responses are parsed for JSON, FHIR, HL7 and XML authorities", () => {
  const json = parseStatusResponse("REST", 200, JSON.stringify({ data: { caseStatus: "under review", ticketId: "GRV-88", remark: "Awaiting response from facility" } }));
  assert.equal(json.ok, true);
  assert.equal(json.status, "UNDER_REVIEW");
  assert.equal(json.reference, "GRV-88");
  assert.equal(json.message, "Awaiting response from facility");

  const fhir = parseStatusResponse("FHIR", 200, JSON.stringify({ resourceType: "Task", status: "in-progress", identifier: [{ value: "TASK-12" }] }));
  assert.equal(fhir.ok, true);
  assert.equal(fhir.status, "IN_PROGRESS");
  assert.equal(fhir.reference, "TASK-12");

  const hl7 = parseStatusResponse("HL7v2", 200, "MSH|^~\\&|A|B|C|D|20260101||ACK|1|P|2.5\rORC|RE|ORC-77|SC\rOBX|1|ST|STATUS|Under Review\r");
  assert.equal(hl7.ok, true);
  assert.equal(hl7.status, "UNDER_REVIEW");

  const xml = parseStatusResponse("SOAP", 200, "<Envelope><Body><StatusResponse><Status>RESOLVED</Status><Reference>REF-3</Reference></StatusResponse></Body></Envelope>");
  assert.equal(xml.ok, true);
  assert.equal(xml.status, "RESOLVED");
  assert.equal(xml.reference, "REF-3");

  const failure = parseStatusResponse("REST", 503, "service unavailable");
  assert.equal(failure.ok, false);
  assert.equal(failure.status, null);
});

test("remote statuses map onto the internal workflow", () => {
  assert.equal(mapRemoteStatus("RESOLVED"), "RESOLVED");
  assert.equal(mapRemoteStatus("CLOSED"), "RESOLVED");
  assert.equal(mapRemoteStatus("ACKNOWLEDGED"), "UNDER_REVIEW");
  assert.equal(mapRemoteStatus("ESCALATED"), "UNDER_REVIEW");
  assert.equal(mapRemoteStatus("SOMETHING_ELSE"), null);
  assert.equal(mapRemoteStatus(null), null);
});

test("sandbox simulation is deterministic and reports a status", () => {
  const caseRow = { id: "CASE-2026-000101" } as never;
  const sim = simulatedStatus(caseRow, null, new Date().toISOString());
  assert.equal(sim.status, "ACKNOWLEDGED");
  assert.equal(sim.reference, "SIM-CASE-2026-000101");
  assert.ok((sim.message ?? "").length > 0);
});

/* --------------------------- dispatch workflow --------------------------- */

test("the dispatch cron transmits verified cases that the authority has not accepted", async () => {
  const caseId = "CASE-2026-900001";
  const now = new Date().toISOString();
  run(
    `INSERT INTO cases (id, patient_name_masked, patient_email_masked, country, region, authority_id, facility_id, facility_name,
      category, category_confidence, priority, priority_score, triage_json, complaint_enc, timeline_json, status,
      verification_status, consent_data_sharing, cross_border_allowed, language, source, created_at, updated_at, sla_due_at)
     VALUES (?, 'T*** K***', 't***@e***.in', 'IN', 'Delhi', 'IN-SHA-DL', 'FAC-IN-002', 'Safdarjung Hospital',
      'Billing Fraud', 0.8, 'P2', 40, '{}', 'enc', '[]', 'SUBMITTED', 'VERIFIED', 1, 0, 'en', 'TEST', ?, ?, ?)`,
    caseId,
    now,
    now,
    new Date(Date.now() + 43_200_000).toISOString(),
  );

  const pending = pendingDispatchCases(50).map((p) => p.caseRow.id);
  assert.ok(pending.includes(caseId), "the case should be waiting for dispatch");

  const eligibility = dispatchEligibility(caseId);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.reason, "ready to dispatch");

  const summary = await runDispatchCycle(25);
  assert.ok(summary.dispatched >= 1, `expected a dispatch, got ${JSON.stringify(summary)}`);
  assert.ok(summary.caseIds.includes(caseId));

  const transmission = get<{ status: string; reference: string | null }>(
    "SELECT status, reference FROM transmissions WHERE case_id = ? ORDER BY created_at DESC LIMIT 1",
    caseId,
  );
  assert.equal(transmission?.status, "DELIVERED");
  assert.ok(transmission?.reference);

  const routed = get<{ status: string; authority_reference: string | null }>("SELECT status, authority_reference FROM cases WHERE id = ?", caseId)!;
  assert.equal(routed.status, "ROUTED");
  assert.equal(routed.authority_reference, transmission?.reference);

  // A case the authority already accepted is never re-transmitted.
  assert.equal(dispatchEligibility(caseId).eligible, false);
  assert.ok(!pendingDispatchCases(50).map((p) => p.caseRow.id).includes(caseId));

  const state = schedulerState();
  assert.equal(state.lastDispatch?.dispatched, summary.dispatched);
});

test("the status cron pulls the department status and applies it to the case", async () => {
  const routedCase = get<{ id: string }>(
    "SELECT id FROM cases WHERE status = 'ROUTED' AND verification_status = 'VERIFIED' AND EXISTS (SELECT 1 FROM transmissions t WHERE t.case_id = cases.id AND t.status = 'DELIVERED') LIMIT 1",
  )!;
  assert.ok(routedCase, "expected a routed case");

  const summary = await runSyncCycle(25);
  assert.ok(summary.synced >= 1, `expected a status sync, got ${JSON.stringify(summary)}`);

  const updated = get<{ status: string; authority_status: string | null; authority_status_at: string | null }>(
    "SELECT status, authority_status, authority_status_at FROM cases WHERE id = ?",
    routedCase.id,
  )!;
  assert.ok(updated.authority_status, "the authority status should be stored on the case");
  assert.ok(updated.authority_status_at);
  assert.equal(updated.status, "UNDER_REVIEW");

  const sync = get<{ remote_status: string; applied: number; simulated: number; status: string }>(
    "SELECT remote_status, applied, simulated, status FROM case_status_syncs WHERE case_id = ? ORDER BY checked_at DESC LIMIT 1",
    routedCase.id,
  )!;
  assert.equal(sync.status, "SUCCESS");
  assert.equal(sync.applied, 1);
  assert.equal(sync.simulated, 1);
  assert.ok(sync.remote_status);
});

test("a case that was never transmitted is not polled", async () => {
  const caseId = "CASE-2026-900002";
  const now = new Date().toISOString();
  run(
    `INSERT INTO cases (id, patient_name_masked, patient_email_masked, country, region, authority_id, facility_id, facility_name,
      category, category_confidence, priority, priority_score, triage_json, complaint_enc, timeline_json, status,
      verification_status, consent_data_sharing, cross_border_allowed, language, source, created_at, updated_at, sla_due_at)
     VALUES (?, 'U*** P***', 'u***@e***.in', 'IN', 'Delhi', 'IN-SHA-DL', 'FAC-IN-002', 'Safdarjung Hospital',
      'Billing Fraud', 0.8, 'P2', 40, '{}', 'enc', '[]', 'SUBMITTED', 'VERIFIED', 1, 0, 'en', 'TEST', ?, ?, ?)`,
    caseId,
    now,
    now,
    new Date(Date.now() + 43_200_000).toISOString(),
  );

  const { syncCaseStatus } = await import("../server/authority-status.js");
  const outcome = await syncCaseStatus(caseId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "not-dispatched");
  assert.equal(outcome.applied, false);
});

/* ------------------------------ admin API -------------------------------- */

test("the dispatch desk API reports the last data sent and the status history", async () => {
  const cookie = await login("admin@mednotice.in", "Admin!2345");

  const status = await fetch(`${base}/api/admin/dispatch/status`, { headers: { cookie } });
  const statusBody = await status.json();
  assert.equal(status.status, 200, JSON.stringify(statusBody));
  assert.ok(statusBody.scheduler);
  assert.equal(typeof statusBody.scheduler.dispatchIntervalMs, "number");
  assert.ok(statusBody.queue.awaitingDispatch >= 0);
  assert.ok(statusBody.transmissions.total > 0);
  assert.ok(statusBody.transmissions.lastSentAt);
  assert.ok(statusBody.statusSyncs.total > 0);

  const transmissions = await fetch(`${base}/api/admin/dispatch/transmissions?limit=5`, { headers: { cookie } });
  const transmissionBody = await transmissions.json();
  assert.equal(transmissions.status, 200);
  assert.ok(transmissionBody.transmissions.length > 0);
  const first = transmissionBody.transmissions[0];
  assert.ok(first.caseId);
  assert.ok(first.adapterCode);
  assert.ok(first.createdAt);
  assert.ok(first.case.authorityName);
  assert.equal(JSON.stringify(transmissionBody).includes("asha.nair@example.in"), false);

  const syncs = await fetch(`${base}/api/admin/dispatch/syncs?limit=5`, { headers: { cookie } });
  const syncBody = await syncs.json();
  assert.equal(syncs.status, 200);
  assert.ok(syncBody.syncs.length > 0);
  assert.ok(syncBody.syncs[0].checkedAt);
  assert.ok(["SUCCESS", "UNCHANGED", "FAILED"].includes(syncBody.syncs[0].status));

  const queue = await fetch(`${base}/api/admin/dispatch/queue`, { headers: { cookie } });
  const queueBody = await queue.json();
  assert.equal(queue.status, 200);
  assert.ok(Array.isArray(queueBody.pending));
  assert.ok(Array.isArray(queueBody.dueForSync));
});

test("a staff reviewer can run a cycle on demand and a patient cannot", async () => {
  const reviewer = await login("reviewer@mohfw.gov.in", "Review!2345");
  const run = await fetch(`${base}/api/admin/dispatch/sync`, { method: "POST", headers: { cookie: reviewer } });
  assert.equal(run.status, 200);
  const body = await run.json();
  assert.ok(body.summary);
  assert.equal(typeof body.summary.synced, "number");

  const patient = await login("patient@demo.in", "Patient!2345");
  const forbidden = await fetch(`${base}/api/admin/dispatch/status`, { headers: { cookie: patient } });
  assert.equal(forbidden.status, 403);
});

test("the case detail exposes the latest authority status and its history", async () => {
  const cookie = await login("admin@mednotice.in", "Admin!2345");
  const routedCase = get<{ id: string }>("SELECT id FROM cases WHERE authority_status IS NOT NULL LIMIT 1")!;
  const res = await fetch(`${base}/api/cases/${routedCase.id}`, { headers: { cookie } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.authorityStatus.status);
  assert.ok(body.authorityStatus.checkedAt);
  assert.ok(Array.isArray(body.authorityStatus.history));
  assert.ok(body.authorityStatus.history.length > 0);
  assert.equal(body.case.authorityStatus, body.authorityStatus.status);
});

test("the audit chain stays intact after the dispatch cycles", () => {
  const chain = verifyAuditChain();
  assert.equal(chain.valid, true, `broken at ${chain.brokenAt}`);
  assert.ok(chain.checked > 30);
});
