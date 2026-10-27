import { useEffect, useState } from "react";
import { api, formatDate, ROLE_LABELS } from "../../api";
import { useAuth } from "../../auth";
import type { PermissionDefinition, RoleDefinition } from "../../types";
import { Alert, Badge, Card, CardHead, Icon, Modal, Spinner } from "../../components/ui";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  country: string | null;
  organisation: string | null;
  facility_id: string | null;
  active: number;
  mfa_enabled: number;
  last_login_at: string | null;
  created_at: string;
};

type FacilityOption = { id: string; name: string; city: string | null; status: string };

type RolesPayload = {
  roles: RoleDefinition[];
  permissions: PermissionDefinition[];
  baseRoles: string[];
};

const ASSIGNABLE_BASE = ["MINISTRY_REVIEWER", "HOSPITAL_COMPLIANCE", "SYSTEM_AUDITOR"];

const emptyRoleForm = { key: null as string | null, name: "", description: "", baseRole: "MINISTRY_REVIEWER", permissions: [] as string[] };

export default function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [facilities, setFacilities] = useState<FacilityOption[]>([]);
  const [rolesPayload, setRolesPayload] = useState<RolesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<"create" | "role" | { reset: UserRow } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "MINISTRY_REVIEWER", country: "", organisation: "", facilityId: "" });
  const [newPassword, setNewPassword] = useState("");
  const [roleForm, setRoleForm] = useState(emptyRoleForm);

  async function load() {
    try {
      const [userRes, roleRes, facilityRes] = await Promise.all([
        api.get<{ users: UserRow[] }>("/api/admin/users"),
        api.get<RolesPayload>("/api/admin/roles"),
        api.get<{ facilities: FacilityOption[] }>("/api/admin/directory/facilities"),
      ]);
      setUsers(userRes.users);
      setRolesPayload(roleRes);
      setFacilities(facilityRes.facilities);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const roleName = (key: string) => rolesPayload?.roles.find((r) => r.key === key)?.name ?? ROLE_LABELS[key] ?? key;

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
      await api.post("/api/admin/users", {
        ...form,
        country: form.country || undefined,
        organisation: form.organisation || undefined,
        facilityId: form.facilityId || undefined,
      });
      setNotice(`Created account for ${form.email}.`);
      setModal(null);
      setForm({ name: "", email: "", password: "", role: "MINISTRY_REVIEWER", country: "", organisation: "", facilityId: "" });
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

  function openRoleEditor(role?: RoleDefinition) {
    setError(null);
    setRoleForm(
      role
        ? { key: role.key, name: role.name, description: role.description, baseRole: role.baseRole, permissions: [...role.permissions] }
        : emptyRoleForm,
    );
    setModal("role");
  }

  async function saveRole() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: roleForm.name,
        description: roleForm.description,
        baseRole: roleForm.baseRole,
        permissions: roleForm.permissions,
      };
      if (roleForm.key) await api.patch(`/api/admin/roles/${roleForm.key}`, body);
      else await api.post("/api/admin/roles", body);
      setNotice(roleForm.key ? `Role “${roleForm.name}” updated.` : `Role “${roleForm.name}” created.`);
      setModal(null);
      setRoleForm(emptyRoleForm);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteRole(role: RoleDefinition) {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/admin/roles/${role.key}`);
      setNotice(`Role “${role.name}” deleted.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const RESERVED_PERMISSIONS = ["users.manage", "adapters.manage"];
  const assignablePermissions = (rolesPayload?.permissions ?? []).filter((p) => !RESERVED_PERMISSIONS.includes(p.key));
  const grouped = assignablePermissions.reduce<Record<string, PermissionDefinition[]>>((acc, p) => {
    (acc[p.group] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Users & roles</h2>
          <p className="small muted" style={{ marginTop: 4 }}>Accounts, custom roles and capability bundles — all enforced server-side.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm ghost" onClick={() => openRoleEditor()}><Icon name="shield" size={14} /> New role</button>
          <button className="btn primary sm" onClick={() => setModal("create")}><Icon name="plus" size={14} /> New user</button>
        </div>
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
                <tr><th>User</th><th>Role</th><th>Facility</th><th>Jurisdiction</th><th>MFA</th><th>Last login</th><th>Status</th><th></th></tr>
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
                        style={{ padding: "5px 26px 5px 8px", fontSize: 12, minWidth: 180 }}
                        value={u.role}
                        disabled={u.id === me?.id}
                        onChange={(e) => void patch(u.id, { role: e.target.value }, `${u.name} is now ${roleName(e.target.value)}.`)}
                      >
                        {(rolesPayload?.roles ?? []).map((r) => (
                          <option key={r.key} value={r.key}>{r.name}{r.builtin ? "" : " (custom)"}</option>
                        ))}
                        {!rolesPayload?.roles.some((r) => r.key === u.role) && <option value={u.role}>{u.role}</option>}
                      </select>
                    </td>
                    <td>
                      <select
                        className="select"
                        style={{ padding: "5px 26px 5px 8px", fontSize: 12, minWidth: 170 }}
                        value={u.facility_id ?? ""}
                        onChange={(e) => void patch(u.id, { facilityId: e.target.value || null }, e.target.value ? `${u.name} now works the ${facilities.find((f) => f.id === e.target.value)?.name ?? e.target.value} queue.` : `${u.name} now has state-wide scope.`)}
                      >
                        <option value="">State-wide</option>
                        {facilities.map((f) => (
                          <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
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

      <Card flush style={{ marginTop: 18 }}>
        <div style={{ padding: "18px 20px 8px" }}>
          <CardHead
            title="Roles & capability bundles"
            sub="Built-in roles are fixed. Custom roles inherit one staff capability family and the permissions you tick."
            right={<Badge tone="info">{rolesPayload?.roles.length ?? 0} roles</Badge>}
          />
        </div>
        {!rolesPayload && <div style={{ padding: 20 }}><Spinner /></div>}
        {rolesPayload && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Role</th><th>Base scope</th><th>Permissions</th><th>Accounts</th><th></th></tr>
              </thead>
              <tbody>
                {rolesPayload.roles.map((role) => (
                  <tr key={role.key}>
                    <td>
                      <div className="strong">{role.name} {role.builtin ? <Badge tone="muted">Built-in</Badge> : <Badge tone="info">Custom</Badge>}</div>
                      <div className="cell-sub">{role.description || role.key}</div>
                    </td>
                    <td><span className="mono small">{role.baseRole}</span></td>
                    <td style={{ maxWidth: 340 }}>
                      {role.permissions.length === 0 ? (
                        <span className="faint small">{role.baseRole === "PATIENT" ? "No staff capabilities" : "Base role defaults only"}</span>
                      ) : (
                        <div className="row" style={{ gap: 4 }}>
                          {role.permissions.slice(0, 4).map((p) => <span className="chip" key={p}>{p}</span>)}
                          {role.permissions.length > 4 && <span className="chip">+{role.permissions.length - 4}</span>}
                        </div>
                      )}
                    </td>
                    <td>{role.userCount}</td>
                    <td className="right nowrap">
                      {role.builtin ? (
                        <span className="tiny faint">Read-only</span>
                      ) : (
                        <>
                          <button className="btn sm ghost" onClick={() => openRoleEditor(role)}>Edit</button>
                          <button
                            className="btn sm ghost"
                            style={{ marginLeft: 6, color: "var(--danger)" }}
                            disabled={busy || role.userCount > 0}
                            title={role.userCount > 0 ? "Reassign the accounts using this role first" : "Delete role"}
                            onClick={() => void deleteRole(role)}
                          >
                            Delete
                          </button>
                        </>
                      )}
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
          ["Super Administrator", "Full access, user management, adapter configuration and India-wide metrics."],
          ["Ministry Reviewer", "Country-scoped review, triage override, document approval, routing and resolution."],
          ["Hospital Compliance", "Reviews and resolves the cases filed against the facility the account is bound to."],
          ["System Auditor", "Read-only across the platform with masked patient identifiers."],
          ["Patient", "Own cases and community participation only; no console access."],
          ["Custom roles", "Start from a staff family, then grant only the capabilities that person needs."],
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
            <div className="field">
              <label htmlFor="nu-role">Role</label>
              <select id="nu-role" className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {(rolesPayload?.roles ?? []).map((r) => (
                  <option key={r.key} value={r.key}>{r.name}{r.builtin ? "" : " (custom)"}</option>
                ))}
              </select>
            </div>
            <div className="field"><label htmlFor="nu-country">Country scope</label><input id="nu-country" className="input" maxLength={2} placeholder="US, DE, GB, IN… (blank = global)" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} /></div>
            <div className="field full"><label htmlFor="nu-org">Organisation</label><input id="nu-org" className="input" value={form.organisation} onChange={(e) => setForm({ ...form, organisation: e.target.value })} /></div>
            <div className="field full">
              <label htmlFor="nu-facility">Facility</label>
              <select id="nu-facility" className="select" value={form.facilityId} onChange={(e) => setForm({ ...form, facilityId: e.target.value })}>
                <option value="">No facility — state-wide scope</option>
                {facilities.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}{f.city ? ` · ${f.city}` : ""}</option>
                ))}
              </select>
              <span className="hint">A facility-bound account only sees and resolves cases filed against that facility.</span>
            </div>
            <div className="field full"><label htmlFor="nu-password">Temporary password</label><input id="nu-password" className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="12+ characters, mixed case, digit, symbol" /></div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !form.email || form.password.length < 12} onClick={() => void create()}>{busy ? <span className="spinner" /> : "Create user"}</button>
          </div>
        </Modal>
      )}

      {modal === "role" && (
        <Modal
          title={roleForm.key ? "Edit custom role" : "Create custom role"}
          sub="Custom roles can never exceed the data scope of their base role."
          onClose={() => setModal(null)}
        >
          <div className="form-grid">
            <div className="field"><label htmlFor="role-name">Role name</label><input id="role-name" className="input" maxLength={60} value={roleForm.name} onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })} placeholder="e.g. District Grievance Officer" /></div>
            <div className="field">
              <label htmlFor="role-base">Base staff scope</label>
              <select id="role-base" className="select" value={roleForm.baseRole} onChange={(e) => setRoleForm({ ...roleForm, baseRole: e.target.value })}>
                {ASSIGNABLE_BASE.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div className="field full"><label htmlFor="role-desc">Description</label><input id="role-desc" className="input" maxLength={240} value={roleForm.description} onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })} placeholder="What is this role accountable for?" /></div>
          </div>

          <div className="label" style={{ marginBottom: 8 }}>Capabilities</div>
          {Object.entries(grouped).map(([group, perms]) => (
            <div key={group} style={{ marginBottom: 12 }}>
              <div className="tiny faint" style={{ marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}>{group}</div>
              <div className="stack" style={{ gap: 6 }}>
                {perms.map((p) => (
                  <label className="check" key={p.key} style={{ marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={roleForm.permissions.includes(p.key)}
                      onChange={(e) =>
                        setRoleForm({
                          ...roleForm,
                          permissions: e.target.checked ? [...roleForm.permissions, p.key] : roleForm.permissions.filter((k) => k !== p.key),
                        })
                      }
                    />
                    <span><strong>{p.label}</strong> — {p.description}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <p className="tiny faint">User, role and adapter configuration stay reserved for Super Administrators, so those capabilities are not assignable to custom roles.</p>

          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || roleForm.name.trim().length < 3} onClick={() => void saveRole()}>
              {busy ? <span className="spinner" /> : roleForm.key ? "Save role" : "Create role"}
            </button>
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
