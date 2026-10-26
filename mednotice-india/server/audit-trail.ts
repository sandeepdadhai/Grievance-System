import { all, get } from "./db.js";
import {
  COMMUNICATION_AUDIT_ACTIONS,
  COMMUNICATION_AUDIT_MATCH,
  COMMUNICATION_KINDS,
  COMMUNICATION_QUERY,
  type CommunicationAuditLink,
} from "./communications.js";

/**
 * Unified audit trail.
 *
 * The hash-chained `audit_log` records decisions; the communication stream
 * records messages. An auditor asking "what happened to this case?" needs one
 * chronological ledger of both, so this module merges the two into a single
 * filterable log: every audit entry, and every message with the audit entry
 * that proves it.
 */

export type TrailSource = "all" | "audit" | "communications";

export type TrailRow = {
  id: string;
  recordType: "AUDIT" | "COMMUNICATION";
  ts: string;
  action: string;
  kind: string | null;
  direction: string | null;
  entityType: string;
  entityId: string | null;
  caseId: string | null;
  actorId: string | null;
  actorRole: string | null;
  status: string | null;
  channel: string | null;
  target: string | null;
  subject: string | null;
  summary: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  attempts: number | null;
  ip: string | null;
  hash: string | null;
  prevHash: string | null;
  auditId: number | null;
  audit: CommunicationAuditLink | null;
  details: Record<string, unknown> | null;
  request: string | null;
  response: string | null;
};

export type TrailFilter = {
  source?: TrailSource;
  kind?: string;
  status?: string;
  action?: string;
  caseId?: string;
  q?: string;
  from?: string;
  to?: string;
  /** Jurisdiction scope applied to state-restricted roles (messages only). */
  country?: string | null;
};

export type TrailCounts = {
  total: number;
  audit: number;
  communications: number;
  failed: number;
  lastMessageAt: string | null;
  byKind: Record<string, number>;
};

/**
 * Match every message to the audit entry that proves it. The matching rules
 * live with the communication log so the SQL and the TypeScript view of them
 * cannot drift apart.
 */
function buildAuditJoin(): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const kind of COMMUNICATION_KINDS) {
    const actions = COMMUNICATION_AUDIT_ACTIONS[kind] ?? [];
    if (!actions.length) continue;
    const match =
      COMMUNICATION_AUDIT_MATCH[kind] === "ENTITY"
        ? "a2.entity_id = c.audit_key"
        : "a2.details_json LIKE '%' || c.audit_key || '%'";
    parts.push(`(c.kind = ? AND a2.action IN (${actions.map(() => "?").join(", ")}) AND ${match})`);
    params.push(kind, ...actions);
  }
  return { sql: parts.join(" OR "), params };
}

const auditJoin = buildAuditJoin();

const TRAIL_CTE = `
WITH comms AS (${COMMUNICATION_QUERY}),
trail AS (
  SELECT
    'AUDIT' AS record_type,
    a.ts AS ts,
    printf('A%012d', a.id) AS seq,
    a.action AS action,
    NULL AS kind,
    NULL AS direction,
    a.entity_type AS entity_type,
    a.entity_id AS entity_id,
    CASE WHEN a.entity_type = 'case' THEN a.entity_id ELSE NULL END AS case_id,
    a.actor_id AS actor_id,
    a.actor_role AS actor_role,
    NULL AS status,
    NULL AS channel,
    NULL AS target,
    NULL AS subject,
    NULL AS summary,
    NULL AS http_status,
    NULL AS latency_ms,
    NULL AS attempts,
    NULL AS country,
    a.ip AS ip,
    a.hash AS hash,
    a.prev_hash AS prev_hash,
    a.id AS audit_id,
    a.ts AS audit_ts,
    a.details_json AS details_json,
    NULL AS request_body,
    NULL AS response_body,
    NULL AS audit_key
  FROM audit_log a

  UNION ALL

  SELECT
    'COMMUNICATION' AS record_type,
    c.ts AS ts,
    'C' || c.audit_key AS seq,
    COALESCE(a.action, c.kind) AS action,
    c.kind AS kind,
    c.direction AS direction,
    CASE c.kind
      WHEN 'COMMUNITY_POST' THEN 'community_post'
      WHEN 'COMMUNITY_COMMENT' THEN 'community_comment'
      ELSE 'communication' END AS entity_type,
    COALESCE(c.case_id, c.audit_key) AS entity_id,
    c.case_id AS case_id,
    NULL AS actor_id,
    NULL AS actor_role,
    c.status AS status,
    c.channel AS channel,
    c.target AS target,
    c.subject AS subject,
    c.summary AS summary,
    c.http_status AS http_status,
    c.latency_ms AS latency_ms,
    c.attempts AS attempts,
    c.country AS country,
    NULL AS ip,
    a.hash AS hash,
    a.prev_hash AS prev_hash,
    a.id AS audit_id,
    a.ts AS audit_ts,
    NULL AS details_json,
    c.request_body AS request_body,
    c.response_body AS response_body,
    c.audit_key AS audit_key
  FROM comms c
  LEFT JOIN audit_log a ON a.id = (
    SELECT a2.id FROM audit_log a2 WHERE ${auditJoin.sql} ORDER BY a2.id DESC LIMIT 1
  )
)`;

function buildConditions(filter: TrailFilter): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.source === "audit") conditions.push("record_type = 'AUDIT'");
  if (filter.source === "communications") conditions.push("record_type = 'COMMUNICATION'");
  if (filter.kind && COMMUNICATION_KINDS.includes(filter.kind as (typeof COMMUNICATION_KINDS)[number])) {
    conditions.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status.toUpperCase());
  }
  if (filter.caseId) {
    conditions.push("case_id = ?");
    params.push(filter.caseId.toUpperCase());
  }
  if (filter.action) {
    conditions.push("action LIKE ?");
    params.push(`%${filter.action.toUpperCase()}%`);
  }
  if (filter.q) {
    const like = `%${filter.q}%`;
    conditions.push(
      "(action LIKE ? OR entity_id LIKE ? OR details_json LIKE ? OR target LIKE ? OR subject LIKE ? OR summary LIKE ? OR actor_id LIKE ? OR channel LIKE ?)",
    );
    params.push(like, like, like, like, like, like, like, like);
  }
  if (filter.from) {
    conditions.push("ts >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    conditions.push("ts <= ?");
    params.push(filter.to.length === 10 ? `${filter.to}T23:59:59.999Z` : filter.to);
  }
  // The chain itself is global; messages stay inside the reader's jurisdiction.
  if (filter.country) {
    conditions.push("(record_type = 'AUDIT' OR country = ?)");
    params.push(filter.country);
  }

  return { conditions, params };
}

const clause = (conditions: string[]): string => (conditions.length ? `WHERE ${conditions.join(" AND ")}` : "");

type RawTrailRow = {
  record_type: string;
  ts: string;
  seq: string;
  action: string;
  kind: string | null;
  direction: string | null;
  entity_type: string;
  entity_id: string | null;
  case_id: string | null;
  actor_id: string | null;
  actor_role: string | null;
  status: string | null;
  channel: string | null;
  target: string | null;
  subject: string | null;
  summary: string | null;
  http_status: number | null;
  latency_ms: number | null;
  attempts: number | null;
  ip: string | null;
  hash: string | null;
  prev_hash: string | null;
  audit_id: number | null;
  audit_ts: string | null;
  details_json: string | null;
  request_body: string | null;
  response_body: string | null;
  audit_key: string | null;
};

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { raw };
  }
}

function toRow(row: RawTrailRow): TrailRow {
  const isAudit = row.record_type === "AUDIT";
  const audit: CommunicationAuditLink | null =
    row.audit_id != null && row.hash
      ? { id: row.audit_id, ts: row.audit_ts ?? row.ts, action: row.action, hash: row.hash }
      : null;
  return {
    id: isAudit ? `A-${row.audit_id}` : `C-${row.audit_key ?? row.seq}`,
    recordType: isAudit ? "AUDIT" : "COMMUNICATION",
    ts: row.ts,
    action: row.action,
    kind: row.kind,
    direction: row.direction,
    entityType: row.entity_type,
    entityId: row.entity_id,
    caseId: row.case_id,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    status: row.status,
    channel: row.channel,
    target: row.target,
    subject: row.subject,
    summary: row.summary,
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    attempts: row.attempts,
    ip: row.ip,
    hash: row.hash,
    prevHash: row.prev_hash,
    auditId: row.audit_id,
    audit,
    details: isAudit ? parseDetails(row.details_json) : null,
    request: row.request_body,
    response: row.response_body,
  };
}

export function listAuditTrail(
  filter: TrailFilter,
  limit = 50,
  offset = 0,
): { rows: TrailRow[]; total: number; counts: TrailCounts } {
  const { conditions, params } = buildConditions(filter);
  const where = clause(conditions);

  const rows = all<RawTrailRow>(
    `${TRAIL_CTE} SELECT * FROM trail ${where} ORDER BY ts DESC, seq DESC LIMIT ? OFFSET ?`,
    ...auditJoin.params,
    ...params,
    limit,
    offset,
  );

  const totals = get<{ total: number; audit_count: number; comm_count: number; failed: number; last_message: string | null }>(
    `${TRAIL_CTE}
     SELECT COUNT(*) AS total,
            SUM(CASE WHEN record_type = 'AUDIT' THEN 1 ELSE 0 END) AS audit_count,
            SUM(CASE WHEN record_type = 'COMMUNICATION' THEN 1 ELSE 0 END) AS comm_count,
            SUM(CASE WHEN record_type = 'COMMUNICATION' AND status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
            MAX(CASE WHEN record_type = 'COMMUNICATION' THEN ts END) AS last_message
     FROM trail ${where}`,
    ...auditJoin.params,
    ...params,
  );

  const byKindRows = all<{ kind: string; n: number }>(
    `${TRAIL_CTE} SELECT kind, COUNT(*) AS n FROM trail ${clause([...conditions, "kind IS NOT NULL"])} GROUP BY kind`,
    ...auditJoin.params,
    ...params,
  );
  const byKind: Record<string, number> = {};
  for (const kind of COMMUNICATION_KINDS) byKind[kind] = 0;
  for (const row of byKindRows) byKind[row.kind] = Number(row.n);

  const total = Number(totals?.total ?? 0);
  return {
    rows: rows.map(toRow),
    total,
    counts: {
      total,
      audit: Number(totals?.audit_count ?? 0),
      communications: Number(totals?.comm_count ?? 0),
      failed: Number(totals?.failed ?? 0),
      lastMessageAt: totals?.last_message ?? null,
      byKind,
    },
  };
}

/** Every distinct message status in the trail — used to populate the filter. */
export function trailStatuses(): string[] {
  const rows = all<{ status: string }>(`${TRAIL_CTE} SELECT DISTINCT status FROM trail WHERE status IS NOT NULL ORDER BY status`);
  return rows.map((r) => r.status);
}
