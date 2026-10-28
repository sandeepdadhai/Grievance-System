import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, bytes, formatDate } from "../api";
import { useAuth } from "../auth";
import type { CaseDto, Facility, Jurisdiction } from "../types";
import { Alert, Badge, Card, Icon, PriorityBadge, Spinner, VerificationBadge } from "../components/ui";

type PreScreen = {
  file: File;
  kind: string;
  declared: string;
  magicOk: boolean;
  sha: string;
  notes: string[];
};

type SubmissionResult = {
  case: CaseDto;
  accessCode: string | null;
  transmission: { adapterCode: string; status: string; latencyMs: number; simulated: boolean; ackId: string | null } | null;
  bundleReason: string;
  verification: { status: string; documents: Array<{ filename: string; status: string; score: number }> };
};

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.dcm,application/pdf,image/jpeg,image/png,application/dicom,text/plain";

/**
 * Advisory digest for the client-side pre-screen.
 *
 * `crypto.subtle` only exists in a secure context (HTTPS or localhost). On a
 * plain-HTTP deployment the whole upload handler used to throw here, so chosen
 * files never entered the form and the drop zone appeared to do nothing. The
 * digest is skipped when SubtleCrypto is unavailable; the server always
 * recomputes the authoritative SHA-256 after upload.
 */
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return "";
  try {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

async function preScreen(file: File): Promise<PreScreen> {
  const head = new Uint8Array(await file.slice(0, 160).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  let kind = "UNKNOWN";
  if (ascii(0, 5) === "%PDF-") kind = "PDF";
  else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) kind = "JPEG";
  else if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") kind = "PNG";
  else if (ascii(128, 132) === "DICM") kind = "DICOM";

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const declared = ext === "pdf" ? "PDF" : ["jpg", "jpeg"].includes(ext) ? "JPEG" : ext === "png" ? "PNG" : ext === "dcm" ? "DICOM" : file.type || "UNKNOWN";
  const magicOk = kind !== "UNKNOWN" && (declared === "UNKNOWN" || kind === declared);
  const notes: string[] = [];
  if (!magicOk && kind !== "DICOM") notes.push(`Header reads ${kind}, extension expects ${declared}`);
  if (file.size < 1024) notes.push("Suspiciously small file");
  if (file.size > 10 * 1024 * 1024) notes.push("Large upload — may be rejected");
  if (kind === "PDF" && declared !== "PDF") notes.push("PDF content in a non-PDF file");

  const sha = await sha256Hex(await file.arrayBuffer());
  return { file, kind, declared, magicOk, sha, notes };
}

const STEP_LABELS = ["Location", "Grievance", "Documents", "Review"];

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  hi: "हिन्दी (Hindi)",
  mr: "मराठी (Marathi)",
  kn: "ಕನ್ನಡ (Kannada)",
  ta: "தமிழ் (Tamil)",
  bn: "বাংলা (Bengali)",
};

export default function Submit() {
  const { user, refresh } = useAuth();
  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[]>([]);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [step, setStep] = useState(1);
  const [country, setCountry] = useState("");
  const [authorityId, setAuthorityId] = useState("");
  const [facilityId, setFacilityId] = useState("");
  const [category, setCategory] = useState("");
  const [language, setLanguage] = useState("en");
  const [complaint, setComplaint] = useState("");
  const [symptoms, setSymptoms] = useState("");
  const [incidentDate, setIncidentDate] = useState("");
  const [timeline, setTimeline] = useState<Array<{ date: string; event: string }>>([]);
  const [patientName, setPatientName] = useState(user?.role === "PATIENT" ? user.name : "");
  const [patientEmail, setPatientEmail] = useState(user?.role === "PATIENT" ? user.email : "");
  const [patientPhone, setPatientPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [crossBorder, setCrossBorder] = useState(false);
  const [files, setFiles] = useState<PreScreen[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [aadhaar, setAadhaar] = useState("");
  const [aadhaarCode, setAadhaarCode] = useState("");
  const [aadhaarChallenge, setAadhaarChallenge] = useState<{ id: string; devCode: string | null; masked: string; sentTo: string } | null>(null);
  const [aadhaarBusy, setAadhaarBusy] = useState(false);
  const [aadhaarError, setAadhaarError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isPatient = user?.baseRole === "PATIENT";
  const aadhaarVerified = Boolean(user?.aadhaar?.verified);

  const jurisdiction = useMemo(() => jurisdictions.find((j) => j.code === country), [jurisdictions, country]);
  const authority = useMemo(() => jurisdiction?.authorities.find((a) => a.id === authorityId), [jurisdiction, authorityId]);

  useEffect(() => {
    api.get<{ jurisdictions: Jurisdiction[] }>("/api/public/jurisdictions").then((r) => {
      setJurisdictions(r.jurisdictions);
      if (r.jurisdictions[0]) {
        setCountry(r.jurisdictions[0].code);
        setLanguage(r.jurisdictions[0].languages[0] ?? "en");
      }
    }).catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    if (user?.role === "PATIENT") {
      setPatientName(user.name);
      setPatientEmail(user.email);
    }
  }, [user]);

  useEffect(() => {
    if (!authorityId) {
      setFacilities([]);
      return;
    }
    api.get<{ facilities: Facility[] }>(`/api/public/facilities?authority=${encodeURIComponent(authorityId)}`)
      .then((r) => setFacilities(r.facilities))
      .catch(() => setFacilities([]));
    setFacilityId("");
  }, [authorityId]);

  function selectCountry(code: string) {
    const next = jurisdictions.find((j) => j.code === code);
    setCountry(code);
    setAuthorityId(next?.authorities[0]?.id ?? "");
    setFacilityId("");
    setCategory("");
    setLanguage(next?.languages[0] ?? "en");
  }

  async function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).slice(0, 8 - files.length);
    setError(null);
    const screened: PreScreen[] = [];
    for (const file of incoming) {
      if (file.size > 12 * 1024 * 1024) {
        setError(`${file.name} exceeds the 12 MB per-document limit.`);
        continue;
      }
      if (files.some((f) => f.file.name === file.name && f.file.size === file.size)) continue;
      screened.push(await preScreen(file));
    }
    const dupes = screened.filter((f) => f.sha && files.some((existing) => existing.sha === f.sha));
    if (dupes.length) setError(`${dupes.map((d) => d.file.name).join(", ")} duplicates a document already attached.`);
    setFiles([...files, ...screened.filter((f) => !dupes.includes(f))]);
  }

  async function requestAadhaarOtp() {
    setAadhaarBusy(true);
    setAadhaarError(null);
    try {
      const res = await api.post<{ challengeId: string; masked: string; sentTo: string; devCode: string | null }>(
        "/api/auth/aadhaar/request",
        { aadhaar },
      );
      setAadhaarChallenge({ id: res.challengeId, devCode: res.devCode, masked: res.masked, sentTo: res.sentTo });
      setAadhaarCode("");
    } catch (err) {
      setAadhaarError((err as Error).message);
    } finally {
      setAadhaarBusy(false);
    }
  }

  async function confirmAadhaar() {
    if (!aadhaarChallenge) return;
    setAadhaarBusy(true);
    setAadhaarError(null);
    try {
      await api.post("/api/auth/aadhaar/verify", { challengeId: aadhaarChallenge.id, code: aadhaarCode });
      await refresh();
      setAadhaarChallenge(null);
      setAadhaar("");
      setAadhaarCode("");
    } catch (err) {
      setAadhaarError((err as Error).message);
    } finally {
      setAadhaarBusy(false);
    }
  }

  function canContinue(): boolean {
    if (step === 1) return Boolean(country && authorityId && facilityId && category);
    if (step === 2) return complaint.trim().length >= 40;
    if (step === 3) return Boolean(patientName.trim() && /.+@.+\..+/.test(patientEmail) && consent && (!isPatient || aadhaarVerified));
    return true;
  }

  function next() {
    if (!canContinue()) {
      setError(
        step === 1
          ? "Select a state, health authority, facility and category."
          : step === 2
            ? "Describe the grievance in at least 40 characters."
            : isPatient && !aadhaarVerified
              ? "Verify your Aadhaar number first — it is required for patient submissions."
              : "Provide a name, a valid email address and consent to proceed.",
      );
      return;
    }
    setError(null);
    setStep(Math.min(4, step + 1));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("country", country);
      form.set("authorityId", authorityId);
      form.set("facilityId", facilityId);
      form.set("category", category);
      form.set("language", language);
      form.set("complaint", complaint);
      form.set("symptoms", symptoms);
      form.set("incidentDate", incidentDate);
      form.set("timeline", JSON.stringify(timeline.filter((t) => t.event.trim())));
      form.set("patientName", patientName);
      form.set("patientEmail", patientEmail);
      form.set("patientPhone", patientPhone);
      form.set("consentDataSharing", consent ? "true" : "false");
      form.set("crossBorderAllowed", crossBorder ? "true" : "false");
      for (const f of files) form.append("documents", f.file, f.file.name);
      const res = await api.post<SubmissionResult>("/api/cases", form);
      setResult(res);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const rejected = result.verification.status === "REJECTED";
    const pending = result.verification.status === "PENDING_MANUAL_REVIEW";
    return (
      <section className="section" style={{ maxWidth: 860 }}>
        <div className="fade-in stack">
          <Card>
            <div className="row-between">
              <div>
                <span className="eyebrow" style={{ marginBottom: 10 }}>Submission received</span>
                <h1 style={{ fontSize: "1.9rem" }}>{result.case.id}</h1>
                <p className="muted small" style={{ marginTop: 6 }}>
                  {result.case.facilityName} · {result.case.country} · {formatDate(result.case.createdAt)}
                </p>
              </div>
              <PriorityBadge priority={result.case.priority} />
            </div>

            {rejected && (
              <div style={{ marginTop: 16 }}>
                <Alert tone="error">
                  <strong>Documents rejected as inauthentic.</strong> The case is logged for investigation but cannot be routed to
                  the health authority until a reviewer accepts the evidence. Reason: {result.bundleReason}
                </Alert>
              </div>
            )}
            {pending && (
              <div style={{ marginTop: 16 }}>
                <Alert tone="warn">
                  <strong>Held for manual verification.</strong> One or more documents triggered tamper or registry signals. A
                  compliance reviewer will assess the bundle before routing.
                </Alert>
              </div>
            )}
            {!rejected && !pending && (
              <div style={{ marginTop: 16 }}>
                <Alert tone="success">
                  <strong>Verified and {result.transmission?.status === "DELIVERED" ? "routed" : "accepted"}.</strong>{" "}
                  {result.transmission
                    ? `Delivered to ${result.transmission.adapterCode} in ${result.transmission.latencyMs} ms${result.transmission.simulated ? " (sandbox endpoint)" : ""}.`
                    : "The case is queued for routing."}
                </Alert>
              </div>
            )}

            {result.accessCode && (
              <div style={{ marginTop: 18, border: "1px solid rgba(255,171,74,0.35)", background: "var(--warn-soft)", borderRadius: 12, padding: 16 }}>
                <div className="label" style={{ color: "#ffd7a3", marginBottom: 6 }}>Save your access code</div>
                <div className="row" style={{ gap: 12 }}>
                  <span className="mono" style={{ fontSize: 20, letterSpacing: "0.12em", color: "#ffe6c2" }}>{result.accessCode}</span>
                  <button
                    className="btn sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(result.accessCode ?? "");
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? <><Icon name="check" size={13} /> Copied</> : "Copy"}
                  </button>
                </div>
                <p className="tiny" style={{ marginTop: 8, color: "#ffd7a3" }}>
                  This code is shown once and cannot be recovered. You need it together with the case reference to track the case.
                </p>
              </div>
            )}

            <div className="divider" />
            <div className="meta-grid">
              <div className="meta-item"><dt>Priority</dt><dd>{result.case.priority} · score {result.case.priorityScore}/100</dd></div>
              <div className="meta-item"><dt>Category</dt><dd>{result.case.category}</dd></div>
              <div className="meta-item"><dt>Verification</dt><dd><VerificationBadge status={result.verification.status} /></dd></div>
              <div className="meta-item"><dt>Authority</dt><dd>{result.case.authorityId}</dd></div>
            </div>

            {result.case.triage?.signals?.length > 0 && (
              <>
                <div className="divider" />
                <h3 style={{ fontSize: "0.92rem", marginBottom: 8 }}>Why this priority was assigned</h3>
                <div className="row" style={{ gap: 6 }}>
                  {result.case.triage.signals.slice(0, 6).map((s) => <span className="chip" key={s.code}>{s.label} <span className="mono faint">+{s.weight}</span></span>)}
                </div>
                <p className="tiny faint" style={{ marginTop: 10 }}>
                  SLA clock: response due {formatDate(result.case.slaDueAt)} · {result.case.triage.regulatoryBasis?.slice(0, 2).join(" · ")}
                </p>
              </>
            )}
          </Card>

          <Card>
            <div className="card-head"><h3>Document verification</h3><span className="card-sub">{result.verification.documents.length} file(s)</span></div>
            {result.verification.documents.length === 0 && <p className="small muted">No supporting documents were attached. The case was triaged on the narrative alone.</p>}
            <div className="stack" style={{ gap: 10 }}>
              {result.verification.documents.map((d) => (
                <div key={d.filename} className="row-between" style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px" }}>
                  <div><div className="file-name">{d.filename}</div><div className="file-meta">Automated trust score {d.score}/100</div></div>
                  <VerificationBadge status={d.status} />
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="card-head"><h3>What happens next</h3></div>
            <div className="timeline">
              {[
                { title: "Automated verification & triage", meta: "Completed", body: "Document forensics, field extraction, priority scoring and category assignment." },
                pending || rejected
                  ? { title: "Manual compliance review", meta: "Next", body: "A reviewer inspects flagged documents, may request originals and can override the triage." }
                  : { title: "Authority acknowledgement", meta: "Next", body: "The receiving authority assigns an investigator and acknowledges the case through the adapter." },
                { title: "Resolution & outcome", meta: "Tracked", body: "Status changes are captured in the timeline and mirrored in the audit chain." },
              ].map((item) => (
                <div className="timeline-item" key={item.title}>
                  <span className="timeline-dot" />
                  <div>
                    <div className="timeline-title">{item.title}</div>
                    <div className="timeline-meta">{item.meta}</div>
                    <div className="timeline-body">{item.body}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="row" style={{ gap: 10, marginTop: 8 }}>
              <Link to={`/track?case=${result.case.id}`} className="btn primary">Track this case</Link>
              <Link to="/" className="btn ghost">Back to home</Link>
              {!result.accessCode && <Link to={`/cases/${result.case.id}`} className="btn">Open in portal</Link>}
            </div>
          </Card>
        </div>
      </section>
    );
  }

  return (
    <section className="section" style={{ maxWidth: 1080 }}>
      <div className="section-head">
        <span className="eyebrow">New grievance</span>
        <h2>Tell us what happened</h2>
        <p>The form is configured for India. The selected state and facility determine which authority receives the case; documents are screened before they reach it.</p>
      </div>

      <div className="steps">
        {STEP_LABELS.map((label, i) => (
          <div key={label} className={`step ${step === i + 1 ? "active" : step > i + 1 ? "done" : ""}`}>
            <span className="step-num">{step > i + 1 ? <Icon name="check" size={10} /> : i + 1}</span>
            {label}
          </div>
        ))}
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {step === 1 && (
        <div className="stack fade-in">
          <Card>
            <div className="card-head"><h3>Location</h3><span className="card-sub">Where in India did the treatment take place?</span></div>
            <div className="grid-3">
              {jurisdictions.map((j) => (
                <button
                  key={j.code}
                  type="button"
                  onClick={() => selectCountry(j.code)}
                  className="card"
                  style={{
                    textAlign: "left",
                    cursor: "pointer",
                    borderColor: country === j.code ? "rgba(45,212,191,0.55)" : "var(--line)",
                    background: country === j.code ? "rgba(45,212,191,0.07)" : undefined,
                    padding: 14,
                  }}
                >
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontSize: 18 }} aria-hidden>{j.flag}</span>
                    <strong style={{ fontSize: 13.5 }}>{j.name}</strong>
                  </div>
                  <div className="tiny faint" style={{ marginTop: 6 }}>{j.regulator}</div>
                  <div className="tiny faint" style={{ marginTop: 3 }}>{j.authorities.length} authorities · P1 SLA {j.slaHours.P1}h</div>
                </button>
              ))}
            </div>
            {!jurisdictions.length && <Spinner label="Loading jurisdictions…" />}
          </Card>

          <Card>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="authority">Health authority</label>
                <select id="authority" className="select" value={authorityId} onChange={(e) => setAuthorityId(e.target.value)} disabled={!jurisdiction}>
                  <option value="">Select authority…</option>
                  {jurisdiction?.authorities.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.region}</option>)}
                </select>
                <span className="hint">{authority ? `Routes through ${authority.adapter}` : "The authority determines the routing adapter."}</span>
              </div>
              <div className="field">
                <label htmlFor="facility">Facility</label>
                <select id="facility" className="select" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} disabled={!facilities.length}>
                  <option value="">{facilities.length ? "Select facility…" : "Select an authority first"}</option>
                  {facilities.map((f) => <option key={f.id} value={f.id}>{f.name}{f.city ? ` · ${f.city}` : ""}</option>)}
                </select>
                <span className="hint">Only registered facilities are accepted for this authority.</span>
              </div>
              <div className="field">
                <label htmlFor="category">Complaint category</label>
                <select id="category" className="select" value={category} onChange={(e) => setCategory(e.target.value)} disabled={!jurisdiction}>
                  <option value="">Select category…</option>
                  {jurisdiction?.complaintCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <span className="hint">The final category is assigned by the triage engine; your selection is a prior.</span>
              </div>
              <div className="field">
                <label htmlFor="language">Preferred language</label>
                <select id="language" className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {jurisdiction?.languages.map((l) => <option key={l} value={l}>{LANGUAGE_LABELS[l] ?? l.toUpperCase()}</option>)}
                </select>
                <span className="hint">Notifications and authority payloads include this preference.</span>
              </div>
            </div>
            {jurisdiction && (
              <div className="row" style={{ gap: 6 }}>
                {jurisdiction.frameworks.map((f) => <Badge tone="info" key={f}>{f}</Badge>)}
                {jurisdiction.crossBorderRestricted && <Badge tone="warn"><Icon name="lock" size={11} /> Identifiers masked in outbound payloads</Badge>}
              </div>
            )}
          </Card>

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn primary" onClick={next}>Continue <Icon name="arrow" size={15} /></button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="stack fade-in">
          <Card>
            <div className="card-head"><h3>What happened?</h3><span className="card-sub">Be specific — the triage engine reads this narrative</span></div>
            <div className="field">
              <label htmlFor="complaint">Grievance narrative</label>
              <textarea
                id="complaint"
                className="textarea"
                style={{ minHeight: 170 }}
                value={complaint}
                maxLength={20000}
                onChange={(e) => setComplaint(e.target.value)}
                placeholder="Describe the care you received, what went wrong, who was involved and what happened as a result…"
              />
              <span className="hint">{complaint.trim().length}/40 minimum · {complaint.length}/20000</span>
            </div>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="symptoms">Symptoms / clinical description</label>
                <textarea id="symptoms" className="textarea" style={{ minHeight: 96 }} value={symptoms} maxLength={5000} onChange={(e) => setSymptoms(e.target.value)} placeholder="Pain, deterioration, medication reactions…" />
              </div>
              <div className="field">
                <label htmlFor="incidentDate">Date of incident</label>
                <input id="incidentDate" type="date" className="input" value={incidentDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setIncidentDate(e.target.value)} />
                <span className="hint">Recent incidents receive additional urgency weighting.</span>
              </div>
            </div>
          </Card>

          <Card>
            <div className="card-head">
              <h3>Timeline of events</h3>
              <button
                className="btn sm"
                type="button"
                onClick={() => setTimeline([...timeline, { date: new Date().toISOString().slice(0, 10), event: "" }])}
              >
                <Icon name="plus" size={13} /> Add event
              </button>
            </div>
            {timeline.length === 0 && <p className="small muted">Optional. Add key moments: admission, procedure, discharge, complaint escalation.</p>}
            <div className="stack" style={{ gap: 10 }}>
              {timeline.map((entry, index) => (
                <div key={index} className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                  <input
                    className="input"
                    type="date"
                    style={{ maxWidth: 170 }}
                    value={entry.date}
                    onChange={(e) => setTimeline(timeline.map((t, i) => (i === index ? { ...t, date: e.target.value } : t)))}
                  />
                  <input
                    className="input"
                    placeholder="What happened on this date?"
                    value={entry.event}
                    onChange={(e) => setTimeline(timeline.map((t, i) => (i === index ? { ...t, event: e.target.value } : t)))}
                  />
                  <button className="btn ghost icon-btn" type="button" aria-label="Remove event" onClick={() => setTimeline(timeline.filter((_, i) => i !== index))}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </Card>

          <div className="row-between">
            <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn primary" onClick={next}>Continue <Icon name="arrow" size={15} /></button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="stack fade-in">
          <Card>
            <div className="card-head"><h3>Supporting documents</h3><span className="card-sub">Optional · max 8 files · 12 MB each</span></div>
            <div
              className={`dropzone ${dragging ? "drag" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void addFiles(e.dataTransfer.files);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
            >
              <Icon name="upload" size={24} />
              <strong style={{ marginTop: 8 }}>Drop medical records here or browse</strong>
              <span>Discharge summaries, prescriptions, lab results, bills, DICOM metadata reports</span>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <p className="upload-note">
              Files are encrypted with AES-256-GCM before being written to storage. The client pre-screen below is advisory; the
              server performs authoritative PDF/image forensics, licence checks and duplicate detection.
            </p>

            <div className="file-list">
              {files.map((f, index) => (
                <div className="file-row" key={`${f.file.name}-${index}`}>
                  <span className="file-icon">{f.kind === "UNKNOWN" ? "?" : f.kind.slice(0, 4)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="file-name">{f.file.name}</div>
                    <div className="file-meta">{bytes(f.file.size)}{f.sha ? ` · sha256 ${f.sha.slice(0, 12)}…` : " · hashed on the server"}</div>
                    {f.notes.length > 0 && (
                      <div className="row" style={{ gap: 5, marginTop: 5 }}>
                        {f.notes.map((n) => <span className="chip" key={n} style={{ color: "#ffca8c", borderColor: "rgba(255,171,74,0.3)" }}>{n}</span>)}
                      </div>
                    )}
                  </div>
                  <Badge tone={f.magicOk ? "ok" : "warn"}>{f.magicOk ? "Header OK" : "Check format"}</Badge>
                  <button className="btn ghost icon-btn" type="button" aria-label={`Remove ${f.file.name}`} onClick={() => setFiles(files.filter((_, i) => i !== index))}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </Card>

          {isPatient && (
            <Card>
              <div className="card-head">
                <h3>Aadhaar verification</h3>
                <span className="card-sub">{aadhaarVerified ? "Verified" : "Required before a patient grievance is accepted"}</span>
              </div>
              {aadhaarVerified ? (
                <Alert tone="success">
                  <strong>Aadhaar verified.</strong> {user?.aadhaar?.masked} was confirmed with a one-time password sent to your
                  registered mobile number. Only the masked form is ever displayed.
                </Alert>
              ) : (
                <div className="stack" style={{ gap: 12 }}>
                  <p className="small muted" style={{ margin: 0 }}>
                    Patient submissions must be tied to a verified identity. We check the Aadhaar number structurally, then send a
                    one-time password to the mobile number on your account. The number is stored AES-256-GCM encrypted and is never
                    sent to the health authority.
                  </p>
                  {aadhaarError && <Alert tone="error">{aadhaarError}</Alert>}
                  {!aadhaarChallenge ? (
                    <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                      <input
                        className="input"
                        style={{ maxWidth: 280 }}
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="12-digit Aadhaar number"
                        value={aadhaar}
                        onChange={(e) => setAadhaar(e.target.value)}
                      />
                      <button
                        className="btn primary"
                        type="button"
                        disabled={aadhaarBusy || aadhaar.replace(/\D/g, "").length !== 12}
                        onClick={() => void requestAadhaarOtp()}
                      >
                        {aadhaarBusy ? <span className="spinner" /> : "Send verification code"}
                      </button>
                    </div>
                  ) : (
                    <div className="stack" style={{ gap: 10 }}>
                      <p className="small" style={{ margin: 0 }}>
                        Code sent to <strong className="mono">{aadhaarChallenge.sentTo}</strong> for {aadhaarChallenge.masked}. It
                        expires in five minutes and can be used once.
                      </p>
                      {aadhaarChallenge.devCode && (
                        <Alert tone="warn">
                          SMS gateway not configured — simulation mode. Your code is{" "}
                          <strong className="mono">{aadhaarChallenge.devCode}</strong>.
                        </Alert>
                      )}
                      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                        <input
                          className="input"
                          style={{ maxWidth: 190 }}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="6-digit code"
                          value={aadhaarCode}
                          onChange={(e) => setAadhaarCode(e.target.value)}
                        />
                        <button className="btn primary" type="button" disabled={aadhaarBusy || aadhaarCode.length < 4} onClick={() => void confirmAadhaar()}>
                          {aadhaarBusy ? <span className="spinner" /> : "Verify Aadhaar"}
                        </button>
                        <button
                          className="btn ghost"
                          type="button"
                          disabled={aadhaarBusy}
                          onClick={() => {
                            setAadhaarChallenge(null);
                            setAadhaarCode("");
                          }}
                        >
                          Start over
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}

          <Card>
            <div className="card-head"><h3>Your details</h3><span className="card-sub">Stored encrypted · shared only with the selected authority</span></div>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="patientName">Full name</label>
                <input id="patientName" className="input" value={patientName} onChange={(e) => setPatientName(e.target.value)} placeholder="Patient or complainant name" />
              </div>
              <div className="field">
                <label htmlFor="patientEmail">Email</label>
                <input id="patientEmail" type="email" className="input" value={patientEmail} onChange={(e) => setPatientEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="field full">
                <label htmlFor="patientPhone">Phone (optional)</label>
                <input id="patientPhone" className="input" value={patientPhone} onChange={(e) => setPatientPhone(e.target.value)} placeholder="+91 98100 01000" />
              </div>
            </div>
            <div className="divider" />
            <label className="check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                I consent to MedNotice India processing this grievance and its attachments, verifying documents with the NMC
                registration registry, and transmitting the case to <strong>{authority?.name ?? "the selected authority"}</strong>{" "}
                under the Digital Personal Data Protection Act 2023 and the Charter of Patients' Rights.
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={crossBorder} onChange={(e) => setCrossBorder(e.target.checked)} />
              <span>
                I additionally consent to my case being shared with the National Health Authority or MoHFW where a national scheme
                or escalated review requires it. Identifiers are masked in outbound payloads unless a reviewer has a lawful basis
                to see them.
              </span>
            </label>
          </Card>

          <div className="row-between">
            <button className="btn ghost" onClick={() => setStep(2)}>Back</button>
            <button className="btn primary" onClick={next}>Review submission <Icon name="arrow" size={15} /></button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="stack fade-in">
          <Card>
            <div className="card-head"><h3>Review</h3><span className="card-sub">Nothing is transmitted until you submit</span></div>
            <div className="meta-grid">
              <div className="meta-item"><dt>State / authority</dt><dd>{authority?.region} · {jurisdiction?.flag} {jurisdiction?.name}</dd></div>
              <div className="meta-item"><dt>Authority</dt><dd>{authority?.name}</dd></div>
              <div className="meta-item"><dt>Facility</dt><dd>{facilities.find((f) => f.id === facilityId)?.name}</dd></div>
              <div className="meta-item"><dt>Category</dt><dd>{category}</dd></div>
              <div className="meta-item"><dt>Language</dt><dd>{language.toUpperCase()}</dd></div>
              <div className="meta-item"><dt>Documents</dt><dd>{files.length}</dd></div>
              <div className="meta-item"><dt>Incident date</dt><dd>{incidentDate || "not provided"}</dd></div>
              <div className="meta-item"><dt>Adapter</dt><dd className="mono">{authority?.adapter}</dd></div>
            </div>
            <div className="divider" />
            <h3 style={{ fontSize: "0.92rem", marginBottom: 6 }}>Narrative</h3>
            <p className="narrative" style={{ fontSize: 13 }}>{complaint}</p>
            {symptoms && <><div className="divider" /><h3 style={{ fontSize: "0.92rem", marginBottom: 6 }}>Symptoms</h3><p className="narrative" style={{ fontSize: 13 }}>{symptoms}</p></>}
            <div className="divider" />
            <div className="kv">
              <dt>Complainant</dt><dd>{patientName} · {patientEmail}</dd>
              <dt>Consent</dt><dd>{consent ? "Granted" : "Missing"}</dd>
              <dt>Cross-border</dt><dd>{crossBorder ? "Allowed" : "Masked identifiers"}</dd>
            </div>
          </Card>

          <div className="row-between">
            <button className="btn ghost" onClick={() => setStep(3)}>Back</button>
            <button className="btn primary" onClick={() => void submit()} disabled={busy || !consent}>
              {busy ? <><span className="spinner" /> Verifying & routing…</> : <>Submit grievance <Icon name="arrow" size={15} /></>}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
