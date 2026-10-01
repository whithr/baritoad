// Bulk import review and batch progress — pure helpers for the Import Songs
// dialog (views/ImportDialog.tsx) and the Library's batch reporting. The
// folder scan itself is karaoke-core's (import.rs); this decides labels,
// defaults and counts.

import type { ImportCandidate, ImportLyrics, ImportSongItem } from "./api";
import type { JobProgress } from "./jobEvents";

/** What a song's lyrics column says. */
export function lyricsLabel(l: ImportLyrics): string {
  switch (l.kind) {
    case "text":
      return "Lyrics (.txt)";
    case "lrc":
      return "Lyrics (.lrc)";
    case "ultrastar":
      return "UltraStar timings";
    case "unreadable":
      return "Unreadable — transcribe";
    default:
      return "None — transcribe";
  }
}

/** Lyrics that will line up with the singing (pasted or hand-timed). */
export const hasLyrics = (l: ImportLyrics) => l.kind === "text" || l.kind === "lrc" || l.kind === "ultrastar";

/** Songs start checked unless the library already has them. */
export function defaultChecked(items: ImportCandidate[]): Set<string> {
  return new Set(items.filter((i) => !i.in_library).map((i) => i.audio_path));
}

export interface ImportSummary {
  count: number;
  withLyrics: number;
  transcribe: number;
  /** In the library already and left unchecked. */
  skipped: number;
  collections: number;
}

export function importSummary(items: ImportCandidate[], checked: Set<string>, useCollections: boolean): ImportSummary {
  const picked = items.filter((i) => checked.has(i.audio_path));
  return {
    count: picked.length,
    withLyrics: picked.filter((i) => hasLyrics(i.lyrics)).length,
    transcribe: picked.filter((i) => !hasLyrics(i.lyrics)).length,
    skipped: items.filter((i) => i.in_library && !checked.has(i.audio_path)).length,
    collections: useCollections ? new Set(picked.map((i) => i.collection).filter(Boolean)).size : 0,
  };
}

/** "31 songs · 26 with lyrics · 5 will be transcribed · into 3 collections · 1 already in your library"
 *  (`lookup`: songs without lyrics look them up online first). */
export function summaryText(s: ImportSummary, lookup = false): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts = [plural(s.count, "song")];
  if (s.count > 0) {
    if (s.withLyrics > 0) parts.push(`${s.withLyrics} with lyrics`);
    if (s.transcribe > 0) parts.push(lookup ? `${s.transcribe} will look lyrics up online` : `${s.transcribe} will be transcribed`);
    if (s.collections > 0) parts.push(`into ${plural(s.collections, "collection")}`);
  }
  if (s.skipped > 0) parts.push(`${s.skipped} already in your library`);
  return parts.join(" · ");
}

/** The import request for the checked songs, in list order. */
export function importItems(items: ImportCandidate[], checked: Set<string>, useCollections: boolean): ImportSongItem[] {
  return items
    .filter((i) => checked.has(i.audio_path))
    .map((i) => ({
      audio_path: i.audio_path,
      title: i.title,
      artist: i.artist ?? undefined,
      lyrics: i.lyrics,
      collection: useCollections ? (i.collection ?? undefined) : undefined,
      year: i.year ?? undefined,
      genre: i.genre ?? undefined,
      language: i.language ?? undefined,
    }));
}

/** Where the songs were found: the one folder they share, else null. */
export function commonFolder(items: ImportCandidate[]): string | null {
  const dirs = items.map((i) => i.audio_path.replace(/[\\/][^\\/]*$/, ""));
  if (dirs.length === 0) return null;
  const split = (d: string) => d.split(/[\\/]/);
  let common = split(dirs[0]);
  for (const d of dirs.slice(1)) {
    const parts = split(d);
    let k = 0;
    while (k < common.length && k < parts.length && common[k].toLowerCase() === parts[k].toLowerCase()) k++;
    common = common.slice(0, k);
  }
  const joined = common.join("\\");
  return joined === "" || /^[A-Za-z]:$/.test(joined) ? null : joined;
}

export interface BatchProgress {
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Queued or running. */
  remaining: number;
}

export function batchProgress(jobs: (JobProgress | undefined)[]): BatchProgress {
  const out: BatchProgress = { total: jobs.length, done: 0, failed: 0, cancelled: 0, remaining: 0 };
  for (const p of jobs) {
    const s = p?.job.status;
    if (s === "completed") out.done++;
    else if (s === "failed") out.failed++;
    else if (s === "cancelled") out.cancelled++;
    else out.remaining++;
  }
  return out;
}
