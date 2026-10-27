import { Router } from "express";
import { z } from "zod";
import { count, get, nowIso, run } from "../db.js";
import { audit } from "../audit.js";
import { asyncHandler, HttpError, meta, parseBody } from "../http.js";
import { requireAuth, requireRole } from "../auth.js";
import {
  ALL_PERMISSIONS,
  BUILTIN_ROLE_KEYS,
  PERMISSIONS,
  listRoles,
  normalisePermissions,
  roleKeyFromName,
  staffBaseRoles,
} from "../roles.js";

/**
 * Administrator-defined roles. Built-in roles are immutable here; custom roles
 * are scoped to one of the staff capability families so they can never exceed
 * the data access of the base role they are derived from.
 */
export const rolesRouter = Router();

rolesRouter.use(requireAuth, requireRole("SUPER_ADMIN"));

rolesRouter.get("/", (_req, res) => {
  res.json({ roles: listRoles(), permissions: PERMISSIONS, baseRoles: staffBaseRoles(), builtinKeys: BUILTIN_ROLE_KEYS });
});

const roleBody = z.object({
  name: z.string().trim().min(3, "Role name must be at least 3 characters").max(60),
  description: z.string().trim().max(240).optional().default(""),
  baseRole: z.enum(["MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE", "SYSTEM_AUDITOR"], {
    errorMap: () => ({ message: "Custom roles must derive from a staff role" }),
  }),
  permissions: z.array(z.string()).max(ALL_PERMISSIONS.length).optional().default([]),
});

rolesRouter.post(
  "/",
  asyncHandler((req, res) => {
    const body = parseBody(roleBody, req.body);
    let key = roleKeyFromName(body.name);
    if (BUILTIN_ROLE_KEYS.includes(key as never) || get("SELECT key FROM roles WHERE key = ?", key)) {
      key = `${key}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`.slice(0, 60);
    }
    const permissions = normalisePermissions(body.permissions);
    const now = nowIso();
    run(
      "INSERT INTO roles (key, name, description, base_role, permissions_json, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      key,
      body.name,
      body.description,
      body.baseRole,
      JSON.stringify(permissions),
      now,
      now,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "ROLE_CREATED",
      entityType: "role",
      entityId: key,
      ...meta(req),
      details: { name: body.name, baseRole: body.baseRole, permissions },
    });
    const created = listRoles().find((r) => r.key === key)!;
    res.status(201).json({ role: created, roles: listRoles() });
  }),
);

const rolePatch = z.object({
  name: z.string().trim().min(3).max(60).optional(),
  description: z.string().trim().max(240).optional(),
  baseRole: z.enum(["MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE", "SYSTEM_AUDITOR"]).optional(),
  permissions: z.array(z.string()).max(ALL_PERMISSIONS.length).optional(),
});

rolesRouter.patch(
  "/:key",
  asyncHandler((req, res) => {
    const body = parseBody(rolePatch, req.body);
    const row = get<{ key: string; name: string; base_role: string; permissions_json: string; builtin: number }>(
      "SELECT key, name, base_role, permissions_json, builtin FROM roles WHERE key = ?",
      req.params.key,
    );
    if (!row) throw new HttpError(404, "Role not found");
    if (row.builtin) throw new HttpError(400, "Built-in roles cannot be edited. Create a custom role instead.");
    const permissions = body.permissions ? normalisePermissions(body.permissions) : null;
    run(
      "UPDATE roles SET name = ?, description = ?, base_role = ?, permissions_json = ?, updated_at = ? WHERE key = ?",
      body.name ?? row.name,
      body.description ?? get<{ description: string }>("SELECT description FROM roles WHERE key = ?", row.key)?.description ?? "",
      body.baseRole ?? row.base_role,
      permissions ? JSON.stringify(permissions) : row.permissions_json,
      nowIso(),
      row.key,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "ROLE_UPDATED",
      entityType: "role",
      entityId: row.key,
      ...meta(req),
      details: { changes: body, previousPermissions: JSON.parse(row.permissions_json || "[]") },
    });
    res.json({ role: listRoles().find((r) => r.key === row.key), roles: listRoles() });
  }),
);

rolesRouter.delete(
  "/:key",
  asyncHandler((req, res) => {
    const row = get<{ key: string; name: string; builtin: number }>("SELECT key, name, builtin FROM roles WHERE key = ?", req.params.key);
    if (!row) throw new HttpError(404, "Role not found");
    if (row.builtin) throw new HttpError(400, "Built-in roles cannot be deleted.");
    const assigned = count("SELECT COUNT(*) AS n FROM users WHERE role = ?", row.key);
    if (assigned > 0) throw new HttpError(409, `${assigned} account(s) still use this role. Reassign them first.`);
    run("DELETE FROM roles WHERE key = ?", row.key);
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "ROLE_DELETED",
      entityType: "role",
      entityId: row.key,
      ...meta(req),
      details: { name: row.name },
    });
    res.json({ ok: true, roles: listRoles() });
  }),
);
