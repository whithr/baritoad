// App settings — the few user-facing preferences that aren't per-song.
// Persisted in localStorage (the webview's own store; nothing leaves the
// machine). The player's stage themes are a separate store (themes.ts).

import { GROUP_BYS, type GroupBy } from "./categories";

/** Chrome colour scheme (DESIGN.md). The TV stage follows its own theme. */
export type Scheme = "classic" | "night";
export type UiScale = "normal" | "large";

export interface Settings {
  scheme: Scheme;
  /** Pixel Operator for chrome; off = the smooth stack (fractional-DPI screens). */
  pixelFont: boolean;
  /** Large = 125 % chrome. Lyrics have their own couch-sized type. */
  uiScale: UiScale;
  /** Where the bench opens a song: the last view used. (A stored "focus"
   *  from before that view was removed parses back to Lanes.) */
  benchView: "text" | "lanes";
  /** Last shift scope, remembered across songs (the bench's default). */
  shiftScope: "word" | "line" | "tail";
  /** Where song import runs: the graphics card (DirectML separation and word
   *  timing, each falling back to the CPU on its own) or the processor only,
   *  leaving the GPU free. */
  importOn: "gpu" | "cpu";
  /** Gaming mode: what import does while the app in front is a game using
   *  the graphics card — separate on the processor (default), pause, or
   *  keep using the graphics card. Only matters with importOn "gpu". */
  whileGaming: "cpu" | "pause" | "gpu";
  /** Library › View › Group by (the song list's group headers). */
  libraryGroupBy: GroupBy;
  /** Look songs' lyrics up online (LRCLIB) when they have none — off until
   *  the person ticks it once in an import dialog (PLAN.md §2: features
   *  reach out only when asked); remembered after. */
  lookupLyrics: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  scheme: "classic",
  pixelFont: true,
  uiScale: "normal",
  benchView: "lanes",
  shiftScope: "line",
  importOn: "gpu",
  whileGaming: "cpu",
  libraryGroupBy: "none",
  lookupLyrics: false,
};

export const SETTINGS_KEY = "karascape.settings.v1";

const SCHEMES: Scheme[] = ["classic", "night"];
const SCALES: UiScale[] = ["normal", "large"];
const VIEWS: Settings["benchView"][] = ["text", "lanes"];
const SCOPES: Settings["shiftScope"][] = ["word", "line", "tail"];
const IMPORT_ON: Settings["importOn"][] = ["gpu", "cpu"];
const WHILE_GAMING: Settings["whileGaming"][] = ["cpu", "pause", "gpu"];

const pick = <T,>(allowed: readonly T[], v: unknown, fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** Parse a stored settings blob; unknown or malformed fields fall back to
 *  defaults so an old/corrupt blob never breaks startup. Blobs from before
 *  Karascape 98 carry `theme: light|dark`, which maps to classic/night. */
export function parseSettings(raw: string | null | undefined): Settings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof Settings | "theme", unknown>>;
    const legacy = v.theme === "dark" ? "night" : v.theme === "light" ? "classic" : undefined;
    return {
      scheme: pick(SCHEMES, v.scheme ?? legacy, DEFAULT_SETTINGS.scheme),
      pixelFont: typeof v.pixelFont === "boolean" ? v.pixelFont : DEFAULT_SETTINGS.pixelFont,
      uiScale: pick(SCALES, v.uiScale, DEFAULT_SETTINGS.uiScale),
      benchView: pick(VIEWS, v.benchView, DEFAULT_SETTINGS.benchView),
      shiftScope: pick(SCOPES, v.shiftScope, DEFAULT_SETTINGS.shiftScope),
      importOn: pick(IMPORT_ON, v.importOn, DEFAULT_SETTINGS.importOn),
      whileGaming: pick(WHILE_GAMING, v.whileGaming, DEFAULT_SETTINGS.whileGaming),
      libraryGroupBy: pick(GROUP_BYS, v.libraryGroupBy, DEFAULT_SETTINGS.libraryGroupBy),
      lookupLyrics: typeof v.lookupLyrics === "boolean" ? v.lookupLyrics : DEFAULT_SETTINGS.lookupLyrics,
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

/** Stamp the appearance on the document so the CSS tokens switch. */
export function applyAppearance(s: Pick<Settings, "scheme" | "pixelFont" | "uiScale">): void {
  if (typeof document === "undefined") return;
  const d = document.documentElement.dataset;
  d.scheme = s.scheme;
  d.pixelFont = s.pixelFont ? "on" : "off";
  d.uiScale = s.uiScale;
}
