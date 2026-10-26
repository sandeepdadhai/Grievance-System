import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, slaCountdown, statusLabel, timeAgo } from "../api";
import { useAuth } from "../auth";
import type { CaseDto } from "../types";
import { Alert, Card, Icon, PriorityBadge, Spinner, StatusBadge, VerificationBadge } from "../components/ui";

export default function Portal() {
  const { user, refresh } = useAuth();
  const [cases, setCases] = useState<CaseDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [waBusy, setWaBusy] = useState(false);
  const [waNote, setWaNote] = useState<string | null>(null);
  const [waError, setWaError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ cases: CaseDto[] }>("/api/cases/mine")
      .then((r) => setCases(r.cases))
      .catch((err) => setError((err as Error).message));
  }, []);

  const whatsapp = user?.whatsapp;

  async function saveWhatsApp(optIn: boolean) {
    setWaBusy(true);
    setWaError(null);
    setWaNote(null);
    try {
      await api.post("/api/auth/whatsapp", { phone, optIn });
      await refresh();
      setPhone("");
      setWaNote(optIn ? "Saved. This number now receives updates for your cases." : "WhatsApp updates are off. Your number is kept on file.");
    } catch (err) {
      setWaError((err as Error).message);
    } finally {
      setWaBusy(false);
    }
  }

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

      <Card style={{ marginTop: 18 }}>
        <div className="row-between" style={{ alignItems: "flex-start", gap: 18 }}>
          <div style={{ minWidth: 0 }}>
            <span className="eyebrow">Notifications</span>
            <h3 style={{ marginTop: 4 }}>WhatsApp updates</h3>
            <p className="small muted" style={{ marginTop: 4, maxWidth: 520 }}>
              Get one WhatsApp message when a grievance is received, and another whenever its status changes. Only the case
              reference, facility, category and status are included — never your complaint text or documents.
            </p>
          </div>
          <span
            className={`badge ${whatsapp?.connected ? "ok" : "warn"}`}
            title={whatsapp?.connected ? "Live WhatsApp Business channel" : "No WhatsApp Business credentials on this server"}
          >
            {whatsapp?.connected ? "Live channel" : "Simulation mode"}
          </span>
        </div>

        {whatsapp?.number && (
          <p className="small" style={{ marginTop: 12 }}>
            Number on file: <span className="mono">{whatsapp.number}</span>{" "}
            <span className="faint">· {whatsapp.optIn ? "updates on" : "updates paused"}</span>
          </p>
        )}

        {waError && <Alert tone="error">{waError}</Alert>}
        {waNote && <Alert tone="success">{waNote}</Alert>}
        {!whatsapp?.connected && (
          <p className="tiny faint" style={{ marginTop: 10 }}>
            This deployment has no WhatsApp Business credentials, so messages are written to the server outbox instead of
            being delivered. The workflow is identical once credentials are added.
          </p>
        )}

        <div className="row" style={{ gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          <input
            className="input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98100 01000"
            aria-label="WhatsApp number"
            style={{ maxWidth: 260 }}
          />
          <button className="btn primary" disabled={waBusy || !phone.trim()} onClick={() => void saveWhatsApp(true)} type="button">
            {waBusy ? <span className="spinner" /> : whatsapp?.optIn ? "Update number" : "Enable updates"}
          </button>
          {whatsapp?.optIn && (
            <button className="btn ghost" disabled={waBusy} onClick={() => void saveWhatsApp(false)} type="button">
              Turn off
            </button>
          )}
        </div>
      </Card>

      <p className="small faint" style={{ marginTop: 18 }}>
        Looking for a guest submission? <Link to="/track">Track with a case reference and access code</Link>.
      </p>
    </section>
  );
}
