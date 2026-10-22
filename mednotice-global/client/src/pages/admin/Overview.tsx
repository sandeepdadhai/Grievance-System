import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, statusLabel } from "../../api";
import type { Overview } from "../../types";
import { BarChart, HBars, PriorityDonut } from "../../components/charts";
import { Alert, Badge, Card, CardHead, Icon, PriorityBadge, Spinner, StatusBadge, VerificationBadge } from "../../components/ui";

export default function AdminOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setData(await api.get<Overview>("/api/admin/overview"));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <Spinner label="Loading operations dashboard…" />;

  const t = data.totals;
  const verificationCounts = Object.fromEntries(data.verification.map((v) => [v.verification_status, Number(v.n)]));

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Global overview</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            {data.scope === "GLOBAL" ? "All jurisdictions" : `${data.scope} jurisdiction only`} · refreshed {formatDate(data.generatedAt, { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link to="/admin/cases?priority=P1" className="btn sm">Open P1 queue</Link>
          <button className="btn sm ghost" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={13} /> Refresh
          </button>
        </div>
      </div>

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi">
          <div className="kpi-label">Open cases</div>
          <div className="kpi-value">{t.open}</div>
          <div className="kpi-foot">{t.total} total cases on record</div>
        </div>
        <div className={`kpi ${t.openP1 > 0 ? "alert" : ""}`}>
          <div className="kpi-label">Open P1 <Badge tone="bad">critical</Badge></div>
          <div className="kpi-value">{t.openP1}</div>
          <div className="kpi-foot">Immediate escalation required</div>
        </div>
        <div className={`kpi ${t.overdue > 0 ? "alert" : ""}`}>
          <div className="kpi-label">SLA breaches</div>
          <div className="kpi-value">{t.overdue}</div>
          <div className="kpi-foot">Past jurisdiction response window</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Pending verification</div>
          <div className="kpi-value">{t.pendingVerification}</div>
          <div className="kpi-foot">Manual review queue</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Resolved</div>
          <div className="kpi-value">{t.resolved}</div>
          <div className="kpi-foot">{t.avgResolutionHours ? `Avg ${t.avgResolutionHours}h to resolution` : "No closed cases yet"}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">SLA compliance</div>
          <div className="kpi-value">{t.slaCompliance === null ? "—" : `${t.slaCompliance}%`}</div>
          <div className="kpi-foot">Resolved inside the priority clock</div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 18 }}>
        <Card>
          <CardHead title="Case volume · last 14 days" sub={`${data.trend.reduce((n, d) => n + d.count, 0)} submissions`} right={<Badge tone="info">daily</Badge>} />
          <BarChart data={data.trend} />
        </Card>
        <Card>
          <CardHead title="Priority distribution" sub="Clinical prioritisation matrix" />
          <PriorityDonut data={data.byPriority.map((p) => ({ priority: p.priority, n: Number(p.n) }))} />
        </Card>
      </div>

      <div className="grid-2" style={{ marginBottom: 18 }}>
        <Card>
          <CardHead title="Cases by jurisdiction" sub="Regional distribution" />
          <HBars items={data.byCountry.map((c) => ({ label: c.country, value: Number(c.n) }))} />
        </Card>
        <Card>
          <CardHead title="Case categories" sub="Triage classification" />
          <HBars items={data.byCategory.map((c) => ({ label: c.category, value: Number(c.n) }))} />
        </Card>
      </div>

      <div className="grid-2">
        <Card flush>
          <div style={{ padding: "18px 20px 12px" }}>
            <CardHead title="Recent cases" sub="Newest submissions" right={<Link to="/admin/cases" className="btn sm ghost">View all <Icon name="chevron" size={12} /></Link>} />
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Case</th><th>Priority</th><th>Facility</th><th>Verification</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.recent.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => { window.location.href = `/admin/cases/${c.id}`; }}>
                    <td>
                      <div className="cell-id">{c.id}</div>
                      <div className="cell-sub">{c.country} · {c.category}</div>
                    </td>
                    <td><PriorityBadge priority={c.priority} solid /></td>
                    <td><div className="strong">{c.facilityName}</div><div className="cell-sub">{c.patientName}</div></td>
                    <td><VerificationBadge status={c.verificationStatus} /></td>
                    <td><StatusBadge status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card>
            <CardHead title="Compliance posture" sub="Continuous checks" right={<Badge tone={data.auditChain.valid ? "ok" : "bad"} dot>{data.auditChain.valid ? "Chain valid" : "Chain broken"}</Badge>} />
            <div className="stack" style={{ gap: 10 }}>
              <div className="row-between">
                <span className="small muted">Audit entries verified</span>
                <span className="mono small">{data.auditChain.checked}</span>
              </div>
              <div className="row-between">
                <span className="small muted">Encryption at rest</span>
                <Badge tone="ok">AES-256-GCM</Badge>
              </div>
              <div className="row-between">
                <span className="small muted">Verification mix</span>
                <div className="row" style={{ gap: 5 }}>
                  <Badge tone="ok">V {verificationCounts.VERIFIED ?? 0}</Badge>
                  <Badge tone="warn">R {verificationCounts.PENDING_MANUAL_REVIEW ?? 0}</Badge>
                  <Badge tone="bad">X {verificationCounts.REJECTED ?? 0}</Badge>
                </div>
              </div>
              <div className="row-between">
                <span className="small muted">Rejected bundles</span>
                <span className="mono small">{t.rejected}</span>
              </div>
            </div>
            <div className="divider" />
            <Link to="/admin/compliance" className="btn sm ghost block">Open compliance workspace</Link>
          </Card>

          <Card>
            <CardHead title="Delivery queues" sub="Notifications & routing" right={<Link to="/admin/delivery" className="btn sm ghost">Inspect</Link>} />
            <div className="grid-2" style={{ gap: 10 }}>
              <div className="meta-item"><dt>Notifications queued</dt><dd>{data.notifications.queued}</dd></div>
              <div className="meta-item"><dt>Notifications sent</dt><dd>{data.notifications.sent}</dd></div>
              <div className="meta-item"><dt>Failed notifications</dt><dd style={{ color: data.notifications.failed ? "var(--danger)" : undefined }}>{data.notifications.failed}</dd></div>
              <div className="meta-item"><dt>Avg routing latency</dt><dd>{data.transmissions.avgLatencyMs ?? "—"} ms</dd></div>
            </div>
            <div className="divider" />
            <div className="row" style={{ gap: 6 }}>
              <Badge tone="ok">Delivered {data.transmissions.delivered}</Badge>
              <Badge tone={data.transmissions.failed ? "bad" : "muted"}>Failed {data.transmissions.failed}</Badge>
              <Badge tone="info">Status mix {data.byStatus.length}</Badge>
            </div>
          </Card>

          <Card>
            <CardHead title="Workload by status" />
            <HBars items={data.byStatus.map((s) => ({ label: statusLabel(s.status), value: Number(s.n) }))} />
          </Card>
        </div>
      </div>
    </div>
  );
}
