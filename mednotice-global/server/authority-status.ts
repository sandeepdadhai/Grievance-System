import { all, get, nowIso, run } from "./db.js";
import { audit } from "./audit.js";
import { STATUS_REQUEST_TIMEOUT_MS } from "./config.js";
import { randomCode } from "./crypto.js";
import { findAuthority } from "./registry.js";
import { resolveAdapter } from "./adapters/index.js";
import { buildStatusRequest, parseStatusResponse, simulatedStatus, type RemoteStatus } from "./adapters/status.js";
import { notifyCaseStatusChange } from "./notifications.js";
import type { CaseRow } from "./models.js";

/**
 * Authority status synchronisation.
 *
 * After a case is transmitted, the receiving department is polled for the
 * latest status. The remote status is stored verbatim on the case
 * (`authority_status`) and mapped onto the internal workflow status, with the
 * full history kept in `case_status_syncs`.
 */

export type StatusSyncOutcome = {
  caseId: string;
  authorityId: string;
  adapterCode: string;
  endpoint: string;
  ok: boolean;
  simulated: boolean;
  remoteStatus: string | null;
  remoteReference: string | null;
  message: string | null;
  httpStatus: number | null;
  latencyMs: number;
  applied: boolean;
  caseStatus: string;
  reason?: string;
};

type TransmissionRow = {
  id: string;
  adapter_code: string;
  status: string;
  http_status: number | null;
  latency_ms: number | null;
  created_at: string;
  reference: string | null;
};

export function lastTransmissionFor(caseId: string): TransmissionRow | undefined {
  return get<TransmissionRow>(
    "SELECT id, adapter_code, status, http_status, latency_ms, created_at, reference FROM transmissions WHERE case_id = ? ORDER BY created_at DESC LIMIT 1",
    caseId,
  );
}

export function listStatusSyncs(caseId: string, limit = 20): Array<Record<string, unknown>> {
  return all(
    `SELECT id, case_id, transmission_id, authority_id, adapter_code, endpoint, status, remote_status, remote_reference,
            message, http_status, latency_ms, applied, simulated, checked_at
     FROM case_status_syncs WHERE case_id = ? ORDER BY checked_at DESC LIMIT ?`,
    caseId,
    limit,
  );
}

/** Map a status reported by the department onto the internal workflow. */
export function mapRemoteStatus(remote: string | null): "RESOLVED" | "UNDER_REVIEW" | "ROUTED" | null {
  if (!remote) return null;
  const value = remote.toUpperCase();
  if (/(RESOLVED|CLOSED|COMPLETED|DISPOSED|FINALISED|FINALIZED|ACTION_COMPLETE)/.test(value)) return "RESOLVED";
  if (/(REJECTED|DISMISSED|NOT_ACCEPTED|REJECT)/.test(value)) return "RESOLVED";
  if (/(REVIEW|PROGRESS|PENDING|IN_FLIGHT|INPROGRESS|QUERY|ACTION|ESCALAT|REGISTER|ACKNOWLEDG|RECEIV|OPEN|RECEIPT)/.test(value)) {
    return "UNDER_REVIEW";
  }
  return null;
}

function appendTimeline(caseRow: CaseRow, entry: { date: string; event: string }): string {
  let timeline: Array<{ date: string; event: string }> = [];
  try {
    const parsed = JSON.parse(caseRow.timeline_json || "[]");
    if (Array.isArray(parsed)) timeline = parsed;
  } catch {
    timeline = [];
  }
  timeline.push(entry);
  return JSON.stringify(timeline.slice(-60));
}

function recordSync(params: {
  caseId: string;
  transmissionId: string | null;
  authorityId: string;
  adapterCode: string;
  endpoint: string;
  status: "SUCCESS" | "FAILED" | "UNCHANGED";
  remote: RemoteStatus | null;
  httpStatus: number | null;
  latencyMs: number;
  applied: boolean;
  simulated: boolean;
  raw: unknown;
  message: string | null;
}): string {
  const id = `SYNC-${randomCode(10)}`;
  run(
    `INSERT INTO case_status_syncs (id, case_id, transmission_id, authority_id, adapter_code, endpoint, status,
      remote_status, remote_reference, message, http_status, latency_ms, applied, simulated, response_json, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    params.caseId,
    params.transmissionId,
    params.authorityId,
    params.adapterCode,
    params.endpoint,
    params.status,
    params.remote?.status ?? null,
    params.remote?.reference ?? null,
    params.message,
    params.httpStatus,
    params.latencyMs,
    params.applied ? 1 : 0,
    params.simulated ? 1 : 0,
    JSON.stringify(params.raw ?? {}).slice(0, 8000),
    nowIso(),
  );
  return id;
}

/**
 * Apply a remote status to the local case. A case that a human already
 * resolved is never downgraded by a status pull; the remote value is still
 * recorded so the discrepancy stays visible.
 */
export function applyAuthorityStatus(
  caseRow: CaseRow,
  remote: RemoteStatus,
  opts: { actor?: { id: string | null; role: string | null }; message?: string } = {},
): { applied: boolean; caseStatus: string; reason?: string } {
  const mapped = mapRemoteStatus(remote.status);
  const now = nowIso();
  const reference = remote.reference ?? caseRow.authority_reference ?? null;

  if (!mapped) {
    run(
      "UPDATE cases SET authority_status = ?, authority_status_at = ?, authority_reference = ?, updated_at = ? WHERE id = ?",
      remote.status ?? caseRow.authority_status,
      now,
      reference,
      now,
      caseRow.id,
    );
    return { applied: false, caseStatus: caseRow.status, reason: "The department reported a status that maps to no workflow step" };
  }

  if (caseRow.status === "RESOLVED" && mapped !== "RESOLVED") {
    run(
      "UPDATE cases SET authority_status = ?, authority_status_at = ?, authority_reference = ?, updated_at = ? WHERE id = ?",
      remote.status,
      now,
      reference,
      now,
      caseRow.id,
    );
    return { applied: false, caseStatus: "RESOLVED", reason: "Case is already resolved locally; the authority status was recorded but not applied" };
  }

  if (caseRow.status === "REJECTED") {
    return { applied: false, caseStatus: "REJECTED", reason: "Case was rejected during verification and is not routed" };
  }

  const resolvedAt = mapped === "RESOLVED" ? caseRow.resolved_at ?? now : caseRow.resolved_at;
  const timeline = appendTimeline(caseRow, {
    date: now.slice(0, 10),
    event: `Health authority reported ${remote.status}${remote.message ? ` — ${remote.message}` : ""}`,
  });

  run(
    `UPDATE cases SET status = ?, authority_status = ?, authority_status_at = ?, authority_reference = ?,
      timeline_json = ?, resolved_at = ?, updated_at = ? WHERE id = ?`,
    mapped,
    remote.status,
    now,
    reference,
    timeline,
    resolvedAt,
    now,
    caseRow.id,
  );

  audit({
    actor: opts.actor ?? { id: null, role: "SYSTEM" },
    action: "AUTHORITY_STATUS_SYNCED",
    entityType: "case",
    entityId: caseRow.id,
    details: {
      remoteStatus: remote.status,
      appliedStatus: mapped,
      reference,
      message: remote.message ?? null,
      previousStatus: caseRow.status,
    },
  });

  // A status pulled from the department is a status the patient should hear about.
  notifyCaseStatusChange({ ...caseRow, status: mapped, resolved_at: resolvedAt }, caseRow.status);

  return { applied: true, caseStatus: mapped };
}

/**
 * Poll the receiving department for the latest status of a single case.
 */
export async function syncCaseStatus(
  caseId: string,
  opts: { actor?: { id: string | null; role: string | null }; force?: boolean } = {},
): Promise<StatusSyncOutcome> {
  const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", caseId.toUpperCase());
  if (!caseRow) throw Object.assign(new Error("Case not found"), { status: 404 });

  const authority = findAuthority(caseRow.authority_id);
  const adapterCode = authority?.authority.adapter ?? "IN-FHIR";
  const { config } = resolveAdapter(adapterCode);
  const transmission = lastTransmissionFor(caseRow.id);
  const reference = caseRow.authority_reference ?? transmission?.reference ?? null;
  const started = Date.now();

  if (!transmission || transmission.status !== "DELIVERED") {
    const outcome: StatusSyncOutcome = {
      caseId: caseRow.id,
      authorityId: caseRow.authority_id,
      adapterCode,
      endpoint: "",
      ok: false,
      simulated: false,
      remoteStatus: null,
      remoteReference: null,
      message: "The case has not been transmitted to the authority yet",
      httpStatus: null,
      latencyMs: 0,
      applied: false,
      caseStatus: caseRow.status,
      reason: "not-dispatched",
    };
    const syncId = recordSync({
      caseId: caseRow.id,
      transmissionId: transmission?.id ?? null,
      authorityId: caseRow.authority_id,
      adapterCode,
      endpoint: "",
      status: "FAILED",
      remote: null,
      httpStatus: null,
      latencyMs: 0,
      applied: false,
      simulated: false,
      raw: {},
      message: outcome.message,
    });
    audit({
      actor: opts.actor ?? { id: null, role: "SYSTEM" },
      action: "AUTHORITY_STATUS_CHECK_FAILED",
      entityType: "case",
      entityId: caseRow.id,
      details: { syncId, adapter: adapterCode, reason: "not-dispatched" },
    });
    return outcome;
  }

  const request = buildStatusRequest(config, caseRow, reference);
  const endpoint = request?.url ?? "";
  let remote: RemoteStatus | null = null;
  let httpStatus: number | null = null;
  let simulated = false;
  let message: string | null = null;
  let ok = false;
  let raw: unknown = {};

  if (config.simulate) {
    simulated = true;
    const sim = simulatedStatus(caseRow, reference, transmission.created_at);
    remote = { status: sim.status, reference: sim.reference, message: sim.message, updatedAt: sim.updatedAt };
    httpStatus = 200;
    ok = true;
    raw = sim;
  } else if (!request) {
    message = "No status endpoint is configured for this adapter";
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATUS_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(request.url, { method: "GET", headers: request.headers, signal: controller.signal });
      const text = await res.text();
      httpStatus = res.status;
      const parsed = parseStatusResponse(config.kind, res.status, text);
      raw = parsed.raw;
      remote = { status: parsed.status, reference: parsed.reference, message: parsed.message, updatedAt: parsed.updatedAt };
      ok = parsed.ok;
      message = parsed.ok ? parsed.message : (parsed.message ?? "The authority did not return a recognisable status");
    } catch (err) {
      message = `Status request failed: ${(err as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
  }

  const latencyMs = Date.now() - started;
  let applied = false;
  let caseStatus = caseRow.status;
  let reason: string | undefined;

  if (remote?.status) {
    const result = applyAuthorityStatus(caseRow, remote, { actor: opts.actor });
    applied = result.applied;
    caseStatus = result.caseStatus;
    reason = result.reason;
  }

  const syncId = recordSync({
    caseId: caseRow.id,
    transmissionId: transmission.id,
    authorityId: caseRow.authority_id,
    adapterCode,
    endpoint,
    status: !ok ? "FAILED" : applied ? "SUCCESS" : "UNCHANGED",
    remote,
    httpStatus,
    latencyMs,
    applied,
    simulated,
    raw,
    message: message ?? remote?.message ?? null,
  });

  audit({
    actor: opts.actor ?? { id: null, role: "SYSTEM" },
    action: ok ? "AUTHORITY_STATUS_CHECKED" : "AUTHORITY_STATUS_CHECK_FAILED",
    entityType: "case",
    entityId: caseRow.id,
    details: {
      syncId,
      adapter: adapterCode,
      endpoint,
      httpStatus,
      latencyMs,
      simulated,
      remoteStatus: remote?.status ?? null,
    },
  });

  return {
    caseId: caseRow.id,
    authorityId: caseRow.authority_id,
    adapterCode,
    endpoint,
    ok,
    simulated,
    remoteStatus: remote?.status ?? null,
    remoteReference: remote?.reference ?? null,
    message: message ?? remote?.message ?? null,
    httpStatus,
    latencyMs,
    applied,
    caseStatus,
    reason,
  };
}
