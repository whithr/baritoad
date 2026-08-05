// Title/artist from a file name (milestone 1 — the tag reader and real
// library store land next milestone). Mirrors queue::meta_from_filename on
// the Rust side; the wizard uses this copy for instant feedback.

export interface SongMeta {
  title: string;
  artist: string | null;
}

export function metaFromFilename(path: string): SongMeta {
  const base = path.split(/[\\/]/).pop() ?? path;
  const stem = base.replace(/\.[^.]+$/, "") || "Untitled";
  const cleaned = stem.replace(/_/g, " ").trim().replace(/\s+/g, " ");
  const idx = cleaned.indexOf(" - ");
  if (idx > 0) {
    const artist = cleaned.slice(0, idx).trim();
    const title = cleaned.slice(idx + 3).trim();
    if (artist && title) return { title, artist };
  }
  return { title: cleaned, artist: null };
}

/** One-liner under the paste box: cleanup summary + kept counts. */
export function previewLine(p: {
  summary: string;
  lines_kept: number;
  words_kept: number;
}): string {
  return `${p.summary} — keeping ${p.lines_kept} line${p.lines_kept === 1 ? "" : "s"}, ${p.words_kept} word${p.words_kept === 1 ? "" : "s"}`;
}
