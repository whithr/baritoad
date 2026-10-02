// Library + queue view logic — pure functions, vitest-covered.
//
// The Rust store can search/sort in SQL (the CLI will use that); the webview
// fetches the selected collection once and filters/sorts client-side so
// keystrokes in the search box never round-trip to the backend.

import type { Song } from "./api";
import type { JobProgress, JobsState } from "./jobEvents";

export type SongStatus =
  | { kind: "processing"; p: JobProgress }
  | { kind: "failed"; p: JobProgress }
  | { kind: "needs-timings" }
  | { kind: "review" }
  | { kind: "ready" };

/** A library song's status: any queued/running job for it wins; otherwise
 *  its latest finished job decides — a retry that completed clears an older
 *  failure, while a cancelled retry leaves it standing (it changed nothing).
 *  Jobs match by library row, or by audio path for runs that haven't
 *  registered yet. */
export function statusFor(song: Song, jobs: JobsState): SongStatus {
  let last: JobProgress | undefined;
  for (const id of jobs.order) {
    const p = jobs.jobs[id];
    if (!p) continue;
    if (p.job.library_song_id !== song.id && p.job.audio !== song.audio_path) continue;
    if (p.job.status === "queued" || p.job.status === "running") return { kind: "processing", p };
    if (p.job.status !== "cancelled") last = p;
  }
  if (last?.job.status === "failed") return { kind: "failed", p: last };
  if (!song.timing_map_path) return { kind: "needs-timings" };
  if (song.reviewed_at == null) return { kind: "review" };
  return { kind: "ready" };
}

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

/** "1:34" / "12:05" from seconds; null-safe. */
export function fmtDuration(s?: number | null): string | null {
  if (s == null || !isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  const sec = Math.round(s - m * 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export type SortDir = "asc" | "desc";

/** Stable column sort for the library list view. `key` returns the cell's
 *  sort value; nulls always sort last whichever way the column points, so
 *  "never sung" songs never crowd the top of Last sung. Strings compare
 *  case-insensitively. */
export function sortBy<T>(rows: T[], key: (row: T) => string | number | null | undefined, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: key(row) }))
    .sort((a, b) => {
      const an = a.v == null;
      const bn = b.v == null;
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
      const c =
        typeof a.v === "string" && typeof b.v === "string"
          ? a.v.localeCompare(b.v, undefined, { sensitivity: "base" })
          : (a.v as number) - (b.v as number);
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}
