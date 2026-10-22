import { useEffect, useState } from "react";
import { api, formatDate, ROLE_LABELS } from "../../api";
import { useAuth } from "../../auth";
import { Alert, Badge, Card, CardHead, Icon, Modal, Spinner } from "../../components/ui";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  country: string | null;
  organisation: string | null;
  active: number;
  mfa_enabled: number;
  last_login_at: string | null;
  created_at: string;
};

const ROLES = ["SUPER_ADMIN", "MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE", "SYSTEM_AUDITOR", "PATIENT"];

export default function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<"create" | { reset: UserRow } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "MINISTRY_REVIEWER", country: "", organisation: "" });
  const [newPassword, setNewPassword] = useState("");

  async function load() {
    try {
      const res = await api.get<{ users: UserRow[] }>("/api/admin/users");
      setUsers(res.users);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function patch(id: string, body: Record<string, unknown>, message: string) {
    setError(null);
    setNotice(null);
    try {
      await api.patch(`/api/admin/users/${id}`, body);
      setNotice(message);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/admin/users", { ...form, country: form.country || undefined, organisation: form.organisation || undefined });
      setNotice(`Created account for ${form.email}.`);
      setModal(null);
      setForm({ name: "", email: "", password: "", role: "MINISTRY_REVIEWER", country: "", organisation: "" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(row: UserRow) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/admin/users/${row.id}/reset-password`, { password: newPassword });
      setNotice(`Password reset for ${row.email}; all their sessions were revoked.`);
      setModal(null);
      setNewPassword("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Users & roles</h2>
          <p className="small muted" style={{ marginTop: 4 }}>Multi-tier permissions with jurisdiction scoping and audit coverage.</p>
        </div>
        <button className="btn primary sm" onClick={() => setModal("create")}><Icon name="plus" size={14} /> New user</button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card flush>
        <div style={{ padding: "18px 20px 8px" }}>
          <CardHead title="Accounts" sub={`${users?.length ?? 0} users`} right={<Badge tone="info">RBAC enforced server-side</Badge>} />
        </div>
        {!users && <div style={{ padding: 20 }}><Spinner /></div>}
        {users && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>User</th><th>Role</th><th>Jurisdiction</th><th>MFA</th><th>Last login</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="strong">{u.name}{u.id === me?.id && <span className="cell-sub"> (you)</span>}</div>
                      <div className="cell-sub">{u.email}</div>
                      <div className="cell-sub">{u.organisation ?? "—"}</div>
                    </td>
                    <td>
                      <select
                        className="select"
                        style={{ padding: "5px 26px 5px 8px", fontSize: 12, minWidth: 170 }}
                        value={u.role}
                        disabled={u.id === me?.id}
                        onChange={(e) => void patch(u.id, { role: e.target.value }, `${u.name} is now ${ROLE_LABELS[e.target.value]}.`)}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                    </td>
                    <td>{u.country ?? <span className="faint">Global</span>}</td>
                    <td>{u.mfa_enabled ? <Badge tone="ok">Enabled</Badge> : <Badge tone="muted">Off</Badge>}</td>
                    <td className="nowrap">{u.last_login_at ? formatDate(u.last_login_at, { hour: "2-digit", minute: "2-digit" }) : <span className="faint">Never</span>}</td>
                    <td>{u.active ? <Badge tone="ok" dot>Active</Badge> : <Badge tone="bad">Disabled</Badge>}</td>
                    <td className="right nowrap">
                      <button className="btn sm ghost" onClick={() => setModal({ reset: u })}>Reset password</button>
                      <button
                        className="btn sm ghost"
                        style={{ marginLeft: 6, color: u.active ? "var(--danger)" : undefined }}
                        disabled={u.id === me?.id}
                        onClick={() => void patch(u.id, { active: !u.active }, `${u.name} ${u.active ? "deactivated" : "reactivated"}.`)}
                      >
                        {u.active ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid-3" style={{ marginTop: 18 }}>
        {[
          ["Super Administrator", "Full access, user management, adapter configuration, global metrics."],
          ["Ministry Reviewer", "Country-scoped review, triage override, document approval, resolution."],
          ["Hospital Compliance", "Country-scoped review of cases targeting their facilities."],
          ["System Auditor", "Read-only across the platform with masked patient identifiers."],
          ["Patient", "Own cases only; cannot access the staff console."],
        ].map(([role, desc]) => (
          <div className="card" key={role}>
            <div className="label">{role}</div>
            <p className="small muted" style={{ marginTop: 6 }}>{desc}</p>
          </div>
        ))}
      </div>

      {modal === "create" && (
        <Modal title="Create user" sub="Passwords must meet the platform complexity policy." onClose={() => setModal(null)}>
          <div className="form-grid">
            <div className="field"><label htmlFor="nu-name">Full name</label><input id="nu-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="nu-email">Email</label><input id="nu-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="field"><label htmlFor="nu-role">Role</label><select id="nu-role" className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></div>
            <div className="field"><label htmlFor="nu-country">Country scope</label><input id="nu-country" className="input" maxLength={2} placeholder="US (blank = global)" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} /></div>
            <div className="field full"><label htmlFor="nu-org">Organisation</label><input id="nu-org" className="input" value={form.organisation} onChange={(e) => setForm({ ...form, organisation: e.target.value })} /></div>
            <div className="field full"><label htmlFor="nu-password">Temporary password</label><input id="nu-password" className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="12+ characters, mixed case, digit, symbol" /></div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !form.email || form.password.length < 12} onClick={() => void create()}>{busy ? <span className="spinner" /> : "Create user"}</button>
          </div>
        </Modal>
      )}

      {modal && typeof modal === "object" && (
        <Modal title="Reset password" sub={`${modal.reset.email} · all sessions will be revoked`} onClose={() => setModal(null)}>
          <div className="field">
            <label htmlFor="reset-pw">New password</label>
            <input id="reset-pw" className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <span className="hint">12+ characters with uppercase, lowercase, digit and symbol.</span>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || newPassword.length < 12} onClick={() => void resetPassword(modal.reset)}>{busy ? <span className="spinner" /> : "Reset password"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
