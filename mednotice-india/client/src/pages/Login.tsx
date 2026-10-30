import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth, type OtpChallenge } from "../auth";
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

/** Mobile number on the demo patient account, for the OTP sign-in walkthrough. */
const DEMO_MOBILE = "9810000123";

/**
 * Test accounts accepted by the one-time-password form. Only these accounts
 * exist, so the endpoint cannot be turned into a way of messaging an arbitrary
 * mobile or mailbox. The same field takes either form.
 */
const TEST_IDENTITIES = [
  { value: DEMO_MOBILE, label: "Demo patient · SMS" },
  { value: "patient@demo.in", label: "Demo patient · email" },
  { value: "9810000124", label: "Rahul Verma · SMS" },
  { value: "rahul.verma@demo.in", label: "Rahul Verma · email" },
];

export default function Login() {
  const { login, startOtp, loginWithOtp, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
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

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await startOtp(identifier);
      setChallenge(next);
      // Simulation mode hands the code back so a tester can finish the flow;
      // a live gateway returns no devCode and the field stays empty.
      setCode(next.devCode ?? "");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const next = await loginWithOtp(challenge.challengeId, code);
      navigate(destination(next.baseRole), { replace: true });
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
          <p>Patients sign in with a one-time password sent to their mobile number or email address.</p>

          {error && <Alert tone="error">{error}</Alert>}

          {challenge ? (
            <form onSubmit={verifyCode}>
              <p className="small muted" style={{ marginTop: 0 }}>
                We sent a six-digit code to <strong className="mono">{challenge.sentTo ?? challenge.masked}</strong>
                {challenge.channel === "EMAIL" ? " by email" : " by SMS"}. It expires in five minutes and can be used once.
              </p>
              {challenge.devCode && (
                <Alert tone="warn">
                  SMS gateway not configured — simulation mode. Your code is <strong className="mono">{challenge.devCode}</strong>.
                </Alert>
              )}
              <div className="field">
                <label htmlFor="otp-code">One-time password</label>
                <input
                  id="otp-code"
                  className="input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  maxLength={8}
                  required
                />
              </div>
              <button className="btn primary block" disabled={busy || code.length < 4} type="submit">
                {busy ? <span className="spinner" /> : "Verify and sign in"}
              </button>
              <button
                className="btn ghost block"
                style={{ marginTop: 8 }}
                type="button"
                disabled={busy}
                onClick={() => {
                  setChallenge(null);
                  setCode("");
                }}
              >
                Use a different number or email
              </button>
            </form>
          ) : (
            <form onSubmit={sendCode}>
              <div className="field">
                <label htmlFor="otp-identifier">Mobile number or email address</label>
                <input
                  id="otp-identifier"
                  className="input"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="+91 98100 01000 or you@example.org"
                  required
                />
                <span className="hint">
                  One code, sent to whichever you enter — an SMS to a mobile number, an email to a mailbox. Patients sign in with
                  the number or address saved on their account. No account yet? <Link to="/signup">Create one</Link>.
                </span>
              </div>
              <button className="btn primary block" disabled={busy} type="submit">
                {busy ? <span className="spinner" /> : "Send one-time password"}
              </button>
              <div className="label" style={{ marginBottom: 6 }}>Test accounts — tap to fill</div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {TEST_IDENTITIES.map((t) => (
                  <button
                    key={t.value}
                    className="btn ghost sm"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setIdentifier(t.value);
                      setError(null);
                    }}
                  >
                    <span className="mono">{t.value}</span>
                    <span className="faint"> · {t.label}</span>
                  </button>
                ))}
              </div>
              <p className="tiny faint" style={{ marginTop: 8 }}>
                With no SMS gateway or email provider configured the six-digit code is returned by the server and filled in for you
                on the next screen, so the flow can be walked end to end. Live delivery needs{" "}
                <span className="mono">SMS_PROVIDER</span> or <span className="mono">EMAIL_API_URL</span> set in the server
                environment.
              </p>
            </form>
          )}

          <div className="divider" />
          <details>
            <summary className="label" style={{ marginBottom: 8, cursor: "pointer" }}>
              Staff demo sign-in · email &amp; password
            </summary>
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
          </details>
          <p className="tiny faint" style={{ marginTop: 10 }}>
            One-time password demo: <span className="mono">{DEMO_MOBILE}</span> or <span className="mono">patient@demo.in</span> on
            the demo patient account. In simulation the code is written to the server outbox and filled in for you on the next
            screen.
          </p>
          <p className="tiny faint" style={{ marginTop: 16 }}>
            New patient? <Link to="/signup">Create an account</Link> to keep every case in one workspace. Prefer to stay anonymous? <Link to="/submit">File a grievance as a guest</Link> — you will receive a case reference and access code.
          </p>
        </div>
      </main>
    </div>
  );
}
