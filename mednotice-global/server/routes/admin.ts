import { Router } from "express";
import { z } from "zod";
import { all, count, get, nowIso, run } from "../db.js";
import { JURISDICTIONS, findAuthority, findJurisdiction, type Priority } from "../config.js";
import { encryptField, hashPassword, maskPayload, randomCode } from "../crypto.js";
import { audit, listAudit, verifyAuditChain } from "../audit.js";
import { assertCaseAccess, scopeCountry } from "../access.js";
import { asyncHandler, createRateLimiter, HttpError, meta, parseBody } from "../http.js";
import { requireAuth, requireRole, REVIEWER_ROLES, STAFF_ROLES } from "../auth.js";
import { caseToDto, type CaseRow, type DocumentRow, type Role, type UserRow } from "../models.js";
import { resolveAdapter, implementationFor } from "../adapters/index.js";
import { buildCasePayload, transmitCase } from "../routing.js";
import { processPendingNotifications, requeueNotification } from "../notifications.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole(...STAFF_ROLES));

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const boolish = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((v) => v === true || v === "true");
const strongPassword = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(200)
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[0-9]/, "Include a digit")
  .regex(/[^A-Za-z0-9]/, "Include a symbol");

/* ------------------------------- overview -------------------------------- */

adminRouter.get(
  "/overview",
  asyncHandler((req, res) => {
    const scope = scopeCountry(req);
    const scoped = scope ? " AND country = ?" : "";
    const p = scope ? [scope] : [];
    const now = nowIso();

    const totals =
      get<Record<string, number>>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('SUBMITTED','ROUTED','UNDER_REVIEW','PENDING_REVIEW','ROUTE_FAILED') THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN status = 'RESOLVED' THEN 1 ELSE 0 END) AS resolved,
                SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN verification_status = 'PENDING_MANUAL_REVIEW' THEN 1 ELSE 0 END) AS pendingVerification,
                SUM(CASE WHEN priority = 'P1' AND status NOT IN ('RESOLVED','REJECTED') THEN 1 ELSE 0 END) AS openP1,
                SUM(CASE WHEN sla_due_at < ? AND status NOT IN ('RESOLVED','REJECTED') THEN 1 ELSE 0 END) AS overdue
         FROM cases WHERE 1=1 ${scoped}`,
        now,
        ...p,
      ) ?? {};

    const resolution = get<{ hours: number | null }>(
      `SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) AS hours FROM cases WHERE resolved_at IS NOT NULL ${scoped}`,
      ...p,
    );
    const slaCompliance = get<{ met: number; total: number }>(
      `SELECT SUM(CASE WHEN resolved_at <= sla_due_at THEN 1 ELSE 0 END) AS met, COUNT(*) AS total
       FROM cases WHERE resolved_at IS NOT NULL ${scoped}`,
      ...p,
    );

    const byPriority = all<{ priority: string; n: number }>(`SELECT priority, COUNT(*) AS n FROM cases WHERE 1=1 ${scoped} GROUP BY priority`, ...p);
    const byCountry = all<{ country: string; n: number }>(`SELECT country, COUNT(*) AS n FROM cases WHERE 1=1 ${scoped} GROUP BY country ORDER BY n DESC`, ...p);
    const byCategory = all<{ category: string; n: number }>(`SELECT category, COUNT(*) AS n FROM cases WHERE 1=1 ${scoped} GROUP BY category ORDER BY n DESC`, ...p);
    const byStatus = all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM cases WHERE 1=1 ${scoped} GROUP BY status`, ...p);
    const verification = all<{ verification_status: string; n: number }>(
      `SELECT verification_status, COUNT(*) AS n FROM cases WHERE 1=1 ${scoped} GROUP BY verification_status`,
      ...p,
    );

    const since = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
    const trendRows = all<{ d: string; n: number }>(
      `SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM cases WHERE created_at >= ? ${scoped} GROUP BY d ORDER BY d`,
      since,
      ...p,
    );
    const trendMap = new Map(trendRows.map((r) => [r.d, Number(r.n)]));
    const trend = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10);
      return { date: d, count: trendMap.get(d) ?? 0 };
    });

    const recentRows = all<CaseRow>("SELECT * FROM cases WHERE 1=1 " + scoped + " ORDER BY created_at DESC LIMIT 8", ...p);
    const recent = recentRows.map((row) => {
      const dto = caseToDto(row, { role: "SYSTEM_AUDITOR", id: "system" });
      return {
        id: dto.id,
        patientName: dto.patientName,
        country: dto.country,
        facilityName: dto.facilityName,
        category: dto.category,
        priority: dto.priority,
        status: dto.status,
        verificationStatus: dto.verificationStatus,
        createdAt: dto.createdAt,
        slaDueAt: dto.slaDueAt,
      };
    });

    const notifications = get<Record<string, number>>(
      "SELECT SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed FROM notifications",
    );
    const transmissions = get<Record<string, number>>(
      "SELECT SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed, AVG(latency_ms) AS avgLatency FROM transmissions",
    );
    const chain = verifyAuditChain();

    res.json({
      totals: {
        total: Number(totals.total ?? 0),
        open: Number(totals.open ?? 0),
        resolved: Number(totals.resolved ?? 0),
        rejected: Number(totals.rejected ?? 0),
        pendingVerification: Number(totals.pendingVerification ?? 0),
        openP1: Number(totals.openP1 ?? 0),
        overdue: Number(totals.overdue ?? 0),
        avgResolutionHours: resolution?.hours ? Number(Number(resolution.hours).toFixed(1)) : null,
        slaCompliance: slaCompliance && Number(slaCompliance.total) > 0 ? Number(((Number(slaCompliance.met) / Number(slaCompliance.total)) * 100).toFixed(1)) : null,
      },
      byPriority,
      byCountry,
      byCategory,
      byStatus,
      verification,
      trend,
      recent,
      notifications: { queued: Number(notifications?.queued ?? 0), sent: Number(notifications?.sent ?? 0), failed: Number(notifications?.failed ?? 0) },
      transmissions: {
        delivered: Number(transmissions?.delivered ?? 0),
        failed: Number(transmissions?.failed ?? 0),
        avgLatencyMs: transmissions?.avgLatency ? Math.round(Number(transmissions.avgLatency)) : null,
      },
      auditChain: chain,
      scope: scope ?? "GLOBAL",
      generatedAt: nowIso(),
    });
  }),
);

/* --------------------------------- cases --------------------------------- */

adminRouter.get(
  "/cases",
  asyncHandler((req, res) => {
    const scope = scopeCountry(req);
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope) {
      where.push("c.country = ?");
      params.push(scope);
    }
    const q = str(req.query.q);
    if (q) {
      where.push("(c.id LIKE ? OR c.facility_name LIKE ? OR c.patient_name_masked LIKE ? OR c.patient_email_masked LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    for (const [key, column] of [
      ["priority", "c.priority"],
      ["status", "c.status"],
      ["country", "c.country"],
      ["category", "c.category"],
      ["verification", "c.verification_status"],
      ["assigned", "c.assigned_to"],
      ["authority", "c.authority_id"],
    ] as const) {
      const value = str(req.query[key]);
      if (value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    const from = str(req.query.from);
    const to = str(req.query.to);
    if (from) {
      where.push("c.created_at >= ?");
      params.push(from);
    }
    if (to) {
      where.push("c.created_at <= ?");
      params.push(`${to}T23:59:59.999Z`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25) || 25));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);

    const rows = all<CaseRow & { doc_count: number }>(
      `SELECT c.*, (SELECT COUNT(*) FROM documents d WHERE d.case_id = c.id) AS doc_count
       FROM cases c ${clause} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const total = Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM cases c ${clause}`, ...params)?.n ?? 0);

    res.json({
      total,
      limit,
      offset,
      cases: rows.map((row) => ({
        ...caseToDto(row, { role: req.user!.role as Role, id: req.user!.id }),
        documentCount: Number(row.doc_count),
        patientName: row.patient_name_masked,
        patientEmail: row.patient_email_masked,
      })),
    });
  }),
);

const overrideSchema = z.object({
  priority: z.enum(["P1", "P2", "P3", "P4"]).optional(),
  category: z.string().trim().min(2).max(60).optional(),
  assignedTo: z.string().trim().min(2).max(60).nullable().optional(),
  note: z.string().trim().min(10, "Document the reason for the override").max(2000),
  adapterCode: z.string().trim().min(2).max(40).optional(),
});

adminRouter.post(
  "/cases/:id/override",
  requireRole(...REVIEWER_ROLES),
  asyncHandler(async (req, res) => {
    const body = parseBody(overrideSchema, req.body);
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", req.params.id.toUpperCase());
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow, "write");
    const jurisdiction = findJurisdiction(caseRow.country);
    if (!jurisdiction) throw new HttpError(400, "Case jurisdiction is not configured");

    if (body.category && !jurisdiction.complaintCategories.includes(body.category)) {
      throw new HttpError(400, "Category is not valid for this jurisdiction");
    }
    let assigned = caseRow.assigned_to;
    if (body.assignedTo !== undefined) {
      if (body.assignedTo === null) assigned = null;
      else {
        const user = get<UserRow>("SELECT * FROM users WHERE id = ? AND active = 1", body.assignedTo);
        if (!user || user.role === "PATIENT") throw new HttpError(400, "Assignee must be an active staff member");
        assigned = user.id;
      }
    }

    const nextPriority = (body.priority ?? caseRow.priority) as Priority;
    const nextCategory = body.category ?? caseRow.category;
    const nextSla = new Date(
      new Date(caseRow.created_at).getTime() + jurisdiction.slaHours[nextPriority] * 3_600_000,
    ).toISOString();

    run(
      "UPDATE cases SET priority = ?, category = ?, assigned_to = ?, sla_due_at = ?, updated_at = ? WHERE id = ?",
      nextPriority,
      nextCategory,
      assigned,
      nextSla,
      nowIso(),
      caseRow.id,
    );

    run(
      `INSERT INTO case_reviews (id, case_id, reviewer_id, action, previous_json, new_json, note, created_at)
       VALUES (?, ?, ?, 'TRIAGE_OVERRIDE', ?, ?, ?, ?)`,
      `REV-${randomCode(9)}`,
      caseRow.id,
      req.user!.id,
      JSON.stringify({ priority: caseRow.priority, category: caseRow.category, assignedTo: caseRow.assigned_to, slaDueAt: caseRow.sla_due_at }),
      JSON.stringify({ priority: nextPriority, category: nextCategory, assignedTo: assigned, slaDueAt: nextSla }),
      body.note,
      nowIso(),
    );

    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "TRIAGE_OVERRIDE",
      entityType: "case",
      entityId: caseRow.id,
      ...meta(req),
      details: {
        note: body.note,
        previous: { priority: caseRow.priority, category: caseRow.category, assignedTo: caseRow.assigned_to },
        next: { priority: nextPriority, category: nextCategory, assignedTo: assigned },
      },
    });

    let transmission = null;
    if (body.adapterCode) {
      transmission = await transmitCase(caseRow.id, {
        adapterCode: body.adapterCode,
        actor: { id: req.user!.id, role: req.user!.role },
        ...meta(req),
      });
    }

    const fresh = get<CaseRow>("SELECT * FROM cases WHERE id = ?", caseRow.id)!;
    const docs = all<DocumentRow>("SELECT * FROM documents WHERE case_id = ?", caseRow.id);
    res.json({ case: caseToDto(fresh, { role: req.user!.role as Role, id: req.user!.id }, docs), transmission });
  }),
);

adminRouter.post(
  "/cases/:id/resolve",
  requireRole(...REVIEWER_ROLES),
  asyncHandler((req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().min(10).max(2000), outcome: z.string().trim().max(200).optional() }), req.body);
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", req.params.id.toUpperCase());
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow, "write");
    const now = nowIso();
    run("UPDATE cases SET status = 'RESOLVED', resolved_at = ?, updated_at = ? WHERE id = ?", now, now, caseRow.id);
    run(
      `INSERT INTO case_reviews (id, case_id, reviewer_id, action, previous_json, new_json, note, created_at)
       VALUES (?, ?, ?, 'CASE_RESOLVED', ?, ?, ?, ?)`,
      `REV-${randomCode(9)}`,
      caseRow.id,
      req.user!.id,
      JSON.stringify({ status: caseRow.status, resolvedAt: caseRow.resolved_at }),
      JSON.stringify({ status: "RESOLVED", resolvedAt: now, outcome: body.outcome ?? null }),
      body.note,
      now,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "CASE_RESOLVED",
      entityType: "case",
      entityId: caseRow.id,
      ...meta(req),
      details: { outcome: body.outcome ?? null, note: body.note },
    });
    res.json({ case: caseToDto({ ...caseRow, status: "RESOLVED", resolved_at: now, updated_at: now }, { role: req.user!.role as Role, id: req.user!.id }) });
  }),
);

adminRouter.post(
  "/cases/:id/reopen",
  requireRole(...REVIEWER_ROLES),
  asyncHandler((req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().min(10).max(2000) }), req.body);
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", req.params.id.toUpperCase());
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow, "write");
    run("UPDATE cases SET status = 'UNDER_REVIEW', resolved_at = NULL, updated_at = ? WHERE id = ?", nowIso(), caseRow.id);
    run(
      `INSERT INTO case_reviews (id, case_id, reviewer_id, action, previous_json, new_json, note, created_at)
       VALUES (?, ?, ?, 'CASE_REOPENED', ?, ?, ?, ?)`,
      `REV-${randomCode(9)}`,
      caseRow.id,
      req.user!.id,
      JSON.stringify({ status: caseRow.status, resolvedAt: caseRow.resolved_at }),
      JSON.stringify({ status: "UNDER_REVIEW" }),
      body.note,
      nowIso(),
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "CASE_REOPENED",
      entityType: "case",
      entityId: caseRow.id,
      ...meta(req),
      details: { note: body.note },
    });
    res.json({ ok: true });
  }),
);

const rerouteSchema = z.object({ adapterCode: z.string().trim().min(2).max(40).optional() });

adminRouter.post(
  "/cases/:id/reroute",
  requireRole(...REVIEWER_ROLES),
  asyncHandler(async (req, res) => {
    const body = parseBody(rerouteSchema, req.body);
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", req.params.id.toUpperCase());
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow, "write");
    const transmission = await transmitCase(caseRow.id, {
      adapterCode: body.adapterCode,
      actor: { id: req.user!.id, role: req.user!.role },
      ...meta(req),
    });
    res.json({ transmission });
  }),
);

/* --------------------------------- users --------------------------------- */

adminRouter.get(
  "/users",
  requireRole("SUPER_ADMIN"),
  asyncHandler((_req, res) => {
    const users = all(
      "SELECT id, email, name, role, country, organisation, active, mfa_enabled, last_login_at, created_at FROM users ORDER BY created_at",
    );
    res.json({ users });
  }),
);

const roleEnum = z.enum(["SUPER_ADMIN", "MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE", "SYSTEM_AUDITOR", "PATIENT"]);

adminRouter.post(
  "/users",
  requireRole("SUPER_ADMIN"),
  createRateLimiter({ bucket: "user-create", windowMs: 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        email: z.string().trim().toLowerCase().email().max(200),
        name: z.string().trim().min(2).max(120),
        password: strongPassword,
        role: roleEnum,
        country: z.string().trim().length(2).optional().or(z.literal("")),
        organisation: z.string().trim().max(160).optional().or(z.literal("")),
      }),
      req.body,
    );
    if (get("SELECT id FROM users WHERE email = ?", body.email)) throw new HttpError(409, "A user with that email already exists");
    const id = `USR-${randomCode(8)}`;
    run(
      "INSERT INTO users (id, email, name, password_hash, role, country, organisation, active, mfa_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)",
      id,
      body.email,
      body.name,
      await hashPassword(body.password),
      body.role,
      body.country || null,
      body.organisation || null,
      nowIso(),
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "USER_CREATED",
      entityType: "user",
      entityId: id,
      ...meta(req),
      details: { email: body.email, role: body.role, country: body.country || null },
    });
    res.status(201).json({ user: { id, email: body.email, name: body.name, role: body.role, country: body.country || null, organisation: body.organisation || null, active: 1 } });
  }),
);

adminRouter.patch(
  "/users/:id",
  requireRole("SUPER_ADMIN"),
  asyncHandler((req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        role: roleEnum.optional(),
        active: boolish.optional(),
        country: z.string().trim().length(2).nullable().optional(),
        organisation: z.string().trim().max(160).nullable().optional(),
      }),
      req.body,
    );
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", req.params.id);
    if (!user) throw new HttpError(404, "User not found");
    if (user.id === req.user!.id && (body.active === false || (body.role && body.role !== user.role))) {
      throw new HttpError(400, "You cannot deactivate or change the role of your own account");
    }
    if (user.role === "SUPER_ADMIN" && (body.active === false || (body.role && body.role !== "SUPER_ADMIN"))) {
      const admins = count("SELECT COUNT(*) AS n FROM users WHERE role = 'SUPER_ADMIN' AND active = 1");
      if (admins <= 1) throw new HttpError(400, "At least one active super administrator must remain");
    }
    run(
      "UPDATE users SET name = ?, role = ?, active = ?, country = ?, organisation = ? WHERE id = ?",
      body.name ?? user.name,
      body.role ?? user.role,
      body.active === undefined ? user.active : body.active ? 1 : 0,
      body.country === undefined ? user.country : body.country,
      body.organisation === undefined ? user.organisation : body.organisation,
      user.id,
    );
    if (body.active === false) run("DELETE FROM sessions WHERE user_id = ?", user.id);
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "USER_UPDATED",
      entityType: "user",
      entityId: user.id,
      ...meta(req),
      details: { changes: body, previousRole: user.role },
    });
    res.json({ ok: true });
  }),
);

adminRouter.post(
  "/users/:id/reset-password",
  requireRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ password: strongPassword }), req.body);
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", req.params.id);
    if (!user) throw new HttpError(404, "User not found");
    run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(body.password), user.id);
    run("DELETE FROM sessions WHERE user_id = ?", user.id);
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "PASSWORD_RESET",
      entityType: "user",
      entityId: user.id,
      ...meta(req),
      details: { sessionsRevoked: true },
    });
    res.json({ ok: true });
  }),
);

/* --------------------------------- audit --------------------------------- */

adminRouter.get(
  "/audit",
  requireRole("SUPER_ADMIN", "SYSTEM_AUDITOR"),
  asyncHandler((req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const result = listAudit({
      limit,
      offset,
      entityType: str(req.query.entityType),
      entityId: str(req.query.entityId),
      actorId: str(req.query.actorId),
      action: str(req.query.action),
      q: str(req.query.q),
    });
    res.json({
      ...result,
      limit,
      offset,
      chain: verifyAuditChain(),
      rows: result.rows.map((r) => ({ ...r, details: JSON.parse(r.details_json), details_json: undefined })),
    });
  }),
);

adminRouter.get(
  "/audit/verify",
  requireRole("SUPER_ADMIN", "SYSTEM_AUDITOR"),
  asyncHandler((_req, res) => {
    res.json(verifyAuditChain());
  }),
);

/* -------------------------------- adapters ------------------------------- */

adminRouter.get(
  "/adapters",
  asyncHandler((_req, res) => {
    const rows = all<Record<string, unknown>>("SELECT * FROM adapters ORDER BY country, code");
    const stats = all<{ adapter_code: string; status: string; n: number }>("SELECT adapter_code, status, COUNT(*) AS n FROM transmissions GROUP BY adapter_code, status");
    res.json({
      adapters: rows.map((r) => ({
        code: r.code,
        name: r.name,
        country: r.country,
        kind: r.kind,
        endpoint: r.endpoint,
        authType: r.auth_type,
        mapping: JSON.parse(String(r.mapping_json || "{}")),
        enabled: Boolean(r.enabled),
        simulate: Boolean(r.simulate),
        hasCredentials: Boolean(r.auth_config_enc),
        createdAt: r.created_at,
        deliveries: stats.filter((s) => s.adapter_code === r.code).map((s) => ({ status: s.status, count: Number(s.n) })),
      })),
      jurisdictions: JURISDICTIONS.map((j) => ({ code: j.code, name: j.name, framework: j.frameworks })),
    });
  }),
);

const adapterSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,30}$/, "Use 3–30 alphanumeric characters or dashes"),
  name: z.string().trim().min(3).max(120),
  country: z.string().trim().length(2).transform((c) => c.toUpperCase()),
  kind: z.enum(["FHIR", "HL7v2", "REST", "SOAP"]),
  endpoint: z.string().trim().url().max(500),
  mapping: z.record(z.unknown()).optional().default({}),
  simulate: boolish.optional().default(true),
  enabled: boolish.optional().default(true),
  authType: z.enum(["NONE", "BEARER", "API_KEY", "MTLS"]).optional().default("NONE"),
  authConfig: z.record(z.string()).optional(),
});

adminRouter.post(
  "/adapters",
  requireRole("SUPER_ADMIN"),
  asyncHandler((req, res) => {
    const body = parseBody(adapterSchema, req.body);
    if (!findJurisdiction(body.country)) throw new HttpError(400, "Country is not configured");
    const exists = get("SELECT code FROM adapters WHERE code = ?", body.code);
    run(
      `INSERT INTO adapters (code, name, country, kind, endpoint, auth_type, auth_config_enc, mapping_json, enabled, simulate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, country = excluded.country, kind = excluded.kind,
         endpoint = excluded.endpoint, auth_type = excluded.auth_type, auth_config_enc = excluded.auth_config_enc,
         mapping_json = excluded.mapping_json, enabled = excluded.enabled, simulate = excluded.simulate, updated_at = excluded.updated_at`,
      body.code,
      body.name,
      body.country,
      body.kind,
      body.endpoint,
      body.authType,
      body.authConfig ? encryptField(JSON.stringify(body.authConfig)) : null,
      JSON.stringify(body.mapping ?? {}),
      body.enabled ? 1 : 0,
      body.simulate ? 1 : 0,
      nowIso(),
      nowIso(),
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: exists ? "ADAPTER_UPDATED" : "ADAPTER_CREATED",
      entityType: "adapter",
      entityId: body.code,
      ...meta(req),
      details: { kind: body.kind, country: body.country, enabled: body.enabled, simulate: body.simulate, hasCredentials: Boolean(body.authConfig) },
    });
    res.status(201).json({ ok: true, code: body.code });
  }),
);

adminRouter.patch(
  "/adapters/:code",
  requireRole("SUPER_ADMIN"),
  asyncHandler((req, res) => {
    const row = get<Record<string, unknown>>("SELECT * FROM adapters WHERE code = ?", req.params.code);
    if (!row) throw new HttpError(404, "Adapter not found");
    const body = parseBody(
      z.object({
        enabled: boolish.optional(),
        simulate: boolish.optional(),
        endpoint: z.string().trim().url().max(500).optional(),
        mapping: z.record(z.unknown()).optional(),
      }),
      req.body,
    );
    run(
      "UPDATE adapters SET enabled = ?, simulate = ?, endpoint = ?, mapping_json = ?, updated_at = ? WHERE code = ?",
      body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
      body.simulate === undefined ? row.simulate : body.simulate ? 1 : 0,
      body.endpoint ?? row.endpoint,
      body.mapping ? JSON.stringify(body.mapping) : row.mapping_json,
      nowIso(),
      req.params.code,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "ADAPTER_UPDATED",
      entityType: "adapter",
      entityId: req.params.code,
      ...meta(req),
      details: { changes: body },
    });
    res.json({ ok: true });
  }),
);

adminRouter.post(
  "/adapters/:code/preview",
  asyncHandler((req, res) => {
    const body = parseBody(z.object({ caseId: z.string().trim().min(4).max(40) }), req.body);
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", body.caseId.toUpperCase());
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow);
    const { config } = resolveAdapter(req.params.code.toUpperCase());
    const docs = all<DocumentRow>("SELECT * FROM documents WHERE case_id = ?", caseRow.id);
    const payload = buildCasePayload(caseRow, docs);
    const built = implementationFor(config.kind).build(payload, config);
    res.json({
      adapter: config.code,
      kind: config.kind,
      endpoint: config.endpoint,
      simulate: config.simulate,
      contentType: built.contentType,
      summary: built.summary,
      payload: maskPayload(typeof built.payload === "string" ? built.payload : "[binary payload]", [payload.patient.name]),
      piiMasked: payload.masked,
    });
  }),
);

/* ------------------------------ notifications ---------------------------- */

adminRouter.get(
  "/notifications",
  asyncHandler((req, res) => {
    const status = str(req.query.status);
    const rows = status
      ? all("SELECT * FROM notifications WHERE status = ? ORDER BY created_at DESC LIMIT 100", status)
      : all("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100");
    res.json({ notifications: rows });
  }),
);

adminRouter.post(
  "/notifications/process",
  requireRole(...REVIEWER_ROLES),
  asyncHandler(async (_req, res) => {
    const result = await processPendingNotifications(50);
    res.json(result);
  }),
);

adminRouter.post(
  "/notifications/:id/retry",
  requireRole(...REVIEWER_ROLES),
  asyncHandler(async (req, res) => {
    const row = get("SELECT * FROM notifications WHERE id = ?", req.params.id);
    if (!row) throw new HttpError(404, "Notification not found");
    requeueNotification(req.params.id);
    const result = await processPendingNotifications(5);
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "NOTIFICATION_RETRIED",
      entityType: "notification",
      entityId: req.params.id,
      ...meta(req),
      details: result,
    });
    res.json(result);
  }),
);

adminRouter.get("/webhooks", asyncHandler((_req, res) => {
  const events = all("SELECT * FROM webhook_events ORDER BY id DESC LIMIT 50");
  res.json({ events: events.map((e) => ({ ...e, payload: JSON.parse(String(e.payload_json)), payload_json: undefined })) });
}));

/* -------------------------------- registry ------------------------------- */

adminRouter.get("/facilities", asyncHandler((_req, res) => {
  const rows = all("SELECT * FROM facilities ORDER BY country, name");
  res.json({ facilities: rows.map((r) => ({ ...r, letterheadKeywords: JSON.parse(String(r.letterhead_keywords)) })) });
}));

adminRouter.post(
  "/facilities",
  requireRole("SUPER_ADMIN"),
  asyncHandler((req, res) => {
    const body = parseBody(
      z.object({
        id: z.string().trim().min(3).max(40),
        name: z.string().trim().min(3).max(160),
        authorityId: z.string().trim().min(3).max(60),
        city: z.string().trim().max(120).optional().default(""),
        letterheadKeywords: z.array(z.string().max(120)).max(20).optional().default([]),
      }),
      req.body,
    );
    const authority = findAuthority(body.authorityId);
    if (!authority) throw new HttpError(400, "Unknown health authority");
    if (get("SELECT id FROM facilities WHERE id = ?", body.id)) throw new HttpError(409, "Facility ID already exists");
    run(
      "INSERT INTO facilities (id, name, authority_id, country, city, letterhead_keywords, status) VALUES (?, ?, ?, ?, ?, ?, 'VERIFIED')",
      body.id,
      body.name,
      body.authorityId,
      authority.jurisdiction.code,
      body.city,
      JSON.stringify(body.letterheadKeywords),
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "FACILITY_CREATED",
      entityType: "facility",
      entityId: body.id,
      ...meta(req),
      details: { name: body.name, authority: body.authorityId },
    });
    res.status(201).json({ ok: true });
  }),
);

adminRouter.get("/physicians", asyncHandler((_req, res) => {
  res.json({ physicians: all("SELECT * FROM physician_licenses ORDER BY jurisdiction, full_name") });
}));

adminRouter.post(
  "/physicians",
  requireRole("SUPER_ADMIN"),
  asyncHandler((req, res) => {
    const body = parseBody(
      z.object({
        licenseNo: z.string().trim().min(3).max(40).transform((v) => v.toUpperCase()),
        fullName: z.string().trim().min(3).max(160),
        jurisdiction: z.string().trim().length(2).transform((c) => c.toUpperCase()),
        status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"]),
        expiresAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        facilityId: z.string().trim().max(40).optional(),
      }),
      req.body,
    );
    if (get("SELECT license_no FROM physician_licenses WHERE license_no = ?", body.licenseNo)) {
      throw new HttpError(409, "Licence already exists");
    }
    run(
      "INSERT INTO physician_licenses (license_no, full_name, jurisdiction, status, expires_at, facility_id) VALUES (?, ?, ?, ?, ?, ?)",
      body.licenseNo,
      body.fullName,
      body.jurisdiction,
      body.status,
      body.expiresAt ?? null,
      body.facilityId ?? null,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "PHYSICIAN_LICENSE_CREATED",
      entityType: "physician_license",
      entityId: body.licenseNo,
      ...meta(req),
      details: { status: body.status, jurisdiction: body.jurisdiction },
    });
    res.status(201).json({ ok: true });
  }),
);

adminRouter.patch(
  "/physicians/:licenseNo",
  requireRole("SUPER_ADMIN"),
  asyncHandler((req, res) => {
    const body = parseBody(z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"]) }), req.body);
    const row = get("SELECT license_no FROM physician_licenses WHERE license_no = ?", req.params.licenseNo.toUpperCase());
    if (!row) throw new HttpError(404, "Licence not found");
    run("UPDATE physician_licenses SET status = ? WHERE license_no = ?", body.status, req.params.licenseNo.toUpperCase());
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "PHYSICIAN_LICENSE_UPDATED",
      entityType: "physician_license",
      entityId: req.params.licenseNo.toUpperCase(),
      ...meta(req),
      details: { status: body.status },
    });
    res.json({ ok: true });
  }),
);
