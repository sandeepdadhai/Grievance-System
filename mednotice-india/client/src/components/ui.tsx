import { useEffect, type CSSProperties, type ReactNode } from "react";
import { PRIORITY_META, statusLabel, verificationTone } from "../api";
import type { Priority } from "../types";

export function Badge({ tone = "muted", children, dot }: { tone?: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function PriorityBadge({ priority, solid }: { priority: Priority; solid?: boolean }) {
  if (solid) return <span className={`badge solid-${priority.toLowerCase()}`}>{priority}</span>;
  const meta = PRIORITY_META[priority];
  const tone = priority === "P1" ? "bad" : priority === "P2" ? "warn" : priority === "P3" ? "info" : "muted";
  return <Badge tone={tone}>{meta.label}</Badge>;
}

export function VerificationBadge({ status }: { status: string }) {
  const tone = verificationTone(status);
  return <Badge tone={tone === "ok" ? "ok" : tone === "warn" ? "warn" : tone === "bad" ? "bad" : "muted"}>{statusLabel(status)}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
    ROUTED: "ok",
    RESOLVED: "ok",
    VERIFIED: "ok",
    UNDER_REVIEW: "info",
    SUBMITTED: "info",
    PENDING_REVIEW: "warn",
    ROUTE_FAILED: "bad",
    REJECTED: "bad",
    SENT: "ok",
    QUEUED: "warn",
    FAILED: "bad",
    DELIVERED: "ok",
  };
  return <Badge tone={map[status] ?? "muted"}>{statusLabel(status)}</Badge>;
}

export function Card({ children, className = "", flush, style }: { children: ReactNode; className?: string; flush?: boolean; style?: CSSProperties }) {
  return <section className={`card ${flush ? "flush" : ""} ${className}`} style={style}>{children}</section>;
}

export function CardHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="card-head" style={{ padding: "unset" }}>
      <div>
        <h3>{title}</h3>
        {sub && <div className="card-sub">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

export function Alert({ tone = "info", children }: { tone?: "error" | "success" | "info" | "warn"; children: ReactNode }) {
  return <div className={`alert ${tone}`}>{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ gap: 10, color: "var(--muted)", fontSize: 13 }}>
      <span className="spinner" />
      {label ?? "Loading…"}
    </div>
  );
}

export function LoadingPage() {
  return (
    <div className="loading-page">
      <Spinner />
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div style={{ fontSize: 14, color: "var(--text-2)", marginBottom: 4 }}>{title}</div>
      {hint && <div>{hint}</div>}
    </div>
  );
}

export function Modal({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal fade-in" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row-between" style={{ marginBottom: 14 }}>
          <div>
            <h3>{title}</h3>
            {sub && <p className="small muted" style={{ marginTop: 4 }}>{sub}</p>}
          </div>
          <button className="btn ghost icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

type IconName = "grid" | "folder" | "users" | "shield" | "plug" | "send" | "activity" | "logout" | "arrow" | "upload" | "check" | "x" | "alert" | "search" | "chevron" | "lock" | "file" | "plus" | "refresh" | "clipboard" | "globe" | "message";

export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "grid":
      return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
    case "folder":
      return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
    case "users":
      return <svg {...common}><circle cx="9" cy="8" r="3.2" /><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" /><path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 20a5.6 5.6 0 0 0-2-4.3" /></svg>;
    case "shield":
      return <svg {...common}><path d="M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "plug":
      return <svg {...common}><path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0Z" /><path d="M12 18v3" /></svg>;
    case "send":
      return <svg {...common}><path d="M21 3 10.5 13.5" /><path d="M21 3 14.5 21l-4-7.5L3 9.5Z" /></svg>;
    case "activity":
      return <svg {...common}><path d="M3 12h4l2.5-7 5 14 2.5-7h4" /></svg>;
    case "logout":
      return <svg {...common}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5M5 12h11" /></svg>;
    case "arrow":
      return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
    case "upload":
      return <svg {...common}><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>;
    case "check":
      return <svg {...common}><path d="m4 12 5 5L20 6" /></svg>;
    case "x":
      return <svg {...common}><path d="M6 6l12 12M18 6 6 18" /></svg>;
    case "alert":
      return <svg {...common}><path d="M12 3 2.5 20h19Z" /><path d="M12 9v5M12 17.5v.5" /></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>;
    case "chevron":
      return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
    case "lock":
      return <svg {...common}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
    case "file":
      return <svg {...common}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /></svg>;
    case "plus":
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case "refresh":
      return <svg {...common}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>;
    case "clipboard":
      return <svg {...common}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3" /></svg>;
    case "globe":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" /></svg>;
    case "message":
      return <svg {...common}><path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-5.4A8 8 0 0 1 9 4h4a8 8 0 0 1 8 8Z" /><path d="M9 11h6M9 14.5h4" /></svg>;
    default:
      return null;
  }
}
