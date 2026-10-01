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

/** The queue request for the checked songs, in list order. */
export function linkItems(links: FoundLink[], checked: Set<string>): LinkItem[] {
  return links
    .filter((l) => checked.has(l.url))
    .map((l) => ({
      url: l.url,
      id: l.id,
      title: l.title,
      artist: l.artist ?? undefined,
      duration_s: l.duration_s ?? undefined,
      thumbnail: l.thumbnail ?? undefined,
    }));
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
