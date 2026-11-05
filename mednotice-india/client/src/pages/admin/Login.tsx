import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth";
import { Alert, Icon } from "../../components/ui";
import { Brand } from "../../components/Layout";

const DEMOS = [
  { email: "admin@mednotice.in", password: "Admin!2345", label: "Super Administrator", org: "Government of Assam" },
  { email: "reviewer@mohfw.gov.in", password: "Review!2345", label: "Ministry Reviewer", org: "India · MoHFW" },
  { email: "compliance@aiims.edu", password: "Comply!2345", label: "Hospital Compliance", org: "India · AIIMS" },
  { email: "facility.aiims@mednotice.in", password: "Facility!2345", label: "Facility officer", org: "AIIMS New Delhi" },
  { email: "facility.kem@mednotice.in", password: "Facility!2345", label: "Facility officer", org: "KEM Mumbai" },
  { email: "auditor@mednotice.in", password: "Audit!2345", label: "System Auditor", org: "Read-only" },
];

/**
 * Staff sign-in for the separately deployed console. Patients have no account
 * path here: a patient session is signed out and told to use the patient app.
 */
export default function AdminLogin() {
  const { login, logout, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function destination(): string {
    const next = params.get("next");
    if (next && next.startsWith("/admin")) return next;
    return "/admin";
  }

  useEffect(() => {
    if (!user) return;
    if (user.baseRole === "PATIENT") {
      void logout().then(() => setError("This console is for departmental staff accounts only. You have been signed out."));
      return;
    }
    navigate(destination(), { replace: true });
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  async function signIn(nextEmail: string, nextPassword: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await login(nextEmail, nextPassword);
      if (next.baseRole === "PATIENT") {
        await logout();
        setError("This console is for departmental staff accounts only.");
        return;
      }
      navigate(destination(), { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    await signIn(email, password);
  }

  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <Brand />
        <div style={{ maxWidth: 430 }}>
          <h1 style={{ fontSize: "2rem", marginBottom: 12 }}>Staff console.</h1>
          <p className="muted" style={{ fontSize: 13.5 }}>
            This console is deployed separately from the patient application and is reachable only from the staff network.
            Ministry, hospital, facility and audit accounts sign in here; patient accounts cannot open it.
          </p>
          <div className="assurance">
            {[
              ["Separate deployment", "The console ships as its own bundle on its own origin, apart from the public patient app."],
              ["State-scoped reviewers", "Ministry and hospital staff only see cases inside their assigned state or authority."],
              ["DPDP-aligned audit log", "Every access, review decision and transmission is recorded in a tamper-evident hash chain."],
            ].map(([title, body]) => (
              <div className="assurance-item" key={title}>
                <span className="assurance-check"><Icon name="check" size={11} /></span>
                <span><strong>{title}</strong>{body}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="tiny faint">Restricted access · staff credentials only</p>
      </aside>

      <main className="auth-main">
        <div className="auth-card fade-in">
          <h1>Staff sign in</h1>
          <p>Use your departmental staff email address and password.</p>

          {error && <Alert tone="error">{error}</Alert>}

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="staff-email">Email address</label>
              <input
                id="staff-email"
                className="input"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@mednotice.in"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="staff-password">Password</label>
              <input
                id="staff-password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button className="btn primary block" disabled={busy || !email || !password} type="submit">
              {busy ? <span className="spinner" /> : "Sign in"}
            </button>
          </form>

          <div className="divider" />
          <div className="label" style={{ marginBottom: 8 }}>Demo staff accounts — tap to sign in</div>
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
          <p className="tiny faint" style={{ marginTop: 12 }}>
            Patients file and track grievances on the public grievance portal and never need this console.
          </p>
        </div>
      </main>
    </div>
  );
}
