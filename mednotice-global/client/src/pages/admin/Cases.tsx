import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, formatDate, PRIORITY_META, slaCountdown } from "../../api";
import type { CaseDto, Priority } from "../../types";
import { Alert, Badge, Card, Icon, PriorityBadge, Spinner, StatusBadge, VerificationBadge } from "../../components/ui";

type ListResponse = { total: number; limit: number; offset: number; cases: CaseDto[] };

const PAGE_SIZE = 25;

export default function AdminCases() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(params.get("q") ?? "");

  const offset = Number(params.get("offset") ?? 0) || 0;
  const filters = useMemo(
    () => ({
      q: params.get("q") ?? "",
      priority: params.get("priority") ?? "",
      status: params.get("status") ?? "",
      country: params.get("country") ?? "",
      category: params.get("category") ?? "",
      verification: params.get("verification") ?? "",
      offset,
    }),
    [params, offset],
  );

  useEffect(() => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, String(value));
    query.set("limit", String(PAGE_SIZE));
    setLoading(true);
    api
      .get<ListResponse>(`/api/admin/cases?${query.toString()}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [filters]);

  function update(next: Record<string, string | number>) {
    const merged: Record<string, string> = { ...Object.fromEntries(params.entries()), ...Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])) };
    if ("offset" in next && next.offset !== 0) merged.offset = String(next.offset);
    if (!("offset" in next)) delete merged.offset;
    for (const [key, value] of Object.entries(merged)) if (!value) delete merged[key];
    setParams(merged, { replace: true });
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Case queue</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            {data ? `${data.total} matching case(s)` : "Loading…"} · jurisdiction scoping applied automatically
          </p>
        </div>
        {filters.priority === "P1" && <Badge tone="bad" dot>Filtering critical cases</Badge>}
      </div>

      <Card>
        <div className="filter-bar">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="q">Search</label>
            <input
              id="q"
              className="input"
              placeholder="Case ID, facility, masked complainant…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && update({ q })}
            />
          </div>
          <div className="field">
            <label htmlFor="priority">Priority</label>
            <select id="priority" className="select" value={filters.priority} onChange={(e) => update({ priority: e.target.value })}>
              <option value="">All</option>
              {(Object.keys(PRIORITY_META) as Priority[]).map((p) => <option key={p} value={p}>{p} · {PRIORITY_META[p].label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="status">Status</label>
            <select id="status" className="select" value={filters.status} onChange={(e) => update({ status: e.target.value })}>
              <option value="">All</option>
              {["SUBMITTED", "ROUTED", "UNDER_REVIEW", "PENDING_REVIEW", "ROUTE_FAILED", "RESOLVED", "REJECTED"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="verification">Verification</label>
            <select id="verification" className="select" value={filters.verification} onChange={(e) => update({ verification: e.target.value })}>
              <option value="">All</option>
              <option value="VERIFIED">Verified</option>
              <option value="PENDING_MANUAL_REVIEW">Manual review</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="country">Country</label>
            <input id="country" className="input" maxLength={2} placeholder="US" value={filters.country} onChange={(e) => update({ country: e.target.value.toUpperCase() })} style={{ minWidth: 80, maxWidth: 90 }} />
          </div>
          <button className="btn" onClick={() => update({ q })}><Icon name="search" size={14} /> Apply</button>
          <button
            className="btn ghost"
            onClick={() => {
              setQ("");
              setParams({}, { replace: true });
            }}
          >
            Reset
          </button>
        </div>

        {error && <Alert tone="error">{error}</Alert>}
        {loading && !data && <Spinner />}

        {data && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Priority</th>
                  <th>Complainant</th>
                  <th>Facility / authority</th>
                  <th>Verification</th>
                  <th>Status</th>
                  <th>SLA</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {data.cases.map((c) => {
                  const sla = slaCountdown(c.slaDueAt);
                  return (
                    <tr key={c.id} className="clickable" onClick={() => navigate(`/admin/cases/${c.id}`)}>
                      <td>
                        <div className="cell-id">{c.id}</div>
                        <div className="cell-sub">{c.category}</div>
                      </td>
                      <td><PriorityBadge priority={c.priority} solid /><div className="cell-sub mono" style={{ marginTop: 3 }}>{c.priorityScore}</div></td>
                      <td><div className="strong">{c.patientName}</div><div className="cell-sub">{c.country}</div></td>
                      <td><div className="strong">{c.facilityName}</div><div className="cell-sub">{c.authorityId}</div></td>
                      <td><VerificationBadge status={c.verificationStatus} />{c.documentCount !== undefined && <div className="cell-sub">{c.documentCount} doc(s)</div>}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="nowrap"><span className="small" style={{ color: sla.overdue && c.status !== "RESOLVED" ? "var(--danger)" : "var(--muted)" }}>{c.resolvedAt ? "Closed" : sla.text}</span></td>
                      <td className="nowrap"><div className="small">{formatDate(c.createdAt, { hour: undefined, minute: undefined })}</div><div className="cell-sub">{c.source}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data.cases.length === 0 && <div className="empty">No cases match these filters.</div>}
          </div>
        )}

        <div className="row-between" style={{ marginTop: 14 }}>
          <span className="small faint">Page {page} of {pages}</span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm ghost" disabled={offset === 0} onClick={() => update({ offset: Math.max(0, offset - PAGE_SIZE) })}>Previous</button>
            <button className="btn sm ghost" disabled={offset + PAGE_SIZE >= (data?.total ?? 0)} onClick={() => update({ offset: offset + PAGE_SIZE })}>Next</button>
          </div>
        </div>
      </Card>

      <p className="small faint" style={{ marginTop: 14 }}>
        Need the compliance view instead? <Link to="/admin/compliance">Open registries</Link>.
      </p>
    </div>
  );
}
