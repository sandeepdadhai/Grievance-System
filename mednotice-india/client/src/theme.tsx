import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Runtime theming.
 *
 * All palettes ship inside the shared stylesheet; the server only stores which
 * preset each surface should use. The provider reads that on load and writes
 * `data-theme` on <html>, which is what the `:root[data-theme="…"]` blocks in
 * styles.css key off. `preview()` lets the Appearance page show a candidate
 * palette without saving it.
 */
export type ThemeFamily = "dark" | "government" | "enterprise";
export type ThemeSide = "patient" | "admin";

export type ThemePreset = {
  id: string;
  name: string;
  family: ThemeFamily;
  description: string;
  swatches: string[];
};

export type ThemeSettings = {
  patient: string;
  admin: string;
  updatedAt: string | null;
  updatedBy: string | null;
  defaultTheme: string;
  presets: ThemePreset[];
};

type ThemeContextValue = {
  settings: ThemeSettings | null;
  side: ThemeSide;
  applied: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<ThemeSettings | null>;
  preview: (themeId: string | null) => void;
};

export const DEFAULT_THEME = "midnight";

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ side, children }: { side: ThemeSide; children: ReactNode }) {
  const [settings, setSettings] = useState<ThemeSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/public/theme", { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`Theme service returned HTTP ${res.status}`);
      const body = (await res.json()) as { theme: ThemeSettings };
      setSettings(body.theme);
      setError(null);
      return body.theme;
    } catch (err) {
      // Styling is not worth blocking the page: fall back to the built-in
      // default palette and surface the problem in the Appearance page only.
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saved = settings ? settings[side] : DEFAULT_THEME;
  const applied = preview ?? saved;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = applied;
    const family = settings?.presets.find((preset) => preset.id === applied)?.family ?? (applied === "midnight" ? "dark" : "light");
    root.style.colorScheme = family === "dark" ? "dark" : "light";
  }, [applied, settings]);

  const value = useMemo<ThemeContextValue>(
    () => ({ settings, side, applied, loading, error, refresh, preview: setPreview }),
    [settings, side, applied, loading, error, refresh],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside a ThemeProvider");
  return context;
}
