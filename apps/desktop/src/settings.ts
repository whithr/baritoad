// App settings — the few user-facing preferences that aren't per-song.
// Persisted in localStorage (the webview's own store; nothing leaves the
// machine). The player's stage themes are a separate store (themes.ts).

export type AppTheme = "light" | "dark";

export interface Settings {
  /** App chrome theme. The TV player is always dark and ignores this. */
  theme: AppTheme;
  /** Where the bench opens a song: remembered view zoom level. */
  benchView: "text" | "lanes" | "focus";
  /** Last shift scope, remembered across songs (the bench's default). */
  shiftScope: "word" | "line" | "tail";
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  benchView: "lanes",
  shiftScope: "line",
};

export const SETTINGS_KEY = "karascape.settings.v1";

const THEMES: AppTheme[] = ["light", "dark"];
const VIEWS: Settings["benchView"][] = ["text", "lanes", "focus"];
const SCOPES: Settings["shiftScope"][] = ["word", "line", "tail"];

/** Parse a stored settings blob; unknown or malformed fields fall back to
 *  defaults so an old/corrupt blob never breaks startup. */
export function parseSettings(raw: string | null | undefined): Settings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
    return {
      theme: THEMES.includes(v.theme as AppTheme) ? (v.theme as AppTheme) : DEFAULT_SETTINGS.theme,
      benchView: VIEWS.includes(v.benchView as Settings["benchView"])
        ? (v.benchView as Settings["benchView"])
        : DEFAULT_SETTINGS.benchView,
      shiftScope: SCOPES.includes(v.shiftScope as Settings["shiftScope"])
        ? (v.shiftScope as Settings["shiftScope"])
        : DEFAULT_SETTINGS.shiftScope,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadSettings(): Settings {
  return parseSettings(storage()?.getItem(SETTINGS_KEY));
}

export function saveSettings(s: Settings): void {
  try {
    storage()?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // quota / private mode: the in-memory copy still applies this session
  }
}

/** Stamp the theme on the document so CSS tokens switch (hw.css). */
export function applyTheme(theme: AppTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}
