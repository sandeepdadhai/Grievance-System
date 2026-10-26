import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-comm-"));

const { seed } = await import("../server/seed.js");
const { createApp } = await import("../server/app.js");
const { syncCaseStatus } = await import("../server/authority-status.js");
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

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0];
}

type Row = {
  id: string;
  kind: string;
  direction: string;
  ts: string;
  caseId: string | null;
  patientName: string | null;
  target: string;
  status: string;
  subject: string | null;
  summary: string | null;
  message: string | null;
  reference: string | null;
  request: string | null;
  response: string | null;
  audit: { id: number; ts: string; action: string; hash: string } | null;
};

type LogResponse = {
  rows: Row[];
  total: number;
  summary: { total: number; byKind: Record<string, number>; failed: number; lastSentAt: string | null; lastReceivedAt: string | null };
  kinds: string[];
  statuses: string[];
  scope: string;
};

async function getLog(cookie: string, query = ""): Promise<{ status: number; body: LogResponse }> {
  const res = await fetch(`${base}/api/admin/communications${query}`, { headers: { cookie } });
  const body = (await res.json()) as LogResponse;
  return { status: res.status, body };
}

test("communication log", async (t) => {
  const adminCookie = await login("admin@mednotice.in", "Admin!2345");

  // A status pull, so the log contains every kind of message.
  const routed = get<{ id: string }>(
    "SELECT id FROM cases WHERE status = 'ROUTED' AND verification_status = 'VERIFIED' ORDER BY id LIMIT 1",
  );
  assert.ok(routed?.id, "the seed must contain a routed case");
  await syncCaseStatus(routed!.id);

  await t.test("merges every channel into one chronological stream", async () => {
    const { status, body } = await getLog(adminCookie, "?limit=200");
    assert.equal(status, 200);
    const kinds = new Set(body.rows.map((r) => r.kind));
    assert.ok(kinds.has("NOTIFICATION"), "notifications are missing");
    assert.ok(kinds.has("TRANSMISSION"), "transmissions are missing");
    assert.ok(kinds.has("STATUS_SYNC"), "status pulls are missing");
    assert.ok(body.rows.length > 0);
    assert.ok(body.total >= body.rows.length);
    assert.deepEqual(body.kinds, ["NOTIFICATION", "TRANSMISSION", "STATUS_SYNC", "WEBHOOK_EVENT", "COMMUNITY_POST", "COMMUNITY_COMMENT"]);
    assert.ok(body.summary.byKind.NOTIFICATION > 0);
    assert.ok(body.summary.byKind.TRANSMISSION > 0);
    assert.ok(body.summary.lastSentAt, "the log must report when data was last sent");
  });

  await t.test("rows are ordered newest first", async () => {
    const { body } = await getLog(adminCookie, "?limit=200");
    const times = body.rows.map((r) => new Date(r.ts).getTime());
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] >= times[i], `row ${i} is out of order`);
    }
  });

  await t.test("every message is linked to its hash-chained audit entry", async () => {
    const { body } = await getLog(adminCookie, "?limit=200");
    const transmissions = body.rows.filter((r) => r.kind === "TRANSMISSION");
    const notifications = body.rows.filter((r) => r.kind === "NOTIFICATION");
    const syncs = body.rows.filter((r) => r.kind === "STATUS_SYNC");
    assert.ok(transmissions.length > 0);
    assert.ok(notifications.length > 0);
    assert.ok(syncs.length > 0);

    for (const row of [...transmissions, ...notifications, ...syncs]) {
      assert.ok(row.audit, `${row.kind} ${row.id} is missing its audit-chain entry`);
      assert.equal(row.audit.hash.length, 64);
      assert.ok(row.audit.id > 0);
    }
    assert.ok(transmissions.every((r) => r.audit!.action === "CASE_ROUTED"));
    assert.ok(notifications.every((r) => r.audit!.action.startsWith("NOTIFICATION_")));
    assert.ok(syncs.every((r) => r.audit!.action.startsWith("AUTHORITY_STATUS_")));
  });

  await t.test("filters narrow the log by kind, case, status and free text", async () => {
    const byKind = await getLog(adminCookie, "?kind=NOTIFICATION&limit=200");
    assert.equal(byKind.status, 200);
    assert.ok(byKind.body.rows.length > 0);
    assert.ok(byKind.body.rows.every((r) => r.kind === "NOTIFICATION"));

    const caseId = byKind.body.rows[0].caseId!;
    const byCase = await getLog(adminCookie, `?caseId=${caseId}&limit=200`);
    assert.ok(byCase.body.rows.length > 0);
    assert.ok(byCase.body.rows.every((r) => r.caseId === caseId));

    const byStatus = await getLog(adminCookie, "?status=FAILED&limit=200");
    assert.ok(byStatus.body.rows.every((r) => r.status === "FAILED"));

    const byText = await getLog(adminCookie, `?q=${encodeURIComponent("grievance")}&limit=200`);
    assert.equal(byText.status, 200);
    assert.ok(byText.body.rows.every((r) => `${r.target} ${r.subject ?? ""} ${r.summary ?? ""}`.toLowerCase().includes("grievance")));
  });

  await t.test("the log carries the masked payload that was actually sent", async () => {
    const { body } = await getLog(adminCookie, "?kind=TRANSMISSION&limit=10");
    const row = body.rows[0];
    assert.ok(row.request, "the sent payload must be retained");
    assert.ok(row.response, "the authority response must be retained");
    assert.equal(row.message, "Accepted by simulated authority endpoint");
    assert.equal(JSON.stringify(body).includes("Asha Nair"), false);
  });

  await t.test("patients cannot read the log and auditors can", async () => {
    const patient = await login("patient@demo.in", "Patient!2345");
    const forbidden = await fetch(`${base}/api/admin/communications`, { headers: { cookie: patient } });
    assert.equal(forbidden.status, 403);

    const auditor = await login("auditor@mednotice.in", "Audit!2345");
    const allowed = await getLog(auditor);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.scope, "INDIA");
  });

  await t.test("the audit chain is still intact after the log reads", async () => {
    const chain = verifyAuditChain();
    assert.equal(chain.valid, true, `broken at ${chain.brokenAt}`);
  });
});
