// Library categories — pure, vitest-covered. Everything is derived from what
// the library row already holds (tags, play history, our own timings); no
// lookups. Used by the Library's tree (shelves + Browse), View › Group by,
// and the Find box.
//
// Pace is relative: "Easy sing-alongs" and "Fast lyrics" are the slowest and
// fastest thirds of *this* library by words per minute while singing, so no
// threshold has to be guessed — and a party playlist of ballads still has a
// "fast" end.

import type { Song } from "./api";

export type GroupBy = "none" | "artist" | "decade" | "genre" | "language" | "pace";
export const GROUP_BYS: GroupBy[] = ["none", "artist", "decade", "genre", "language", "pace"];

/** Library language tags → names (import maps UltraStar names to these). */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  de: "German",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  sv: "Swedish",
  no: "Norwegian",
  da: "Danish",
  fi: "Finnish",
  pl: "Polish",
  cs: "Czech",
  hu: "Hungarian",
  ru: "Russian",
  tr: "Turkish",
  el: "Greek",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  la: "Latin",
};

export const languageName = (tag: string) => LANGUAGE_NAMES[tag] ?? tag.toUpperCase();

export const decadeOf = (year?: number | null): number | null =>
  year != null && Number.isFinite(year) ? Math.floor(year / 10) * 10 : null;

/** Songs shorter than this count as "Short songs". */
export const SHORT_SONG_S = 180;
/** "Recently added" reaches back this far. */
export const RECENT_DAYS = 30;

export type Pace = "slow" | "medium" | "fast";

/** Tercile cut points of the library's pace (null below 3 measured songs). */
export interface PaceBands {
  slowMax: number;
  fastMin: number;
}

export function paceBands(songs: Song[]): PaceBands | null {
  const v = songs
    .map((s) => s.pace_wpm)
    .filter((p): p is number => p != null && Number.isFinite(p))
    .sort((a, b) => a - b);
  if (v.length < 3) return null;
  const at = (q: number) => v[Math.round(q * (v.length - 1))];
  return { slowMax: at(1 / 3), fastMin: at(2 / 3) };
}

export function paceOf(s: Song, bands: PaceBands | null): Pace | null {
  const p = s.pace_wpm;
  if (!bands || p == null || !Number.isFinite(p)) return null;
  if (p <= bands.slowMax) return "slow";
  if (p >= bands.fastMin) return "fast";
  return "medium";
}

export const PACE_LABELS: Record<Pace, string> = {
  slow: "Easy sing-alongs",
  medium: "Moderate pace",
  fast: "Fast lyrics",
};

/** What every category decision needs besides the song. */
export interface CategoryContext {
  bands: PaceBands | null;
  /** Unix seconds "now" (tests pin it). */
  now: number;
}

export function categoryContext(songs: Song[], now = Date.now() / 1000): CategoryContext {
  return { bands: paceBands(songs), now };
}

const singable = (s: Song) => !!s.timing_map_path;
const isRecent = (s: Song, ctx: CategoryContext) => s.date_added >= ctx.now - RECENT_DAYS * 86400;
const isShort = (s: Song) => s.duration_s != null && s.duration_s > 0 && s.duration_s < SHORT_SONG_S;
const fold = (t: string) => t.trim().toLowerCase();

// ------------------------------------------------------------- tree nodes

/** A tree node id's song filter, or null when the id isn't a category. */
export function categoryFilter(nodeId: string, ctx: CategoryContext): ((s: Song) => boolean) | null {
  const [kind, ...rest] = nodeId.split(":");
  const value = rest.join(":");
  switch (kind) {
    case "shelf":
      if (value === "most") return (s) => s.play_count > 0;
      if (value === "never") return (s) => s.play_count === 0 && singable(s);
      if (value === "recent") return (s) => isRecent(s, ctx);
      return null;
    case "sing":
      if (value === "short") return isShort;
      return (s) => paceOf(s, ctx.bands) === value;
    case "artist":
      return (s) => fold(s.artist ?? "") === value;
    case "decade":
      return (s) => String(decadeOf(s.year)) === value;
    case "genre":
      return (s) => fold(s.genre ?? "") === value;
    case "lang":
      return (s) => s.language_tag === value;
    default:
      return null;
  }
}

export interface Facet {
  /** Tree node id (`artist:abba`, `decade:1980`, …). */
  id: string;
  label: string;
  count: number;
}

/** Browse branch contents: every value the library has, with counts. */
export function facets(songs: Song[], kind: "artist" | "decade" | "genre" | "lang"): Facet[] {
  const out = new Map<string, Facet>();
  for (const s of songs) {
    let key: string | null = null;
    let label = "";
    if (kind === "artist" && s.artist?.trim()) [key, label] = [fold(s.artist), s.artist.trim()];
    if (kind === "genre" && s.genre?.trim()) [key, label] = [fold(s.genre), s.genre.trim()];
    if (kind === "decade") {
      const d = decadeOf(s.year);
      if (d != null) [key, label] = [String(d), `${d}s`];
    }
    if (kind === "lang") [key, label] = [s.language_tag, languageName(s.language_tag)];
    if (key == null) continue;
    const f = out.get(key);
    if (f) f.count++;
    else out.set(key, { id: `${kind}:${key}`, label, count: 1 });
  }
  const list = [...out.values()];
  return kind === "decade"
    ? list.sort((a, b) => a.label.localeCompare(b.label))
    : list.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

// -------------------------------------------------------------- group by

export interface Group {
  /** Sort key: groups order by this; unknowns last. */
  order: string;
  label: string;
}

const UNKNOWN = "￿";

export function groupOf(s: Song, by: GroupBy, ctx: CategoryContext): Group {
  switch (by) {
    case "artist":
      return s.artist?.trim()
        ? { order: fold(s.artist), label: s.artist.trim() }
        : { order: UNKNOWN, label: "Unknown artist" };
    case "decade": {
      const d = decadeOf(s.year);
      return d != null ? { order: String(d), label: `${d}s` } : { order: UNKNOWN, label: "Unknown year" };
    }
    case "genre":
      return s.genre?.trim() ? { order: fold(s.genre), label: s.genre.trim() } : { order: UNKNOWN, label: "Unknown genre" };
    case "language":
      return { order: fold(languageName(s.language_tag)), label: languageName(s.language_tag) };
    case "pace": {
      const p = paceOf(s, ctx.bands);
      return p ? { order: String(["slow", "medium", "fast"].indexOf(p)), label: PACE_LABELS[p] } : { order: UNKNOWN, label: "Pace not measured" };
    }
    default:
      return { order: "", label: "" };
  }
}

/** Stable re-order so each group is contiguous (groups in `order`, rows keep
 *  their current order inside a group). Labels of one order key are unified
 *  to the first seen, so "rock" and "Rock" share a header. */
export function groupRows(rows: Song[], by: GroupBy, ctx: CategoryContext): { rows: Song[]; labelOf: (s: Song) => string } {
  if (by === "none") return { rows, labelOf: () => "" };
  const keyed = rows.map((s, i) => ({ s, i, g: groupOf(s, by, ctx) }));
  const label = new Map<string, string>();
  for (const k of keyed) if (!label.has(k.g.order)) label.set(k.g.order, k.g.label);
  const cmp = (a: string, b: string) =>
    a === b ? 0 : a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  keyed.sort((a, b) => cmp(a.g.order, b.g.order) || a.i - b.i);
  const byId = new Map(keyed.map((k) => [k.s.id, label.get(k.g.order) ?? k.g.label]));
  return { rows: keyed.map((k) => k.s), labelOf: (s) => byId.get(s.id) ?? "" };
}

// ---------------------------------------------------------------- search

/** Words a song answers to beyond its title and artist: decade ("80s",
 *  "1980s"), year, genre words, language, pace, length and history. */
export function facetWords(s: Song, ctx: CategoryContext): string[] {
  const w: string[] = [];
  const d = decadeOf(s.year);
  if (d != null) w.push(`${d}s`, `${String(d % 100).padStart(2, "0")}s`, String(s.year));
  if (s.genre) {
    const g = fold(s.genre);
    w.push(g, ...g.split(/[\s/,&-]+/).filter(Boolean));
  }
  w.push(fold(languageName(s.language_tag)), s.language_tag);
  const p = paceOf(s, ctx.bands);
  if (p === "slow") w.push("easy", "slow", "easy-sing-alongs");
  if (p === "fast") w.push("fast", "fast-lyrics");
  if (isShort(s)) w.push("short");
  // Same rule as the shelves: a song that can't be sung yet isn't "never sung".
  if (s.play_count > 0) w.push("most-sung", "sung");
  else if (singable(s)) w.push("never-sung", "unsung");
  if (isRecent(s, ctx)) w.push("recent", "recently-added");
  return w;
}

const PHRASES: [RegExp, string][] = [
  [/\bnever\s+sung\b|\bnot\s+sung\b/g, "never-sung"],
  [/\bmost\s+sung\b/g, "most-sung"],
  [/\brecently\s+added\b/g, "recently-added"],
  [/\beasy\s+sing-?\s?alongs?\b/g, "easy-sing-alongs"],
  [/\bfast\s+lyrics\b/g, "fast-lyrics"],
];

/** The Find box: the whole text as a substring of title/artist (what it
 *  always did), or — word by word — each word found in the title/artist or
 *  starting one of the song's facet words ("abba 70s", "rock never sung",
 *  "fast german"). */
export function searchSongs(songs: Song[], query: string, ctx: CategoryContext): Song[] {
  const term = fold(query);
  if (term === "") return songs;
  let phrased = term;
  for (const [re, word] of PHRASES) phrased = phrased.replace(re, word);
  const tokens = phrased.split(/\s+/).filter(Boolean);
  return songs.filter((s) => {
    const text = `${fold(s.title)} ${fold(s.artist ?? "")}`;
    if (text.includes(term) || fold(s.language_tag) === term) return true;
    const words = facetWords(s, ctx);
    return tokens.every((t) => text.includes(t) || words.some((w) => w.startsWith(t)));
  });
}
