import { useEffect, useMemo, useState } from "react";
import { api, formatDate, hasPermission } from "../../api";
import { useAuth } from "../../auth";
import type { AdapterDto, AuthorityDto, FacilityDto } from "../../types";
import { Alert, Badge, Card, CardHead, EmptyState, Icon, Modal, Spinner } from "../../components/ui";

const AUTHORITY_STATUSES = ["ACTIVE", "INACTIVE"] as const;
const FACILITY_STATUSES = ["VERIFIED", "PENDING", "CLOSED"] as const;

type Tab = "authorities" | "facilities";
type EditTarget = { kind: Tab; record: AuthorityDto | FacilityDto | null };

type AuthorityForm = {
  id: string;
  name: string;
  region: string;
  adapter: string;
  contactEmail: string;
  webhook: string;
  status: string;
};

type FacilityForm = {
  id: string;
  name: string;
  authorityId: string;
  city: string;
  letterheadKeywords: string;
  status: string;
};

const EMPTY_AUTHORITY: AuthorityForm = {
  id: "",
  name: "",
  region: "",
  adapter: "",
  contactEmail: "",
  webhook: "",
  status: "ACTIVE",
};

const EMPTY_FACILITY: FacilityForm = {
  id: "",
  name: "",
  authorityId: "",
  city: "",
  letterheadKeywords: "",
  status: "VERIFIED",
};

export default function AdminDirectory() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "registry.manage");
  const [tab, setTab] = useState<Tab>("authorities");
  const [authorities, setAuthorities] = useState<AuthorityDto[] | null>(null);
  const [facilities, setFacilities] = useState<FacilityDto[] | null>(null);
  const [adapters, setAdapters] = useState<AdapterDto[]>([]);
  const [search, setSearch] = useState("");
  const [authorityFilter, setAuthorityFilter] = useState("");
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [authorityForm, setAuthorityForm] = useState<AuthorityForm>(EMPTY_AUTHORITY);
  const [facilityForm, setFacilityForm] = useState<FacilityForm>(EMPTY_FACILITY);
  const [removing, setRemoving] = useState<{ kind: Tab; id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [a, f, ad] = await Promise.all([
        api.get<{ authorities: AuthorityDto[] }>("/api/admin/directory/authorities"),
        api.get<{ facilities: FacilityDto[] }>("/api/admin/directory/facilities"),
        api.get<{ adapters: AdapterDto[] }>("/api/admin/adapters"),
      ]);
      setAuthorities(a.authorities);
      setFacilities(f.facilities);
      setAdapters(ad.adapters);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filteredAuthorities = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (authorities ?? []).filter(
      (a) =>
        (!q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q) || a.region.toLowerCase().includes(q)) &&
        (!authorityFilter || a.id === authorityFilter),
    );
  }, [authorities, search, authorityFilter]);

  const filteredFacilities = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (facilities ?? []).filter(
      (f) =>
        (!q || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q) || (f.city ?? "").toLowerCase().includes(q)) &&
        (!authorityFilter || f.authorityId === authorityFilter),
    );
  }, [facilities, search, authorityFilter]);

  function openNew(kind: Tab) {
    setError(null);
    if (kind === "authorities") {
      setAuthorityForm({ ...EMPTY_AUTHORITY, adapter: adapters[0]?.code ?? "" });
      setEditing({ kind, record: null });
    } else {
      setFacilityForm({ ...EMPTY_FACILITY, authorityId: authorityFilter || (authorities ?? []).find((a) => a.status === "ACTIVE")?.id || "" });
      setEditing({ kind, record: null });
    }
  }

  function openEdit(kind: Tab, record: AuthorityDto | FacilityDto) {
    setError(null);
    if (kind === "authorities") {
      const authority = record as AuthorityDto;
      setAuthorityForm({
        id: authority.id,
        name: authority.name,
        region: authority.region,
        adapter: authority.adapter,
        contactEmail: authority.contactEmail,
        webhook: authority.webhook,
        status: authority.status,
      });
    } else {
      const facility = record as FacilityDto;
      setFacilityForm({
        id: facility.id,
        name: facility.name,
        authorityId: facility.authorityId,
        city: facility.city ?? "",
        letterheadKeywords: facility.letterheadKeywords.join(", "),
        status: facility.status,
      });
    }
    setEditing({ kind, record });
  }

  async function saveAuthority() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        id: authorityForm.id.trim().toUpperCase(),
        name: authorityForm.name.trim(),
        region: authorityForm.region.trim(),
        adapter: authorityForm.adapter.trim().toUpperCase(),
        contactEmail: authorityForm.contactEmail.trim(),
        webhook: authorityForm.webhook.trim(),
        status: authorityForm.status,
      };
      if (editing?.record) {
        await api.patch(`/api/admin/directory/authorities/${encodeURIComponent(payload.id)}`, payload);
        setNotice(`${payload.id} updated. Patients see the new name the next time they file a grievance.`);
      } else {
        await api.post("/api/admin/directory/authorities", payload);
        setNotice(`${payload.id} added to the directory and is now selectable by patients.`);
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveFacility() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        id: facilityForm.id.trim().toUpperCase(),
        name: facilityForm.name.trim(),
        authorityId: facilityForm.authorityId.trim().toUpperCase(),
        city: facilityForm.city.trim(),
        letterheadKeywords: facilityForm.letterheadKeywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        status: facilityForm.status,
      };
      if (editing?.record) {
        await api.patch(`/api/admin/directory/facilities/${encodeURIComponent(payload.id)}`, payload);
        setNotice(`${payload.id} updated.`);
      } else {
        await api.post("/api/admin/directory/facilities", payload);
        setNotice(`${payload.id} added to the directory.`);
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      const path = removing.kind === "authorities" ? "authorities" : "facilities";
      await api.delete(`/api/admin/directory/${path}/${encodeURIComponent(removing.id)}`);
      setNotice(`${removing.name} removed from the directory.`);
      setRemoving(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }

  const statusTone = (status: string): "ok" | "warn" | "bad" | "muted" => {
    if (status === "ACTIVE" || status === "VERIFIED") return "ok";
    if (status === "PENDING") return "warn";
    if (status === "CLOSED" || status === "INACTIVE") return "bad";
    return "muted";
  };

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Directory</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            Health authorities and facilities offered to patients when they file a grievance. Active authorities and verified
            facilities appear in the intake form.
          </p>
        </div>
        {canManage && (
          <button className="btn primary sm" onClick={() => openNew(tab)}>
            <Icon name="plus" size={14} /> New {tab === "authorities" ? "authority" : "facility"}
          </button>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {!canManage && (
        <Alert tone="info">
          You have read access to the directory. Ask a super administrator for the “Manage directory” capability to add or edit
          entries.
        </Alert>
      )}

      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        <button className={`btn sm ${tab === "authorities" ? "primary" : "ghost"}`} onClick={() => setTab("authorities")}>
          Authorities ({authorities?.length ?? 0})
        </button>
        <button className={`btn sm ${tab === "facilities" ? "primary" : "ghost"}`} onClick={() => setTab("facilities")}>
          Facilities ({facilities?.length ?? 0})
        </button>
      </div>

      <Card flush>
        <div style={{ padding: "16px 20px 4px" }}>
          <CardHead
            title={tab === "authorities" ? "Health authorities" : "Facilities"}
            sub={tab === "authorities" ? "National and state authorities that receive grievances" : "Registered facilities patients can select"}
          />
          <div className="row" style={{ gap: 10, padding: "12px 0 8px" }}>
            <input
              className="input"
              style={{ maxWidth: 280 }}
              placeholder="Search by name, reference or city…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="select" style={{ maxWidth: 260 }} value={authorityFilter} onChange={(e) => setAuthorityFilter(e.target.value)}>
              <option value="">All authorities</option>
              {(authorities ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {(search || authorityFilter) && (
              <button
                className="btn sm ghost"
                onClick={() => {
                  setSearch("");
                  setAuthorityFilter("");
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {tab === "authorities" ? (
          !authorities ? (
            <div style={{ padding: 20 }}>
              <Spinner label="Loading authorities…" />
            </div>
          ) : filteredAuthorities.length === 0 ? (
            <EmptyState title="No authority matches this filter" hint="Clear the search or add a new authority." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Authority</th>
                    <th>Region</th>
                    <th>Adapter</th>
                    <th>Contact</th>
                    <th>Facilities</th>
                    <th>Cases</th>
                    <th>Status</th>
                    {canManage && <th />}
                  </tr>
                </thead>
                <tbody>
                  {filteredAuthorities.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="strong">{a.name}</div>
                        <div className="cell-sub mono">{a.id}</div>
                      </td>
                      <td className="small">{a.region}</td>
                      <td className="small mono">{a.adapter}</td>
                      <td className="small">{a.contactEmail}</td>
                      <td className="small">{a.facilityCount}</td>
                      <td className="small">{a.caseCount}</td>
                      <td>
                        <Badge tone={statusTone(a.status)} dot>
                          {a.status}
                        </Badge>
                      </td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                            <button className="btn sm ghost" onClick={() => openEdit("authorities", a)}>
                              Edit
                            </button>
                            <button className="btn sm ghost" onClick={() => setRemoving({ kind: "authorities", id: a.id, name: a.name })}>
                              Delete
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : !facilities ? (
          <div style={{ padding: 20 }}>
            <Spinner label="Loading facilities…" />
          </div>
        ) : filteredFacilities.length === 0 ? (
          <EmptyState title="No facility matches this filter" hint="Clear the search or add a new facility." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Facility</th>
                  <th>Authority</th>
                  <th>City</th>
                  <th>Letterhead keywords</th>
                  <th>Status</th>
                  {canManage && <th />}
                </tr>
              </thead>
              <tbody>
                {filteredFacilities.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <div className="strong">{f.name}</div>
                      <div className="cell-sub mono">{f.id}</div>
                    </td>
                    <td className="small">{authorities?.find((a) => a.id === f.authorityId)?.name ?? f.authorityId}</td>
                    <td className="small">{f.city ?? "—"}</td>
                    <td className="small faint">{f.letterheadKeywords.join(", ") || "—"}</td>
                    <td>
                      <Badge tone={statusTone(f.status)} dot>
                        {f.status}
                      </Badge>
                    </td>
                    {canManage && (
                      <td>
                        <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                          <button className="btn sm ghost" onClick={() => openEdit("facilities", f)}>
                            Edit
                          </button>
                          <button className="btn sm ghost" onClick={() => setRemoving({ kind: "facilities", id: f.id, name: f.name })}>
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="tiny faint" style={{ marginTop: 14 }}>
        Only active authorities and verified facilities are offered to patients. Retiring an authority or facility hides it from
        intake without disturbing cases that already reference it.
      </p>

      {editing?.kind === "authorities" && (
        <Modal
          title={editing.record ? `Edit ${authorityForm.id}` : "New health authority"}
          sub="The authority receives routed grievances and patient notifications."
          onClose={() => setEditing(null)}
        >
          <div className="form-grid">
            <div className="field">
              <label htmlFor="auth-id">Reference</label>
              <input
                id="auth-id"
                className="input mono"
                value={authorityForm.id}
                disabled={Boolean(editing.record)}
                onChange={(e) => setAuthorityForm({ ...authorityForm, id: e.target.value.toUpperCase() })}
                placeholder="IN-SHA-GJ"
              />
              <span className="hint">Letters, digits and dashes. Cannot be changed after creation.</span>
            </div>
            <div className="field">
              <label htmlFor="auth-name">Name</label>
              <input id="auth-name" className="input" value={authorityForm.name} onChange={(e) => setAuthorityForm({ ...authorityForm, name: e.target.value })} placeholder="Health and Family Welfare Department, Gujarat" />
            </div>
            <div className="field">
              <label htmlFor="auth-region">Region</label>
              <input id="auth-region" className="input" value={authorityForm.region} onChange={(e) => setAuthorityForm({ ...authorityForm, region: e.target.value })} placeholder="Gujarat" />
            </div>
            <div className="field">
              <label htmlFor="auth-adapter">Adapter</label>
              <select id="auth-adapter" className="select" value={authorityForm.adapter} onChange={(e) => setAuthorityForm({ ...authorityForm, adapter: e.target.value })}>
                <option value="">Select adapter…</option>
                {adapters.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} · {a.kind}
                  </option>
                ))}
              </select>
              <span className="hint">Configure new adapters under Adapters first.</span>
            </div>
            <div className="field">
              <label htmlFor="auth-email">Contact email</label>
              <input id="auth-email" className="input" type="email" value={authorityForm.contactEmail} onChange={(e) => setAuthorityForm({ ...authorityForm, contactEmail: e.target.value })} placeholder="grievance@example.gov.in" />
              <span className="hint">Case notifications are queued to this mailbox.</span>
            </div>
            <div className="field">
              <label htmlFor="auth-status">Status</label>
              <select id="auth-status" className="select" value={authorityForm.status} onChange={(e) => setAuthorityForm({ ...authorityForm, status: e.target.value })}>
                {AUTHORITY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field full">
              <label htmlFor="auth-webhook">Webhook endpoint</label>
              <input id="auth-webhook" className="input mono" value={authorityForm.webhook} onChange={(e) => setAuthorityForm({ ...authorityForm, webhook: e.target.value })} placeholder="https://sandbox.mednotice.in/in/gj/health/cases" />
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !authorityForm.id || !authorityForm.name || !authorityForm.adapter} onClick={() => void saveAuthority()}>
              {busy ? <span className="spinner" /> : "Save authority"}
            </button>
          </div>
        </Modal>
      )}

      {editing?.kind === "facilities" && (
        <Modal
          title={editing.record ? `Edit ${facilityForm.id}` : "New facility"}
          sub="Patients pick the facility where the treatment took place."
          onClose={() => setEditing(null)}
        >
          <div className="form-grid">
            <div className="field">
              <label htmlFor="fac-id">Reference</label>
              <input
                id="fac-id"
                className="input mono"
                value={facilityForm.id}
                disabled={Boolean(editing.record)}
                onChange={(e) => setFacilityForm({ ...facilityForm, id: e.target.value.toUpperCase() })}
                placeholder="FAC-IN-012"
              />
              <span className="hint">Letters, digits and dashes. Cannot be changed after creation.</span>
            </div>
            <div className="field">
              <label htmlFor="fac-name">Facility name</label>
              <input id="fac-name" className="input" value={facilityForm.name} onChange={(e) => setFacilityForm({ ...facilityForm, name: e.target.value })} placeholder="Civil Hospital, Ahmedabad" />
            </div>
            <div className="field">
              <label htmlFor="fac-authority">Health authority</label>
              <select id="fac-authority" className="select" value={facilityForm.authorityId} onChange={(e) => setFacilityForm({ ...facilityForm, authorityId: e.target.value })}>
                <option value="">Select authority…</option>
                {(authorities ?? [])
                  .filter((a) => a.status === "ACTIVE" || a.id === facilityForm.authorityId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="fac-city">City</label>
              <input id="fac-city" className="input" value={facilityForm.city} onChange={(e) => setFacilityForm({ ...facilityForm, city: e.target.value })} placeholder="Ahmedabad" />
            </div>
            <div className="field full">
              <label htmlFor="fac-keywords">Letterhead keywords</label>
              <input id="fac-keywords" className="input" value={facilityForm.letterheadKeywords} onChange={(e) => setFacilityForm({ ...facilityForm, letterheadKeywords: e.target.value })} placeholder="Civil Hospital, Ahmedabad Civil, CH-Ahmedabad" />
              <span className="hint">Comma separated. Used to detect document tampering against the facility letterhead.</span>
            </div>
            <div className="field">
              <label htmlFor="fac-status">Status</label>
              <select id="fac-status" className="select" value={facilityForm.status} onChange={(e) => setFacilityForm({ ...facilityForm, status: e.target.value })}>
                {FACILITY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <span className="hint">Only verified facilities are offered to patients.</span>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={busy || !facilityForm.id || !facilityForm.name || !facilityForm.authorityId}
              onClick={() => void saveFacility()}
            >
              {busy ? <span className="spinner" /> : "Save facility"}
            </button>
          </div>
        </Modal>
      )}

      {removing && (
        <Modal title={`Delete ${removing.name}?`} sub="This cannot be undone." onClose={() => setRemoving(null)}>
          <p className="small muted">
            {removing.kind === "authorities"
              ? "The authority is removed from the directory and from patient intake. Authorities that still have facilities or cases cannot be deleted — retire them instead."
              : "The facility is removed from the directory and from patient intake. Facilities that still have cases cannot be deleted — close them instead."}
          </p>
          {authorities?.find((a) => a.id === removing.id)?.updatedAt && (
            <p className="tiny faint">Last updated {formatDate(authorities.find((a) => a.id === removing.id)!.updatedAt)}</p>
          )}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button className="btn danger" disabled={busy} onClick={() => void remove()}>
              {busy ? <span className="spinner" /> : "Delete"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
