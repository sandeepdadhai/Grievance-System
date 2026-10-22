import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { ROLE_LABELS } from "../api";
import { REVIEWER_ROLES, STAFF_ROLES, useAuth } from "../auth";
import { Icon, LoadingPage } from "./ui";

function Brand() {
  return (
    <Link to="/" className="brand">
      <span className="brand-mark">MN</span>
      <span>
        <span className="brand-name">MedNotice</span>
        <span className="brand-sub" style={{ display: "block" }}>Global</span>
      </span>
    </Link>
  );
}

export function PublicLayout() {
  const { user } = useAuth();
  return (
    <div style={{ minHeight: "100%" }}>
      <header className="site-header">
        <Brand />
        <nav className="site-nav" aria-label="Primary">
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/submit">File a grievance</NavLink>
          <NavLink to="/track">Track a case</NavLink>
          {user && STAFF_ROLES.includes(user.role) && <NavLink to="/admin">Console</NavLink>}
        </nav>
        <div className="row" style={{ gap: 8 }}>
          {user ? (
            <>
              <Link to={user.role === "PATIENT" ? "/portal" : "/admin"} className="btn sm ghost">My workspace</Link>
              <LogoutButton />
            </>
          ) : (
            <>
              <Link to="/login" className="btn sm ghost">Sign in</Link>
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
          <strong style={{ color: "var(--text-2)" }}>MedNotice-Global</strong> · Multi-jurisdictional patient grievance infrastructure
          <div style={{ marginTop: 4 }}>Reference implementation · synthetic data only</div>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <Link to="/submit">File a grievance</Link>
          <Link to="/track">Track a case</Link>
          <Link to="/login">Staff sign in</Link>
        </div>
      </footer>
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

const NAV = [
  { to: "/admin", label: "Overview", icon: "grid" as const, end: true },
  { to: "/admin/cases", label: "Cases", icon: "folder" as const },
  { to: "/admin/delivery", label: "Delivery", icon: "send" as const },
  { to: "/admin/adapters", label: "Adapters", icon: "plug" as const },
  { to: "/admin/audit", label: "Audit log", icon: "activity" as const },
  { to: "/admin/users", label: "Users & roles", icon: "users" as const },
  { to: "/admin/compliance", label: "Compliance", icon: "shield" as const },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!STAFF_ROLES.includes(user.role)) return <Navigate to="/portal" replace />;

  const nav = NAV.filter((item) => {
    if (item.to === "/admin/users") return user.role === "SUPER_ADMIN";
    if (item.to === "/admin/audit") return user.role === "SUPER_ADMIN" || user.role === "SYSTEM_AUDITOR";
    if (item.to === "/admin/adapters") return true;
    if (item.to === "/admin/delivery") return REVIEWER_ROLES.includes(user.role) || user.role === "SYSTEM_AUDITOR";
    return true;
  });

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <div className="nav-group">
          <div className="nav-label">Operations</div>
          {nav.slice(0, 4).map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
        <div className="nav-group">
          <div className="nav-label">Governance</div>
          {nav.slice(4).map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
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
              <span>{ROLE_LABELS[user.role] ?? user.role}</span>
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
        <div className="topbar">
          <div className="topbar-title">
            <span className="dot" />
            {user.country ? `${user.country} jurisdiction scope` : "Global scope"}
            <span className="faint">·</span>
            <span className="faint">{user.organisation ?? "MedNotice-Global"}</span>
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


