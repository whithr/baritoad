// Player themes: a theme is DATA — background spec, lyric colors, effect
// styling, visualizer choice — applied to the full-screen player as CSS
// variables plus a static background layer. Themes style the PLAYER STAGE
// ONLY; the app's own chrome stays Digital Dash (DESIGN.md).
//
// Guardrails live in code, not knobs (PRODUCT.md accessibility commitments):
// sung vs not-yet-sung never rides hue alone (the wipe's fill edge and the
// sung glow carry it), and text sizes are untouched (couch-readable). The
// editor surfaces a live AA contrast readout via the helpers below.
//
// Storage is a single localStorage blob (user themes + default + per-song
// overrides). Built-in presets live here in code and are never persisted;
// "duplicate to customize" copies one into the user list.

export type ThemeBackground =
  | { kind: "cover"; blurPx: number; dim: number }
  | { kind: "color"; color: string }
  | { kind: "image"; path: string; blurPx: number; dim: number };

export type VisualizerMode = "off" | "pulse" | "bars";

export interface ThemeSpec {
  id: string;
  name: string;
  /** Built-ins are code, not data — immutable, undeletable. */
  builtin?: boolean;
  background: ThemeBackground;
  /** Lyric text at rest (resting lines dim via opacity, not a second color). */
  resting: string;
  /** Sung words, the wipe fill, and the sung glow. */
  sung: string;
  /** Live chrome inside the stage: lead-in pips, wait meter, cue accents. */
  accent: string;
  /** Glow strength multiplier, 0 (off) – 1.5. */
  glow: number;
  /** Font family for lyric lines; null = the app's own stack (Barlow). */
  font: string | null;
  /** 3-2-1 lead-in pips on lines that follow a silence. */
  pips: boolean;
  /** The lead-in bar that runs into a line after a pause (in the accent
   *  colour). On unless false — themes saved before it existed have none. */
  leadBar?: boolean;
  visualizer: VisualizerMode;
}

/** The pre-98 player look, kept as a selectable preset. */
export const DIGITAL_DASH: ThemeSpec = {
  id: "digital-dash",
  name: "Digital Dash",
  builtin: true,
  background: { kind: "cover", blurPx: 48, dim: 0.78 },
  resting: "#e9edf3",
  sung: "#45e0d8",
  accent: "#f2a33c",
  glow: 1,
  font: null,
  pips: true,
  leadBar: true,
  visualizer: "off",
};

/** baritoad 98's own stage: near-black with cyan sung words — the
 *  default and the fallback for everything (DESIGN.md). */
export const BARITOAD_98: ThemeSpec = {
  id: "baritoad-98",
  name: "baritoad 98",
  builtin: true,
  background: { kind: "color", color: "#000010" },
  resting: "#ffffff",
  sung: "#00ffff",
  accent: "#ffff00",
  glow: 0.8,
  font: null,
  pips: true,
  leadBar: true,
  visualizer: "off",
};

export const DEFAULT_THEME = BARITOAD_98;

export const BUILTIN_THEMES: ThemeSpec[] = [
  BARITOAD_98,
  DIGITAL_DASH,
  {
    id: "neon-stage",
    name: "Neon Stage",
    builtin: true,
    background: { kind: "color", color: "#0d0716" },
    resting: "#f3e9f6",
    sung: "#ee7fdb",
    accent: "#8ff2ec",
    glow: 1.3,
    font: null,
    pips: true,
    leadBar: true,
    visualizer: "bars",
  },
  {
    id: "midnight-snow",
    name: "Midnight Snow",
    builtin: true,
    background: { kind: "color", color: "#0a1220" },
    resting: "#dfe9f5",
    sung: "#9fc7ff",
    accent: "#e9edf3",
    glow: 0.7,
    font: null,
    pips: false,
    leadBar: true,
    visualizer: "pulse",
  },
  {
    id: "sunset-vhs",
    name: "Sunset VHS",
    builtin: true,
    background: { kind: "color", color: "#160b0e" },
    resting: "#f6e3d3",
    sung: "#ffb057",
    accent: "#ee7fdb",
    glow: 1.15,
    font: null,
    pips: true,
    leadBar: true,
    visualizer: "bars",
  },
  {
    id: "stage-lights-off",
    name: "Lights Off",
    builtin: true,
    background: { kind: "color", color: "#000000" },
    resting: "#e9edf3",
    sung: "#49e57d",
    accent: "#49e57d",
    glow: 0.85,
    font: null,
    pips: false,
    leadBar: true,
    visualizer: "off",
  },
];

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const THEME_STORE_KEY = "baritoad.themes.v1";
const STORE_KEY = THEME_STORE_KEY;

export interface ThemeStore {
  /** User-made themes (duplicated from presets, then edited). */
  themes: ThemeSpec[];
  /** The app-wide default; a built-in or user id. */
  defaultId: string;
  /** Per-song pins: song id → theme id. */
  songOverrides: Record<string, string>;
}

const EMPTY_STORE: ThemeStore = {
  themes: [],
  defaultId: DEFAULT_THEME.id,
  songOverrides: {},
};

export function loadThemeStore(): ThemeStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...EMPTY_STORE, songOverrides: {} };
    const p = JSON.parse(raw) as Partial<ThemeStore>;
    return {
      themes: Array.isArray(p.themes) ? p.themes.filter(isThemeSpec) : [],
      defaultId: typeof p.defaultId === "string" ? p.defaultId : DEFAULT_THEME.id,
      songOverrides:
        p.songOverrides && typeof p.songOverrides === "object" ? { ...p.songOverrides } : {},
    };
  } catch {
    return { ...EMPTY_STORE, songOverrides: {} };
  }
}

export function saveThemeStore(store: ThemeStore): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // storage unavailable — the theme still applies this session
  }
}

function isThemeSpec(t: unknown): t is ThemeSpec {
  const s = t as ThemeSpec;
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    !!s.background &&
    typeof s.resting === "string" &&
    typeof s.sung === "string" &&
    typeof s.accent === "string"
  );
}

/** All themes visible to pickers: built-ins first, then the user's. */
export function allThemes(store: ThemeStore): ThemeSpec[] {
  return [...BUILTIN_THEMES, ...store.themes];
}

export function themeById(store: ThemeStore, id: string | null | undefined): ThemeSpec | null {
  if (!id) return null;
  return allThemes(store).find((t) => t.id === id) ?? null;
}

/** Song override → app default → baritoad 98. Never returns null. */
export function resolveTheme(store: ThemeStore, songId?: number | null): ThemeSpec {
  const pin = songId != null ? themeById(store, store.songOverrides[String(songId)]) : null;
  return pin ?? themeById(store, store.defaultId) ?? DEFAULT_THEME;
}

/** Copy a theme into the user list under a fresh id/name. */
export function duplicateTheme(store: ThemeStore, sourceId: string): ThemeStore | null {
  const src = themeById(store, sourceId);
  if (!src) return null;
  const base = src.name.replace(/ copy( \d+)?$/, "");
  const names = new Set(allThemes(store).map((t) => t.name));
  let name = `${base} copy`;
  for (let n = 2; names.has(name); n++) name = `${base} copy ${n}`;
  const ids = new Set(allThemes(store).map((t) => t.id));
  let id = `user-${slug(name)}`;
  for (let n = 2; ids.has(id); n++) id = `user-${slug(name)}-${n}`;
  const copy: ThemeSpec = { ...src, id, name, builtin: false };
  return { ...store, themes: [...store.themes, copy] };
}

export function updateTheme(store: ThemeStore, theme: ThemeSpec): ThemeStore {
  if (theme.builtin) return store; // built-ins are code
  return {
    ...store,
    themes: store.themes.map((t) => (t.id === theme.id ? theme : t)),
  };
}

export function deleteTheme(store: ThemeStore, id: string): ThemeStore {
  const overrides = Object.fromEntries(
    Object.entries(store.songOverrides).filter(([, v]) => v !== id),
  );
  return {
    ...store,
    themes: store.themes.filter((t) => t.id !== id || t.builtin),
    defaultId: store.defaultId === id ? DEFAULT_THEME.id : store.defaultId,
    songOverrides: overrides,
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// ---------------------------------------------------------------------------
// CSS application — the theme as a var bag on .player-stage. Fallbacks in
// win98/stage.css equal the baritoad 98 theme, so "no theme" renders the same.
// ---------------------------------------------------------------------------

/** rgba() step of a hex color — the theme's glow halo (mirrors the token
 *  families' `*-glow` pattern). */
export function glowColor(hex: string, alpha = 0.35): string {
  const c = parseHex(hex);
  if (!c) return `rgba(69, 224, 216, ${alpha})`; // cyan-glow fallback
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

export function themeCssVars(t: ThemeSpec): Record<string, string> {
  const vars: Record<string, string> = {
    "--th-rest": t.resting,
    "--th-sung": t.sung,
    "--th-sung-glow": glowColor(t.sung),
    "--th-accent": t.accent,
    "--th-accent-glow": glowColor(t.accent),
    "--th-glow": String(t.glow),
  };
  if (t.font) vars["--th-font"] = `${JSON.stringify(t.font)}, Barlow, "Segoe UI", system-ui, sans-serif`;
  return vars;
}

// ---------------------------------------------------------------------------
// contrast (WCAG 2.1 relative luminance) — the editor's AA readout
// ---------------------------------------------------------------------------

export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number | null {
  const c = parseHex(hex);
  if (!c) return null;
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio between two hex colors; null when unparseable. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la == null || lb == null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The ground a theme's text actually sits on, for the contrast readout —
 *  image/cover grounds are unknowable, judged against near-black (the dim
 *  scrim guarantees a dark floor). */
export function backgroundProbeColor(bg: ThemeBackground): string {
  return bg.kind === "color" ? bg.color : "#0b0d10";
}

/** Apply a Player Themes dialog draft onto the store as it is *now*: the
 *  draft owns the theme list and the default; song pins come from the live
 *  store (the stage may have pinned songs while the dialog was open), minus
 *  pins to themes the draft deleted. */
export function mergeThemeDraft(current: ThemeStore, draft: ThemeStore): ThemeStore {
  const known = new Set(allThemes(draft).map((t) => t.id));
  const songOverrides = Object.fromEntries(Object.entries(current.songOverrides).filter(([, id]) => known.has(id)));
  return {
    themes: draft.themes,
    defaultId: known.has(draft.defaultId) ? draft.defaultId : DEFAULT_THEME.id,
    songOverrides,
  };
}
