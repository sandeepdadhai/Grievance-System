import { useEffect, useState } from "react";
import { api, formatDate } from "../../api";
import { useTheme } from "../../theme";
import { Icon } from "../../components/ui";

type Side = "patient" | "admin";

const SURFACES: { key: Side; title: string; description: string; note: string }[] = [
  {
    key: "patient",
    title: "Patient portal",
    description: "The public application where people file grievances, upload records and track a case.",
    note: "Patients see the new palette on their next page load.",
  },
  {
    key: "admin",
    title: "Staff console",
    description: "This console — reviewers, facility officers, auditors and administrators.",
    note: "Previewed live in this window as soon as you pick a palette; save to publish it to every staff member.",
  },
];

const FAMILY_LABEL: Record<string, string> = {
  dark: "Default dark",
  government: "Government",
  enterprise: "Enterprise",
};

export default function AdminTheme() {
  const { settings, loading, error: themeError, refresh, preview } = useTheme();
  const [draft, setDraft] = useState<{ patient: string; admin: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setDraft((current) => current ?? { patient: settings.patient, admin: settings.admin });
  }, [settings]);

  // A preview is a viewing aid only: never leave it applied on the way out.
  useEffect(() => () => preview(null), [preview]);

  const dirty = Boolean(draft && settings && (draft.patient !== settings.patient || draft.admin !== settings.admin));

  function choose(side: Side, themeId: string) {
    setError(null);
    setNotice(null);
    setDraft((current) => (current ? { ...current, [side]: themeId } : current));
    if (side === "admin") preview(themeId);
  }

  function discard() {
    if (!settings) return;
    setDraft({ patient: settings.patient, admin: settings.admin });
    preview(null);
    setError(null);
    setNotice(null);
  }

  function resetToDefault() {
    if (!settings) return;
    setDraft({ patient: settings.defaultTheme, admin: settings.defaultTheme });
    preview(settings.defaultTheme);
    setError(null);
    setNotice("Default palette selected — save to apply it to everyone.");
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.patch<{ theme: { patient: string; admin: string } }>("/api/admin/theme", draft);
      preview(null);
      await refresh();
      setDraft({ patient: result.theme.patient, admin: result.theme.admin });
      setNotice("Appearance saved. The patient portal and staff console both pick it up on their next page load.");
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
          <h2>Appearance</h2>
          <p className="small muted" style={{ marginTop: 6, maxWidth: 760 }}>
            Choose the palette for the patient portal and for this staff console independently. Palettes ship with the
            application, so a switch needs no rebuild or redeploy — visitors get it on their next page load.
          </p>
        </div>
        <span className="chip">Super administrator</span>
      </div>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}
      {themeError && (
        <div className="alert warn">
          Theme service unreachable ({themeError}) — showing the built-in default palette.{" "}
          <button type="button" className="btn-link" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      {loading && !draft && <p className="small muted">Loading palettes…</p>}

      {draft &&
        SURFACES.map((surface) => {
          const selected = settings?.presets.find((preset) => preset.id === draft[surface.key]);
          return (
            <div className="card" key={surface.key} style={{ marginBottom: 16 }}>
              <div className="card-head">
                <div>
                  <h3>{surface.title}</h3>
                  <p className="small muted" style={{ marginTop: 4 }}>{surface.description}</p>
                </div>
                <span className="chip">{selected?.name ?? draft[surface.key]}</span>
              </div>

              <div className="theme-grid" role="radiogroup" aria-label={`${surface.title} theme`}>
                {(settings?.presets ?? []).map((preset) => {
                  const active = draft[surface.key] === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`theme-option ${active ? "selected" : ""}`}
                      onClick={() => choose(surface.key, preset.id)}
                    >
                      <span className="theme-preview" aria-hidden="true">
                        {preset.swatches.map((colour) => (
                          <span key={colour} style={{ background: colour }} />
                        ))}
                      </span>
                      <span className="theme-option-body">
                        <span className="theme-option-name">{preset.name}</span>
                        <span className="theme-option-desc">{preset.description}</span>
                        <span>
                          <span className="badge muted">{FAMILY_LABEL[preset.family] ?? preset.family}</span>
                        </span>
                      </span>
                      {active && (
                        <span className="theme-option-check" aria-hidden="true">
                          <Icon name="check" size={16} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <p className="small faint" style={{ marginTop: 10 }}>{surface.note}</p>
            </div>
          );
        })}

      <div className="card">
        <div className="row-between">
          <p className="small muted" style={{ maxWidth: 580 }}>
            Government palettes follow real departmental conventions: Assam health directorate portals (green masthead,
            serif headings, tricolour rule), US federal health agencies (navy masthead, action blue, squared corners) and
            Chinese health commissions (red masthead, gold rules).{" "}
            {settings?.updatedAt
              ? `Last change ${formatDate(settings.updatedAt, { hour: "2-digit", minute: "2-digit" })}${settings.updatedBy ? ` by ${settings.updatedBy}` : ""}.`
              : "The built-in default palette is in use."}
          </p>
          <div className="row" style={{ gap: 10 }}>
            <button type="button" className="btn ghost sm" disabled={!dirty || busy} onClick={discard}>
              Discard
            </button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={resetToDefault}>
              Reset to default
            </button>
            <button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save appearance"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
