import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, slaCountdown, statusLabel, timeAgo } from "../api";
import { useAuth } from "../auth";
import type { CaseDto } from "../types";
import { Alert, Card, Icon, PriorityBadge, Spinner, StatusBadge, VerificationBadge } from "../components/ui";

export default function Portal() {
  const { user } = useAuth();
  const [cases, setCases] = useState<CaseDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ cases: CaseDto[] }>("/api/cases/mine")
      .then((r) => setCases(r.cases))
      .catch((err) => setError((err as Error).message));
  }, []);

  return (
    <section className="section" style={{ maxWidth: 1080 }}>
      <div className="row-between" style={{ marginBottom: 22 }}>
        <div>
          <span className="eyebrow">Patient workspace</span>
          <h2>Your grievances</h2>
          <p className="muted small" style={{ marginTop: 4 }}>Signed in as {user?.name} · {user?.email}</p>
        </div>
        <Link to="/submit" className="btn primary"><Icon name="plus" size={15} /> New grievance</Link>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {!cases && !error && <Spinner />}
      {cases && cases.length === 0 && (
        <Card>
          <p className="muted">You have not filed a grievance yet.</p>
          <Link to="/submit" className="btn primary" style={{ marginTop: 14 }}>Start a submission</Link>
        </Card>
      )}

      <div className="stack">
        {cases?.map((c) => {
          const sla = slaCountdown(c.slaDueAt);
          return (
            <Card key={c.id}>
              <div className="row-between">
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="case-id">{c.id}</span>
                    <StatusBadge status={c.status} />
                    <VerificationBadge status={c.verificationStatus} />
                  </div>
                  <h3 style={{ marginTop: 6 }}>{c.category}</h3>
                  <p className="small muted">{c.facilityName} · {c.country} · submitted {formatDate(c.createdAt, { hour: undefined, minute: undefined })}</p>
                  <p className="tiny faint" style={{ marginTop: 4 }}>Last update {timeAgo(c.updatedAt)} · {c.documents?.length ?? 0} document(s)</p>
                </div>
                <div className="stack" style={{ gap: 8, alignItems: "flex-end" }}>
                  <PriorityBadge priority={c.priority} />
                  <span className={`small ${sla.overdue && c.status !== "RESOLVED" ? "" : "faint"}`} style={{ color: sla.overdue && c.status !== "RESOLVED" ? "var(--danger)" : undefined }}>
                    {c.resolvedAt ? "Resolved" : sla.text}
                  </span>
                  <Link to={`/cases/${c.id}`} className="btn sm">Open case <Icon name="chevron" size={13} /></Link>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <p className="small faint" style={{ marginTop: 18 }}>
        Looking for a guest submission? <Link to="/track">Track with a case reference and access code</Link>.
      </p>
    </section>
  );
}
