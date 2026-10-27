import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-trail-"));

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

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0];
}

type TrailRow = {
  id: string;
  recordType: "AUDIT" | "COMMUNICATION";
  ts: string;
  action: string;
  kind: string | null;
  direction: string | null;
  entityId: string | null;
  caseId: string | null;
  actorId: string | null;
  actorRole: string | null;
  status: string | null;
  channel: string | null;
  target: string | null;
  subject: string | null;
  hash: string | null;
  auditId: number | null;
  audit: { id: number; ts: string; action: string; hash: string } | null;
  details: Record<string, unknown> | null;
  request: string | null;
  response: string | null;
};

type TrailResponse = {
  rows: TrailRow[];
  total: number;
  counts: {
    total: number;
    audit: number;
    communications: number;
    failed: number;
    lastMessageAt: string | null;
    byKind: Record<string, number>;
  };
  chain: { valid: boolean; checked: number; brokenAt: number | null };
  canViewMessages: boolean;
  scope: string;
};

async function getTrail(cookie: string, query = ""): Promise<{ status: number; body: TrailResponse }> {
  const res = await fetch(`${base}/api/admin/audit/trail${query}`, { headers: { cookie } });
  const body = (await res.json()) as TrailResponse;
  return { status: res.status, body };
}

test("unified audit trail", async (t) => {
  const adminCookie = await login("admin@mednotice.demo", "Admin!2345");

  await t.test("merges decisions and messages into one chronological stream", async () => {
    const { status, body } = await getTrail(adminCookie, "?limit=200");
    assert.equal(status, 200);
    assert.ok(body.rows.length > 0);

    const decisions = body.rows.filter((r) => r.recordType === "AUDIT");
    const messages = body.rows.filter((r) => r.recordType === "COMMUNICATION");
    assert.ok(decisions.length > 0, "the chain entries are missing");
    assert.ok(messages.length > 0, "the communications are missing");
    assert.equal(body.counts.audit, decisions.length);
    assert.equal(body.counts.communications, messages.length);
    assert.equal(body.counts.total, body.total);
    assert.equal(body.total, body.rows.length);

    const times = body.rows.map((r) => new Date(r.ts).getTime());
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] >= times[i], `row ${i} is out of order`);
    }
  });

  await t.test("every message carries the chain entry that proves it", async () => {
    const { body } = await getTrail(adminCookie, "?source=communications&limit=200");
    const messages = body.rows.filter((r) => r.recordType === "COMMUNICATION");
    const proven = messages.filter((r) => r.kind !== "WEBHOOK_EVENT");
    assert.ok(proven.length > 0);
    for (const row of proven) {
      assert.ok(row.audit, `${row.kind} ${row.entityId} is missing its chain entry`);
      assert.equal(row.audit!.hash.length, 64);
      assert.equal(row.hash, row.audit!.hash);
      assert.ok(row.auditId! > 0);
    }
    const notifications = messages.filter((r) => r.kind === "NOTIFICATION");
    const community = messages.filter((r) => r.kind === "COMMUNITY_POST");
    assert.ok(notifications.length > 0, "notifications must appear in the trail");
    assert.ok(community.length > 0, "community posts must appear in the trail");
    assert.ok(notifications.every((r) => r.action.startsWith("NOTIFICATION_")));
    assert.ok(community.every((r) => r.action.startsWith("COMMUNITY_POST")));
  });

  await t.test("filters narrow the ledger by record, type, action and case", async () => {
    const messagesOnly = await getTrail(adminCookie, "?source=communications&limit=200");
    assert.ok(messagesOnly.body.rows.every((r) => r.recordType === "COMMUNICATION"));

    const decisionsOnly = await getTrail(adminCookie, "?source=audit&limit=200");
    assert.ok(decisionsOnly.body.rows.every((r) => r.recordType === "AUDIT"));

    const notifications = await getTrail(adminCookie, "?kind=NOTIFICATION&limit=200");
    assert.ok(notifications.body.rows.length > 0);
    assert.ok(notifications.body.rows.every((r) => r.kind === "NOTIFICATION"));
    assert.ok(notifications.body.rows.every((r) => r.recordType === "COMMUNICATION"));

    // An action matches both the decision and the message it carried.
    const routed = await getTrail(adminCookie, "?action=CASE_ROUTED&limit=200");
    assert.ok(routed.body.rows.length > 0);
    assert.ok(routed.body.rows.every((r) => r.action === "CASE_ROUTED"));
    assert.ok(routed.body.rows.some((r) => r.recordType === "AUDIT"));
    assert.ok(routed.body.rows.some((r) => r.recordType === "COMMUNICATION"));

    const caseId = routed.body.rows.find((r) => r.caseId)?.caseId;
    assert.ok(caseId, "a routed case must be referenced");
    const byCase = await getTrail(adminCookie, `?caseId=${caseId}&limit=200`);
    assert.ok(byCase.body.rows.length > 0);
    assert.ok(byCase.body.rows.every((r) => r.caseId === caseId));

    const byText = await getTrail(adminCookie, `?q=${encodeURIComponent("CASE_ROUTED")}&limit=200`);
    assert.equal(byText.status, 200);
    assert.ok(byText.body.rows.length > 0);
  });

  await t.test("patients cannot read the trail and auditors can", async () => {
    const patient = await login("patient@demo.io", "Patient!2345");
    const forbidden = await fetch(`${base}/api/admin/audit/trail`, { headers: { cookie: patient } });
    assert.equal(forbidden.status, 403);

    const auditor = await login("auditor@mednotice.demo", "Audit!2345");
    const allowed = await getTrail(auditor, "?limit=5");
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.scope, "GLOBAL");
    assert.equal(allowed.body.canViewMessages, true);
  });

  await t.test("readers without the delivery permission see decisions only", async () => {
    const roleRes = await fetch(`${base}/api/admin/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ name: "Trail reader", baseRole: "SYSTEM_AUDITOR", permissions: ["audit.view"] }),
    });
    assert.equal(roleRes.status, 201);
    const role = ((await roleRes.json()) as { role: { key: string } }).role;

    const userRes = await fetch(`${base}/api/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ email: "trail-reader@mednotice.in", name: "Trail Reader", password: "Trail!2345Reader", role: role.key }),
    });
    assert.equal(userRes.status, 201);

    const cookie = await login("trail-reader@mednotice.in", "Trail!2345Reader");
    const { status, body } = await getTrail(cookie, "?limit=50");
    assert.equal(status, 200);
    assert.equal(body.canViewMessages, false);
    assert.ok(body.rows.every((r) => r.recordType === "AUDIT"), "message payloads must stay hidden");
  });

  await t.test("the audit chain is still intact after the trail reads", async () => {
    const chain = verifyAuditChain();
    assert.equal(chain.valid, true, `broken at ${chain.brokenAt}`);
  });
});
