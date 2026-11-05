import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { hasPermission, roleLabel } from "../api";
import { useAuth } from "../auth";
import { useTheme } from "../theme";
import { ChatWidget } from "./ChatWidget";
import { Icon } from "./ui";

/**
 * The staff console is a separate deployment. `VITE_ADMIN_URL` sets its origin
 * at build time; the default matches the console port in server/admin.ts, which
 * is bound to loopback and reached through an SSH tunnel on this deployment.
 */
export const STAFF_CONSOLE_URL = ((import.meta.env.VITE_ADMIN_URL as string | undefined) ?? "http://localhost:4101").replace(/\/+$/, "");

/**
 * Wordmark for both surfaces: the departmental crest and name, so the patient
 * masthead, the console sidebar and the sign-in screens carry one identity.
 */
export function Brand() {
  return (
    <Link to="/" className="brand">
      <img className="brand-emblem" src="/assam/emblem.svg" alt="Health and Family Welfare Department, Government of Assam" />
      <span>
        <span className="brand-name" style={{ display: "block" }}>Health &amp; Family Welfare</span>
        <span className="brand-sub" style={{ display: "block" }}>Government of Assam</span>
      </span>
    </Link>
  );
}

export function PublicLayout() {
  const { user } = useAuth();
  const { applied } = useTheme();
  if (applied === "assam-health") {
    return (
      <div style={{ minHeight: "100%" }}>
        <GovernmentHeader />
        <main id="main">
          <Outlet />
        </main>
        <GovernmentFooter />
        <ChatWidget />
      </div>
    );
  }
  return (
    <div style={{ minHeight: "100%" }}>
      <header className="site-header">
        <Brand />
        <nav className="site-nav" aria-label="Primary">
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/submit">File a grievance</NavLink>
          <NavLink to="/track">Track a case</NavLink>
          <NavLink to="/community">Community</NavLink>
        </nav>
        <div className="row" style={{ gap: 8 }}>
          {user ? (
            <>
              <Link to={user.baseRole === "PATIENT" ? "/portal" : STAFF_CONSOLE_URL} className="btn sm ghost">My home</Link>
              <LogoutButton />
            </>
          ) : (
            <>
              <Link to="/login" className="btn sm ghost">Sign in</Link>
              <Link to="/signup" className="btn sm ghost">Patient sign up</Link>
              <Link to="/submit" className="btn sm primary">Start a complaint</Link>
            </>
          )}
        </div>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="site-footer">
        <div>
          <strong style={{ color: "var(--text-2)" }}>Health &amp; Family Welfare Department</strong> · Government of Assam
          <div style={{ marginTop: 4 }}>Reference implementation · synthetic data only</div>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <Link to="/submit">File a grievance</Link>
          <Link to="/track">Track a case</Link>
          <Link to="/community">Community</Link>
          <Link to="/signup">Patient sign up</Link>
          <a href={`${STAFF_CONSOLE_URL}/login`}>Staff console</a>
        </div>
      </footer>
      <ChatWidget />
    </div>
  );
}

function LogoutButton() {
  const { logout } = useAuth();
  return (
    <button
      className="btn sm ghost"
      onClick={() => {
        void logout().then(() => {
          window.location.href = "/";
        });
      }}
    >
      Sign out
    </button>
  );
}

/**
 * Assam Health Department presentation for the patient portal: the utility
 * strip, departmental masthead and blue navigation bar that state portals use
 * instead of a single marketing header. Only rendered for that preset.
 */
function GovernmentHeader() {
  const { user } = useAuth();
  return (
    <header className="gov-header">
      <div className="gov-utility">
        <div className="gov-wrap">
          <span className="gov-utility-left">
            <span className="gov-dot" aria-hidden="true" />
            Government of Assam
          </span>
          <nav className="gov-utility-right" aria-label="Utility">
            <a href="#main">Skip to main content</a>
            <span aria-hidden="true">|</span>
            <Link to="/track">Track a case</Link>
            <span aria-hidden="true">|</span>
            {user ? (
              <Link to={user.baseRole === "PATIENT" ? "/portal" : STAFF_CONSOLE_URL}>My home</Link>
            ) : (
              <Link to="/login">Sign in</Link>
            )}
          </nav>
        </div>
      </div>

      <div className="gov-masthead">
        <div className="gov-wrap">
          <Link to="/" className="gov-brand">
            <img src="/assam/emblem.svg" alt="Health and Family Welfare Department, Government of Assam" width={64} height={64} />
            <span className="gov-brand-text">
              <span className="gov-brand-dept">Health &amp; Family Welfare Department</span>
              <span className="gov-brand-state">Government of Assam</span>
              <span className="gov-brand-tag">Patient Grievance Redressal Portal</span>
            </span>
          </Link>
          <div className="gov-masthead-side">
            <div className="gov-helpline">
              <span className="gov-helpline-label">Health Helpline</span>
              <strong>104</strong>
            </div>
            <div className="gov-masthead-actions">
              {user ? (
                <>
                  <Link to={user.baseRole === "PATIENT" ? "/portal" : STAFF_CONSOLE_URL} className="btn sm">My home</Link>
                  <LogoutButton />
                </>
              ) : (
                <>
                  <Link to="/submit" className="btn sm primary">File a grievance</Link>
                  <Link to="/login" className="btn sm ghost">Sign in</Link>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <nav className="gov-nav" aria-label="Primary">
        <div className="gov-wrap">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/submit">File a grievance</NavLink>
          <NavLink to="/track">Track a case</NavLink>
          <NavLink to="/community">Community</NavLink>
          <NavLink to="/signup">Patient sign up</NavLink>
        </div>
      </nav>
    </header>
  );
}

function GovernmentFooter() {
  return (
    <footer className="gov-footer">
      <div className="gov-wrap gov-footer-grid">
        <div>
          <strong>Health &amp; Family Welfare Department</strong>
          <p>
            Government of Assam
            <br />
            Directorate of Health Services (FW)
            <br />
            Hengrabari, Guwahati – 781036, Assam
          </p>
        </div>
        <div>
          <strong>Quick links</strong>
          <Link to="/submit">File a grievance</Link>
          <Link to="/track">Track a case</Link>
          <Link to="/community">Patient community</Link>
          <Link to="/login">Sign in</Link>
        </div>
        <div>
          <strong>Helplines</strong>
          <p>
            Health Helpline: 104
            <br />
            Ambulance: 108
            <br />
            Emergency: 112
          </p>
        </div>
      </div>
      <div className="gov-wrap gov-footer-bottom">
        <span>© {new Date().getFullYear()} Health &amp; Family Welfare Department, Government of Assam · Demonstration deployment with synthetic data.</span>
        <span className="gov-credit">
          Photograph: Assam Medical College &amp; Hospital by Pranabnlp (CC BY-SA 4.0).
        </span>
      </div>
    </footer>
  );
}

const NAV = [
  { to: "/admin", label: "Dashboard", icon: "grid" as const, end: true, group: "Case work" as const },
  { to: "/admin/cases", label: "Grievances", icon: "folder" as const, group: "Case work" as const },
  { to: "/admin/facility", label: "My facility", icon: "building" as const, group: "Case work" as const },
  { to: "/admin/dispatch", label: "Send to authorities", icon: "truck" as const, group: "Case work" as const },
  { to: "/admin/delivery", label: "Notifications", icon: "send" as const, group: "Case work" as const },
  { to: "/admin/communications", label: "Message log", icon: "mail" as const, group: "Case work" as const },
  { to: "/admin/community", label: "Community posts", icon: "message" as const, group: "Case work" as const },
  { to: "/admin/directory", label: "Hospitals & authorities", icon: "building" as const, group: "Administration" as const },
  { to: "/admin/adapters", label: "Authority connections", icon: "plug" as const, group: "Administration" as const },
  { to: "/admin/audit", label: "Audit trail", icon: "activity" as const, group: "Administration" as const },
  { to: "/admin/users", label: "Staff accounts", icon: "users" as const, group: "Administration" as const },
  { to: "/admin/theme", label: "Look & feel", icon: "palette" as const, group: "Administration" as const },
  { to: "/admin/compliance", label: "Compliance", icon: "shield" as const, group: "Administration" as const },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { applied } = useTheme();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (user.baseRole === "PATIENT") return <Navigate to="/login" replace />;

  const nav = NAV.filter((item) => {
    if (item.to === "/admin/facility") return Boolean(user.facilityId);
    if (item.to === "/admin/users") return user.baseRole === "SUPER_ADMIN";
    if (item.to === "/admin/theme") return user.baseRole === "SUPER_ADMIN";
    if (item.to === "/admin/audit") return user.baseRole === "SUPER_ADMIN" || hasPermission(user, "audit.view");
    if (item.to === "/admin/delivery") return hasPermission(user, "delivery.view");
    if (item.to === "/admin/communications") return hasPermission(user, "delivery.view");
    if (item.to === "/admin/community") return hasPermission(user, "community.moderate");
    if (item.to === "/admin/compliance") return hasPermission(user, "compliance.view");
    return true;
  });

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <div className="nav-group">
          <div className="nav-label">Case work</div>
          {nav.filter((item) => item.group === "Case work").map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
        <div className="nav-group">
          <div className="nav-label">Administration</div>
          {nav.filter((item) => item.group === "Administration").map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
        <div className="nav-spacer" />
        <div className="sidebar-footer">
          <div className="user-chip">
            <span className="avatar">{user.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}</span>
            <span className="user-meta">
              <strong>{user.name}</strong>
              <span>{roleLabel(user)}</span>
            </span>
          </div>
          <button
            className="btn ghost sm"
            onClick={() => {
              void logout().then(() => {
                window.location.href = "/login";
              });
            }}
          >
            <Icon name="logout" size={15} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <div className="main">
        {applied === "assam-health" && (
          <div className="gov-admin-strip">
            Government of Assam · Health &amp; Family Welfare Department
          </div>
        )}
        <div className="topbar">
          <div className="topbar-title">
            <span className="dot" />
            {user.facilityName
              ? `Facility scope · ${user.facilityName}`
              : user.country
                ? "India · national scope"
                : "All India scope"}
            <span className="faint">·</span>
            <span className="faint">{user.organisation ?? "Government of Assam"}</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="chip mono">AES-256-GCM</span>
            <span className="chip">Audit chain active</span>
          </div>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}


