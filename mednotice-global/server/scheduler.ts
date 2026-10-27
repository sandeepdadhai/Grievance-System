import { all, get, nowIso } from "./db.js";
import { audit } from "./audit.js";
import {
  DISPATCH_CRON_ENABLED,
  DISPATCH_INTERVAL_MS,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_RETRY_DELAY_MS,
  STATUS_SYNC_INTERVAL_MS,
} from "./config.js";
import { transmitCase } from "./routing.js";
import { syncCaseStatus, type StatusSyncOutcome } from "./authority-status.js";
import type { CaseRow } from "./models.js";

/**
 * Cron-style dispatch worker.
 *
 * Two independent jobs run on fixed intervals:
 *
 *  1. **Dispatch** — every `DISPATCH_INTERVAL_MS` (default 1 minute) the case
 *     queue is scanned for grievances that are verified but not yet accepted
 *     by their health authority (never transmitted, or the last transmission
 *     failed). They are transmitted through the authority's adapter.
 *  2. **Status sync** — every `STATUS_SYNC_INTERVAL_MS` (default 5 minutes)
 *     every routed case is polled at its department for the latest status,
 *     which is written back to the case.
 *
 * Both cycles are idempotent and can also be triggered on demand from the
 * admin console (`POST /api/admin/dispatch/run` and `.../sync`).
 */

export type CycleSummary = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dispatched: number;
  dispatchFailed: number;
  dispatchDeferred: number;
  synced: number;
  syncUnchanged: number;
  syncFailed: number;
  caseIds: string[];
};

export type SchedulerState = {
  enabled: boolean;
  running: boolean;
  startedAt: string | null;
  dispatchIntervalMs: number;
  syncIntervalMs: number;
  nextDispatchAt: string | null;
  nextSyncAt: string | null;
  lastDispatch: CycleSummary | null;
  lastSync: CycleSummary | null;
  lastError: string | null;
};

const PRIORITY_ORDER = "CASE c.priority WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 WHEN 'P3' THEN 2 ELSE 3 END";

const state: SchedulerState = {
  enabled: DISPATCH_CRON_ENABLED,
  running: false,
  startedAt: null,
  dispatchIntervalMs: DISPATCH_INTERVAL_MS,
  syncIntervalMs: STATUS_SYNC_INTERVAL_MS,
  nextDispatchAt: null,
  nextSyncAt: null,
  lastDispatch: null,
  lastSync: null,
  lastError: null,
};

let dispatchTimer: NodeJS.Timeout | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let dispatchInFlight = false;
let syncInFlight = false;

export function schedulerState(): SchedulerState {
  return { ...state };
}

/** Cases that are verified but not yet accepted by their authority. */
export function pendingDispatchCases(limit = 50): Array<{ caseRow: CaseRow; reason: string }> {
  const rows = all<CaseRow>(
    `SELECT c.* FROM cases c
     WHERE c.status IN ('SUBMITTED', 'ROUTE_FAILED')
       AND c.verification_status = 'VERIFIED'
       AND NOT EXISTS (SELECT 1 FROM transmissions t WHERE t.case_id = c.id AND t.status = 'DELIVERED')
     ORDER BY ${PRIORITY_ORDER}, c.sla_due_at ASC
     LIMIT ?`,
    limit,
  );
  return rows.map((caseRow) => ({ caseRow, reason: "awaiting transmission" }));
}

export function dispatchEligibility(caseId: string): { eligible: boolean; reason: string; attempts: number } {
  const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", caseId);
  if (!caseRow) return { eligible: false, reason: "case not found", attempts: 0 };
  const attempts = Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM transmissions WHERE case_id = ?", caseId)?.n ?? 0);
  if (caseRow.status === "REJECTED") return { eligible: false, reason: "case rejected", attempts };
  if (caseRow.verification_status !== "VERIFIED") return { eligible: false, reason: "documents not verified", attempts };
  if (caseRow.status === "PENDING_REVIEW") return { eligible: false, reason: "awaiting manual review", attempts };
  const delivered = Number(
    get<{ n: number }>("SELECT COUNT(*) AS n FROM transmissions WHERE case_id = ? AND status = 'DELIVERED'", caseId)?.n ?? 0,
  );
  if (delivered > 0) return { eligible: false, reason: "the authority has already accepted this case", attempts };
  if (attempts >= DISPATCH_MAX_ATTEMPTS) return { eligible: false, reason: "maximum delivery attempts reached", attempts };
  const last = get<{ created_at: string }>("SELECT created_at FROM transmissions WHERE case_id = ? ORDER BY created_at DESC LIMIT 1", caseId);
  if (last && Date.now() - new Date(last.created_at).getTime() < DISPATCH_RETRY_DELAY_MS) {
    return { eligible: false, reason: "waiting for the retry backoff to elapse", attempts };
  }
  return { eligible: true, reason: "ready to dispatch", attempts };
}

/**
 * Transmit every case that is waiting for the authority. Failures are left in
 * place so the next cycle can retry them (with the configured backoff).
 */
export async function runDispatchCycle(limit = 25): Promise<CycleSummary> {
  const startedAt = nowIso();
  const started = Date.now();
  const summary: CycleSummary = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    dispatched: 0,
    dispatchFailed: 0,
    dispatchDeferred: 0,
    synced: 0,
    syncUnchanged: 0,
    syncFailed: 0,
    caseIds: [],
  };

  const candidates = pendingDispatchCases(limit);
  for (const { caseRow } of candidates) {
    const eligibility = dispatchEligibility(caseRow.id);
    if (!eligibility.eligible) {
      summary.dispatchDeferred += 1;
      continue;
    }
    try {
      const result = await transmitCase(caseRow.id, { actor: { id: null, role: "SYSTEM" } });
      if (result.status === "DELIVERED") {
        summary.dispatched += 1;
        summary.caseIds.push(caseRow.id);
      } else {
        summary.dispatchFailed += 1;
      }
    } catch (err) {
      summary.dispatchFailed += 1;
      audit({
        actor: { id: null, role: "SYSTEM" },
        action: "DISPATCH_FAILED",
        entityType: "case",
        entityId: caseRow.id,
        details: { error: (err as Error).message },
      });
    }
  }

  summary.finishedAt = nowIso();
  summary.durationMs = Date.now() - started;
  state.lastDispatch = summary;
  state.lastError = null;
  audit({
    actor: { id: null, role: "SYSTEM" },
    action: "DISPATCH_CYCLE_COMPLETED",
    entityType: "scheduler",
    entityId: "dispatch",
    details: {
      dispatched: summary.dispatched,
      failed: summary.dispatchFailed,
      deferred: summary.dispatchDeferred,
      durationMs: summary.durationMs,
    },
  });
  return summary;
}

/** Cases whose authority status is due for a refresh. */
export function pendingStatusSyncCases(limit = 50): CaseRow[] {
  const due = new Date(Date.now() - STATUS_SYNC_INTERVAL_MS).toISOString();
  return all<CaseRow>(
    `SELECT c.* FROM cases c
     WHERE c.status NOT IN ('REJECTED')
       AND EXISTS (SELECT 1 FROM transmissions t WHERE t.case_id = c.id AND t.status = 'DELIVERED')
       AND (c.authority_status_at IS NULL OR c.authority_status_at <= ?)
     ORDER BY ${PRIORITY_ORDER}, c.updated_at ASC
     LIMIT ?`,
    due,
    limit,
  );
}

/** Poll every routed case that is due for a status refresh. */
export async function runSyncCycle(limit = 25): Promise<CycleSummary> {
  const startedAt = nowIso();
  const started = Date.now();
  const summary: CycleSummary = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    dispatched: 0,
    dispatchFailed: 0,
    dispatchDeferred: 0,
    synced: 0,
    syncUnchanged: 0,
    syncFailed: 0,
    caseIds: [],
  };

  const cases = pendingStatusSyncCases(limit);
  for (const caseRow of cases) {
    let outcome: StatusSyncOutcome;
    try {
      outcome = await syncCaseStatus(caseRow.id, { actor: { id: null, role: "SYSTEM" } });
    } catch (err) {
      summary.syncFailed += 1;
      audit({
        actor: { id: null, role: "SYSTEM" },
        action: "AUTHORITY_STATUS_CHECK_FAILED",
        entityType: "case",
        entityId: caseRow.id,
        details: { error: (err as Error).message },
      });
      continue;
    }
    if (!outcome.ok) {
      summary.syncFailed += 1;
    } else if (outcome.applied) {
      summary.synced += 1;
      summary.caseIds.push(caseRow.id);
    } else {
      summary.syncUnchanged += 1;
    }
  }

  summary.finishedAt = nowIso();
  summary.durationMs = Date.now() - started;
  state.lastSync = summary;
  audit({
    actor: { id: null, role: "SYSTEM" },
    action: "STATUS_SYNC_CYCLE_COMPLETED",
    entityType: "scheduler",
    entityId: "status-sync",
    details: { synced: summary.synced, unchanged: summary.syncUnchanged, failed: summary.syncFailed, durationMs: summary.durationMs },
  });
  return summary;
}

function scheduleNext(timer: NodeJS.Timeout, intervalMs: number, onTick: () => void, setNext: (iso: string | null) => void): void {
  setNext(new Date(Date.now() + intervalMs).toISOString());
  timer.refresh?.();
  onTick();
}

export function startScheduler(): void {
  if (!DISPATCH_CRON_ENABLED || dispatchTimer || syncTimer) return;
  state.running = true;
  state.startedAt = nowIso();
  state.nextDispatchAt = new Date(Date.now() + DISPATCH_INTERVAL_MS).toISOString();
  state.nextSyncAt = new Date(Date.now() + STATUS_SYNC_INTERVAL_MS).toISOString();

  dispatchTimer = setInterval(() => {
    if (dispatchInFlight) return;
    dispatchInFlight = true;
    state.nextDispatchAt = new Date(Date.now() + DISPATCH_INTERVAL_MS).toISOString();
    void runDispatchCycle()
      .catch((err) => {
        state.lastError = (err as Error).message;
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  }, DISPATCH_INTERVAL_MS);
  dispatchTimer.unref();

  syncTimer = setInterval(() => {
    if (syncInFlight) return;
    syncInFlight = true;
    state.nextSyncAt = new Date(Date.now() + STATUS_SYNC_INTERVAL_MS).toISOString();
    void runSyncCycle()
      .catch((err) => {
        state.lastError = (err as Error).message;
      })
      .finally(() => {
        syncInFlight = false;
      });
  }, STATUS_SYNC_INTERVAL_MS);
  syncTimer.unref();

  console.log(
    `[mednotice] dispatch cron: every ${Math.round(DISPATCH_INTERVAL_MS / 1000)}s · status sync: every ${Math.round(
      STATUS_SYNC_INTERVAL_MS / 1000,
    )}s`,
  );
}

export function stopScheduler(): void {
  if (dispatchTimer) clearInterval(dispatchTimer);
  if (syncTimer) clearInterval(syncTimer);
  dispatchTimer = null;
  syncTimer = null;
  state.running = false;
  state.nextDispatchAt = null;
  state.nextSyncAt = null;
}

/** True while a cycle is executing — used by the API to avoid overlap. */
export function isDispatchRunning(): boolean {
  return dispatchInFlight || syncInFlight;
}
