import { useEffect, useState } from "react";
import { api, formatDate } from "../../api";
import { Alert, Badge, Card, CardHead, Icon, Spinner } from "../../components/ui";

type AuditRow = {
  id: number;
  ts: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip: string | null;
  hash: string;
  prev_hash: string;
  details: Record<string, unknown>;
};

type AuditResponse = { rows: AuditRow[]; total: number; limit: number; offset: number; chain: { valid: boolean; checked: number; brokenAt: number | null } };

const PAGE = 50;

export default function AdminAudit() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (q) params.set("q", q);
    if (action) params.set("action", action);
    try {
      setData(await api.get<AuditResponse>(`/api/admin/audit?${params.toString()}`));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [offset]); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Audit log</h2>
          <p className="small muted" style={{ marginTop: 4 }}>Append-only, hash-chained record of access and decisions.</p>
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

      <Card>
        <div className="filter-bar">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="audit-q">Search</label>
            <input id="audit-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Action, case, user or detail…" onKeyDown={(e) => e.key === "Enter" && (setOffset(0), void load())} />
          </div>
          <div className="field" style={{ minWidth: 180 }}>
            <label htmlFor="audit-action">Action contains</label>
            <input id="audit-action" className="input" value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. CASE_ROUTED" onKeyDown={(e) => e.key === "Enter" && (setOffset(0), void load())} />
          </div>
          <button className="btn" onClick={() => { setOffset(0); void load(); }}><Icon name="search" size={14} /> Search</button>
          <button className="btn ghost" onClick={() => { setQ(""); setAction(""); setOffset(0); setTimeout(() => void load(), 0); }}>Reset</button>
        </div>

        {!data && loading && <Spinner />}
        {data && (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>#</th><th>Timestamp</th><th>Action</th><th>Entity</th><th>Actor</th><th>Hash</th><th></th></tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className="clickable" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                      <td className="mono small faint">{row.id}</td>
                      <td className="nowrap small">{formatDate(row.ts, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                      <td><span className="audit-action">{row.action}</span></td>
                      <td><div className="small">{row.entity_type}</div><div className="cell-sub mono">{row.entity_id ?? "—"}</div></td>
                      <td><div className="small">{row.actor_role ?? "SYSTEM"}</div><div className="cell-sub">{row.actor_id ?? "automated"}</div></td>
                      <td className="mono tiny faint">{row.hash.slice(0, 12)}…</td>
                      <td className="right"><Icon name="chevron" size={13} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.rows.length === 0 && <div className="empty">No audit entries match.</div>}
            {expanded !== null && (() => {
              const row = data.rows.find((r) => r.id === expanded);
              if (!row) return null;
              return (
                <div style={{ borderTop: "1px solid var(--line)", padding: 16, background: "rgba(7,12,21,0.5)" }}>
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <strong className="small">Entry #{row.id} · {row.action}</strong>
                    <span className="tiny faint">{row.ip ?? "no ip"} · prev {row.prev_hash.slice(0, 10)}…</span>
                  </div>
                  <pre className="payload">{JSON.stringify(row.details, null, 2)}</pre>
                </div>
              );
            })()}
            <div className="row-between" style={{ marginTop: 14 }}>
              <span className="small faint">Page {Math.floor(offset / PAGE) + 1} of {pages} · {data.total} entries</span>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
                <button className="btn sm ghost" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card style={{ marginTop: 16 }}>
        <CardHead title="How integrity works" sub="Every mutation appends a record that commits to the previous hash" />
        <pre className="payload">{`hash_n = SHA-256( id | ts | actor | action | entity | details | hash_{n-1} )`}</pre>
        <p className="small muted" style={{ marginTop: 10 }}>
          Rewriting any historical row breaks every subsequent hash. Verification recomputes the full chain from genesis and reports the first broken link.
        </p>
      </Card>
    </div>
  );
}
