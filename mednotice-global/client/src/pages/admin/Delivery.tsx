import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, timeAgo } from "../../api";
import { REVIEWER_ROLES, useAuth } from "../../auth";
import type { NotificationRow } from "../../types";
import { Alert, Badge, Card, CardHead, Icon, Spinner, StatusBadge } from "../../components/ui";

type WebhookEvent = { id: number; received_at: string; source: string | null; payload: Record<string, unknown> };

export default function AdminDelivery() {
  const { user } = useAuth();
  const canAct = Boolean(user && REVIEWER_ROLES.includes(user.role));
  const [tab, setTab] = useState<"notifications" | "webhooks">("notifications");
  const [notifications, setNotifications] = useState<NotificationRow[] | null>(null);
  const [events, setEvents] = useState<WebhookEvent[] | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [n, w] = await Promise.all([
        api.get<{ notifications: NotificationRow[] }>(`/api/admin/notifications${status ? `?status=${status}` : ""}`),
        api.get<{ events: WebhookEvent[] }>("/api/admin/webhooks"),
      ]);
      setNotifications(n.notifications);
      setEvents(w.events);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, [status]);

  async function processQueue() {
    setBusy(true);
    try {
      const result = await api.post<{ processed: number; sent: number; retried: number; failed: number }>("/api/admin/notifications/process");
      setNotice(`Processed ${result.processed}: ${result.sent} sent, ${result.retried} retried, ${result.failed} failed.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retry(id: string) {
    setBusy(true);
    try {
      await api.post(`/api/admin/notifications/${id}/retry`);
      setNotice(`Notification ${id} re-queued and processed.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const queued = notifications?.filter((n) => n.status === "QUEUED").length ?? 0;
  const failed = notifications?.filter((n) => n.status === "FAILED").length ?? 0;

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Delivery</h2>
          <p className="small muted" style={{ marginTop: 4 }}>Priority-aware notifications with retry/backoff and signed webhooks.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Badge tone={queued ? "warn" : "muted"}>Queued {queued}</Badge>
          <Badge tone={failed ? "bad" : "muted"}>Failed {failed}</Badge>
          {canAct && <button className="btn sm" onClick={() => void processQueue()} disabled={busy}>{busy ? <span className="spinner" /> : <><Icon name="send" size={13} /> Process queue</>}</button>}
          <button className="btn sm ghost" onClick={() => void load()}><Icon name="refresh" size={13} /> Refresh</button>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="tabs">
        <button className={`tab ${tab === "notifications" ? "active" : ""}`} onClick={() => setTab("notifications")}>Notifications</button>
        <button className={`tab ${tab === "webhooks" ? "active" : ""}`} onClick={() => setTab("webhooks")}>Webhook inbox ({events?.length ?? 0})</button>
      </div>

      {tab === "notifications" && (
        <Card flush>
          <div style={{ padding: "16px 20px 8px" }} className="row-between">
            <CardHead title="Notification log" sub="Email is written to a local outbox; webhooks are HMAC-signed." />
            <select className="select" style={{ maxWidth: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="QUEUED">Queued</option>
              <option value="SENT">Sent</option>
              <option value="FAILED">Failed</option>
            </select>
          </div>
          {!notifications && <div style={{ padding: 20 }}><Spinner /></div>}
          {notifications && (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Channel</th><th>Case</th><th>Recipient</th><th>Subject</th><th>Status</th><th>Attempts</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  {notifications.map((n) => (
                    <tr key={n.id}>
                      <td><Badge tone={n.channel === "EMAIL" ? "info" : "muted"}>{n.channel}</Badge></td>
                      <td><Link to={`/admin/cases/${n.case_id}`} className="cell-id">{n.case_id}</Link></td>
                      <td className="small" style={{ maxWidth: 200, wordBreak: "break-all" }}>{n.target}</td>
                      <td className="small" style={{ maxWidth: 280 }}>{n.subject}</td>
                      <td><StatusBadge status={n.status} /></td>
                      <td className="mono small">{n.attempts}</td>
                      <td className="small nowrap">{formatDate(n.created_at, { hour: "2-digit", minute: "2-digit" })}</td>
                      <td className="right">{canAct && n.status !== "SENT" && <button className="btn sm ghost" onClick={() => void retry(n.id)} disabled={busy}>Retry</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {notifications.length === 0 && <div className="empty">No notifications in this view.</div>}
            </div>
          )}
        </Card>
      )}

      {tab === "webhooks" && (
        <div className="stack">
          {events?.map((event) => (
            <Card key={event.id}>
              <div className="row-between">
                <div className="row" style={{ gap: 8 }}>
                  <Badge tone="ok" dot>Received</Badge>
                  <span className="mono small">{String((event.payload.body as Record<string, unknown> | undefined)?.event ?? "event")}</span>
                  <span className="tiny faint">{event.source}</span>
                </div>
                <span className="tiny faint">{timeAgo(event.received_at)}</span>
              </div>
              <pre className="payload" style={{ marginTop: 10 }}>{JSON.stringify(event.payload, null, 2)}</pre>
            </Card>
          ))}
          {events && events.length === 0 && <Card><div className="empty">No webhook deliveries recorded yet. Route a case to populate the inbox.</div></Card>}
        </div>
      )}
    </div>
  );
}
