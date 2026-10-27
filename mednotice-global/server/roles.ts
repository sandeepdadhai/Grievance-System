import { all, get, nowIso, run } from "./db.js";
import type { Role } from "./models.js";

/**
 * Fine-grained capability catalogue. Built-in roles map onto these permissions;
 * administrators can compose custom staff roles from the same catalogue without
 * gaining any capability outside their chosen base role.
 */
export const PERMISSIONS = [
  { key: "cases.view", label: "View cases", group: "Casework", description: "Read cases and documents inside the assigned state or authority." },
  { key: "cases.review", label: "Review evidence", group: "Casework", description: "Approve or reject uploaded documents in the manual review queue." },
  { key: "cases.route", label: "Route cases", group: "Casework", description: "Transmit cases to the health authority and re-run failed deliveries." },
  { key: "cases.resolve", label: "Resolve cases", group: "Casework", description: "Override triage, add review notes and close cases." },
  { key: "delivery.view", label: "Delivery desk", group: "Operations", description: "Inspect the notification outbox and delivery receipts." },
  { key: "compliance.view", label: "Compliance workspace", group: "Operations", description: "Review facility registry, physicians and consent controls." },
  { key: "community.moderate", label: "Moderate community", group: "Community", description: "Review, edit, hide and remove community posts and comments." },
  { key: "audit.view", label: "Audit log", group: "Governance", description: "Read the tamper-evident audit chain." },
  { key: "adapters.manage", label: "Manage adapters", group: "Governance", description: "Configure authority adapters and credentials." },
  { key: "registry.manage", label: "Manage directory", group: "Governance", description: "Add, edit and retire the health authorities and facilities offered to patients." },
  { key: "users.manage", label: "Manage users & roles", group: "Governance", description: "Create accounts and compose custom roles." },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const ALL_PERMISSIONS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

export type BuiltinRoleDef = {
  key: Role;
  name: string;
  description: string;
  permissions: PermissionKey[];
};

export const BUILTIN_ROLES: BuiltinRoleDef[] = [
  {
    key: "SUPER_ADMIN",
    name: "Super Administrator",
    description: "Full platform access, account administration and authority adapter configuration.",
    permissions: ALL_PERMISSIONS,
  },
  {
    key: "MINISTRY_REVIEWER",
    name: "Ministry Reviewer",
    description: "State-scoped review, triage override, document approval, routing and resolution.",
    permissions: ["cases.view", "cases.review", "cases.route", "cases.resolve", "delivery.view", "compliance.view", "community.moderate"],
  },
  {
    key: "HOSPITAL_COMPLIANCE",
    name: "Hospital Compliance Officer",
    description: "State-scoped review of cases targeting their registered facilities.",
    permissions: ["cases.view", "cases.review", "cases.route", "cases.resolve", "delivery.view", "compliance.view", "community.moderate"],
  },
  {
    key: "SYSTEM_AUDITOR",
    name: "System Auditor",
    description: "Read-only inspection of casework, delivery receipts and the audit chain.",
    permissions: ["cases.view", "delivery.view", "audit.view"],
  },
  {
    key: "PATIENT",
    name: "Patient",
    description: "Own cases, own submissions and community participation only.",
    permissions: [],
  },
];

export const BUILTIN_ROLE_KEYS = BUILTIN_ROLES.map((r) => r.key);

export type RoleRow = {
  key: string;
  name: string;
  description: string;
  base_role: string;
  permissions_json: string;
  builtin: number;
  created_at: string;
  updated_at: string;
};

export type RoleDto = {
  key: string;
  name: string;
  description: string;
  baseRole: Role;
  permissions: string[];
  builtin: boolean;
  userCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

const STAFF_BASE_ROLES: Role[] = ["MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE", "SYSTEM_AUDITOR"];

function defaultFor(key: string): RoleDto | null {
  const def = BUILTIN_ROLES.find((r) => r.key === key);
  if (!def) return null;
  return {
    key: def.key,
    name: def.name,
    description: def.description,
    baseRole: def.key,
    permissions: [...def.permissions],
    builtin: true,
    userCount: 0,
    createdAt: null,
    updatedAt: null,
  };
}

function rowToDto(row: RoleRow): RoleDto {
  let permissions: string[] = [];
  try {
    const parsed = JSON.parse(row.permissions_json);
    if (Array.isArray(parsed)) permissions = parsed.filter((p): p is string => typeof p === "string" && ALL_PERMISSIONS.includes(p as PermissionKey));
  } catch {
    permissions = [];
  }
  const baseRole = BUILTIN_ROLE_KEYS.includes(row.base_role as Role) ? (row.base_role as Role) : "PATIENT";
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    baseRole,
    permissions,
    builtin: Boolean(row.builtin),
    userCount: 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Resolve a stored role key to its capability set, tolerating unseeded databases. */
export function resolveRole(key: string): RoleDto {
  const row = get<RoleRow>("SELECT * FROM roles WHERE key = ?", key);
  if (row) return rowToDto(row);
  return (
    defaultFor(key) ?? {
      key,
      name: key,
      description: "",
      baseRole: "PATIENT",
      permissions: [],
      builtin: false,
      userCount: 0,
      createdAt: null,
      updatedAt: null,
    }
  );
}

export function roleExists(key: string): boolean {
  return Boolean(get("SELECT key FROM roles WHERE key = ?", key)) || BUILTIN_ROLE_KEYS.includes(key as Role);
}

export function listRoles(): RoleDto[] {
  const counts = new Map(
    all<{ role: string; n: number }>("SELECT role, COUNT(*) AS n FROM users GROUP BY role").map((r) => [r.role, Number(r.n)]),
  );
  const seeded = all<RoleRow>("SELECT * FROM roles ORDER BY builtin DESC, name");
  const roles = seeded.map((row) => {
    const dto = rowToDto(row);
    dto.userCount = counts.get(dto.key) ?? 0;
    return dto;
  });
  for (const def of BUILTIN_ROLES) {
    if (!roles.some((r) => r.key === def.key)) {
      const dto = defaultFor(def.key)!;
      dto.userCount = counts.get(dto.key) ?? 0;
      roles.unshift(dto);
    }
  }
  return roles;
}

export function staffBaseRoles(): Role[] {
  return [...STAFF_BASE_ROLES];
}

export function normalisePermissions(input: string[] | undefined): PermissionKey[] {
  if (!input) return [];
  return [...new Set(input.filter((p): p is PermissionKey => ALL_PERMISSIONS.includes(p as PermissionKey)))];
}

export function roleKeyFromName(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `ROLE_${slug || "CUSTOM"}`.slice(0, 60);
}

/**
 * Insert the built-in role definitions on first boot and keep them aligned with
 * the code-defined catalogue on later boots. Built-in roles are never editable
 * through the API, so code is the source of truth for their permissions.
 */
export function seedRoles(): void {
  for (const def of BUILTIN_ROLES) {
    const existing = get<{ permissions_json: string; name: string; description: string }>(
      "SELECT permissions_json, name, description FROM roles WHERE key = ? AND builtin = 1",
      def.key,
    );
    const permissionsJson = JSON.stringify(def.permissions);
    if (existing) {
      if (existing.permissions_json === permissionsJson && existing.name === def.name && existing.description === def.description) continue;
      run(
        "UPDATE roles SET name = ?, description = ?, base_role = ?, permissions_json = ?, updated_at = ? WHERE key = ?",
        def.name,
        def.description,
        def.key,
        permissionsJson,
        nowIso(),
        def.key,
      );
      continue;
    }
    run(
      "INSERT INTO roles (key, name, description, base_role, permissions_json, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      def.key,
      def.name,
      def.description,
      def.key,
      permissionsJson,
      nowIso(),
      nowIso(),
    );
  }
}
