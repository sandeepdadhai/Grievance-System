import { useEffect, useState } from "react";
import { api, formatDate } from "../../api";
import { useAuth } from "../../auth";
import type { Jurisdiction } from "../../types";
import { Alert, Badge, Card, CardHead, Icon, Spinner } from "../../components/ui";

type FacilityRow = { id: string; name: string; country: string; city: string | null; authority_id: string; status: string; letterheadKeywords: string[] };
type PhysicianRow = { license_no: string; full_name: string; jurisdiction: string; status: string; expires_at: string | null; facility_id: string | null };

const SAMPLE = `Complainant: Maria Santos, maria.santos@example.com, +1 555 987 6543.
MRN: AB-99123. Patient was admitted to St. Mary's General Hospital on 2026-10-19.
Social security number on file: 123-45-6789.`;

function maskDemo(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => {
      const [user, domain] = m.split("@");
      return `${user.slice(0, 1)}${"*".repeat(Math.max(3, user.length - 1))}@${domain.replace(/^[^.]+/, (d) => `${d[0]}***`)}`;
    })
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "***-**-****")
    .replace(/(?:\+\d{1,3}[\s-]?)?\d{3}[\s-]?\d{3}[\s-]?\d{4}/g, (m) => `***-***-${m.replace(/\D/g, "").slice(-4)}`)
    .replace(/\b(?:MRN|medical record(?: number)?)[:\s#]*([A-Z0-9-]{4,})\b/gi, "MRN: ***")
    .replace(/Maria Santos/g, "M*** S*****");
}

export default function AdminCompliance() {
  const { user } = useAuth();
  const isAdmin = user?.role === "SUPER_ADMIN";
  const canAudit = isAdmin || user?.role === "SYSTEM_AUDITOR";
  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[]>([]);
  const [facilities, setFacilities] = useState<FacilityRow[]>([]);
  const [physicians, setPhysicians] = useState<PhysicianRow[]>([]);
  const [chain, setChain] = useState<{ valid: boolean; checked: number; brokenAt: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sample, setSample] = useState(SAMPLE);

  async function load() {
    try {
      const [j, f, p] = await Promise.all([
        api.get<{ jurisdictions: Jurisdiction[] }>("/api/public/jurisdictions"),
        api.get<{ facilities: FacilityRow[] }>("/api/admin/facilities"),
        api.get<{ physicians: PhysicianRow[] }>("/api/admin/physicians"),
      ]);
      setJurisdictions(j.jurisdictions);
      setFacilities(f.facilities);
      setPhysicians(p.physicians);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function verifyChain() {
    try {
      setChain(await api.get<{ valid: boolean; checked: number; brokenAt: number | null }>("/api/admin/audit/verify"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function updateLicence(licenseNo: string, status: string) {
    setError(null);
    try {
      await api.patch(`/api/admin/physicians/${licenseNo}`, { status });
      setNotice(`Licence ${licenseNo} marked ${status}. Future document checks use the new status immediately.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Compliance workspace</h2>
          <p className="small muted" style={{ marginTop: 4 }}>Controls, retention windows and authoritative registries behind verification.</p>
        </div>
        {canAudit && <button className="btn sm" onClick={() => void verifyChain()}>Verify audit chain</button>}
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {chain && (
        <Alert tone={chain.valid ? "success" : "error"}>
          {chain.valid ? `Audit chain verified across ${chain.checked} entries — no tampering detected.` : `Chain broken at entry #${chain.brokenAt}. Escalate to the system owner.`}
        </Alert>
      )}

      <div className="grid-4" style={{ marginBottom: 18 }}>
        {[
          ["Encryption at rest", "AES-256-GCM", "Narratives, identifiers and uploaded files are sealed before disk writes."],
          ["Transport", "TLS 1.2+", "Session cookies are HttpOnly/SameSite; mutations enforce same-origin."],
          ["Audit", "Hash chain", "Each record commits to its predecessor; verification replays from genesis."],
          ["Minimisation", "Field-level", "Cross-border payloads carry masked names, emails, phones and record numbers."],
        ].map(([title, value, body]) => (
          <div className="kpi" key={title}>
            <div className="kpi-label">{title}</div>
            <div className="kpi-value" style={{ fontSize: 18 }}>{value}</div>
            <div className="kpi-foot" style={{ display: "block", lineHeight: 1.5 }}>{body}</div>
          </div>
        ))}
      </div>

      <Card flush style={{ marginBottom: 18 }}>
        <div style={{ padding: "18px 20px 8px" }}>
          <CardHead title="Retention & regulatory matrix" sub="Per-jurisdiction windows and citations used by the triage engine" />
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Jurisdiction</th><th>Regulator</th><th>Frameworks</th><th>P1 SLA</th><th>Retention</th><th>Cross-border</th></tr></thead>
            <tbody>
              {jurisdictions.map((j) => (
                <tr key={j.code}>
                  <td><span aria-hidden>{j.flag}</span> <span className="strong">{j.name}</span><div className="cell-sub">{j.authorities.length} authorities</div></td>
                  <td className="small">{j.regulator}</td>
                  <td><div className="row" style={{ gap: 4 }}>{j.frameworks.map((f) => <span className="chip" key={f}>{f}</span>)}</div></td>
                  <td className="mono small">{j.slaHours.P1}h</td>
                  <td className="small">{Math.round(j.retentionDays / 365)} years</td>
                  <td>{j.crossBorderRestricted ? <Badge tone="warn">Masked</Badge> : <Badge tone="muted">Standard</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid-2" style={{ marginBottom: 18 }}>
        <Card>
          <CardHead title="Facility registry" sub={`${facilities.length} registered facilities`} right={<Badge tone="info">Letterhead matching</Badge>} />
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Facility</th><th>Authority</th><th>Country</th></tr></thead>
              <tbody>
                {facilities.map((f) => (
                  <tr key={f.id}>
                    <td><div className="strong">{f.name}</div><div className="cell-sub">{f.city ?? "—"}</div></td>
                    <td className="small mono">{f.authority_id}</td>
                    <td><Badge tone="muted">{f.country}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHead title="Physician licence registry" sub={`${physicians.length} licences`} right={<Badge tone="warn">Revocation blocks documents</Badge>} />
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Licence</th><th>Physician</th><th>Status</th><th>Expires</th></tr></thead>
              <tbody>
                {physicians.map((p) => (
                  <tr key={p.license_no}>
                    <td className="mono small">{p.license_no}<div className="cell-sub">{p.jurisdiction}</div></td>
                    <td className="small">{p.full_name}</td>
                    <td>
                      {isAdmin ? (
                        <select className="select" style={{ padding: "4px 22px 4px 8px", fontSize: 11.5, minWidth: 120 }} value={p.status} onChange={(e) => void updateLicence(p.license_no, e.target.value)}>
                          {["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"].map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : (
                        <Badge tone={p.status === "ACTIVE" ? "ok" : p.status === "REVOKED" ? "bad" : "warn"}>{p.status}</Badge>
                      )}
                    </td>
                    <td className="small nowrap">{p.expires_at ? formatDate(p.expires_at, { hour: undefined, minute: undefined }) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title="Cross-border masking preview" sub="Same rules the dispatcher applies to outbound payloads and logs" right={<Badge tone="info"><Icon name="lock" size={11} /> field-level</Badge>} />
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div className="field">
            <label htmlFor="mask-input">Raw text</label>
            <textarea id="mask-input" className="textarea mono" style={{ minHeight: 150, fontSize: 12 }} value={sample} onChange={(e) => setSample(e.target.value)} />
            <span className="hint">Edit to test your own identifiers.</span>
          </div>
          <div className="field">
            <label>Masked for transmission</label>
            <pre className="payload" style={{ minHeight: 150 }}>{maskDemo(sample)}</pre>
            <span className="hint">Emails, phones, national IDs, MRNs and known names are replaced; narrative structure is preserved.</span>
          </div>
        </div>
        <div className="divider" />
        <div className="grid-3">
          {[
            ["Data subject access", "Patients retrieve their own cases through the portal; guest submissions use reference + access code."],
            ["Breach readiness", "Audit entries, notification attempts and routing acknowledgements form a single investigation timeline."],
            ["Storage limitation", "Retention windows are configuration per jurisdiction; resolved cases retain their audit chain."],
          ].map(([title, body]) => (
            <div key={title}>
              <div className="label">{title}</div>
              <p className="small muted" style={{ marginTop: 6 }}>{body}</p>
            </div>
          ))}
        </div>
      </Card>

      {!physicians.length && <Spinner />}
    </div>
  );
}
