import type { Priority, User } from "./types";

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const res = await fetch(path, { credentials: "same-origin", ...init, headers });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 400) };
  }
  if (!res.ok) {
    const errorBody = body as { error?: string; details?: unknown };
    throw new ApiError(res.status, errorBody?.error ?? `Request failed (HTTP ${res.status})`, errorBody?.details);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export const COMMUNICATION_KIND_LABEL: Record<string, string> = {
  NOTIFICATION: "Notification",
  TRANSMISSION: "Transmission",
  STATUS_SYNC: "Status pull",
  WEBHOOK_EVENT: "Inbound webhook",
  COMMUNITY_POST: "Community post",
  COMMUNITY_COMMENT: "Community comment",
};

export const PRIORITY_META: Record<Priority, { label: string; short: string; color: string; description: string }> = {
  P1: { label: "Critical / Emergency", short: "P1", color: "#ff5d6c", description: "Immediate threat to life, severe malpractice or acute negligence" },
  P2: { label: "High / Urgent", short: "P2", color: "#ffa14a", description: "Serious complications, denied critical care or severe delay" },
  P3: { label: "Medium / Standard", short: "P3", color: "#4cc9f0", description: "Billing disputes, general feedback or procedural delay" },
  P4: { label: "Low / Informational", short: "P4", color: "#8b98b8", description: "Minor inquiries and suggestions" },
};

export function statusLabel(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join(" ");
}

export function verificationTone(status: string): "ok" | "warn" | "bad" | "muted" {
  if (status === "VERIFIED") return "ok";
  if (status === "PENDING_MANUAL_REVIEW") return "warn";
  if (status === "REJECTED") return "bad";
  return "muted";
}

export function severityTone(severity: string): "ok" | "warn" | "bad" | "muted" | "info" {
  if (severity === "critical" || severity === "high") return "bad";
  if (severity === "medium") return "warn";
  if (severity === "low") return "muted";
  if (severity === "info") return "info";
  return "muted";
}

export function formatDate(value: string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", ...opts });
}

export function timeAgo(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function slaCountdown(dueAt: string): { text: string; overdue: boolean; ratio: number } {
  const due = new Date(dueAt).getTime();
  const remaining = due - Date.now();
  const overdue = remaining < 0;
  const abs = Math.abs(remaining);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  return {
    overdue,
    text: `${overdue ? "Overdue by" : "Due in"} ${hours > 0 ? `${hours}h ` : ""}${minutes}m`,
    ratio: Math.max(0, Math.min(1, remaining / (24 * 3_600_000))),
  };
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function hasPermission(user: User | null, permission: string): boolean {
  if (!user) return false;
  if (user.baseRole === "SUPER_ADMIN") return true;
  return Boolean(user.permissions?.includes(permission));
}

export function roleLabel(user: User | null): string {
  if (!user) return "";
  return user.roleName ?? ROLE_LABELS[user.role] ?? user.role;
}

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super Administrator",
  MINISTRY_REVIEWER: "Ministry Reviewer",
  HOSPITAL_COMPLIANCE: "Hospital Compliance Officer",
  SYSTEM_AUDITOR: "System Auditor",
  PATIENT: "Patient",
};
