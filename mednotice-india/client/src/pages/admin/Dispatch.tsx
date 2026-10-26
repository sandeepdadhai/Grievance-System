import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, timeAgo } from "../../api";
import { hasPermission } from "../../api";
import { useAuth } from "../../auth";
import { Alert, Badge, Card, CardHead, Icon, Spinner, StatusBadge } from "../../components/ui";

type CycleSummary = {
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

type SchedulerState = {
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
  cycleInProgress: boolean;
};

type DispatchStatus = {
  scheduler: SchedulerState;
  queue: {
    awaitingDispatch: number;
    withAuthority: number;
    withAuthorityStatus: number;
    dispatchCandidates: number;
    syncCandidates: number;
  };
  transmissions: { total: number; delivered: number; failed: number; lastSentAt: string | null };
  statusSyncs: { total: number; applied: number; unchanged: number; failed: number; lastCheckedAt: string | null };
  generatedAt: string;
};

type SentRow = {
  id: string;
  caseId: string;
  adapterCode: string;
  status: string;
  httpStatus: number | null;
  latencyMs: number | null;
  reference: string | null;
  ackId: string | null;
  message: string | null;
  simulated: boolean;
  payloadBytes: number;
  createdAt: string;
  case: {
    id: string;
    patientName: string;
    authorityName: string;
    facilityName: string | null;
    priority: string;
    status: string;
    authorityStatus: string | null;
    authorityStatusAt: string | null;
  };
};

type SyncRow = {
  id: string;
  caseId: string;
  patientName: string;
  authorityId: string;
  facilityName: string | null;
  caseStatus: string;
  transmissionId: string | null;
  adapterCode: string;
  endpoint: string;
  status: string;
  remoteStatus: string | null;
  remoteReference: string | null;
  message: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  applied: boolean;
  simulated: boolean;
  checkedAt: string;
};

type QueueRow = {
  id: string;
  patientName: string;
  authorityName: string;
  facilityName: string | null;
  priority: string;
  status: string;
  verificationStatus: string;
  authorityStatus: string | null;
  authorityStatusAt: string | null;
  eligible?: boolean;
  reason?: string;
  attempts?: number;
  adapterCode?: string | null;
  transmittedAt?: string | null;
};

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

function remoteTone(status: string | null): "ok" | "warn" | "bad" | "info" | "muted" {
  if (!status) return "muted";
  const value = status.toUpperCase();
  if (/(RESOLVED|CLOSED|COMPLETED|ACTION_COMPLETE|DISPOSED)/.test(value)) return "ok";
  if (/(REJECT|DISMISS)/.test(value)) return "bad";
  if (/(ESCALAT|URGENT)/.test(value)) return "warn";
  if (/(REVIEW|PENDING|PROGRESS|ACKNOWLEDG|REGISTER|RECEIV)/.test(value)) return "info";
  return "muted";
}

export default function AdminDispatch() {
  const { user } = useAuth();
  const canRun = hasPermission(user, "cases.route");
  const [tab, setTab] = useState<"sent" | "syncs" | "queue">("sent");
  const [status, setStatus] = useState<DispatchStatus | null>(null);
  const [sent, setSent] = useState<SentRow[] | null>(null);
  const [syncs, setSyncs] = useState<SyncRow[] | null>(null);
  const [queue, setQueue] = useState<{ pending: QueueRow[]; dueForSync: QueueRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const [s, sentRows, syncRows, q] = await Promise.all([
        api.get<DispatchStatus>("/api/admin/dispatch/status"),
        api.get<{ transmissions: SentRow[] }>("/api/admin/dispatch/transmissions?limit=50"),
        api.get<{ syncs: SyncRow[] }>("/api/admin/dispatch/syncs?limit=50"),
        api.get<{ pending: QueueRow[]; dueForSync: QueueRow[] }>("/api/admin/dispatch/queue"),
      ]);
      setStatus(s);
      setSent(sentRows.transmissions);
      setSyncs(syncRows.syncs);
      setQueue(q);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function runDispatch() {
    setBusy("dispatch");
    setNotice(null);
    try {
      const { summary } = await api.post<{ summary: CycleSummary }>("/api/admin/dispatch/run");
      setNotice(
        `Dispatch cycle finished in ${summary.durationMs} ms — ${summary.dispatched} sent, ${summary.dispatchFailed} failed, ${summary.dispatchDeferred} deferred.`,
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runSync() {
    setBusy("sync");
    setNotice(null);
    try {
      const { summary } = await api.post<{ summary: CycleSummary }>("/api/admin/dispatch/sync");
      setNotice(
        `Status cycle finished in ${summary.durationMs} ms — ${summary.synced} updated, ${summary.syncUnchanged} unchanged, ${summary.syncFailed} failed.`,
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function syncCase(caseId: string) {
    setBusy(caseId);
    setNotice(null);
    try {
      const result = await api.post<{ outcome: { remoteStatus: string | null; applied: boolean; message: string | null } }>(
        `/api/admin/dispatch/cases/${caseId}/sync`,
      );
      setNotice(
        result.outcome.remoteStatus
          ? `${caseId}: authority reported ${result.outcome.remoteStatus}${result.outcome.applied ? " (applied to the case)" : " (recorded only)"}.`
          : `${caseId}: no status returned — ${result.outcome.message ?? "unknown error"}.`,
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function dispatchCase(caseId: string) {
    setBusy(caseId);
    setNotice(null);
    try {
      const result = await api.post<{ transmission: { status: string; message: string } }>(
        `/api/admin/dispatch/cases/${caseId}/dispatch`,
      );
      setNotice(`${caseId}: transmission ${result.transmission.status.toLowerCase()} — ${result.transmission.message}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const scheduler = status?.scheduler;
  const lastSent = sent?.[0];

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Dispatch</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            Cron delivery of case bundles to each health authority, with automatic status pull-back from the department.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {canRun && (
            <>
              <button className="btn sm" onClick={() => void runDispatch()} disabled={busy !== null}>
                {busy === "dispatch" ? <span className="spinner" /> : <><Icon name="send" size={13} /> Run dispatch now</>}
              </button>
              <button className="btn sm" onClick={() => void runSync()} disabled={busy !== null}>
                {busy === "sync" ? <span className="spinner" /> : <><Icon name="refresh" size={13} /> Pull statuses now</>}
              </button>
            </>
          )}
          <button className="btn sm ghost" onClick={() => void load()}><Icon name="refresh" size={13} /> Refresh</button>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi">
          <div className="kpi-label">Scheduler <span>{scheduler?.running ? <Badge tone="ok" dot>Running</Badge> : <Badge tone="muted">Stopped</Badge>}</span></div>
          <div className="kpi-value">{scheduler?.running ? "Active" : "Paused"}</div>
          <div className="kpi-foot">
            Dispatch every {scheduler ? minutes(scheduler.dispatchIntervalMs) : "—"} · status every {scheduler ? minutes(scheduler.syncIntervalMs) : "—"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Awaiting dispatch</div>
          <div className="kpi-value">{status?.queue.awaitingDispatch ?? 0}</div>
          <div className="kpi-foot">{status?.queue.dispatchCandidates ?? 0} case(s) picked up by the last scan</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">With the authority</div>
          <div className="kpi-value">{status?.queue.withAuthority ?? 0}</div>
          <div className="kpi-foot">{status?.queue.syncCandidates ?? 0} due a status refresh</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Last data sent</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>{lastSent ? formatDate(lastSent.createdAt, { hour: "2-digit", minute: "2-digit" }) : "—"}</div>
          <div className="kpi-foot">
            {status?.transmissions.delivered ?? 0} delivered · {status?.transmissions.failed ?? 0} failed
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Status pulls</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>{status?.statusSyncs.total ?? 0}</div>
          <div className="kpi-foot">
            {status?.statusSyncs.applied ?? 0} applied · {status?.statusSyncs.failed ?? 0} failed
          </div>
        </div>
      </div>

      {scheduler?.lastError && <Alert tone="warn">Last scheduler error: {scheduler.lastError}</Alert>}

      <div className="grid-2" style={{ marginBottom: 18 }}>
        <Card>
          <CardHead title="Dispatch cycle" sub="Transmits verified cases that the authority has not accepted yet." />
          <div className="small" style={{ marginTop: 10, display: "grid", gap: 6 }}>
            {scheduler?.lastDispatch ? (
              <>
                <div className="row-between"><span className="muted">Last run</span><span className="mono">{formatDate(scheduler.lastDispatch.startedAt, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div>
                <div className="row-between"><span className="muted">Sent</span><span className="mono">{scheduler.lastDispatch.dispatched}</span></div>
                <div className="row-between"><span className="muted">Failed</span><span className="mono">{scheduler.lastDispatch.dispatchFailed}</span></div>
                <div className="row-between"><span className="muted">Deferred (backoff / attempts)</span><span className="mono">{scheduler.lastDispatch.dispatchDeferred}</span></div>
                <div className="row-between"><span className="muted">Next run</span><span className="mono">{scheduler.nextDispatchAt ? timeAgo(scheduler.nextDispatchAt).replace(" ago", " from now") : "—"}</span></div>
              </>
            ) : (
              <div className="empty">The dispatch cycle has not run yet.</div>
            )}
          </div>
        </Card>
        <Card>
          <CardHead title="Status sync cycle" sub="Polls each department for the latest status of a routed case." />
          <div className="small" style={{ marginTop: 10, display: "grid", gap: 6 }}>
            {scheduler?.lastSync ? (
              <>
                <div className="row-between"><span className="muted">Last run</span><span className="mono">{formatDate(scheduler.lastSync.startedAt, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div>
                <div className="row-between"><span className="muted">Cases updated</span><span className="mono">{scheduler.lastSync.synced}</span></div>
                <div className="row-between"><span className="muted">Unchanged</span><span className="mono">{scheduler.lastSync.syncUnchanged}</span></div>
                <div className="row-between"><span className="muted">Failed</span><span className="mono">{scheduler.lastSync.syncFailed}</span></div>
                <div className="row-between"><span className="muted">Next run</span><span className="mono">{scheduler.nextSyncAt ? timeAgo(scheduler.nextSyncAt).replace(" ago", " from now") : "—"}</span></div>
              </>
            ) : (
              <div className="empty">The status cycle has not run yet.</div>
            )}
          </div>
        </Card>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "sent" ? "active" : ""}`} onClick={() => setTab("sent")}>Last data sent ({sent?.length ?? 0})</button>
        <button className={`tab ${tab === "syncs" ? "active" : ""}`} onClick={() => setTab("syncs")}>Status pull history ({syncs?.length ?? 0})</button>
        <button className={`tab ${tab === "queue" ? "active" : ""}`} onClick={() => setTab("queue")}>Queue</button>
      </div>

      {tab === "sent" && (
        <Card flush>
          <div style={{ padding: "16px 20px 8px" }}>
            <CardHead title="Data sent to health authorities" sub="Every transmission the platform made, newest first." />
          </div>
          {!sent && <div style={{ padding: 20 }}><Spinner /></div>}
          {sent && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Case</th><th>Authority</th><th>Adapter</th><th>Result</th><th>Reference</th><th>Payload</th><th>Latency</th><th>Sent</th></tr>
                </thead>
                <tbody>
                  {sent.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link to={`/admin/cases/${row.caseId}`} className="cell-id">{row.caseId}</Link>
                        <div className="tiny faint">{row.case.patientName}</div>
                      </td>
                      <td className="small">{row.case.authorityName}<div className="tiny faint">{row.case.facilityName ?? "—"}</div></td>
                      <td className="mono small">{row.adapterCode}</td>
                      <td>
                        <StatusBadge status={row.status} />
                        <div className="tiny faint">
                          {row.httpStatus ? `HTTP ${row.httpStatus}` : "no response"}
                          {row.simulated ? " · sandbox" : ""}
                        </div>
                      </td>
                      <td className="mono small">{row.reference ?? row.ackId ?? "—"}</td>
                      <td className="mono small">{row.payloadBytes.toLocaleString()} B</td>
                      <td className="mono small">{row.latencyMs != null ? `${row.latencyMs} ms` : "—"}</td>
                      <td className="small nowrap">{formatDate(row.createdAt, { hour: "2-digit", minute: "2-digit" })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sent.length === 0 && <div className="empty">Nothing has been transmitted yet.</div>}
            </div>
          )}
        </Card>
      )}

      {tab === "syncs" && (
        <Card flush>
          <div style={{ padding: "16px 20px 8px" }}>
            <CardHead title="Status pull history" sub="Each poll of the department, with the status it reported back." />
          </div>
          {!syncs && <div style={{ padding: 20 }}><Spinner /></div>}
          {syncs && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Case</th><th>Authority</th><th>Reported status</th><th>Applied</th><th>HTTP</th><th>Message</th><th>Checked</th><th></th></tr>
                </thead>
                <tbody>
                  {syncs.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link to={`/admin/cases/${row.caseId}`} className="cell-id">{row.caseId}</Link>
                        <div className="tiny faint">{row.patientName}</div>
                      </td>
                      <td className="small">{row.authorityId}<div className="tiny faint">{row.adapterCode}</div></td>
                      <td>
                        <Badge tone={remoteTone(row.remoteStatus)}>{row.remoteStatus ?? "—"}</Badge>
                        {row.remoteReference && <div className="tiny faint mono">{row.remoteReference}</div>}
                      </td>
                      <td>
                        {row.applied ? <Badge tone="ok">Applied</Badge> : <Badge tone="muted">Recorded</Badge>}
                        <div className="tiny faint">{row.simulated ? "sandbox" : "live"}</div>
                      </td>
                      <td className="mono small">{row.httpStatus ?? "—"}</td>
                      <td className="small" style={{ maxWidth: 280 }}>{row.message ?? "—"}</td>
                      <td className="small nowrap">{formatDate(row.checkedAt, { hour: "2-digit", minute: "2-digit" })}</td>
                      <td className="right">
                        {canRun && (
                          <button className="btn sm ghost" onClick={() => void syncCase(row.caseId)} disabled={busy !== null}>
                            {busy === row.caseId ? <span className="spinner" /> : "Re-check"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {syncs.length === 0 && <div className="empty">No status has been pulled from a department yet.</div>}
            </div>
          )}
        </Card>
      )}

      {tab === "queue" && (
        <div className="stack">
          <Card flush>
            <div style={{ padding: "16px 20px 8px" }}>
              <CardHead title="Waiting for dispatch" sub="Verified cases the cron worker will transmit on its next cycle." />
            </div>
            {!queue && <div style={{ padding: 20 }}><Spinner /></div>}
            {queue && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Case</th><th>Authority</th><th>Priority</th><th>Verification</th><th>Reason</th><th>Attempts</th><th></th></tr>
                  </thead>
                  <tbody>
                    {queue.pending.map((row) => (
                      <tr key={row.id}>
                        <td><Link to={`/admin/cases/${row.id}`} className="cell-id">{row.id}</Link><div className="tiny faint">{row.patientName}</div></td>
                        <td className="small">{row.authorityName}</td>
                        <td><Badge tone={row.priority === "P1" ? "bad" : row.priority === "P2" ? "warn" : "muted"}>{row.priority}</Badge></td>
                        <td><StatusBadge status={row.verificationStatus} /></td>
                        <td className="small">{row.reason ?? "—"}</td>
                        <td className="mono small">{row.attempts ?? 0}</td>
                        <td className="right">
                          {canRun && (
                            <button className="btn sm ghost" onClick={() => void dispatchCase(row.id)} disabled={busy !== null}>
                              {busy === row.id ? <span className="spinner" /> : "Send now"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {queue.pending.length === 0 && <div className="empty">Every verified case has been transmitted.</div>}
              </div>
            )}
          </Card>

          <Card flush>
            <div style={{ padding: "16px 20px 8px" }}>
              <CardHead title="Due for a status refresh" sub="Routed cases whose department status is older than the sync interval." />
            </div>
            {queue && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Case</th><th>Authority</th><th>Transmitted</th><th>Latest authority status</th><th></th></tr>
                  </thead>
                  <tbody>
                    {queue.dueForSync.map((row) => (
                      <tr key={row.id}>
                        <td><Link to={`/admin/cases/${row.id}`} className="cell-id">{row.id}</Link><div className="tiny faint">{row.patientName}</div></td>
                        <td className="small">{row.authorityName}<div className="tiny faint mono">{row.adapterCode}</div></td>
                        <td className="small nowrap">{row.transmittedAt ? formatDate(row.transmittedAt) : "—"}</td>
                        <td>
                          {row.authorityStatus ? (
                            <>
                              <Badge tone={remoteTone(row.authorityStatus)}>{row.authorityStatus}</Badge>
                              <div className="tiny faint">{row.authorityStatusAt ? timeAgo(row.authorityStatusAt) : ""}</div>
                            </>
                          ) : (
                            <span className="small faint">Not checked yet</span>
                          )}
                        </td>
                        <td className="right">
                          {canRun && (
                            <button className="btn sm ghost" onClick={() => void syncCase(row.id)} disabled={busy !== null}>
                              {busy === row.id ? <span className="spinner" /> : "Check now"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {queue.dueForSync.length === 0 && <div className="empty">Every routed case has a fresh status.</div>}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
