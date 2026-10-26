import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, bytes, formatDate, slaCountdown, statusLabel, timeAgo } from "../../api";
import { useAuth } from "../../auth";
import type { DocumentDto, FacilityCase, FacilityWorkspace } from "../../types";
import { Alert, Badge, Card, CardHead, EmptyState, Icon, Modal, PriorityBadge, Spinner, StatusBadge, VerificationBadge } from "../../components/ui";

type ReviewModal = {
  kind: "review";
  caseRow: FacilityCase;
  decisions: Record<string, "APPROVE" | "REJECT">;
};

type ResolveModal = {
  kind: "resolve";
  caseRow: FacilityCase;
  outcome: string;
};

type ModalState = ReviewModal | ResolveModal | null;

/**
 * Facility workspace. Accounts bound to a facility land here: every case filed
 * against their facility, the evidence still waiting for a human decision, and
 * the actions to verify that evidence and close the case.
 */
export default function AdminFacility() {
  const { user } = useAuth();
  const [data, setData] = useState<FacilityWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await api.get<FacilityWorkspace>("/api/admin/facility");
      setData(payload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openReview(caseRow: FacilityCase) {
    const pending = caseRow.documents.filter((d) => d.verificationStatus === "PENDING_MANUAL_REVIEW");
    setNote("");
    setError(null);
    setNotice(null);
    setModal({
      kind: "review",
      caseRow,
      decisions: Object.fromEntries(pending.map((d) => [d.id, "APPROVE" as const])),
    });
  }

  function openResolve(caseRow: FacilityCase) {
    setNote("");
    setError(null);
    setNotice(null);
    setModal({ kind: "resolve", caseRow, outcome: "" });
  }

  async function submitReview(state: ReviewModal) {
    const pending = state.caseRow.documents.filter((d) => d.verificationStatus === "PENDING_MANUAL_REVIEW");
    if (note.trim().length < 8) {
      setError("Add a review rationale of at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const doc of pending) {
        await api.post(`/api/documents/${doc.id}/review`, {
          decision: state.decisions[doc.id] ?? "APPROVE",
          note,
          routeIfVerified: true,
        });
      }
      setNotice(`${pending.length} document(s) reviewed for ${state.caseRow.id}.`);
      setModal(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitResolve(state: ResolveModal) {
    if (note.trim().length < 10) {
      setError("Describe the resolution in at least 10 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/admin/cases/${state.caseRow.id}/resolve`, {
        note,
        outcome: state.outcome.trim() || undefined,
      });
      setNotice(`${state.caseRow.id} marked as resolved.`);
      setModal(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) {
    return <div className="content"><Spinner label="Loading facility queue…" /></div>;
  }

  if (!data) {
    return (
      <div className="fade-in">
        <h2>My facility</h2>
        <Alert tone="warn">{error ?? "This account is not bound to a facility."}</Alert>
        <p className="small muted">
          {user?.baseRole === "SUPER_ADMIN"
            ? "Assign a facility to a staff account under Users & roles to give it a facility queue."
            : "Ask a super administrator to bind your account to the facility you work for."}
        </p>
        <Link to="/admin/cases" className="btn ghost">Open the case list</Link>
      </div>
    );
  }

  const { facility, counts, cases } = data;

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>My facility · {facility.name}</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            {facility.city ? `${facility.city} · ` : ""}{facility.country} · {facility.authorityId} · facility reference {facility.id}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Badge tone="info" dot>Facility-scoped</Badge>
          <button className="btn sm ghost" onClick={() => void load()}><Icon name="refresh" size={14} /> Refresh</button>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="grid-4" style={{ marginBottom: 18 }}>
        {[
          ["Open cases", counts.open, "Awaiting action or authority response"],
          ["Evidence to verify", counts.awaitingVerification, "Bundles flagged for manual review"],
          ["Overdue", counts.overdue, "Past the triage SLA deadline"],
          ["Resolved", counts.resolved, "Closed with a recorded outcome"],
        ].map(([label, value, hint]) => (
          <Card key={String(label)}>
            <div className="label">{label}</div>
            <div style={{ fontSize: 26, fontWeight: 600, margin: "6px 0 2px" }}>{value as number}</div>
            <div className="tiny faint">{hint as string}</div>
          </Card>
        ))}
      </div>

      <Card flush>
        <div style={{ padding: "18px 20px 8px" }}>
          <CardHead
            title="Cases filed against this facility"
            sub="Verify the uploaded evidence, then resolve the case with a documented outcome."
            right={<Badge tone="muted">{counts.total} total</Badge>}
          />
        </div>

        {cases.length === 0 ? (
          <div style={{ padding: 20 }}>
            <EmptyState title="No grievances against this facility yet" hint="New submissions appear here as soon as a patient files against your facility." />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Complainant</th>
                  <th>Category</th>
                  <th>Priority</th>
                  <th>Verification</th>
                  <th>Status</th>
                  <th>SLA</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {cases.map((row) => {
                  const sla = slaCountdown(row.slaDueAt);
                  const pending = row.pendingDocuments;
                  const closed = row.status === "RESOLVED" || row.status === "REJECTED";
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link to={`/admin/cases/${row.id}`} className="mono strong">{row.id}</Link>
                        <div className="cell-sub">{formatDate(row.createdAt)} · {timeAgo(row.createdAt)}</div>
                      </td>
                      <td>
                        <div>{row.patientName}</div>
                        <div className="cell-sub">{row.patientEmail}</div>
                      </td>
                      <td>{row.category}</td>
                      <td><PriorityBadge priority={row.priority} /></td>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          <VerificationBadge status={row.verificationStatus} />
                          {pending > 0 && <Badge tone="warn">{pending} to review</Badge>}
                        </div>
                        <div className="cell-sub">{row.documentCount} document(s)</div>
                      </td>
                      <td><StatusBadge status={row.status} /></td>
                      <td className="nowrap">
                        <span className={sla.overdue && !closed ? "text-danger" : ""}>{closed ? "—" : sla.text}</span>
                        <div className="cell-sub">{row.resolvedAt ? `Resolved ${timeAgo(row.resolvedAt)}` : `Due ${formatDate(row.slaDueAt, { hour: "2-digit", minute: "2-digit" })}`}</div>
                      </td>
                      <td className="right nowrap">
                        {pending > 0 && (
                          <button className="btn sm primary" onClick={() => openReview(row)}>
                            <Icon name="check" size={14} /> Verify
                          </button>
                        )}
                        {!closed && (
                          <button className="btn sm ghost" style={{ marginLeft: 6 }} onClick={() => openResolve(row)}>
                            Resolve
                          </button>
                        )}
                        <Link to={`/admin/cases/${row.id}`} className="btn sm ghost" style={{ marginLeft: 6 }}>Open</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {modal?.kind === "review" && (
        <Modal
          title={`Verify evidence · ${modal.caseRow.id}`}
          sub="Approving every document moves the bundle to verified and releases it to the health authority."
          onClose={() => setModal(null)}
        >
          <div className="stack" style={{ gap: 10 }}>
            {modal.caseRow.documents
              .filter((d) => d.verificationStatus === "PENDING_MANUAL_REVIEW")
              .map((doc) => (
                <DocumentDecision
                  key={doc.id}
                  doc={doc}
                  value={modal.decisions[doc.id] ?? "APPROVE"}
                  onChange={(decision) => setModal({ ...modal, decisions: { ...modal.decisions, [doc.id]: decision } })}
                />
              ))}
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="review-note">Review rationale</label>
            <textarea
              id="review-note"
              className="input"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What did you check, and why is this evidence acceptable or not?"
            />
            <span className="hint">Recorded in the review history and the tamper-evident audit chain.</span>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={() => void submitReview(modal)}>
              {busy ? <span className="spinner" /> : "Submit decision"}
            </button>
          </div>
        </Modal>
      )}

      {modal?.kind === "resolve" && (
        <Modal
          title={`Resolve ${modal.caseRow.id}`}
          sub="Closes the case against this facility and records the outcome for the patient and the authority."
          onClose={() => setModal(null)}
        >
          <div className="field">
            <label htmlFor="resolve-outcome">Outcome (optional)</label>
            <input
              id="resolve-outcome"
              className="input"
              value={modal.outcome}
              onChange={(e) => setModal({ ...modal, outcome: e.target.value })}
              placeholder="e.g. Billing corrected and refunded"
            />
          </div>
          <div className="field">
            <label htmlFor="resolve-note">Resolution note</label>
            <textarea
              id="resolve-note"
              className="input"
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What was investigated, what changed and what the patient was told."
            />
            <span className="hint">At least 10 characters. Stored with your account in the review history.</span>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={() => void submitResolve(modal)}>
              {busy ? <span className="spinner" /> : "Resolve case"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DocumentDecision({
  doc,
  value,
  onChange,
}: {
  doc: DocumentDto;
  value: "APPROVE" | "REJECT";
  onChange: (decision: "APPROVE" | "REJECT") => void;
}) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row-between" style={{ gap: 10 }}>
        <div>
          <div className="strong">{doc.filename}</div>
          <div className="cell-sub">
            {doc.kind} · {bytes(doc.size)} · integrity score {doc.score}/100 · uploaded {timeAgo(doc.uploadedAt)}
          </div>
        </div>
        <Badge tone="warn">{statusLabel(doc.verificationStatus)}</Badge>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button
          className={`btn sm ${value === "APPROVE" ? "primary" : "ghost"}`}
          onClick={() => onChange("APPROVE")}
          type="button"
        >
          <Icon name="check" size={13} /> Accept
        </button>
        <button
          className={`btn sm ${value === "REJECT" ? "danger" : "ghost"}`}
          onClick={() => onChange("REJECT")}
          type="button"
        >
          <Icon name="x" size={13} /> Reject
        </button>
      </div>
    </div>
  );
}
