// Library + queue view logic — pure functions, vitest-covered.
//
// The Rust store can search/sort in SQL (the CLI will use that); the webview
// fetches the selected collection once and filters/sorts client-side so
// keystrokes in the search box never round-trip to the backend.

export interface SongLike {
  id: number;
  title: string;
  artist?: string | null;
  language_tag: string;
  date_added: number;
  last_played?: number | null;
}

export type LibrarySort = "recently_added" | "recently_played" | "title";

export const SORT_LABELS: Record<LibrarySort, string> = {
  recently_added: "Recently added",
  recently_played: "Recently played",
  title: "Title",
};

/** Case-insensitive substring on title/artist, or exact language-tag match
 *  (PLAN.md §3 "Tags and search"). Empty/whitespace search keeps everything. */
export function filterSongs<T extends SongLike>(songs: T[], search: string): T[] {
  const term = search.trim().toLowerCase();
  if (term === "") return songs;
  return songs.filter(
    (s) =>
      s.title.toLowerCase().includes(term) ||
      (s.artist ?? "").toLowerCase().includes(term) ||
      s.language_tag.toLowerCase() === term,
  );
}

/** Stable, non-mutating sort. `recently_played` puts never-played songs after
 *  played ones (a party library is mostly "what did we sing last time"). */
export function sortSongs<T extends SongLike>(songs: T[], sort: LibrarySort): T[] {
  const out = [...songs];
  switch (sort) {
    case "recently_added":
      out.sort((a, b) => b.date_added - a.date_added || b.id - a.id);
      break;
    case "recently_played":
      out.sort((a, b) => {
        const ap = a.last_played ?? null;
        const bp = b.last_played ?? null;
        if (ap === null && bp === null) return b.date_added - a.date_added || b.id - a.id;
        if (ap === null) return 1;
        if (bp === null) return -1;
        return bp - ap || b.date_added - a.date_added;
      });
      break;
    case "title":
      out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
      break;
  }
  return out;
}

/** Move list[from] to index `to` (clamped). Returns a new array; out-of-range
 *  `from` returns the input unchanged. Used for queue drag-reorder. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

/** Initials for the generated-cover fallback: first letters of the first two
 *  title words ("Dancing On My Own" → "DO"). */
export function coverInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words
    .slice(0, 2)
    .map((w) => [...w].find((c) => /[\p{L}\p{N}]/u.test(c)) ?? "")
    .join("")
    .toUpperCase() || "♪";
}

/** Deterministic hue (0..360) from a string — same song, same gradient,
 *  every launch. */
export function coverHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/** CSS gradient for the cover-art fallback. */
export function coverGradient(seed: string): string {
  const hue = coverHue(seed);
  const hue2 = (hue + 40) % 360;
  return `linear-gradient(135deg, hsl(${hue}, 45%, 28%), hsl(${hue2}, 55%, 16%))`;
}

/** "1:34" / "12:05" from seconds; null-safe. */
export function fmtDuration(s?: number | null): string | null {
  if (s == null || !isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  const sec = Math.round(s - m * 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
