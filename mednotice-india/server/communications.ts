import { all, get } from "./db.js";
import { maskWhatsAppNumber } from "./whatsapp.js";

/**
 * Unified communication log.
 *
 * Everything the platform says to somebody else, and everything somebody else
 * says back, is recorded here in one chronological stream:
 *
 *  - `NOTIFICATION`      — email and webhook notices sent to the health
 *                          authority and the duty officer.
 *  - `TRANSMISSION`      — the case bundle pushed to a department's API.
 *  - `STATUS_SYNC`       — a poll of a department for the latest status.
 *  - `WEBHOOK_EVENT`     — an inbound webhook received by the platform.
 *  - `COMMUNITY_POST`    — a post written by a patient in the community forum.
 *  - `COMMUNITY_COMMENT` — a reply written on a community post.
 *
 * Every row is linked back to the tamper-evident audit chain, so a message
 * that was sent can be proven to have been sent.
 */

export type CommunicationKind =
  | "NOTIFICATION"
  | "TRANSMISSION"
  | "STATUS_SYNC"
  | "WEBHOOK_EVENT"
  | "COMMUNITY_POST"
  | "COMMUNITY_COMMENT";

export const COMMUNICATION_KINDS: CommunicationKind[] = [
  "NOTIFICATION",
  "TRANSMISSION",
  "STATUS_SYNC",
  "WEBHOOK_EVENT",
  "COMMUNITY_POST",
  "COMMUNITY_COMMENT",
];

export type CommunicationDirection = "OUTBOUND" | "INBOUND";

export type CommunicationFilter = {
  kind?: string;
  status?: string;
  caseId?: string;
  q?: string;
  from?: string;
  to?: string;
  /** Jurisdiction scope applied to state-restricted roles. */
  country?: string | null;
};

export type CommunicationAuditLink = {
  id: number;
  ts: string;
  action: string;
  hash: string;
};

export type CommunicationDto = {
  id: string;
  kind: CommunicationKind;
  direction: CommunicationDirection;
  ts: string;
  caseId: string | null;
  patientName: string | null;
  country: string | null;
  authorityId: string | null;
  channel: string;
  target: string;
  status: string;
  subject: string | null;
  summary: string | null;
  message: string | null;
  reference: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  attempts: number | null;
  lastError: string | null;
  request: string | null;
  response: string | null;
  audit: CommunicationAuditLink | null;
};

export type CommunicationSummary = {
  total: number;
  byKind: Record<string, number>;
  failed: number;
  lastSentAt: string | null;
  lastReceivedAt: string | null;
};

export const COMMUNICATION_QUERY = `
  SELECT
    'NOTIFICATION' AS kind,
    'OUTBOUND' AS direction,
    n.id AS id,
    COALESCE(n.sent_at, n.created_at) AS ts,
    n.case_id AS case_id,
    c.patient_name_masked AS patient_name,
    c.country AS country,
    c.authority_id AS authority_id,
    n.channel AS channel,
    n.target AS target,
    n.status AS status,
    n.subject AS subject,
    n.body AS summary,
    NULL AS reference,
    NULL AS http_status,
    NULL AS latency_ms,
    n.attempts AS attempts,
    n.last_error AS last_error,
    NULL AS request_body,
    n.body AS response_body,
    n.id AS audit_key
  FROM notifications n JOIN cases c ON c.id = n.case_id

  UNION ALL

  SELECT
    'TRANSMISSION', 'OUTBOUND', t.id, t.created_at, t.case_id,
    c.patient_name_masked, c.country, c.authority_id,
    t.adapter_code, c.authority_id, t.status,
    'Case bundle to ' || c.authority_id,
    t.response_json,
    t.reference, t.http_status, t.latency_ms, t.attempts, NULL,
    t.request_json, t.response_json, t.id
  FROM transmissions t JOIN cases c ON c.id = t.case_id

  UNION ALL

  SELECT
    'STATUS_SYNC', 'OUTBOUND', s.id, s.checked_at, s.case_id,
    c.patient_name_masked, c.country, s.authority_id,
    s.adapter_code, s.endpoint, s.status,
    'Status check of ' || s.endpoint,
    s.message,
    s.remote_reference, s.http_status, s.latency_ms, 1, s.message,
    NULL, s.response_json, s.id
  FROM case_status_syncs s JOIN cases c ON c.id = s.case_id

  UNION ALL

  SELECT
    'WEBHOOK_EVENT', 'INBOUND', 'WHK-' || w.id, w.received_at, NULL,
    NULL, NULL, NULL,
    'WEBHOOK', COALESCE(w.source, 'unknown'), 'RECEIVED',
    'Inbound webhook', w.source,
    NULL, NULL, NULL, 1, NULL,
    NULL, w.payload_json, 'WHK-' || w.id
  FROM webhook_events w

  UNION ALL

  SELECT
    'COMMUNITY_POST', 'INBOUND', p.id, p.created_at, NULL,
    NULL, NULL, NULL,
    'COMMUNITY', p.author_name, p.status,
    p.title, p.body, p.id,
    NULL, NULL, 1, NULL,
    NULL, p.body, p.id
  FROM community_posts p

  UNION ALL

  SELECT
    'COMMUNITY_COMMENT', 'INBOUND', cm.id, cm.created_at, NULL,
    NULL, NULL, NULL,
    'COMMUNITY', cm.author_name, cm.status,
    'Comment on ' || cm.post_id, cm.body, cm.id,
    NULL, NULL, 1, NULL,
    NULL, cm.body, cm.id
  FROM community_comments cm
`;

/** The communication stream wrapped as a reusable CTE. */
export const COMMUNICATION_CTE = `WITH comms AS (${COMMUNICATION_QUERY})`;

/** Audit actions that are the authoritative record for each kind of message. */
export const COMMUNICATION_AUDIT_ACTIONS: Record<CommunicationKind, string[]> = {
  NOTIFICATION: ["NOTIFICATION_SENT", "NOTIFICATION_FAILED", "NOTIFICATION_QUEUED", "NOTIFICATION_RETRIED"],
  TRANSMISSION: ["CASE_ROUTED", "CASE_ROUTE_FAILED"],
  STATUS_SYNC: ["AUTHORITY_STATUS_CHECKED", "AUTHORITY_STATUS_CHECK_FAILED"],
  WEBHOOK_EVENT: [],
  COMMUNITY_POST: ["COMMUNITY_POST_CREATED", "COMMUNITY_POST_MODERATED", "COMMUNITY_POST_REMOVED"],
  COMMUNITY_COMMENT: ["COMMUNITY_COMMENT_CREATED", "COMMUNITY_COMMENT_MODERATED", "COMMUNITY_COMMENT_REMOVED"],
};

/**
 * How a message is matched back to its audit entry: by the message id inside
 * the audit details, or by the audit entity id.
 */
export const COMMUNICATION_AUDIT_MATCH: Record<CommunicationKind, "DETAILS" | "ENTITY"> = {
  NOTIFICATION: "DETAILS",
  TRANSMISSION: "DETAILS",
  STATUS_SYNC: "DETAILS",
  WEBHOOK_EVENT: "DETAILS",
  COMMUNITY_POST: "ENTITY",
  COMMUNITY_COMMENT: "ENTITY",
};

function buildWhere(filter: CommunicationFilter, opts: { includeKind: boolean }): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.includeKind && filter.kind && COMMUNICATION_KINDS.includes(filter.kind as CommunicationKind)) {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status.toUpperCase());
  }
  if (filter.caseId) {
    where.push("case_id = ?");
    params.push(filter.caseId.toUpperCase());
  }
  if (filter.country) {
    where.push("country = ?");
    params.push(filter.country);
  }
  if (filter.q) {
    const like = `%${filter.q}%`;
    where.push("(target LIKE ? OR subject LIKE ? OR summary LIKE ? OR reference LIKE ? OR case_id LIKE ? OR id LIKE ?)");
    params.push(like, like, like, like, like, like);
  }
  if (filter.from) {
    where.push("ts >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    where.push("ts <= ?");
    params.push(filter.to.length === 10 ? `${filter.to}T23:59:59.999Z` : filter.to);
  }

  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

type RawRow = {
  kind: string;
  direction: string;
  id: string;
  ts: string;
  case_id: string | null;
  patient_name: string | null;
  country: string | null;
  authority_id: string | null;
  channel: string;
  target: string;
  status: string;
  subject: string | null;
  summary: string | null;
  reference: string | null;
  http_status: number | null;
  latency_ms: number | null;
  attempts: number | null;
  last_error: string | null;
  request_body: string | null;
  response_body: string | null;
  audit_key: string;
};

export type CommunicationAuditKey = { kind: string; audit_key: string };

/** Resolve the audit-chain entry that proves each message was sent. */
export function resolveCommunicationAuditLinks(rows: CommunicationAuditKey[]): Map<string, CommunicationAuditLink> {
  const links = new Map<string, CommunicationAuditLink>();
  const terms: string[] = [];
  const params: unknown[] = [];
  const keys = new Map<string, { kind: CommunicationKind; mode: "DETAILS" | "ENTITY" }>();

  for (const row of rows) {
    const kind = row.kind as CommunicationKind;
    const actions = COMMUNICATION_AUDIT_ACTIONS[kind] ?? [];
    if (!actions.length || keys.has(row.audit_key)) continue;
    const mode = COMMUNICATION_AUDIT_MATCH[kind] ?? "DETAILS";
    keys.set(row.audit_key, { kind, mode });
    if (mode === "ENTITY") {
      terms.push(`(entity_id = ? AND action IN (${actions.map(() => "?").join(", ")}))`);
      params.push(row.audit_key, ...actions);
    } else {
      terms.push(`(details_json LIKE ? AND action IN (${actions.map(() => "?").join(", ")}))`);
      params.push(`%${row.audit_key}%`, ...actions);
    }
  }
  if (!terms.length) return links;

  const auditRows = all<{ id: number; ts: string; action: string; hash: string; details_json: string; entity_id: string | null }>(
    `SELECT id, ts, action, hash, details_json, entity_id FROM audit_log WHERE ${terms.join(" OR ")} ORDER BY id DESC`,
    ...params,
  );

  for (const auditRow of auditRows) {
    for (const [key, meta] of keys) {
      if (links.has(key)) continue;
      const actions = COMMUNICATION_AUDIT_ACTIONS[meta.kind] ?? [];
      if (!actions.includes(auditRow.action)) continue;
      const matched = meta.mode === "ENTITY" ? auditRow.entity_id === key : auditRow.details_json.includes(key);
      if (!matched) continue;
      links.set(key, { id: auditRow.id, ts: auditRow.ts, action: auditRow.action, hash: auditRow.hash });
    }
  }
  return links;
}

function extractMessage(kind: string, responseBody: string | null): string | null {
  if (!responseBody) return null;
  if (kind !== "TRANSMISSION") return null;
  try {
    const parsed = JSON.parse(responseBody) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : null;
  } catch {
    return null;
  }
}

function toDto(row: RawRow, links: Map<string, CommunicationAuditLink>): CommunicationDto {
  return {
    id: row.id,
    kind: row.kind as CommunicationKind,
    direction: row.direction as CommunicationDirection,
    ts: row.ts,
    caseId: row.case_id,
    patientName: row.patient_name,
    country: row.country,
    authorityId: row.authority_id,
    channel: row.channel,
    // Patient phone numbers stay masked everywhere outside the delivery worker.
    target: row.channel === "WHATSAPP" ? maskWhatsAppNumber(row.target) : row.target,
    status: row.status,
    subject: row.subject,
    summary: row.summary,
    message: extractMessage(row.kind, row.response_body),
    reference: row.reference,
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    attempts: row.attempts,
    lastError: row.last_error,
    request: row.request_body,
    response: row.response_body,
    audit: links.get(row.audit_key) ?? null,
  };
}

export function listCommunications(
  filter: CommunicationFilter,
  limit = 50,
  offset = 0,
): { rows: CommunicationDto[]; total: number; summary: CommunicationSummary } {
  const { clause, params } = buildWhere(filter, { includeKind: true });
  const rows = all<RawRow>(
    `${COMMUNICATION_CTE} SELECT * FROM comms ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  const total = Number(get<{ n: number }>(`${COMMUNICATION_CTE} SELECT COUNT(*) AS n FROM comms ${clause}`, ...params)?.n ?? 0);

  const links = resolveCommunicationAuditLinks(rows);
  const dtos = rows.map((row) => toDto(row, links));

  // The summary counts every kind of message in the filtered set, so the
  // console can show the shape of the traffic even when one kind is selected.
  const summaryWhere = buildWhere(filter, { includeKind: false });
  const byKindRows = all<{ kind: string; n: number }>(
    `${COMMUNICATION_CTE} SELECT kind, COUNT(*) AS n FROM comms ${summaryWhere.clause} GROUP BY kind`,
    ...summaryWhere.params,
  );
  const byKind: Record<string, number> = {};
  for (const kind of COMMUNICATION_KINDS) byKind[kind] = 0;
  for (const row of byKindRows) byKind[row.kind] = Number(row.n);

  const failedRow = get<{ n: number }>(
    `${COMMUNICATION_CTE} SELECT COUNT(*) AS n FROM comms ${summaryWhere.clause}${summaryWhere.clause ? " AND" : " WHERE"} status = 'FAILED'`,
    ...summaryWhere.params,
  );
  const lastRow = get<{ last_sent: string | null; last_received: string | null }>(
    `${COMMUNICATION_CTE} SELECT MAX(CASE WHEN direction = 'OUTBOUND' THEN ts END) AS last_sent,
                             MAX(CASE WHEN direction = 'INBOUND' THEN ts END) AS last_received
       FROM comms ${summaryWhere.clause}`,
    ...summaryWhere.params,
  );

  return {
    rows: dtos,
    total,
    summary: {
      total: Object.values(byKind).reduce((sum, n) => sum + n, 0),
      byKind,
      failed: Number(failedRow?.n ?? 0),
      lastSentAt: lastRow?.last_sent ?? null,
      lastReceivedAt: lastRow?.last_received ?? null,
    },
  };
}

/** Every distinct status value seen in the log — used to populate the filter. */
export function communicationStatuses(): string[] {
  const rows = all<{ status: string }>(`${COMMUNICATION_CTE} SELECT DISTINCT status FROM comms ORDER BY status`);
  return rows.map((r) => r.status);
}
