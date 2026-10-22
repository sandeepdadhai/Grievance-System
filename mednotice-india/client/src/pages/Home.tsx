import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, PRIORITY_META, statusLabel } from "../api";
import type { Jurisdiction } from "../types";
import { Badge, Icon, PriorityBadge, VerificationBadge } from "../components/ui";

const MODULES = [
  {
    step: "01",
    title: "India-wide intake",
    body: "State or Union Territory, health authority and facility selection drive the validation schema, preferred language and destination endpoint for every submission.",
  },
  {
    step: "02",
    title: "Document forensics",
    body: "Uploaded PDFs, images and DICOM reports are inspected for incremental edits, toolchain metadata, font fragmentation, revoked NMC registrations and re-used digests.",
  },
  {
    step: "03",
    title: "Clinical triage",
    body: "A weighted priority matrix maps narratives — in English or Hindi — to P1–P4 with India-specific SLA clocks and the regulation that applies to the case category.",
  },
  {
    step: "04",
    title: "Adapter routing",
    body: "FHIR R4 bundles, HL7 v2 messages, configuration-driven REST envelopes and SOAP 1.2 envelopes deliver the case to MoHFW, NHA or the relevant state health department.",
  },
  {
    step: "05",
    title: "Notifications",
    body: "Priority-aware email and signed webhook notifications are queued with retry/backoff and masked identifiers before any outbound disclosure.",
  },
  {
    step: "06",
    title: "Governed review",
    body: "Ministry reviewers and hospital compliance officers can override triage, approve documents and re-route cases — every action lands in a hash-chained audit log.",
  },
];

export default function Home() {
  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[]>([]);

  useEffect(() => {
    api.get<{ jurisdictions: Jurisdiction[] }>("/api/public/jurisdictions").then((r) => setJurisdictions(r.jurisdictions)).catch(() => undefined);
  }, []);

  const authorities = jurisdictions.flatMap((j) => j.authorities);

  return (
    <>
      <section className="hero">
        <div className="hero-grid">
          <div className="fade-in">
            <span className="eyebrow">
              <span className="dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" }} />
              Patient grievance infrastructure for India
            </span>
            <h1>
              Patient complaints, <span>verified</span> and routed to the right authority.
            </h1>
            <p className="hero-lead">
              MedNotice India ingests grievances and treatment records from patients across the country, screens documents for
              tampering, triages clinical urgency against Indian regulation, and delivers a complete case file to MoHFW, the
              National Health Authority or the relevant State Health Department.
            </p>
            <div className="hero-actions">
              <Link to="/submit" className="btn primary">
                File a grievance <Icon name="arrow" size={16} />
              </Link>
              <Link to="/track" className="btn">Track an existing case</Link>
            </div>
            <div className="hero-stats">
              <div className="hero-stat"><strong>{jurisdictions.length || 1}</strong><span>National platform</span></div>
              <div className="hero-stat"><strong>{authorities.length || 6}</strong><span>Health authorities</span></div>
              <div className="hero-stat"><strong>4</strong><span>Routing protocols</span></div>
              <div className="hero-stat"><strong>DPDP</strong><span>Act 2023 aligned</span></div>
            </div>
          </div>

          <div className="console-card fade-in" aria-label="Example verification console">
            <div className="console-head">
              <div className="row" style={{ gap: 8 }}>
                <span className="brand-mark" style={{ width: 22, height: 22, borderRadius: 6, fontSize: 10 }}>MN</span>
                <span className="small" style={{ color: "var(--text-2)", fontWeight: 600 }}>Verification console</span>
              </div>
              <div className="console-tabs">
                <span className="console-tab">Intake</span>
                <span className="console-tab active">Forensics</span>
                <span className="console-tab">Triage</span>
              </div>
            </div>
            <div className="console-body">
              <div className="signal-row"><span className="mono faint tiny">CASE-2026-000101</span><PriorityBadge priority="P1" /></div>
              <div className="mini-case">
                <div className="mini-case-head">
                  <span className="mini-case-id">ed_triage_record.pdf</span>
                  <VerificationBadge status="VERIFIED" />
                </div>
                <p>Clean incremental structure · embedded EHR signature · NMC registration DL-48291 active · facility match.</p>
                <div className="mini-docs">
                  <span className="chip mono">trust 92/100</span>
                  <span className="chip mono">ICD I21.4</span>
                  <span className="chip">2 pages</span>
                </div>
              </div>
              <div className="mini-case">
                <div className="mini-case-head">
                  <span className="mini-case-id">kem_admission_note.pdf</span>
                  <VerificationBadge status="PENDING_MANUAL_REVIEW" />
                </div>
                <p>Hindi narrative · word-processor provenance · 3 incremental revisions · routed to Maharashtra review queue.</p>
                <div className="mini-docs">
                  <span className="chip mono">trust 61/100</span>
                  <span className="chip">manual review</span>
                </div>
              </div>
              <div className="divider" />
              <div className="signal-row"><span>Priority matrix</span><span className="signal-value">P1 · score 92</span></div>
              <div className="progress"><span style={{ width: "92%" }} /></div>
              <div className="signal-row"><span>Destination</span><span className="signal-value">IN-MOHFW · FHIR R4</span></div>
              <div className="row" style={{ gap: 6 }}>
                <Badge tone="ok" dot>Routed in 142ms</Badge>
                <Badge tone="info">PII masked</Badge>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>One national platform, state-level routing, four protocols</h2>
          <p>Every Indian state and Union Territory is a configuration entry. Adding a health department means adding a schema mapping — not rewriting the case engine.</p>
        </div>
        <div className="grid-3">
          {MODULES.map((m) => (
            <div className="card flow-card" key={m.step}>
              <span className="flow-step">STEP {m.step}</span>
              <h3>{m.title}</h3>
              <p>{m.body}</p>
            </div>
          ))}
        </div>
        <div className="jurisdiction-strip">
          {authorities.map((a) => (
            <span className="jurisdiction-pill" key={a.id}>
              <span aria-hidden>🇮🇳</span>
              {a.region}
              <em>{a.name}</em>
            </span>
          ))}
        </div>
      </section>

      <section className="section" style={{ paddingTop: 10 }}>
        <div className="grid-2">
          <div className="card">
            <div className="card-head">
              <h3><Icon name="shield" size={16} /> Privacy by design</h3>
              <Badge tone="ok">DPDP 2023 · Charter of Patients' Rights</Badge>
            </div>
            <ul style={{ display: "grid", gap: 10, fontSize: 13, color: "var(--text-2)", paddingLeft: 18 }}>
              <li>Narratives, Aadhaar/PAN references and contact details are encrypted with AES-256-GCM before they touch disk.</li>
              <li>Outbound payloads carry masked names, emails, phones and record numbers by default.</li>
              <li>Every read, review and transmission is appended to a tamper-evident audit chain.</li>
              <li>Retention windows and regulator citations follow the Indian jurisdiction matrix.</li>
            </ul>
            <div className="divider" />
            <div className="row" style={{ gap: 8 }}>
              <Badge tone="info">DPDP Act 2023</Badge>
              <Badge tone="info">Clinical Establishments Act 2010</Badge>
              <Badge tone="info">NMC Act 2019</Badge>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3><Icon name="activity" size={16} /> How priority is decided</h3>
              <span className="card-sub">Weighted, explainable, auditable</span>
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              {(["P1", "P2", "P3", "P4"] as const).map((p) => (
                <div key={p} className="row-between" style={{ gap: 12 }}>
                  <div className="row" style={{ gap: 10 }}>
                    <PriorityBadge priority={p} solid />
                    <span style={{ fontSize: 13, color: "var(--text-2)" }}>{PRIORITY_META[p].label}</span>
                  </div>
                  <span className="small faint right" style={{ maxWidth: 260 }}>{PRIORITY_META[p].description}</span>
                </div>
              ))}
            </div>
            <div className="divider" />
            <p className="small muted">
              Example drivers: reported death (+22), cardiac arrest (+22), vulnerable patient (+8), incident within 7 days (+10),
              ongoing harm (+6). Financial-only disputes are capped at {statusLabel("P3")}.
            </p>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 6 }}>
        <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ marginBottom: 6 }}>Ready to file or review a case?</h2>
            <p className="muted small">Patients and families can submit in minutes. Reviewers get a complete, explainable case file.</p>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Link to="/submit" className="btn primary">File a grievance</Link>
            <Link to="/login" className="btn">Staff sign in</Link>
          </div>
        </div>
      </section>
    </>
  );
}
