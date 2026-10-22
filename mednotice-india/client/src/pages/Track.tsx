import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, formatDate, slaCountdown, statusLabel } from "../api";
import type { Priority } from "../types";
import { Alert, Badge, Card, Icon, PriorityBadge, StatusBadge, VerificationBadge } from "../components/ui";

type TrackedCase = {
  id: string;
  status: string;
  priority: Priority;
  priorityScore: number;
  category: string;
  facilityName: string | null;
  country: string;
  region: string | null;
  authorityId: string;
  authorityName: string | null;
  verificationStatus: string;
  createdAt: string;
  updatedAt: string;
  slaDueAt: string;
  resolvedAt: string | null;
  patientName: string;
  timeline: Array<{ date: string; event: string }>;
  triage: { regulatoryBasis: string[]; signals: string[] };
  documents: Array<{ filename: string; status: string; score: number }>;
};

export default function Track() {
  const [params] = useSearchParams();
  const [caseId, setCaseId] = useState(params.get("case") ?? "");
  const [accessCode, setAccessCode] = useState("");
  const [result, setResult] = useState<TrackedCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("mn_track_case");
    if (saved && !params.get("case")) setCaseId(saved);
  }, [params]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ case: TrackedCase }>("/api/public/track", { caseId: caseId.trim().toUpperCase(), accessCode: accessCode.trim().toUpperCase() });
      setResult(res.case);
      localStorage.setItem("mn_track_case", res.case.id);
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sla = result ? slaCountdown(result.slaDueAt) : null;

  return (
    <section className="section" style={{ maxWidth: 980 }}>
      <div className="section-head">
        <span className="eyebrow">Case tracking</span>
        <h2>Follow a grievance without an account</h2>
        <p>Enter the case reference and the access code issued at submission. Both are required and are not recoverable by email in this reference build.</p>
      </div>

      <Card>
        <form onSubmit={submit} className="filter-bar" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="caseId">Case reference</label>
            <input id="caseId" className="input mono" value={caseId} onChange={(e) => setCaseId(e.target.value)} placeholder="CASE-2026-XXXXXX" required />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="accessCode">Access code</label>
            <input id="accessCode" className="input mono" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="XXXXXXXXXX" required />
          </div>
          <button className="btn primary" disabled={busy} type="submit">
            {busy ? <span className="spinner" /> : <><Icon name="search" size={15} /> Look up</>}
          </button>
        </form>
        <p className="tiny faint" style={{ marginTop: 4 }}>
          Demo: the seeded patient case <span className="mono">CASE-2026-000101</span> uses access code <span className="mono">DEMO-ACCESS</span>.
        </p>
      </Card>

      {error && <div style={{ marginTop: 16 }}><Alert tone="error">{error}</Alert></div>}

      {result && (
        <div className="stack fade-in" style={{ marginTop: 18 }}>
          <Card>
            <div className="row-between">
              <div>
                <div className="case-id">{result.id}</div>
                <h2 style={{ fontSize: "1.3rem", marginTop: 4 }}>{result.category}</h2>
                <p className="small muted">{result.facilityName} · {result.authorityName ?? result.authorityId} · {result.country}</p>
              </div>
              <div className="stack" style={{ gap: 8, alignItems: "flex-end" }}>
                <PriorityBadge priority={result.priority} />
                <StatusBadge status={result.status} />
                <VerificationBadge status={result.verificationStatus} />
              </div>
            </div>
            <div className="divider" />
            <div className="meta-grid">
              <div className="meta-item"><dt>Submitted</dt><dd>{formatDate(result.createdAt)}</dd></div>
              <div className="meta-item"><dt>SLA</dt><dd style={{ color: sla?.overdue ? "var(--danger)" : undefined }}>{result.resolvedAt ? "Closed" : sla?.text}</dd></div>
              <div className="meta-item"><dt>Complainant</dt><dd>{result.patientName}</dd></div>
              <div className="meta-item"><dt>Priority score</dt><dd>{result.priorityScore}/100</dd></div>
              <div className="meta-item"><dt>Documents</dt><dd>{result.documents.length}</dd></div>
            </div>
            {result.triage.signals.length > 0 && (
              <>
                <div className="divider" />
                <h3 style={{ fontSize: "0.9rem", marginBottom: 8 }}>Why this priority</h3>
                <div className="row" style={{ gap: 6 }}>
                  {result.triage.signals.map((s) => <span className="chip" key={s}>{s}</span>)}
                </div>
              </>
            )}
            {result.triage.regulatoryBasis.length > 0 && (
              <p className="tiny faint" style={{ marginTop: 12 }}>Regulatory basis: {result.triage.regulatoryBasis.join(" · ")}</p>
            )}
          </Card>

          <div className="grid-2">
            <Card>
              <div className="card-head"><h3>Case timeline</h3><span className="card-sub">{statusLabel(result.status)}</span></div>
              <div className="timeline">
                {[...result.timeline].reverse().map((event, i) => (
                  <div className="timeline-item" key={`${event.date}-${i}`}>
                    <span className="timeline-dot" />
                    <div>
                      <div className="timeline-title">{event.event}</div>
                      <div className="timeline-meta">{event.date}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <div className="card-head"><h3>Documents</h3><span className="card-sub">Verification summary</span></div>
              {result.documents.length === 0 && <p className="small muted">No documents were attached to this submission.</p>}
              <div className="stack" style={{ gap: 10 }}>
                {result.documents.map((doc) => (
                  <div key={doc.filename} className="row-between" style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px" }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="file-name">{doc.filename}</div>
                      <div className="file-meta">Trust score {doc.score}/100</div>
                    </div>
                    <VerificationBadge status={doc.status} />
                  </div>
                ))}
              </div>
              <div className="divider" />
              <div className="row" style={{ gap: 8 }}>
                <Badge tone="info"><Icon name="lock" size={11} /> Access-code protected</Badge>
                <Badge tone="muted">{result.region ?? result.country}</Badge>
              </div>
            </Card>
          </div>
          <p className="small faint">
            Need to add information? <Link to="/submit">File a linked grievance</Link> and quote this case reference in the narrative.
          </p>
        </div>
      )}
    </section>
  );
}
