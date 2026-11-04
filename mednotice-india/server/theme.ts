import { get, nowIso, run } from "./db.js";

/**
 * Interface themes.
 *
 * A theme is a set of CSS custom properties shipped with both bundles; the
 * database only stores which preset each surface should use. That keeps a
 * theme change to a single row write — no rebuild, no redeploy, and the
 * patient portal and the staff console stay in step because they read the
 * same record.
 */
export type ThemeFamily = "dark" | "government" | "enterprise";
export type ThemeSide = "patient" | "admin";

export type ThemePreset = {
  id: string;
  name: string;
  family: ThemeFamily;
  /** Shown in the Appearance page so an administrator knows what they pick. */
  description: string;
  /** Four representative colours for the preview strip. */
  swatches: string[];
};

export const DEFAULT_THEME = "midnight";

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "midnight",
    name: "Midnight control room",
    family: "dark",
    description:
      "The current dark operations palette: near-black surfaces, teal signalling, dense tables. Best for 24×7 monitoring desks.",
    swatches: ["#070c15", "#111c30", "#2dd4bf", "#7aa2ff"],
  },
  {
    id: "assam-health",
    name: "Assam Health Department",
    family: "government",
    description:
      "Formal state-government presentation modelled on Assam health directorate portals: white and parchment surfaces, deep green banner, serif headings, square corners and the tricolour rule above the page.",
    swatches: ["#ffffff", "#eef3e7", "#0d6b3f", "#14538c"],
  },
  {
    id: "national-health",
    name: "National health programme",
    family: "government",
    description:
      "Government-of-India flavour for central programme reviews: white panels, navy masthead, saffron highlights and serif headings.",
    swatches: ["#ffffff", "#eaf0f8", "#12457a", "#d97706"],
  },
  {
    id: "us-health",
    name: "US federal health (HHS)",
    family: "government",
    description:
      "United States federal health style, following HHS, Medicare.gov and CDC conventions: navy masthead, action blue, grey page with hairline borders, squared corners and heavy sans headings.",
    swatches: ["#112e51", "#ffffff", "#005ea2", "#ffbe2e"],
  },
  {
    id: "china-health",
    name: "China health commission",
    family: "government",
    description:
      "Chinese health-commission style, following National Health Commission portals: deep red masthead with gold hairlines, warm off-white page, squared corners and bold sans headings.",
    swatches: ["#9e1b1b", "#faf6f1", "#b81b22", "#d4a017"],
  },
  {
    id: "enterprise",
    name: "Enterprise light",
    family: "enterprise",
    description:
      "Modern enterprise look for private hospital groups and health-tech partners: white cards, indigo accents, generous radii and soft elevation.",
    swatches: ["#ffffff", "#f4f6fb", "#4f46e5", "#0ea5e9"],
  },
];

export type ThemeSettings = {
  patient: string;
  admin: string;
  updatedAt: string | null;
  updatedBy: string | null;
  defaultTheme: string;
  presets: ThemePreset[];
};

/** Theme setting rows are stored under this single key. */
const SETTINGS_KEY = "theme";

type StoredValue = { patient?: unknown; admin?: unknown };
type SettingsRow = { value: string; updated_at: string; updated_by: string | null };

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && THEME_PRESETS.some((preset) => preset.id === value);
}

function readStored(): { value: StoredValue; row: SettingsRow | undefined } {
  const row = get<SettingsRow>("SELECT value, updated_at, updated_by FROM settings WHERE key = ?", SETTINGS_KEY);
  if (!row) return { value: {}, row };
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return { value: parsed && typeof parsed === "object" ? (parsed as StoredValue) : {}, row };
  } catch {
    // A malformed row must not take the portal down: fall back to the defaults.
    return { value: {}, row };
  }
}

export function getThemeSettings(): ThemeSettings {
  const { value, row } = readStored();
  return {
    patient: isThemeId(value.patient) ? value.patient : DEFAULT_THEME,
    admin: isThemeId(value.admin) ? value.admin : DEFAULT_THEME,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    defaultTheme: DEFAULT_THEME,
    presets: THEME_PRESETS,
  };
}

export function setThemeSettings(input: { patient?: string; admin?: string; actor: string }): ThemeSettings {
  const current = getThemeSettings();
  const next = {
    patient: isThemeId(input.patient) ? input.patient : current.patient,
    admin: isThemeId(input.admin) ? input.admin : current.admin,
  };
  const now = nowIso();
  run(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    SETTINGS_KEY,
    JSON.stringify(next),
    now,
    input.actor,
  );
  return getThemeSettings();
}
