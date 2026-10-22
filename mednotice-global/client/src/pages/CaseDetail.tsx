import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatDate, PRIORITY_META, slaCountdown, statusLabel, timeAgo } from "../api";
import { REVIEWER_ROLES, useAuth } from "../auth";
import type { AdapterDto, CaseDetail as CaseDetailType, DocumentDto, Jurisdiction, Priority } from "../types";
import { Alert, Badge, Card, Icon, Modal, PriorityBadge, Spinner, StatusBadge, VerificationBadge } from "../components/ui";
import { ScoreGauge } from "../components/charts";

type ModalState =
  | { kind: "override" }
  | { kind: "resolve" }
  | { kind: "reroute" }
  | { kind: "review"; document: DocumentDto; decision: "APPROVE" | "REJECT" }
  | null;

export default function CaseDetail({ staff = false }: { staff?: boolean }) {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const [detail, setDetail] = useState<CaseDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [busy, setBusy] = useState(false);
  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[]>([]);
  const [adapters, setAdapters] = useState<AdapterDto[]>([]);
  const [form, setForm] = useState({ priority: "P3" as Priority, category: "", note: "", outcome: "", adapterCode: "" });

  const canReview = Boolean(user && REVIEWER_ROLES.includes(user.role));

  const load = useCallback(async () => {
    try {
      const data = await api.get<CaseDetailType>(`/api/cases/${id}`);
      setDetail(data);
      setError(null);
      setForm((f) => ({ ...f, priority: data.case.priority, category: data.case.category, adapterCode: f.adapterCode }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canReview) return;
    api.get<{ jurisdictions: Jurisdiction[] }>("/api/public/jurisdictions").then((r) => setJurisdictions(r.jurisdictions)).catch(() => undefined);
    api.get<{ adapters: AdapterDto[] }>("/api/admin/adapters").then((r) => setAdapters(r.adapters)).catch(() => undefined);
  }, [canReview]);

  const categories = useMemo(() => {
    if (!detail) return [];
    return jurisdictions.find((j) => j.code === detail.case.country)?.complaintCategories ?? [];
  }, [jurisdictions, detail]);

  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(message);
      setModal(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !detail) {
    return (
      <section className="section" style={{ maxWidth: 760 }}>
        <Alert tone="error">{error}</Alert>
        <Link to={staff ? "/admin/cases" : "/portal"} className="btn">Back</Link>
      </section>
    );
  }
  if (!detail) {
    return <div className="content"><Spinner label="Loading case file…" /></div>;
  }

  const c = detail.case;
  const sla = slaCountdown(c.slaDueAt);
  const docs = c.documents ?? [];
  const p1 = PRIORITY_META[c.priority];

  return (
    <>
      <div className="row-between" style={{ marginBottom: 14 }}>
        <Link to={staff ? "/admin/cases" : "/portal"} className="btn ghost sm">
          <Icon name="chevron" size={13} /> {staff ? "All cases" : "My cases"}
        </Link>
        <div className="row" style={{ gap: 8 }}>
          {!detail.piiVisible && <Badge tone="warn"><Icon name="lock" size={11} /> Identifiers masked for your role</Badge>}
          <Badge tone="muted">Source: {c.source}</Badge>
          <button className="btn ghost sm" onClick={() => void load()}><Icon name="refresh" size={13} /> Refresh</button>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="case-header">
        <div className="case-title-row">
          <div>
            <div className="case-id">{c.id} · {c.country} · {c.authorityId}</div>
            <h1 className="case-title">{c.category}</h1>
            <p className="muted small" style={{ marginTop: 4 }}>
              {c.facilityName} · incident {c.incidentDate ?? "unspecified"} · submitted {formatDate(c.createdAt)}
            </p>
          </div>
          <div className="stack" style={{ gap: 8, alignItems: "flex-end" }}>
            <PriorityBadge priority={c.priority} />
            <StatusBadge status={c.status} />
            <VerificationBadge status={c.verificationStatus} />
            <span className={`small ${sla.overdue && c.status !== "RESOLVED" ? "" : "faint"}`} style={{ color: sla.overdue && c.status !== "RESOLVED" ? "var(--danger)" : undefined }}>
              {c.resolvedAt ? `Resolved ${timeAgo(c.resolvedAt)}` : sla.text}
            </span>
          </div>
        </div>

        {canReview && (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => setModal({ kind: "override" })}><Icon name="clipboard" size={14} /> Override triage</button>
            <button className="btn sm" onClick={() => setModal({ kind: "reroute" })}><Icon name="send" size={14} /> Re-route</button>
            {c.status !== "RESOLVED" ? (
              <button className="btn sm" onClick={() => setModal({ kind: "resolve" })}><Icon name="check" size={14} /> Resolve case</button>
            ) : (
              <button
                className="btn sm ghost"
                onClick={() => act(() => api.post(`/api/admin/cases/${c.id}/reopen`, { note: "Case reopened by reviewer for further investigation." }), "Case reopened.")}
                disabled={busy}
              >
                Reopen
              </button>
            )}
          </div>
        )}
      </div>

      {c.verificationStatus === "PENDING_MANUAL_REVIEW" && (
        <Alert tone="warn">
          <strong>Manual verification required.</strong> Routing is blocked until every flagged document is approved or rejected.
        </Alert>
      )}
      {c.verificationStatus === "REJECTED" && (
        <Alert tone="error">
          <strong>Bundle rejected.</strong> At least one document was classified as inauthentic. Routing is blocked; the case remains on record for investigation.
        </Alert>
      )}

      <div className="detail-layout">
        <div className="stack">
          <Card>
            <div className="card-head"><h3>Complaint narrative</h3><Badge tone="info">{p1.label}</Badge></div>
            <p className="narrative">{c.complaint}</p>
            {c.symptoms && (
              <>
                <div className="divider" />
                <h3 style={{ fontSize: "0.88rem", marginBottom: 6 }}>Symptoms</h3>
                <p className="narrative">{c.symptoms}</p>
              </>
            )}
            <div className="divider" />
            <div className="meta-grid">
              <div className="meta-item"><dt>Complainant</dt><dd>{c.patientName}</dd></div>
              <div className="meta-item"><dt>Email</dt><dd style={{ wordBreak: "break-all" }}>{c.patientEmail}</dd></div>
              <div className="meta-item"><dt>Region</dt><dd>{c.region ?? "—"}</dd></div>
              <div className="meta-item"><dt>Language</dt><dd>{c.language.toUpperCase()}</dd></div>
              <div className="meta-item"><dt>Consent</dt><dd>{c.consentDataSharing ? "Granted" : "No"}</dd></div>
              <div className="meta-item"><dt>Cross-border</dt><dd>{c.crossBorderAllowed ? "Allowed" : "Masked"}</dd></div>
            </div>
          </Card>

          <Card>
            <div className="card-head">
              <h3>Triage rationale</h3>
              <span className="card-sub">{c.priority} · score {c.priorityScore}/100 · confidence {Math.round(c.categoryConfidence * 100)}%</span>
            </div>
            <div className="progress" style={{ marginBottom: 16 }}><span style={{ width: `${c.priorityScore}%` }} /></div>
            <div className="stack" style={{ gap: 8 }}>
              {c.triage?.signals?.map((s) => (
                <div key={`${s.code}-${s.label}`} className="row-between" style={{ gap: 12, borderBottom: "1px solid rgba(151,180,235,0.07)", paddingBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 12.5, color: "var(--text-2)" }}>{s.label}</div>
                    <div className="tiny faint">{s.detail}</div>
                  </div>
                  <span className="mono small" style={{ color: s.weight >= 15 ? "var(--danger)" : "var(--muted)" }}>+{s.weight}</span>
                </div>
              ))}
            </div>
            {c.triage?.regulatoryBasis?.length > 0 && (
              <>
                <div className="divider" />
                <h3 style={{ fontSize: "0.86rem", marginBottom: 6 }}>Regulatory basis</h3>
                <div className="row" style={{ gap: 6 }}>
                  {c.triage.regulatoryBasis.map((r) => <span className="chip" key={r}>{r}</span>)}
                </div>
              </>
            )}
            <div className="divider" />
            <h3 style={{ fontSize: "0.86rem", marginBottom: 6 }}>Timeline</h3>
            <div className="timeline">
              {c.timeline.map((t, i) => (
                <div className="timeline-item" key={`${t.date}-${i}`}>
                  <span className="timeline-dot" />
                  <div><div className="timeline-title">{t.event}</div><div className="timeline-meta">{t.date}</div></div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="card-head">
              <h3>Documents</h3>
              <span className="card-sub">{docs.length} file(s) · encrypted at rest</span>
            </div>
            {docs.length === 0 && <p className="small muted">No documents attached.</p>}
            <div className="stack" style={{ gap: 14 }}>
              {docs.map((doc) => (
                <div key={doc.id} style={{ border: "1px solid var(--line)", borderRadius: 11, padding: 14, background: "rgba(8,14,25,0.4)" }}>
                  <div className="doc-header">
                    <div style={{ minWidth: 0 }}>
                      <div className="doc-name">{doc.filename}</div>
                      <div className="doc-meta">
                        {doc.kind} · {doc.pageCount ? `${doc.pageCount} pages · ` : ""}uploaded {timeAgo(doc.uploadedAt)}
                      </div>
                      <div className="row" style={{ gap: 6, marginTop: 7 }}>
                        <VerificationBadge status={doc.verificationStatus} />
                        <span className="chip mono">sha256 {doc.sha256.slice(0, 12)}…</span>
                        {doc.reviewedAt && <span className="chip">Reviewed {timeAgo(doc.reviewedAt)}</span>}
                      </div>
                    </div>
                    <div className="stack" style={{ gap: 8, alignItems: "center" }}>
                      <ScoreGauge score={doc.score} />
                      <span className="tiny faint">trust score</span>
                    </div>
                  </div>

                  {doc.findings.length > 0 && (
                    <div className="doc-section">
                      <h4>Verification findings ({doc.findings.length})</h4>
                      {doc.findings.map((f) => (
                        <div className="finding" key={f.code}>
                          <div className="finding-head">
                            <span className="finding-title">{f.label}</span>
                            <div className="row" style={{ gap: 8 }}>
                              <Badge tone={f.severity === "critical" || f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : f.severity === "info" ? "info" : "muted"}>
                                {f.severity}
                              </Badge>
                              <span className="finding-weight">{f.weight > 0 ? `+${f.weight}` : f.weight}</span>
                            </div>
                          </div>
                          <div className="finding-detail">{f.detail}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {Object.keys(doc.extracted).length > 0 && (
                    <div className="doc-section">
                      <h4>Extracted fields</h4>
                      <dl className="extract-grid">
                        {doc.extracted.patientName && <><dt>Patient</dt><dd>{doc.extracted.patientName}</dd></>}
                        {doc.extracted.physicianName && <><dt>Physician</dt><dd>{doc.extracted.physicianName}</dd></>}
                        {doc.extracted.physicianLicense && <><dt>Licence</dt><dd>{doc.extracted.physicianLicense}</dd></>}
                        {doc.extracted.diagnosisCode && <><dt>ICD</dt><dd>{doc.extracted.diagnosisCode}</dd></>}
                        {doc.extracted.facilityName && <><dt>Facility</dt><dd>{doc.extracted.facilityName}</dd></>}
                        {doc.extracted.datesOfService?.length > 0 && <><dt>Dates of service</dt><dd>{doc.extracted.datesOfService.join(", ")}</dd></>}
                        {doc.extracted.mrn && <><dt>MRN</dt><dd>{doc.extracted.mrn}</dd></>}
                      </dl>
                    </div>
                  )}

                  {doc.reviewNote && (
                    <div className="doc-section">
                      <h4>Reviewer note</h4>
                      <p className="small muted">{doc.reviewNote}</p>
                    </div>
                  )}

                  <div className="doc-section row" style={{ gap: 8 }}>
                    {doc.downloadUrl && <a className="btn sm ghost" href={doc.downloadUrl}>Download original</a>}
                    {canReview && doc.verificationStatus !== "VERIFIED" && (
                      <button className="btn sm" onClick={() => setModal({ kind: "review", document: doc, decision: "APPROVE" })}>
                        <Icon name="check" size={13} /> Approve
                      </button>
                    )}
                    {canReview && doc.verificationStatus !== "REJECTED" && (
                      <button className="btn sm danger" onClick={() => setModal({ kind: "review", document: doc, decision: "REJECT" })}>
                        <Icon name="x" size={13} /> Reject
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="card-head"><h3>Routing transmissions</h3><span className="card-sub">{detail.transmissions.length} attempt(s)</span></div>
            {detail.transmissions.length === 0 && <p className="small muted">No transmission attempted. The case may be awaiting verification.</p>}
            <div className="stack" style={{ gap: 12 }}>
              {detail.transmissions.map((tx) => (
                <div key={tx.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12 }}>
                  <div className="row-between">
                    <div className="row" style={{ gap: 8 }}>
                      <StatusBadge status={tx.status} />
                      <span className="mono small">{tx.adapter_code}</span>
                    </div>
                    <span className="tiny faint">{formatDate(tx.created_at)} · {tx.latency_ms ?? 0} ms · HTTP {tx.http_status ?? "—"}</span>
                  </div>
                  <details style={{ marginTop: 10 }}>
                    <summary className="small muted" style={{ cursor: "pointer" }}>Inspect masked payload & acknowledgement</summary>
                    <pre className="payload" style={{ marginTop: 8 }}>{tx.request_json.slice(0, 2200)}</pre>
                    <pre className="payload" style={{ marginTop: 8 }}>{tx.response_json}</pre>
                  </details>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="card-head"><h3>Review history</h3><span className="card-sub">{detail.reviews.length} decision(s)</span></div>
            {detail.reviews.length === 0 && <p className="small muted">No human decisions recorded yet.</p>}
            <div className="timeline">
              {[...detail.reviews].reverse().map((r) => (
                <div className="timeline-item" key={r.id}>
                  <span className="timeline-dot" />
                  <div>
                    <div className="timeline-title">{statusLabel(r.action)}</div>
                    <div className="timeline-meta">{r.reviewer_id} · {formatDate(r.created_at)}</div>
                    <div className="timeline-body">{r.note}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card>
            <div className="card-head"><h3>Case at a glance</h3></div>
            <dl className="kv">
              <dt>Priority</dt><dd>{c.priority} · {p1.label}</dd>
              <dt>Score</dt><dd>{c.priorityScore}/100</dd>
              <dt>Category</dt><dd>{c.category}</dd>
              <dt>Status</dt><dd>{statusLabel(c.status)}</dd>
              <dt>SLA due</dt><dd>{formatDate(c.slaDueAt)}</dd>
              <dt>Assigned</dt><dd>{c.assignedTo ?? "Unassigned"}</dd>
              <dt>Authority</dt><dd>{c.authorityId}</dd>
              <dt>Facility</dt><dd>{c.facilityName}</dd>
            </dl>
          </Card>

          <Card>
            <div className="card-head"><h3>Activity trail</h3><span className="card-sub">Hash-chained</span></div>
            <div className="stack" style={{ gap: 0 }}>
              {detail.activity.slice(0, 14).map((a, i) => (
                <div className="audit-row" key={`${a.ts}-${i}`} style={{ gridTemplateColumns: "1fr" }}>
                  <div className="row-between">
                    <span className="audit-action">{a.action}</span>
                    <span className="audit-time">{timeAgo(a.ts)}</span>
                  </div>
                  <div className="audit-actor">{a.actor_role ?? "SYSTEM"} · {a.actor_id ?? "automated"}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="card-head"><h3>Notifications</h3><span className="card-sub">{detail.notifications.length}</span></div>
            {detail.notifications.length === 0 && <p className="small muted">No notifications queued for this case.</p>}
            <div className="stack" style={{ gap: 10 }}>
              {detail.notifications.map((n) => (
                <div key={n.id} style={{ borderBottom: "1px solid rgba(151,180,235,0.08)", paddingBottom: 8 }}>
                  <div className="row-between">
                    <span className="chip mono">{n.channel}</span>
                    <StatusBadge status={n.status} />
                  </div>
                  <div className="small" style={{ marginTop: 4, wordBreak: "break-all" }}>{n.target}</div>
                  <div className="tiny faint">{n.sent_at ? `Sent ${timeAgo(n.sent_at)}` : `Attempts: ${n.attempts}`}{n.last_error ? ` · ${n.last_error}` : ""}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {modal?.kind === "override" && (
        <Modal title="Override triage" sub="The change is recorded with your identity and rationale." onClose={() => setModal(null)}>
          <div className="field">
            <label htmlFor="ov-priority">Priority</label>
            <select id="ov-priority" className="select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}>
              {(Object.keys(PRIORITY_META) as Priority[]).map((p) => <option key={p} value={p}>{p} · {PRIORITY_META[p].label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ov-category">Category</label>
            <select id="ov-category" className="select" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {(categories.length ? categories : [c.category]).map((cat) => <option key={cat} value={cat}>{cat}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ov-note">Rationale (required)</label>
            <textarea id="ov-note" className="textarea" style={{ minHeight: 90 }} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Why is the automated assignment being changed?" />
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || form.note.trim().length < 10}
              onClick={() => act(() => api.post(`/api/admin/cases/${c.id}/override`, { priority: form.priority, category: form.category, note: form.note }), "Triage override recorded and SLA recalculated.")}
            >
              {busy ? <span className="spinner" /> : "Save override"}
            </button>
          </div>
        </Modal>
      )}

      {modal?.kind === "resolve" && (
        <Modal title="Resolve case" sub="Closes the case and records the outcome." onClose={() => setModal(null)}>
          <div className="field">
            <label htmlFor="res-outcome">Outcome summary</label>
            <input id="res-outcome" className="input" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} placeholder="e.g. Remediation agreed with facility" />
          </div>
          <div className="field">
            <label htmlFor="res-note">Resolution note (required)</label>
            <textarea id="res-note" className="textarea" style={{ minHeight: 90 }} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="What was agreed, found or referred?" />
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || form.note.trim().length < 10}
              onClick={() => act(() => api.post(`/api/admin/cases/${c.id}/resolve`, { note: form.note, outcome: form.outcome }), "Case resolved.")}
            >
              {busy ? <span className="spinner" /> : "Resolve case"}
            </button>
          </div>
        </Modal>
      )}

      {modal?.kind === "reroute" && (
        <Modal title="Re-route case" sub="Re-sends the current verified payload through another adapter." onClose={() => setModal(null)}>
          <div className="field">
            <label htmlFor="rr-adapter">Adapter</label>
            <select id="rr-adapter" className="select" value={form.adapterCode} onChange={(e) => setForm({ ...form, adapterCode: e.target.value })}>
              <option value="">Authority default</option>
              {adapters.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}{a.enabled ? "" : " (disabled)"}</option>)}
            </select>
          </div>
          <p className="small muted">Re-routing is blocked when the bundle is pending review or rejected.</p>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => act(() => api.post(`/api/admin/cases/${c.id}/reroute`, form.adapterCode ? { adapterCode: form.adapterCode } : {}), "Case re-transmitted.")}
            >
              {busy ? <span className="spinner" /> : "Transmit now"}
            </button>
          </div>
        </Modal>
      )}

      {modal?.kind === "review" && (
        <Modal
          title={modal.decision === "APPROVE" ? "Approve document" : "Reject document"}
          sub={`${modal.document.filename} · trust score ${modal.document.score}/100`}
          onClose={() => setModal(null)}
        >
          <div className="field">
            <label htmlFor="rev-note">Review rationale (required)</label>
            <textarea id="rev-note" className="textarea" style={{ minHeight: 100 }} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="What evidence did you check? Reference the registry, original document or facility confirmation." />
          </div>
          {modal.decision === "APPROVE" && (
            <Alert tone="info">Approving recalculates the bundle status. If every document is verified, the case is routed immediately and notifications are queued.</Alert>
          )}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button
              className={modal.decision === "APPROVE" ? "btn primary" : "btn danger"}
              disabled={busy || form.note.trim().length < 8}
              onClick={() =>
                act(
                  () => api.post(`/api/documents/${modal.document.id}/review`, { decision: modal.decision, note: form.note, routeIfVerified: true }),
                  `Document ${modal.decision === "APPROVE" ? "approved" : "rejected"}.`,
                )
              }
            >
              {busy ? <span className="spinner" /> : modal.decision === "APPROVE" ? "Approve document" : "Reject document"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
