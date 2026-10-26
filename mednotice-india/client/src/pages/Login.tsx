import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import { Alert, Icon } from "../components/ui";

const DEMOS = [
  { email: "admin@mednotice.in", password: "Admin!2345", label: "Super Administrator", org: "MedNotice India" },
  { email: "reviewer@mohfw.gov.in", password: "Review!2345", label: "Ministry Reviewer", org: "India · MoHFW" },
  { email: "compliance@aiims.edu", password: "Comply!2345", label: "Hospital Compliance", org: "India · AIIMS" },
  { email: "facility.aiims@mednotice.in", password: "Facility!2345", label: "Facility officer", org: "AIIMS New Delhi" },
  { email: "facility.kem@mednotice.in", password: "Facility!2345", label: "Facility officer", org: "KEM Mumbai" },
  { email: "auditor@mednotice.in", password: "Audit!2345", label: "System Auditor", org: "Read-only" },
  { email: "patient@demo.in", password: "Patient!2345", label: "Patient", org: "India · demo patient" },
];

export default function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const destination = (baseRole: string) => {
    const next = params.get("next");
    if (next && !next.startsWith("/login")) return next;
    return baseRole !== "PATIENT" ? "/admin" : "/portal";
  };

  useEffect(() => {
    if (user) navigate(destination(user.baseRole), { replace: true });
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  async function signIn(nextEmail: string, nextPassword: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await login(nextEmail, nextPassword);
      navigate(destination(next.baseRole), { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void signIn(email, password);
  }

  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <Link to="/" className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">MN</span>
          <span>
            <span className="brand-name">MedNotice</span>
            <span className="brand-sub" style={{ display: "block" }}>India</span>
          </span>
        </Link>
        <div style={{ maxWidth: 430 }}>
          <h1 style={{ fontSize: "2rem", marginBottom: 12 }}>A single case file, from patient to regulator.</h1>
          <p className="muted" style={{ fontSize: 13.5 }}>
            Role-scoped access keeps patient narratives, verification evidence and routing payloads visible only to the people
            accountable for them.
          </p>
          <div className="assurance">
            {[
              ["State-scoped reviewers", "Ministry and hospital staff only see cases inside their assigned state or authority."],
              ["Masked auditor view", "System auditors inspect workflows without seeing direct identifiers."],
              ["DPDP-aligned audit log", "Every access, review decision and transmission is recorded in a tamper-evident hash chain."],
            ].map(([title, body]) => (
              <div className="assurance-item" key={title}>
                <span className="assurance-check"><Icon name="check" size={11} /></span>
                <span><strong>{title}</strong>{body}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="tiny faint">Synthetic demonstration environment · DPDP Act 2023-aligned reference architecture</p>
      </aside>

      <main className="auth-main">
        <div className="auth-card fade-in">
          <h1>Sign in</h1>
          <p>Staff console and patient case tracking.</p>
          {error && <Alert tone="error">{error}</Alert>}
          <form onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@organisation.org" required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" required />
            </div>
            <button className="btn primary block" disabled={busy} type="submit">
              {busy ? <span className="spinner" /> : "Sign in"}
            </button>
          </form>

          <div className="divider" />
          <div className="label" style={{ marginBottom: 8 }}>Demo accounts — one click sign in</div>
          <div className="demo-accounts">
            {DEMOS.map((d) => (
              <button
                key={d.email}
                className="btn ghost sm"
                style={{ justifyContent: "space-between", width: "100%" }}
                disabled={busy}
                onClick={() => void signIn(d.email, d.password)}
                type="button"
              >
                <span>{d.label} <span className="faint">· {d.org}</span></span>
                <span className="mono tiny faint">{d.email.split("@")[0]}</span>
              </button>
            ))}
          </div>
          <p className="tiny faint" style={{ marginTop: 16 }}>
            New patient? <Link to="/signup">Create an account</Link> to keep every case in one workspace. Prefer to stay anonymous? <Link to="/submit">File a grievance as a guest</Link> — you will receive a case reference and access code.
          </p>
        </div>
      </main>
    </div>
  );
}
