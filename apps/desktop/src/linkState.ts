// Add from URL — pure helpers for the dialog (views/LinkDialog.tsx): which
// pasted text is a link, what starts checked, what gets queued. The fetching
// itself is karaoke-core's (fetch.rs, via yt-dlp).

import type { FoundLink, LinkItem } from "./api";

/** The links in pasted text, in order, without repeats. Anything that isn't
 *  a link is ignored; a bare "youtu.be/…" or "www.…" gets https://. Trailing
 *  punctuation from prose ("…see https://x.org/a.") is dropped. */
export function parseLinks(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s<>"]+/)) {
    let t = raw.trim().replace(/[),.;]+$/, "");
    if (!t) continue;
    if (/^(www\.|youtu\.be\/|m\.youtube\.com\/|music\.youtube\.com\/)/i.test(t)) t = `https://${t}`;
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Songs start checked unless they were fetched before. */
export const defaultCheckedLinks = (links: FoundLink[]) => new Set(links.filter((l) => !l.in_library).map((l) => l.url));

/** What the review list knows about a song's lyrics. */
export type LinkLyrics =
  | { kind: "checking" }
  | { kind: "found"; track: string; artist: string; lines: number }
  | { kind: "missing" }
  | { kind: "failed"; message: string }
  | { kind: "pasted"; text: string };

/** The Lyrics cell: icon, label, and a tooltip with the details. */
export function lyricsCell(
  l: LinkLyrics | undefined,
  lookupOn: boolean,
): { icon: "ready" | "warn" | "working"; label: string; tip?: string } {
  if (l?.kind === "pasted") {
    const lines = l.text.split(/\r?\n/).filter((s) => s.trim()).length;
    return { icon: "ready", label: "Pasted", tip: `${lines === 1 ? "1 line" : `${lines} lines`} you pasted` };
  }
  if (!lookupOn) return { icon: "warn", label: "Will transcribe", tip: "Paste lyrics, or tick Find lyrics online" };
  switch (l?.kind) {
    case "found":
      return { icon: "ready", label: "On LRCLIB", tip: `“${l.track}” by ${l.artist} — ${l.lines} lines` };
    case "missing":
      return { icon: "warn", label: "Not found — will transcribe", tip: "LRCLIB doesn't have this song. Paste the lyrics for the best timing." };
    case "failed":
      return { icon: "warn", label: "Couldn't check", tip: l.message };
    default:
      return { icon: "working", label: "Checking…" };
  }
}

/** "4 songs · 2 with lyrics from LRCLIB · 1 pasted · 1 will be transcribed" */
export function lyricsSummary(
  links: FoundLink[],
  checked: Set<string>,
  lyrics: Record<string, LinkLyrics>,
  lookupOn: boolean,
): string {
  const picked = links.filter((l) => checked.has(l.url));
  let found = 0;
  let pasted = 0;
  let checking = 0;
  for (const l of picked) {
    const s = lyrics[l.url];
    if (s?.kind === "pasted") pasted++;
    else if (lookupOn && s?.kind === "found") found++;
    else if (lookupOn && (!s || s.kind === "checking")) checking++;
  }
  const rest = picked.length - found - pasted - checking;
  const parts = [picked.length === 1 ? "1 song" : `${picked.length} songs`];
  if (found > 0) parts.push(`${found} with lyrics from LRCLIB`);
  if (pasted > 0) parts.push(`${pasted} pasted`);
  if (checking > 0) parts.push(`${checking} still checking`);
  if (rest > 0) parts.push(`${rest} will be transcribed`);
  return parts.join(" · ");
}

/** The queue request for the checked songs, in list order. Pasted lyrics go
 *  with their song. */
export function linkItems(links: FoundLink[], checked: Set<string>, lyrics: Record<string, LinkLyrics> = {}): LinkItem[] {
  return links
    .filter((l) => checked.has(l.url))
    .map((l) => {
      const s = lyrics[l.url];
      return {
        url: l.url,
        id: l.id,
        title: l.title,
        artist: l.artist ?? undefined,
        duration_s: l.duration_s ?? undefined,
        thumbnail: l.thumbnail ?? undefined,
        lyrics_text: s?.kind === "pasted" ? s.text : undefined,
      };
    });
}

/** yt-dlp's extractor names, as people say them. */
export function siteLabel(site: string): string {
  const s = site.toLowerCase();
  if (s.startsWith("youtube")) return "YouTube";
  if (s === "archiveorg" || s === "archive.org") return "Internet Archive";
  if (s.startsWith("soundcloud")) return "SoundCloud";
  if (s.startsWith("bandcamp")) return "Bandcamp";
  if (s.startsWith("vimeo")) return "Vimeo";
  return site.replace(/:.*/, "") || "Web";
}
