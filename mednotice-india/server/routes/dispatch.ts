import { Router } from "express";
import { all, count, get, nowIso } from "../db.js";
import { audit } from "../audit.js";
import { assertCaseAccess } from "../access.js";
import { asyncHandler, HttpError, meta } from "../http.js";
import { requireAuth, requirePermission, requireRole, STAFF_ROLES } from "../auth.js";
import { findAuthority } from "../registry.js";
import { transmitCase } from "../routing.js";
import { syncCaseStatus, listStatusSyncs, lastTransmissionFor } from "../authority-status.js";
import {
  dispatchEligibility,
  isDispatchRunning,
  pendingDispatchCases,
  pendingStatusSyncCases,
  runDispatchCycle,
  runSyncCycle,
  schedulerState,
} from "../scheduler.js";
import type { CaseRow } from "../models.js";

/**
 * Dispatch desk API.
 *
 * Exposes the state of the cron-style dispatcher, the log of data sent to the
 * health authorities, the status-pull history and the manual controls used to
 * run a cycle or refresh a single case on demand.
 */
export const dispatchRouter = Router();

dispatchRouter.use(requireAuth, requireRole(...STAFF_ROLES));

const intParam = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
};

type TransmissionRow = {
  transmission_id: string;
  case_id: string;
  adapter_code: string;
  transmission_status: string;
  request_json: string;
  response_json: string;
  http_status: number | null;
  latency_ms: number | null;
  sent_at: string;
  reference: string | null;
  patient_name_masked: string;
  authority_id: string;
  facility_name: string | null;
  priority: string;
  case_status: string;
  verification_status: string;
  authority_status: string | null;
  authority_status_at: string | null;
  authority_reference: string | null;
  case_created_at: string;
  case_updated_at: string;
};

type CaseSummary = {
  id: string;
  patientName: string;
  authorityId: string;
  authorityName: string;
  facilityName: string | null;
  priority: string;
  status: string;
  verificationStatus: string;
  authorityStatus: string | null;
  authorityStatusAt: string | null;
  authorityReference: string | null;
  createdAt: string;
  updatedAt: string;
};

function caseSummary(row: CaseRow): CaseSummary {
  const authority = findAuthority(row.authority_id);
  return {
    id: row.id,
    patientName: row.patient_name_masked,
    authorityId: row.authority_id,
    authorityName: authority?.authority.name ?? row.authority_id,
    facilityName: row.facility_name,
    priority: row.priority,
    status: row.status,
    verificationStatus: row.verification_status,
    authorityStatus: row.authority_status ?? null,
    authorityStatusAt: row.authority_status_at ?? null,
    authorityReference: row.authority_reference ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------ scheduler -------------------------------- */

dispatchRouter.get(
  "/status",
  requirePermission("cases.view"),
  asyncHandler((_req, res) => {
    const scheduler = schedulerState();
    const queue = pendingDispatchCases(50);
    const dueForSync = pendingStatusSyncCases(50);

    const counts = get<Record<string, number>>(
      `SELECT
         SUM(CASE WHEN status IN ('SUBMITTED','ROUTE_FAILED') AND verification_status = 'VERIFIED' THEN 1 ELSE 0 END) AS awaitingDispatch,
         SUM(CASE WHEN status IN ('ROUTED','UNDER_REVIEW') THEN 1 ELSE 0 END) AS withAuthority,
         SUM(CASE WHEN authority_status IS NOT NULL THEN 1 ELSE 0 END) AS withAuthorityStatus
       FROM cases`,
    );

    const totals = get<Record<string, number>>(
      `SELECT
         SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS total
       FROM transmissions`,
    );

    const syncTotals = get<Record<string, number>>(
      `SELECT
         SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS applied,
         SUM(CASE WHEN status = 'UNCHANGED' THEN 1 ELSE 0 END) AS unchanged,
         SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS total
       FROM case_status_syncs`,
    );

    const lastSent = get<{ created_at: string }>("SELECT created_at FROM transmissions ORDER BY created_at DESC LIMIT 1");
    const lastChecked = get<{ checked_at: string }>("SELECT checked_at FROM case_status_syncs ORDER BY checked_at DESC LIMIT 1");

    res.json({
      scheduler: {
        ...scheduler,
        running: scheduler.running && !isDispatchRunning(),
        cycleInProgress: isDispatchRunning(),
      },
      queue: {
        awaitingDispatch: Number(counts?.awaitingDispatch ?? 0),
        withAuthority: Number(counts?.withAuthority ?? 0),
        withAuthorityStatus: Number(counts?.withAuthorityStatus ?? 0),
        dispatchCandidates: queue.length,
        syncCandidates: dueForSync.length,
      },
      transmissions: {
        total: Number(totals?.total ?? 0),
        delivered: Number(totals?.delivered ?? 0),
        failed: Number(totals?.failed ?? 0),
        lastSentAt: lastSent?.created_at ?? null,
      },
      statusSyncs: {
        total: Number(syncTotals?.total ?? 0),
        applied: Number(syncTotals?.applied ?? 0),
        unchanged: Number(syncTotals?.unchanged ?? 0),
        failed: Number(syncTotals?.failed ?? 0),
        lastCheckedAt: lastChecked?.checked_at ?? null,
      },
      generatedAt: nowIso(),
    });
  }),
);

/* --------------------------- last data sent ----------------------------- */

dispatchRouter.get(
  "/transmissions",
  requirePermission("cases.view"),
  asyncHandler((req, res) => {
    const limit = intParam(req.query.limit, 25, 200);
    const offset = intParam(req.query.offset, 0, 100_000);
    const status = typeof req.query.status === "string" ? req.query.status.trim().toUpperCase() : "";

    const where: string[] = [];
    const params: unknown[] = [];
    if (status === "DELIVERED" || status === "FAILED") {
      where.push("t.status = ?");
      params.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = all<TransmissionRow>(
      `SELECT t.id AS transmission_id, t.case_id, t.adapter_code, t.status AS transmission_status, t.request_json,
              t.response_json, t.http_status, t.latency_ms, t.created_at AS sent_at, t.reference,
              c.patient_name_masked, c.authority_id, c.facility_name, c.priority, c.status AS case_status,
              c.verification_status, c.authority_status, c.authority_status_at, c.authority_reference,
              c.created_at AS case_created_at, c.updated_at AS case_updated_at
       FROM transmissions t JOIN cases c ON c.id = t.case_id ${clause}
       ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const total = count(`SELECT COUNT(*) AS n FROM transmissions t ${clause}`, ...params);

    res.json({
      total,
      limit,
      offset,
      transmissions: rows.map((row) => {
        let response: Record<string, unknown> = {};
        try {
          response = JSON.parse(row.response_json || "{}") as Record<string, unknown>;
        } catch {
          response = { raw: row.response_json };
        }
        const authority = findAuthority(row.authority_id);
        return {
          id: row.transmission_id,
          caseId: row.case_id,
          adapterCode: row.adapter_code,
          status: row.transmission_status,
          httpStatus: row.http_status,
          latencyMs: row.latency_ms,
          reference: row.reference,
          ackId: response.ackId ?? null,
          message: response.message ?? null,
          simulated: Boolean(response.simulated),
          payloadBytes: (row.request_json || "").length,
          createdAt: row.sent_at,
          case: {
            id: row.case_id,
            patientName: row.patient_name_masked,
            authorityId: row.authority_id,
            authorityName: authority?.authority.name ?? row.authority_id,
            facilityName: row.facility_name,
            priority: row.priority,
            status: row.case_status,
            verificationStatus: row.verification_status,
            authorityStatus: row.authority_status ?? null,
            authorityStatusAt: row.authority_status_at ?? null,
            authorityReference: row.authority_reference ?? null,
            createdAt: row.case_created_at,
            updatedAt: row.case_updated_at,
          },
        };
      }),
    });
  }),
);

/* -------------------------- status pull history ------------------------- */

dispatchRouter.get(
  "/syncs",
  requirePermission("cases.view"),
  asyncHandler((req, res) => {
    const limit = intParam(req.query.limit, 25, 200);
    const offset = intParam(req.query.offset, 0, 100_000);
    const caseId = typeof req.query.caseId === "string" ? req.query.caseId.trim().toUpperCase() : "";

    const where: string[] = [];
    const params: unknown[] = [];
    if (caseId) {
      where.push("s.case_id = ?");
      params.push(caseId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = all<Record<string, unknown>>(
      `SELECT s.*, c.patient_name_masked, c.authority_id, c.facility_name, c.status AS case_status
       FROM case_status_syncs s JOIN cases c ON c.id = s.case_id ${clause}
       ORDER BY s.checked_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const total = count(`SELECT COUNT(*) AS n FROM case_status_syncs s ${clause}`, ...params);

    res.json({
      total,
      limit,
      offset,
      syncs: rows.map((row) => ({
        id: row.id,
        caseId: row.case_id,
        patientName: row.patient_name_masked,
        authorityId: row.authority_id,
        facilityName: row.facility_name,
        caseStatus: row.case_status,
        transmissionId: row.transmission_id,
        adapterCode: row.adapter_code,
        endpoint: row.endpoint,
        status: row.status,
        remoteStatus: row.remote_status,
        remoteReference: row.remote_reference,
        message: row.message,
        httpStatus: row.http_status,
        latencyMs: row.latency_ms,
        applied: Boolean(row.applied),
        simulated: Boolean(row.simulated),
        checkedAt: row.checked_at,
      })),
    });
  }),
);

/* -------------------------------- queue ---------------------------------- */

dispatchRouter.get(
  "/queue",
  requirePermission("cases.view"),
  asyncHandler((_req, res) => {
    const pending = pendingDispatchCases(50).map(({ caseRow }) => {
      const eligibility = dispatchEligibility(caseRow.id);
      return { ...caseSummary(caseRow), eligible: eligibility.eligible, reason: eligibility.reason, attempts: eligibility.attempts };
    });
    const dueForSync = pendingStatusSyncCases(50).map((row) => {
      const transmission = lastTransmissionFor(row.id);
      return {
        ...caseSummary(row),
        adapterCode: transmission?.adapter_code ?? null,
        transmittedAt: transmission?.created_at ?? null,
      };
    });
    res.json({ pending, dueForSync });
  }),
);

/* ------------------------------- controls -------------------------------- */

dispatchRouter.post(
  "/run",
  requirePermission("cases.route"),
  asyncHandler(async (req, res) => {
    const summary = await runDispatchCycle(25);
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "DISPATCH_CYCLE_TRIGGERED",
      entityType: "scheduler",
      entityId: "dispatch",
      ...meta(req),
      details: { dispatched: summary.dispatched, failed: summary.dispatchFailed, deferred: summary.dispatchDeferred },
    });
    res.json({ summary });
  }),
);

dispatchRouter.post(
  "/sync",
  requirePermission("cases.route"),
  asyncHandler(async (req, res) => {
    const summary = await runSyncCycle(25);
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "STATUS_SYNC_CYCLE_TRIGGERED",
      entityType: "scheduler",
      entityId: "status-sync",
      ...meta(req),
      details: { synced: summary.synced, unchanged: summary.syncUnchanged, failed: summary.syncFailed },
    });
    res.json({ summary });
  }),
);

dispatchRouter.post(
  "/cases/:id/dispatch",
  requirePermission("cases.route"),
  asyncHandler(async (req, res) => {
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", req.params.id.toUpperCase());
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow, "write");
    const result = await transmitCase(caseRow.id, { actor: { id: req.user!.id, role: req.user!.role }, ...meta(req) });
    res.json({ transmission: result });
  }),
);

dispatchRouter.post(
  "/cases/:id/sync",
  requirePermission("cases.route"),
  asyncHandler(async (req, res) => {
    const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", req.params.id.toUpperCase());
    if (!caseRow) throw new HttpError(404, "Case not found");
    assertCaseAccess(req, caseRow, "write");
    const outcome = await syncCaseStatus(caseRow.id, { actor: { id: req.user!.id, role: req.user!.role }, force: true });
    const fresh = get<CaseRow>("SELECT * FROM cases WHERE id = ?", caseRow.id)!;
    res.json({ outcome, case: caseSummary(fresh), history: listStatusSyncs(caseRow.id, 10) });
  }),
);
