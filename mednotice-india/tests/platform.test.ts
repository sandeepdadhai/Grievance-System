import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-platform-"));

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

type JsonResult = { status: number; body: any; cookie: string };

async function call(pathname: string, init: RequestInit = {}, cookie?: string): Promise<JsonResult> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${base}${pathname}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

async function login(email: string, password: string): Promise<string> {
  const res = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.cookie;
}

test("patient self-service and community", async (t) => {
  const admin = await login("admin@mednotice.in", "Admin!2345");
  const patientCookie = await login("patient@demo.in", "Patient!2345");
  let customKey = "";
  let customUserCookie = "";
  let guestPostId = "";
  let patientPostId = "";
  let seedCommentId = "";

  await t.test("signup rejects weak passwords and duplicate emails", async () => {
    const weak = await call("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Test Person", email: "weak@example.in", password: "short", consent: true }),
    });
    assert.equal(weak.status, 400);

    const noConsent = await call("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Test Person", email: "noconsent@example.in", password: "Strong!Passw0rd", consent: false }),
    });
    assert.equal(noConsent.status, 400);

    const duplicate = await call("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Meera Sharma", email: "patient@demo.in", password: "Strong!Passw0rd", consent: true }),
    });
    assert.equal(duplicate.status, 409);
  });

  await t.test("a new patient signs up, gets a patient session and cannot reach staff APIs", async () => {
    const res = await call("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Kavya Menon", email: "kavya.menon@example.in", password: "Strong!Passw0rd", consent: true }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.role, "PATIENT");
    assert.equal(res.body.user.baseRole, "PATIENT");
    assert.deepEqual(res.body.user.permissions, []);
    assert.ok(res.cookie.startsWith("mni_session="));

    const me = await call("/api/auth/me", {}, res.cookie);
    assert.equal(me.body.user.name, "Kavya Menon");
    assert.equal(me.body.user.baseRole, "PATIENT");

    const adminAttempt = await call("/api/admin/overview", {}, res.cookie);
    assert.equal(adminAttempt.status, 403);

    const mine = await call("/api/cases/mine", {}, res.cookie);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.cases, []);

    const post = await call(
      "/api/community/posts",
      {
        method: "POST",
        body: JSON.stringify({ title: "Posting as a signed-in patient", body: "This body is long enough to pass the twenty character minimum for community posts.", topic: "Feedback", guidelines: true }),
      },
      res.cookie,
    );
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assert.equal(post.body.post.isGuest, false);
    assert.equal(post.body.post.authorName, "Kavya Menon");
  });

  await t.test("guest and patient posts and comments appear in the community feed", async () => {
    const guest = await call("/api/community/posts", {
      method: "POST",
      body: JSON.stringify({ title: "Guest question about discharge paperwork", body: "The hospital kept my discharge summary and I only have a photo of the bill. Is that enough to file?", topic: "Documents", authorName: "Guest from Nagpur", guidelines: true }),
    });
    assert.equal(guest.status, 201, JSON.stringify(guest.body));
    assert.equal(guest.body.post.isGuest, true);
    guestPostId = guest.body.post.id;

    const missingName = await call("/api/community/posts", {
      method: "POST",
      body: JSON.stringify({ title: "Another guest post without a name", body: "This should be rejected because guest authors must supply a display name.", topic: "General", guidelines: true }),
    });
    assert.equal(missingName.status, 400);

    const comment = await call(`/api/community/posts/${guestPostId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "A photo of the bill plus the hospital's discharge summary is usually enough.", authorName: "Guest from Surat", guidelines: true }),
    });
    assert.equal(comment.status, 201);

    const patientPost = await call(
      "/api/community/posts",
      {
        method: "POST",
        body: JSON.stringify({ title: "Patient post about a billing query", body: "I was charged for consumables that were never explained on the itemised bill.", topic: "Billing", guidelines: true }),
      },
      patientCookie,
    );
    assert.equal(patientPost.status, 201);
    patientPostId = patientPost.body.post.id;

    const feed = await call("/api/community/posts");
    assert.equal(feed.status, 200);
    assert.ok(feed.body.posts.some((p: { id: string }) => p.id === guestPostId));
    assert.ok(feed.body.posts.some((p: { id: string }) => p.id === patientPostId));
    assert.equal(feed.body.posts.some((p: { status: string }) => p.status !== "VISIBLE"), false);

    const detail = await call(`/api/community/posts/${guestPostId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.comments.length, 1);
  });

  await t.test("super admin creates a custom role and assigns it", async () => {
    const roles = await call("/api/admin/roles", {}, admin);
    assert.equal(roles.status, 200);
    assert.ok(roles.body.roles.some((r: { key: string }) => r.key === "SUPER_ADMIN"));
    assert.ok(roles.body.permissions.length >= 8);

    const created = await call(
      "/api/admin/roles",
      {
        method: "POST",
        body: JSON.stringify({
          name: "District Grievance Officer",
          description: "Reviews cases and moderates the community for a district team.",
          baseRole: "MINISTRY_REVIEWER",
          permissions: ["cases.view", "cases.review", "community.moderate", "audit.view"],
        }),
      },
      admin,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    customKey = created.body.role.key;
    assert.ok(customKey.startsWith("ROLE_"));
    assert.equal(created.body.role.builtin, false);
    assert.deepEqual(created.body.role.permissions.sort(), ["audit.view", "cases.review", "cases.view", "community.moderate"]);

    const unknownRole = await call(
      "/api/admin/users",
      {
        method: "POST",
        body: JSON.stringify({ name: "Unknown Role", email: "unknown.role@example.in", password: "Strong!Passw0rd", role: "ROLE_NOT_REAL" }),
      },
      admin,
    );
    assert.equal(unknownRole.status, 400);

    const user = await call(
      "/api/admin/users",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Suresh Pillai",
          email: "suresh.pillai@example.in",
          password: "Strong!Passw0rd",
          role: customKey,
          country: "IN",
          organisation: "District grievance cell",
        }),
      },
      admin,
    );
    assert.equal(user.status, 201, JSON.stringify(user.body));
    assert.equal(user.body.user.role, customKey);

    customUserCookie = await login("suresh.pillai@example.in", "Strong!Passw0rd");
    const me = await call("/api/auth/me", {}, customUserCookie);
    assert.equal(me.body.user.role, customKey);
    assert.equal(me.body.user.roleName, "District Grievance Officer");
    assert.equal(me.body.user.baseRole, "MINISTRY_REVIEWER");
    assert.ok(me.body.user.permissions.includes("community.moderate"));

    const patientRoleAttempt = await call(
      "/api/admin/roles",
      { method: "POST", body: JSON.stringify({ name: "Escalation", baseRole: "MINISTRY_REVIEWER", permissions: [] }) },
      patientCookie,
    );
    assert.equal(patientRoleAttempt.status, 403);

    const inUse = await call(`/api/admin/roles/${customKey}`, { method: "DELETE" }, admin);
    assert.equal(inUse.status, 409);

    const builtinDelete = await call("/api/admin/roles/MINISTRY_REVIEWER", { method: "DELETE" }, admin);
    assert.equal(builtinDelete.status, 400);
  });

  await t.test("custom role permissions gate case actions and community moderation", async () => {
    const cases = await call("/api/admin/cases", {}, customUserCookie);
    assert.equal(cases.status, 200);

    const moderation = await call("/api/admin/community/posts", {}, customUserCookie);
    assert.equal(moderation.status, 200);
    assert.ok(moderation.body.posts.length >= 4);

    const audit = await call("/api/admin/audit", {}, customUserCookie);
    assert.equal(audit.status, 200);

    const overrides = await call(
      "/api/admin/cases/CASE-2026-000101/override",
      { method: "POST", body: JSON.stringify({ priority: "P2", note: "Attempt without the resolve capability." }) },
      customUserCookie,
    );
    assert.equal(overrides.status, 403);
    assert.match(overrides.body.error, /permission/i);

    // A role without community.moderate cannot reach the moderation API.
    const createViewer = await call(
      "/api/admin/roles",
      { method: "POST", body: JSON.stringify({ name: "Case Viewer", baseRole: "SYSTEM_AUDITOR", permissions: ["cases.view"] }) },
      admin,
    );
    assert.equal(createViewer.status, 201);
    const viewerUser = await call(
      "/api/admin/users",
      {
        method: "POST",
        body: JSON.stringify({ name: "Nisha Rao", email: "nisha.rao@example.in", password: "Strong!Passw0rd", role: createViewer.body.role.key }),
      },
      admin,
    );
    assert.equal(viewerUser.status, 201);
    const viewerCookie = await login("nisha.rao@example.in", "Strong!Passw0rd");
    const denied = await call("/api/admin/community/posts", {}, viewerCookie);
    assert.equal(denied.status, 403);
  });

  await t.test("moderators hide, edit and remove posts and comments", async () => {
    const hide = await call(
      `/api/admin/community/posts/${guestPostId}`,
      { method: "PATCH", body: JSON.stringify({ status: "HIDDEN", note: "Contains an unsupported claim during review" }) },
      customUserCookie,
    );
    assert.equal(hide.status, 200);
    assert.equal(hide.body.post.status, "HIDDEN");

    const publicDetail = await call(`/api/community/posts/${guestPostId}`);
    assert.equal(publicDetail.status, 404);
    const feed = await call("/api/community/posts");
    assert.equal(feed.body.posts.some((p: { id: string }) => p.id === guestPostId), false);

    const edit = await call(
      `/api/admin/community/posts/${patientPostId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "Billing query (edited by moderator)", body: "Removed a staff member's name from the original post. The billing question itself is unchanged.", note: "Removed personal identifier" }),
      },
      admin,
    );
    assert.equal(edit.status, 200);
    assert.match(edit.body.post.title, /edited by moderator/);
    assert.ok(edit.body.post.editedAt);

    const detail = await call("/api/admin/community/posts/POST-SEED-1/comments", {}, admin);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.comments.length, 2);
    seedCommentId = detail.body.comments[0].id;

    const hideComment = await call(
      `/api/admin/community/comments/${seedCommentId}`,
      { method: "PATCH", body: JSON.stringify({ status: "HIDDEN", note: "Off-topic" }) },
      admin,
    );
    assert.equal(hideComment.status, 200);
    const publicPost = await call("/api/community/posts/POST-SEED-1");
    assert.equal(publicPost.body.comments.length, 1);

    const remove = await call(`/api/admin/community/comments/${seedCommentId}`, { method: "DELETE" }, admin);
    assert.equal(remove.status, 200);
    const afterRemove = await call("/api/admin/community/posts/POST-SEED-1/comments", {}, admin);
    assert.equal(afterRemove.body.comments.length, 1);

    const restore = await call(
      `/api/admin/community/posts/${guestPostId}`,
      { method: "PATCH", body: JSON.stringify({ status: "VISIBLE" }) },
      admin,
    );
    assert.equal(restore.status, 200);
  });

  await t.test("assistant answers questions and checks a case without leaking", async () => {
    const faq = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "How do I file a grievance?" }) });
    assert.equal(faq.status, 200);
    assert.equal(faq.body.intent, "submit");
    assert.ok(faq.body.suggestions.some((s: { href: string }) => s.href === "/submit"));

    const emergency = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "My father has chest pain and cannot breathe" }) });
    assert.equal(emergency.body.intent, "emergency");
    assert.equal(emergency.body.emergency, true);
    assert.match(emergency.body.reply, /108/);

    const hindi = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "मेरी शिकायत की स्थिति क्या है?" }) });
    assert.equal(hindi.status, 200);
    assert.match(hindi.body.reply, /[\u0900-\u097F]/);

    const guestStatus = await call(
      "/api/chat",
      { method: "POST", body: JSON.stringify({ message: "What is the status of my case?", caseId: "CASE-2026-000101", accessCode: "DEMO-ACCESS" }) },
    );
    assert.equal(guestStatus.status, 200);
    assert.equal(guestStatus.body.caseStatus.id, "CASE-2026-000101");
    assert.match(guestStatus.body.reply, /CASE-2026-000101/);

    const denied = await call(
      "/api/chat",
      { method: "POST", body: JSON.stringify({ message: "Status please", caseId: "CASE-2026-000101", accessCode: "WRONG-CODE" }) },
    );
    assert.equal(denied.body.caseStatus, undefined);
    assert.equal(JSON.stringify(denied.body).includes("Negligence"), false);

    const patientStatus = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "What is the status of my case?" }) }, patientCookie);
    assert.equal(patientStatus.status, 200);
    assert.ok(patientStatus.body.caseStatus);
    assert.ok(patientStatus.body.caseStatus.id.startsWith("CASE-"));
  });

  await t.test("audit chain records the new moderation and role actions", async () => {
    const chain = verifyAuditChain();
    assert.equal(chain.valid, true, `audit chain broken at ${chain.brokenAt}`);

    const res = await call("/api/admin/audit?limit=200", {}, admin);
    assert.equal(res.status, 200);
    const actions = new Set(res.body.rows.map((r: { action: string }) => r.action));
    for (const action of ["PATIENT_SIGNUP", "ROLE_CREATED", "USER_CREATED", "COMMUNITY_POST_CREATED", "COMMUNITY_POST_MODERATED", "COMMUNITY_COMMENT_REMOVED", "CHAT_CASE_LOOKUP", "CHAT_CASE_LOOKUP_DENIED"]) {
      assert.ok(actions.has(action), `missing audit action ${action}`);
    }
  });
});
