import { all, get, nowIso, run } from "./db.js";
import { sha256Hex } from "./crypto.js";

export type AuditActor = { id: string | null; role: string | null };

export type AuditEntry = {
  id: number;
  ts: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details_json: string;
  prev_hash: string;
  hash: string;
};

const GENESIS = "0".repeat(64);

function canonical(entry: Omit<AuditEntry, "hash">): string {
  return JSON.stringify({
    id: entry.id,
    ts: entry.ts,
    actor_id: entry.actor_id,
    actor_role: entry.actor_role,
    action: entry.action,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    ip: entry.ip,
    user_agent: entry.user_agent,
    details: entry.details_json,
    prev_hash: entry.prev_hash,
  });
}

/**
 * Append an audit record. Each row commits to the previous row's hash,
 * producing a tamper-evident chain (DPDP Act 2023 ss.8 and 33).
 */
export function audit(params: {
  actor?: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
  ts?: string;
}): AuditEntry {
  const ts = params.ts ?? nowIso();
  const actor = params.actor ?? { id: null, role: null };
  const prev = get<{ hash: string }>("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
  const prevHash = prev?.hash ?? GENESIS;
  const detailsJson = JSON.stringify(params.details ?? {});

  const nextId = Number(get<{ n: number }>("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM audit_log")?.n ?? 1);

  const base: Omit<AuditEntry, "hash"> = {
    id: nextId,
    ts,
    actor_id: actor.id,
    actor_role: actor.role,
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId ?? null,
    ip: params.ip ?? null,
    user_agent: params.userAgent ?? null,
    details_json: detailsJson,
    prev_hash: prevHash,
  };
  const hash = sha256Hex(canonical(base));

  run(
    `INSERT INTO audit_log (id, ts, actor_id, actor_role, action, entity_type, entity_id, ip, user_agent, details_json, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    base.id,
    base.ts,
    base.actor_id,
    base.actor_role,
    base.action,
    base.entity_type,
    base.entity_id,
    base.ip,
    base.user_agent,
    base.details_json,
    base.prev_hash,
    hash,
  );

  return { ...base, hash };
}

export function listAudit(opts: {
  limit: number;
  offset: number;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  q?: string;
}): { rows: AuditEntry[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.entityType) {
    where.push("entity_type = ?");
    params.push(opts.entityType);
  }
  if (opts.entityId) {
    where.push("entity_id = ?");
    params.push(opts.entityId);
  }
  if (opts.actorId) {
    where.push("actor_id = ?");
    params.push(opts.actorId);
  }
  if (opts.action) {
    where.push("action LIKE ?");
    params.push(`%${opts.action}%`);
  }
  if (opts.q) {
    where.push("(action LIKE ? OR entity_id LIKE ? OR details_json LIKE ?)");
    params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = all<AuditEntry>(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, opts.limit, opts.offset);
  const total = Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log ${clause}`, ...params)?.n ?? 0);
  return { rows, total };
}

/** Recompute the chain and report the first broken link, if any. */
export function verifyAuditChain(): { valid: boolean; checked: number; brokenAt: number | null } {
  const rows = all<AuditEntry>("SELECT * FROM audit_log ORDER BY id ASC");
  let prevHash = GENESIS;
  for (const row of rows) {
    const expected = sha256Hex(canonical({ ...row, prev_hash: prevHash }));
    if (row.prev_hash !== prevHash || row.hash !== expected) {
      return { valid: false, checked: rows.length, brokenAt: row.id };
    }
    prevHash = row.hash;
  }
  return { valid: true, checked: rows.length, brokenAt: null };
}
