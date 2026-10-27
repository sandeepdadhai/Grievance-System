import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { Alert, Icon } from "../components/ui";

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "", country: "US" });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strong =
    form.password.length >= 12 && /[A-Z]/.test(form.password) && /[a-z]/.test(form.password) && /[0-9]/.test(form.password) && /[^A-Za-z0-9]/.test(form.password);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!strong) {
      setError("Use at least 12 characters with uppercase, lowercase, a digit and a symbol.");
      return;
    }
    if (form.password !== form.confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (!consent) {
      setError("Please confirm the processing notice to continue.");
      return;
    }
    setBusy(true);
    try {
      await signup({ name: form.name, email: form.email, password: form.password, country: form.country });
      navigate("/portal", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <Link to="/" className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">MN</span>
          <span>
            <span className="brand-name">MedNotice</span>
            <span className="brand-sub" style={{ display: "block" }}>Global</span>
          </span>
        </Link>
        <div style={{ maxWidth: 440 }}>
          <h1 style={{ fontSize: "2rem", marginBottom: 12 }}>Every grievance in one place.</h1>
          <p className="muted" style={{ fontSize: 13.5 }}>
            A patient account keeps your cases, documents and authority replies together, so you never have to save an
            access code. Guest submissions remain available if you prefer to stay anonymous.
          </p>
          <div className="assurance">
            {[
              ["One workspace", "Track every case, download documents and follow the authority's response."],
              ["Encrypted at rest", "Narratives and uploads are protected with AES-256-GCM field encryption."],
              ["DPDP-aligned", "Consent is recorded, access is logged and you can ask for erasure after the retention period."],
            ].map(([title, body]) => (
              <div className="assurance-item" key={title}>
                <span className="assurance-check"><Icon name="check" size={11} /></span>
                <span><strong>{title}</strong>{body}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="tiny faint">Synthetic demonstration environment · no real patient data</p>
      </aside>

      <main className="auth-main">
        <div className="auth-card fade-in">
          <h1>Create a patient account</h1>
          <p>Free, takes a minute, and only for patients. Staff accounts are provisioned by an administrator.</p>
          {error && <Alert tone="error">{error}</Alert>}
          <form onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input id="name" className="input" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="As it appears on your records" required />
            </div>
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input id="email" className="input" type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" required />
            </div>
            <div className="field">
              <label htmlFor="country">Country of treatment</label>
              <select id="country" className="select" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
                {[
                  ["US", "United States"],
                  ["DE", "Germany"],
                  ["GB", "United Kingdom"],
                  ["IN", "India"],
                  ["SG", "Singapore"],
                  ["BR", "Brazil"],
                ].map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
              <span className="hint">Sets the jurisdiction and SLA matrix applied to your grievances.</span>
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="12+ characters" required />
              <span className="hint">At least 12 characters, with uppercase, lowercase, a digit and a symbol.</span>
            </div>
            <div className="field">
              <label htmlFor="confirm">Confirm password</label>
              <input id="confirm" className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required />
            </div>
            <label className="check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                I agree to MedNotice-Global processing my grievance data under the DPDP Act 2023 to route and resolve complaints.
                I understand documents are shared only with the selected health authority.
              </span>
            </label>
            <button className="btn primary block" type="submit" disabled={busy || !consent}>
              {busy ? <span className="spinner" /> : "Create account"}
            </button>
          </form>
          <p className="tiny faint" style={{ marginTop: 16 }}>
            Already registered? <Link to="/login">Sign in</Link>. Prefer to stay anonymous? <Link to="/submit">File as a guest</Link>.
          </p>
        </div>
      </main>
    </div>
  );
}
