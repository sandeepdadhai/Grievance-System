import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { COMMUNICATION_KIND_LABEL, api, formatDate, timeAgo } from "../../api";
import { Alert, Badge, Card, CardHead, Icon, Spinner } from "../../components/ui";

type Kind = "NOTIFICATION" | "TRANSMISSION" | "STATUS_SYNC" | "WEBHOOK_EVENT" | "COMMUNITY_POST" | "COMMUNITY_COMMENT";

type AuditLink = { id: number; ts: string; action: string; hash: string };

type Row = {
  id: string;
  kind: Kind;
  direction: "OUTBOUND" | "INBOUND";
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
  audit: AuditLink | null;
};

type LogResponse = {
  rows: Row[];
  total: number;
  limit: number;
  offset: number;
  summary: {
    total: number;
    byKind: Record<string, number>;
    failed: number;
    lastSentAt: string | null;
    lastReceivedAt: string | null;
  };
  kinds: string[];
  statuses: string[];
  scope: string;
  generatedAt: string;
};

const PAGE = 50;

const KIND_LABEL = COMMUNICATION_KIND_LABEL;

function kindTone(kind: Kind): "ok" | "warn" | "bad" | "info" | "muted" {
  if (kind === "TRANSMISSION") return "info";
  if (kind === "NOTIFICATION") return "ok";
  if (kind === "STATUS_SYNC") return "warn";
  if (kind === "COMMUNITY_POST" || kind === "COMMUNITY_COMMENT") return "info";
  return "muted";
}

function statusTone(status: string): "ok" | "warn" | "bad" | "info" | "muted" {
  const value = status.toUpperCase();
  if (["SENT", "DELIVERED", "SUCCESS", "RECEIVED"].includes(value)) return "ok";
  if (value === "FAILED") return "bad";
  if (value === "QUEUED") return "warn";
  if (value === "UNCHANGED") return "muted";
  return "muted";
}

function pretty(value: string | null): string {
  if (!value) return "—";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export default function AdminCommunications() {
  const [data, setData] = useState<LogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [caseId, setCaseId] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  function queryString(extra?: { limit: number; offset: number }): string {
    const params = new URLSearchParams({
      limit: String(extra?.limit ?? PAGE),
      offset: String(extra?.offset ?? offset),
    });
    if (kind) params.set("kind", kind);
    if (status) params.set("status", status);
    if (caseId.trim()) params.set("caseId", caseId.trim().toUpperCase());
    if (q.trim()) params.set("q", q.trim());
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }

  async function load() {
    setLoading(true);
    try {
      setData(await api.get<LogResponse>(`/api/admin/communications?${queryString()}`));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [offset, kind, status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function exportJson() {
    try {
      const full = await api.get<LogResponse>(`/api/admin/communications?${queryString({ limit: 200, offset: 0 })}`);
      const blob = new Blob(
        [JSON.stringify({ generatedAt: full.generatedAt, scope: full.scope, total: full.total, rows: full.rows }, null, 2)],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `mednotice-communications-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function resetFilters() {
    setKind("");
    setStatus("");
    setCaseId("");
    setQ("");
    setFrom("");
    setTo("");
    setOffset(0);
    setTimeout(() => void load(), 0);
  }

  const summary = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Communications</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            Every message exchanged with a health authority, in one audit-style log — with the hash-chained proof of each send.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm ghost" onClick={() => void exportJson()}><Icon name="clipboard" size={13} /> Export JSON</button>
          <button className="btn sm ghost" onClick={() => void load()}><Icon name="refresh" size={13} /> Refresh</button>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi">
          <div className="kpi-label">Messages logged</div>
          <div className="kpi-value">{summary?.total ?? 0}</div>
          <div className="kpi-foot">{data?.total ?? 0} in the current filter</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Notifications</div>
          <div className="kpi-value">{summary?.byKind.NOTIFICATION ?? 0}</div>
          <div className="kpi-foot">Email and webhook notices</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Transmissions</div>
          <div className="kpi-value">{summary?.byKind.TRANSMISSION ?? 0}</div>
          <div className="kpi-foot">Case bundles sent to a department</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Status pulls</div>
          <div className="kpi-value">{summary?.byKind.STATUS_SYNC ?? 0}</div>
          <div className="kpi-foot">Status checks against a department</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Community</div>
          <div className="kpi-value">
            {(summary?.byKind.COMMUNITY_POST ?? 0) + (summary?.byKind.COMMUNITY_COMMENT ?? 0)}
          </div>
          <div className="kpi-foot">Posts and comments from patients</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Failed</div>
          <div className="kpi-value" style={{ color: (summary?.failed ?? 0) > 0 ? "var(--danger)" : undefined }}>
            {summary?.failed ?? 0}
          </div>
          <div className="kpi-foot">
            Last sent {summary?.lastSentAt ? timeAgo(summary.lastSentAt) : "—"}
          </div>
        </div>
      </div>

      <Card>
        <div className="filter-bar">
          <div className="field" style={{ minWidth: 170 }}>
            <label htmlFor="comm-kind">Type</label>
            <select id="comm-kind" className="select" value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
              <option value="">All types</option>
              {(data?.kinds ?? []).map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k as Kind] ?? k}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="comm-status">Status</label>
            <select id="comm-status" className="select" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
              <option value="">Any status</option>
              {(data?.statuses ?? []).map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 170 }}>
            <label htmlFor="comm-case">Case</label>
            <input id="comm-case" className="input" value={caseId} onChange={(e) => setCaseId(e.target.value)} placeholder="CASE-2026-000101" onKeyDown={(e) => e.key === "Enter" && (setOffset(0), void load())} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="comm-q">Search</label>
            <input id="comm-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Target, subject, reference…" onKeyDown={(e) => e.key === "Enter" && (setOffset(0), void load())} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="comm-from">From</label>
            <input id="comm-from" className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="comm-to">To</label>
            <input id="comm-to" className="input" type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />
          </div>
          <button className="btn" onClick={() => { setOffset(0); void load(); }}><Icon name="search" size={14} /> Search</button>
          <button className="btn ghost" onClick={resetFilters}>Reset</button>
        </div>

        {!data && loading && <Spinner />}
        {data && (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Case</th>
                    <th>Channel / target</th>
                    <th>Message</th>
                    <th>Status</th>
                    <th>Reference</th>
                    <th>Audit</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={`${row.kind}-${row.id}`} className="clickable" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                      <td className="small nowrap">
                        {formatDate(row.ts, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        <div className="tiny faint">{timeAgo(row.ts)}</div>
                      </td>
                      <td>
                        <Badge tone={kindTone(row.kind)}>{KIND_LABEL[row.kind] ?? row.kind}</Badge>
                        <div className="tiny faint">{row.direction === "INBOUND" ? "received" : "sent"}</div>
                      </td>
                      <td>
                        {row.caseId ? (
                          <>
                            <Link to={`/admin/cases/${row.caseId}`} className="cell-id" onClick={(e) => e.stopPropagation()}>{row.caseId}</Link>
                            <div className="tiny faint">{row.patientName ?? "—"}</div>
                          </>
                        ) : (
                          <span className="tiny faint">Platform level</span>
                        )}
                      </td>
                      <td className="small">
                        <div className="mono tiny">{row.channel}</div>
                        <div className="cell-sub" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.target}>
                          {row.target}
                        </div>
                      </td>
                      <td className="small" style={{ maxWidth: 300 }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.subject ?? row.summary ?? ""}>
                          {row.subject ?? row.summary ?? "—"}
                        </div>
                        {row.message && <div className="tiny faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.message}</div>}
                      </td>
                      <td>
                        <Badge tone={statusTone(row.status)}>{row.status.replace(/_/g, " ")}</Badge>
                        <div className="tiny faint">
                          {row.httpStatus ? `HTTP ${row.httpStatus}` : ""}
                          {row.latencyMs != null ? ` · ${row.latencyMs} ms` : ""}
                          {row.attempts && row.attempts > 1 ? ` · ${row.attempts} tries` : ""}
                        </div>
                      </td>
                      <td className="mono small">{row.reference ?? "—"}</td>
                      <td className="tiny">
                        {row.audit ? (
                          <>
                            <div className="mono">#{row.audit.id} {row.audit.action}</div>
                            <div className="faint mono">{row.audit.hash.slice(0, 10)}…</div>
                          </>
                        ) : (
                          <span className="faint">not in chain</span>
                        )}
                      </td>
                      <td className="right"><Icon name="chevron" size={13} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.rows.length === 0 && <div className="empty">No communication matches these filters.</div>}

            {expanded !== null && (() => {
              const row = data.rows.find((r) => r.id === expanded);
              if (!row) return null;
              return (
                <div style={{ borderTop: "1px solid var(--line)", padding: 16, background: "rgba(7,12,21,0.5)" }}>
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <strong className="small">{KIND_LABEL[row.kind] ?? row.kind} · {row.id}</strong>
                    <span className="tiny faint">
                      {row.audit ? `audit #${row.audit.id} · ${row.audit.hash.slice(0, 12)}…` : "no audit-chain entry"}
                    </span>
                  </div>
                  <div className="small muted" style={{ marginBottom: 10 }}>
                    {row.caseId ? `Case ${row.caseId}` : "Platform-level event"} · {row.authorityId ?? "no authority"} · {row.channel}
                    {row.lastError ? ` · last error: ${row.lastError}` : ""}
                  </div>
                  <div className="grid-2">
                    <div>
                      <div className="tiny muted" style={{ marginBottom: 4 }}>Request</div>
                      <pre className="payload">{pretty(row.request)}</pre>
                    </div>
                    <div>
                      <div className="tiny muted" style={{ marginBottom: 4 }}>Response / message</div>
                      <pre className="payload">{pretty(row.response ?? row.summary)}</pre>
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="row-between" style={{ marginTop: 14 }}>
              <span className="small faint">Page {Math.floor(offset / PAGE) + 1} of {pages} · {data.total} messages · scope {data.scope}</span>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
                <button className="btn sm ghost" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card style={{ marginTop: 16 }}>
        <CardHead title="How this log is built" sub="Every row is a message, not an edit." />
        <p className="small muted" style={{ marginTop: 10 }}>
          Notifications, case-bundle transmissions, department status pulls and inbound webhooks are merged into a single
          chronological stream. Each row is matched to its entry in the tamper-evident audit chain, so a message that appears
          here can be proven to have been sent — and the payloads are the masked ones that actually left the platform.
        </p>
      </Card>
    </div>
  );
}
