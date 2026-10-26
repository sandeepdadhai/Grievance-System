import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { COMMUNICATION_KIND_LABEL, api, formatDate, timeAgo } from "../../api";
import { Alert, Badge, Card, CardHead, Icon, Spinner } from "../../components/ui";

type TrailRow = {
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
  audit: { id: number; ts: string; action: string; hash: string } | null;
  details: Record<string, unknown> | null;
  request: string | null;
  response: string | null;
};

type TrailResponse = {
  rows: TrailRow[];
  total: number;
  limit: number;
  offset: number;
  counts: {
    total: number;
    audit: number;
    communications: number;
    failed: number;
    lastMessageAt: string | null;
    byKind: Record<string, number>;
  };
  chain: { valid: boolean; checked: number; brokenAt: number | null };
  kinds: string[];
  statuses: string[];
  canViewMessages: boolean;
  scope: string;
  generatedAt: string;
};

const PAGE = 50;

function statusTone(status: string): "ok" | "warn" | "bad" | "info" | "muted" {
  const value = status.toUpperCase();
  if (["SENT", "DELIVERED", "SUCCESS", "RECEIVED"].includes(value)) return "ok";
  if (value === "FAILED") return "bad";
  if (value === "QUEUED") return "warn";
  if (["VISIBLE", "UNCHANGED"].includes(value)) return "muted";
  if (["HIDDEN", "REMOVED"].includes(value)) return "warn";
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

export default function AdminAudit() {
  const [data, setData] = useState<TrailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [source, setSource] = useState("all");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [caseId, setCaseId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function queryString(): string {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (source !== "all") params.set("source", source);
    if (kind) params.set("kind", kind);
    if (status) params.set("status", status);
    if (action.trim()) params.set("action", action.trim());
    if (caseId.trim()) params.set("caseId", caseId.trim().toUpperCase());
    if (q.trim()) params.set("q", q.trim());
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }

  async function load() {
    setLoading(true);
    try {
      setData(await api.get<TrailResponse>(`/api/admin/audit/trail?${queryString()}`));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [offset, source, kind, status]); // eslint-disable-line react-hooks/exhaustive-deps

  function resetFilters() {
    setQ("");
    setAction("");
    setSource("all");
    setKind("");
    setStatus("");
    setCaseId("");
    setFrom("");
    setTo("");
    setOffset(0);
    setTimeout(() => void load(), 0);
  }

  const counts = data?.counts;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Audit log</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            Every decision and every message the platform exchanged, in one append-only ledger.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {data && (
            <Badge tone={data.chain.valid ? "ok" : "bad"} dot>
              {data.chain.valid ? `Chain valid · ${data.chain.checked} entries` : `Broken at #${data.chain.brokenAt}`}
            </Badge>
          )}
          <button className="btn sm ghost" onClick={() => void load()}><Icon name="refresh" size={13} /> Refresh</button>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi">
          <div className="kpi-label">Records in view</div>
          <div className="kpi-value">{counts?.total ?? 0}</div>
          <div className="kpi-foot">{data?.total ?? 0} match the filter</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Decisions</div>
          <div className="kpi-value">{counts?.audit ?? 0}</div>
          <div className="kpi-foot">Entries in the hash chain</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Messages</div>
          <div className="kpi-value">{counts?.communications ?? 0}</div>
          <div className="kpi-foot">Sent, received and posted</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Failed messages</div>
          <div className="kpi-value" style={{ color: (counts?.failed ?? 0) > 0 ? "var(--danger)" : undefined }}>
            {counts?.failed ?? 0}
          </div>
          <div className="kpi-foot">
            Last message {counts?.lastMessageAt ? timeAgo(counts.lastMessageAt) : "—"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Scope</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>{data?.scope ?? "—"}</div>
          <div className="kpi-foot">Messages stay inside the jurisdiction</div>
        </div>
      </div>

      <Card>
        <div className="filter-bar">
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="trail-source">Records</label>
            <select id="trail-source" className="select" value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }}>
              <option value="all">Everything</option>
              <option value="audit">Decisions only</option>
              <option value="communications">Messages only</option>
            </select>
          </div>
          <div className="field" style={{ minWidth: 170 }}>
            <label htmlFor="trail-kind">Message type</label>
            <select id="trail-kind" className="select" value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
              <option value="">All messages</option>
              {(data?.kinds ?? []).map((k) => (
                <option key={k} value={k}>{COMMUNICATION_KIND_LABEL[k] ?? k}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="trail-status">Status</label>
            <select id="trail-status" className="select" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
              <option value="">Any status</option>
              {(data?.statuses ?? []).map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 180 }}>
            <label htmlFor="trail-action">Action contains</label>
            <input id="trail-action" className="input" value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. CASE_ROUTED" onKeyDown={(e) => e.key === "Enter" && (setOffset(0), void load())} />
          </div>
          <div className="field" style={{ minWidth: 170 }}>
            <label htmlFor="trail-case">Case</label>
            <input id="trail-case" className="input" value={caseId} onChange={(e) => setCaseId(e.target.value)} placeholder="CASE-2026-000101" onKeyDown={(e) => e.key === "Enter" && (setOffset(0), void load())} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="trail-q">Search</label>
            <input id="trail-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Action, case, target, actor or detail…" onKeyDown={(e) => e.key === "Enter" && (setOffset(0), void load())} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="trail-from">From</label>
            <input id="trail-from" className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="trail-to">To</label>
            <input id="trail-to" className="input" type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />
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
                    <th>Record</th>
                    <th>Action</th>
                    <th>Case / entity</th>
                    <th>Actor / channel</th>
                    <th>Status</th>
                    <th>Chain</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className="clickable" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                      <td className="small nowrap">
                        {formatDate(row.ts, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        <div className="tiny faint">{timeAgo(row.ts)}</div>
                      </td>
                      <td>
                        {row.recordType === "AUDIT" ? (
                          <Badge tone="muted">Decision</Badge>
                        ) : (
                          <>
                            <Badge tone="info">Message</Badge>
                            <div className="tiny faint">
                              {COMMUNICATION_KIND_LABEL[row.kind ?? ""] ?? row.kind}
                              {row.direction ? ` · ${row.direction === "INBOUND" ? "received" : "sent"}` : ""}
                            </div>
                          </>
                        )}
                      </td>
                      <td>
                        <span className="audit-action">{row.action}</span>
                        {row.recordType === "COMMUNICATION" && row.subject && (
                          <div className="cell-sub" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.subject}>
                            {row.subject}
                          </div>
                        )}
                      </td>
                      <td>
                        {row.caseId ? (
                          <Link to={`/admin/cases/${row.caseId}`} className="cell-id" onClick={(e) => e.stopPropagation()}>{row.caseId}</Link>
                        ) : (
                          <span className="cell-id">{row.entityType}</span>
                        )}
                        <div className="cell-sub mono" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.entityId ?? "—"}
                        </div>
                      </td>
                      <td className="small">
                        {row.recordType === "AUDIT" ? (
                          <>
                            <div>{row.actorRole ?? "SYSTEM"}</div>
                            <div className="cell-sub">{row.actorId ?? "automated"}</div>
                          </>
                        ) : (
                          <>
                            <div className="mono tiny">{row.channel}</div>
                            <div className="cell-sub" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.target ?? ""}>
                              {row.target ?? "—"}
                            </div>
                          </>
                        )}
                      </td>
                      <td>
                        {row.status ? (
                          <>
                            <Badge tone={statusTone(row.status)}>{row.status.replace(/_/g, " ")}</Badge>
                            <div className="tiny faint">
                              {row.httpStatus ? `HTTP ${row.httpStatus}` : ""}
                              {row.latencyMs != null ? ` · ${row.latencyMs} ms` : ""}
                              {row.attempts && row.attempts > 1 ? ` · ${row.attempts} tries` : ""}
                            </div>
                          </>
                        ) : (
                          <span className="faint tiny">{row.ip ?? "—"}</span>
                        )}
                      </td>
                      <td className="tiny">
                        {row.hash ? (
                          <>
                            <div className="mono">#{row.auditId} {row.action}</div>
                            <div className="faint mono">{row.hash.slice(0, 10)}…</div>
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
            {data.rows.length === 0 && <div className="empty">No records match these filters.</div>}

            {expanded !== null && (() => {
              const row = data.rows.find((r) => r.id === expanded);
              if (!row) return null;
              return (
                <div style={{ borderTop: "1px solid var(--line)", padding: 16, background: "rgba(7,12,21,0.5)" }}>
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <strong className="small">
                      {row.recordType === "AUDIT" ? `Decision #${row.auditId}` : `${COMMUNICATION_KIND_LABEL[row.kind ?? ""] ?? row.kind} · ${row.entityId}`}
                    </strong>
                    <span className="tiny faint">
                      {row.hash ? `chain #${row.auditId} · ${row.hash.slice(0, 12)}…` : "no chain entry"}
                      {row.prevHash ? ` · prev ${row.prevHash.slice(0, 8)}…` : ""}
                    </span>
                  </div>
                  <div className="small muted" style={{ marginBottom: 10 }}>
                    {row.caseId ? `Case ${row.caseId}` : row.entityType}
                    {row.recordType === "AUDIT" ? ` · actor ${row.actorRole ?? "SYSTEM"}` : ` · ${row.direction === "INBOUND" ? "received" : "sent"} on ${row.channel}`}
                    {row.ip ? ` · ${row.ip}` : ""}
                  </div>
                  {row.recordType === "AUDIT" ? (
                    <pre className="payload">{JSON.stringify(row.details ?? {}, null, 2)}</pre>
                  ) : (
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
                  )}
                </div>
              );
            })()}

            <div className="row-between" style={{ marginTop: 14 }}>
              <span className="small faint">Page {Math.floor(offset / PAGE) + 1} of {pages} · {data.total} records · scope {data.scope}</span>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
                <button className="btn sm ghost" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card style={{ marginTop: 16 }}>
        <CardHead title="How this log is built" sub="Decisions come from the chain, messages from the traffic they carry." />
        <pre className="payload">{`hash_n = SHA-256( id | ts | actor | action | entity | details | hash_{n-1} )`}</pre>
        <p className="small muted" style={{ marginTop: 10 }}>
          Every row marked <strong>Decision</strong> is an entry of the tamper-evident chain — rewriting any historical row
          breaks every subsequent hash. Every row marked <strong>Message</strong> is a notification, case-bundle transmission,
          department status pull, inbound webhook or community message, shown with the exact masked payload that left the
          platform and the chain entry that proves it. Messages stay inside the reader&apos;s jurisdiction; the chain itself
          is global.
        </p>
      </Card>
    </div>
  );
}
