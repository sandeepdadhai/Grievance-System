import { useEffect, useState } from "react";
import { api, formatDate } from "../../api";
import { useAuth } from "../../auth";
import type { AdapterDto } from "../../types";
import { Alert, Badge, Card, CardHead, Icon, Modal, Spinner } from "../../components/ui";

const COUNTRIES = ["US", "DE", "GB", "IN", "SG", "BR"];

export default function AdminAdapters() {
  const { user } = useAuth();
  const isAdmin = user?.role === "SUPER_ADMIN";
  const [adapters, setAdapters] = useState<AdapterDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ adapter: AdapterDto; caseId: string; result: Record<string, unknown> | null; busy: boolean } | null>(null);
  const [editing, setEditing] = useState<AdapterDto | "new" | null>(null);
  const [form, setForm] = useState({ code: "", name: "", country: "US", kind: "FHIR", endpoint: "", simulate: true, enabled: true, mapping: "{}" });
  const [expandedMapping, setExpandedMapping] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.get<{ adapters: AdapterDto[] }>("/api/admin/adapters");
      setAdapters(res.adapters);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(adapter: AdapterDto, field: "enabled" | "simulate") {
    setError(null);
    try {
      await api.patch(`/api/admin/adapters/${adapter.code}`, { [field]: !adapter[field] });
      setNotice(`${adapter.code}: ${field} ${adapter[field] ? "disabled" : "enabled"}.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function openNew() {
    setForm({ code: "", name: "", country: "US", kind: "FHIR", endpoint: "https://", simulate: true, enabled: true, mapping: "{\n  \n}" });
    setEditing("new");
  }

  function openEdit(adapter: AdapterDto) {
    setForm({
      code: adapter.code,
      name: adapter.name,
      country: adapter.country,
      kind: adapter.kind,
      endpoint: adapter.endpoint,
      simulate: adapter.simulate,
      enabled: adapter.enabled,
      mapping: JSON.stringify(adapter.mapping, null, 2),
    });
    setEditing(adapter);
  }

  async function save() {
    setError(null);
    let mapping: Record<string, unknown>;
    try {
      mapping = JSON.parse(form.mapping || "{}");
    } catch {
      setError("Mapping must be valid JSON.");
      return;
    }
    try {
      await api.post("/api/admin/adapters", { ...form, mapping });
      setNotice(`${form.code} saved. New configs take effect on the next routing attempt.`);
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function runPreview() {
    if (!preview) return;
    setPreview({ ...preview, busy: true, result: null });
    try {
      const result = await api.post<Record<string, unknown>>(`/api/admin/adapters/${preview.adapter.code}/preview`, { caseId: preview.caseId.trim().toUpperCase() });
      setPreview({ ...preview, busy: false, result });
    } catch (err) {
      setError((err as Error).message);
      setPreview({ ...preview, busy: false, result: null });
    }
  }

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Integration adapters</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            Adding a jurisdiction is a configuration change: pick a protocol, endpoint and schema mapping.
          </p>
        </div>
        {isAdmin && <button className="btn primary sm" onClick={openNew}><Icon name="plus" size={14} /> New adapter</button>}
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {!adapters && <Spinner label="Loading adapters…" />}

      <div className="grid-2">
        {adapters?.map((adapter) => {
          const delivered = adapter.deliveries.find((d) => d.status === "DELIVERED")?.count ?? 0;
          const failed = adapter.deliveries.find((d) => d.status === "FAILED")?.count ?? 0;
          return (
            <Card key={adapter.code}>
              <div className="row-between" style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="mono" style={{ fontSize: 14, fontWeight: 650 }}>{adapter.code}</span>
                    <Badge tone="info">{adapter.kind}</Badge>
                    <Badge tone="muted">{adapter.country}</Badge>
                    {adapter.simulate && <Badge tone="warn">sandbox</Badge>}
                  </div>
                  <div className="small" style={{ marginTop: 4 }}>{adapter.name}</div>
                  <div className="tiny faint mono" style={{ marginTop: 4, wordBreak: "break-all" }}>{adapter.endpoint}</div>
                </div>
                <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
                  <Badge tone={adapter.enabled ? "ok" : "bad"} dot>{adapter.enabled ? "Enabled" : "Disabled"}</Badge>
                  <span className="tiny faint">updated {formatDate(adapter.createdAt, { hour: undefined, minute: undefined })}</span>
                </div>
              </div>

              <div className="divider" />
              <div className="row" style={{ gap: 6 }}>
                <span className="chip">Auth {adapter.authType}</span>
                <span className="chip">Delivered {delivered}</span>
                <span className="chip" style={{ color: failed ? "var(--danger)" : undefined }}>Failed {failed}</span>
                {adapter.hasCredentials && <span className="chip"><Icon name="lock" size={11} /> credentials stored</span>}
              </div>

              <div className="row" style={{ gap: 8, marginTop: 14 }}>
                <button
                  className="btn sm"
                  onClick={() => setPreview({ adapter, caseId: "", result: null, busy: false })}
                >
                  Preview payload
                </button>
                <button className="btn sm ghost" onClick={() => setExpandedMapping(expandedMapping === adapter.code ? null : adapter.code)}>
                  {expandedMapping === adapter.code ? "Hide mapping" : "View mapping"}
                </button>
                {isAdmin && (
                  <>
                    <button className="btn sm ghost" onClick={() => void toggle(adapter, "enabled")}>{adapter.enabled ? "Disable" : "Enable"}</button>
                    <button className="btn sm ghost" onClick={() => void toggle(adapter, "simulate")}>{adapter.simulate ? "Use live endpoint" : "Simulate"}</button>
                    <button className="btn sm ghost" onClick={() => openEdit(adapter)}>Edit</button>
                  </>
                )}
              </div>

              {expandedMapping === adapter.code && (
                <pre className="payload" style={{ marginTop: 12 }}>{JSON.stringify(adapter.mapping, null, 2)}</pre>
              )}
            </Card>
          );
        })}
      </div>

      <Card style={{ marginTop: 18 }}>
        <CardHead title="Schema translation model" sub="No core code changes when onboarding a new authority" />
        <div className="grid-3">
          {[
            ["FHIR R4", "Patient + Task + DocumentReference transaction bundle, priority mapped to stat/urgent/asap/routine."],
            ["HL7 v2.5", "Pipe-delimited ORU^R01 with narrative, priority and document digest OBX segments."],
            ["REST / SOAP", "Template mapping ({{caseId}}, {{priority}}, {{complaint}}) rendered into JSON or a SOAP 1.2 envelope."],
          ].map(([title, body]) => (
            <div key={title}>
              <div className="label">{title}</div>
              <p className="small muted" style={{ marginTop: 6 }}>{body}</p>
            </div>
          ))}
        </div>
      </Card>

      {preview && (
        <Modal title={`Preview · ${preview.adapter.code}`} sub="Renders the outbound payload for a real case without transmitting." onClose={() => setPreview(null)}>
          <div className="field">
            <label htmlFor="preview-case">Case reference</label>
            <input id="preview-case" className="input mono" value={preview.caseId} onChange={(e) => setPreview({ ...preview, caseId: e.target.value })} placeholder="CASE-2026-000101" />
          </div>
          <div className="modal-actions" style={{ marginTop: 4 }}>
            <button className="btn ghost" onClick={() => setPreview(null)}>Close</button>
            <button className="btn primary" disabled={preview.busy || preview.caseId.length < 4} onClick={() => void runPreview()}>
              {preview.busy ? <span className="spinner" /> : "Render payload"}
            </button>
          </div>
          {preview.result && (
            <div style={{ marginTop: 14 }}>
              <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                <Badge tone="info">{String(preview.result.contentType)}</Badge>
                <span className="small muted">{String(preview.result.summary)}</span>
              </div>
              <pre className="payload">{String(preview.result.payload)}</pre>
            </div>
          )}
        </Modal>
      )}

      {editing && (
        <Modal title={editing === "new" ? "New adapter" : `Edit ${form.code}`} sub="Endpoint, protocol and field mapping." onClose={() => setEditing(null)}>
          <div className="form-grid">
            <div className="field"><label htmlFor="ad-code">Code</label><input id="ad-code" className="input mono" value={form.code} disabled={editing !== "new"} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="FR-FHIR" /></div>
            <div className="field"><label htmlFor="ad-name">Name</label><input id="ad-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="ad-country">Country</label><select id="ad-country" className="select" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>{COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div className="field"><label htmlFor="ad-kind">Protocol</label><select id="ad-kind" className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{["FHIR", "HL7v2", "REST", "SOAP"].map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
            <div className="field full"><label htmlFor="ad-endpoint">Endpoint</label><input id="ad-endpoint" className="input mono" value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} /></div>
            <div className="field full">
              <label htmlFor="ad-mapping">Mapping JSON</label>
              <textarea id="ad-mapping" className="textarea mono" style={{ minHeight: 160, fontSize: 12 }} value={form.mapping} onChange={(e) => setForm({ ...form, mapping: e.target.value })} />
              <span className="hint">Use {"{{caseId}}"}, {"{{priority}}"}, {"{{complaint}}"} and other payload fields.</span>
            </div>
          </div>
          <label className="check"><input type="checkbox" checked={form.simulate} onChange={(e) => setForm({ ...form, simulate: e.target.checked })} /><span>Simulate delivery (no outbound network call)</span></label>
          <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /><span>Adapter enabled</span></label>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" disabled={!form.code || !form.name || !form.endpoint} onClick={() => void save()}>Save adapter</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
