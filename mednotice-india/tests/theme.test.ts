import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-theme-"));

const { seed } = await import("../server/seed.js");
const { createApp } = await import("../server/app.js");
const { verifyAuditChain } = await import("../server/audit.js");
const { get } = await import("../server/db.js");

await seed();
const app = createApp({ staticDir: null });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
});

type ThemeBody = {
  theme: {
    patient: string;
    admin: string;
    defaultTheme: string;
    updatedAt: string | null;
    updatedBy: string | null;
    presets: { id: string; name: string; family: string }[];
  };
};

async function readTheme(): Promise<ThemeBody["theme"]> {
  const res = await fetch(`${base}/api/public/theme`);
  assert.equal(res.status, 200);
  return ((await res.json()) as ThemeBody).theme;
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

function patchTheme(cookie: string | null, body: unknown): Promise<Response> {
  return fetch(`${base}/api/admin/theme`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test("appearance themes", async (t) => {
  await t.test("the public palette read needs no session and defaults to midnight", async () => {
    const theme = await readTheme();
    assert.equal(theme.patient, "midnight");
    assert.equal(theme.admin, "midnight");
    assert.equal(theme.defaultTheme, "midnight");
    assert.deepEqual(
      theme.presets.map((preset) => preset.id),
      ["midnight", "assam-health", "national-health", "enterprise"],
    );
    assert.equal(theme.presets.filter((preset) => preset.family === "government").length, 2);
  });

  await t.test("only a super administrator may repaint the platform", async () => {
    assert.equal((await patchTheme(null, { patient: "enterprise" })).status, 401);

    const patient = await login("patient@demo.in", "Patient!2345");
    assert.equal((await patchTheme(patient, { patient: "enterprise" })).status, 403);

    const reviewer = await login("reviewer@mohfw.gov.in", "Review!2345");
    assert.equal((await patchTheme(reviewer, { admin: "enterprise" })).status, 403);

    const auditor = await login("auditor@mednotice.in", "Audit!2345");
    assert.equal((await patchTheme(auditor, { admin: "enterprise" })).status, 403);

    // Nothing was written by any refused attempt.
    const theme = await readTheme();
    assert.equal(theme.patient, "midnight");
    assert.equal(theme.admin, "midnight");
  });

  await t.test("a super administrator switches each surface independently", async () => {
    const admin = await login("admin@mednotice.in", "Admin!2345");

    const first = await patchTheme(admin, { patient: "assam-health" });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as ThemeBody;
    assert.equal(firstBody.theme.patient, "assam-health");
    assert.equal(firstBody.theme.admin, "midnight");
    assert.equal(firstBody.theme.updatedBy, "admin@mednotice.in");
    assert.ok(firstBody.theme.updatedAt);

    // The patient portal sees it without any other change.
    assert.equal((await readTheme()).patient, "assam-health");

    const second = await patchTheme(admin, { admin: "enterprise" });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as ThemeBody;
    assert.equal(secondBody.theme.patient, "assam-health");
    assert.equal(secondBody.theme.admin, "enterprise");

    // Switching back to the government palette in one call, as a demo would.
    const third = await patchTheme(admin, { patient: "national-health", admin: "assam-health" });
    assert.equal(third.status, 200);
    const thirdBody = (await third.json()) as ThemeBody;
    assert.equal(thirdBody.theme.patient, "national-health");
    assert.equal(thirdBody.theme.admin, "assam-health");
  });

  await t.test("unknown or empty changes are rejected and the stored palette survives", async () => {
    const admin = await login("admin@mednotice.in", "Admin!2345");

    assert.equal((await patchTheme(admin, { patient: "neon" })).status, 400);
    assert.equal((await patchTheme(admin, { admin: "../../etc/passwd" })).status, 400);
    assert.equal((await patchTheme(admin, {})).status, 400);

    const theme = await readTheme();
    assert.equal(theme.patient, "national-health");
    assert.equal(theme.admin, "assam-health");
  });

  await t.test("every change is written to the audit chain", async () => {
    const row = get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'THEME_UPDATED'");
    assert.equal(Number(row?.n ?? 0), 3);
    assert.equal(verifyAuditChain().valid, true);
  });
});
