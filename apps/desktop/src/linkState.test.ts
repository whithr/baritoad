import { describe, expect, it } from "vitest";
import type { FoundLink } from "./api";
import { defaultCheckedLinks, linkItems, lyricsCell, lyricsSummary, parseLinks, siteLabel, type LinkLyrics } from "./linkState";

const link = (url: string, extra: Partial<FoundLink> = {}): FoundLink => ({
  url,
  id: url.slice(-4),
  title: `Song ${url.slice(-1)}`,
  site: "Youtube",
  in_library: false,
  ...extra,
});

describe("parseLinks", () => {
  it("finds links one per line, in order, without repeats", () => {
    const text = "https://www.youtube.com/watch?v=aaaa\n\nhttps://archive.org/details/x\nhttps://www.youtube.com/watch?v=aaaa\n";
    expect(parseLinks(text)).toEqual(["https://www.youtube.com/watch?v=aaaa", "https://archive.org/details/x"]);
  });

  it("ignores words and fixes bare links", () => {
    expect(parseLinks("check this youtu.be/abc and www.example.org/song, thanks.")).toEqual([
      "https://youtu.be/abc",
      "https://www.example.org/song",
    ]);
  });

  it("drops trailing prose punctuation but keeps query strings", () => {
    expect(parseLinks("(see https://x.org/a?b=1).")).toEqual(["https://x.org/a?b=1"]);
  });

  it("needs a host with a dot", () => {
    expect(parseLinks("http://localhost/x https:// not-a-link")).toEqual([]);
  });
});

describe("review defaults", () => {
  it("leaves songs fetched before unchecked", () => {
    const links = [link("u1"), link("u2", { in_library: true })];
    expect([...defaultCheckedLinks(links)]).toEqual(["u1"]);
  });

  it("queues the checked songs in list order with nulls dropped", () => {
    const links = [link("u1", { artist: null, duration_s: 61.5 }), link("u2", { artist: "A", thumbnail: "t.jpg" }), link("u3")];
    expect(linkItems(links, new Set(["u3", "u1"]))).toEqual([
      { url: "u1", id: "u1", title: "Song 1", artist: undefined, duration_s: 61.5, thumbnail: undefined },
      { url: "u3", id: "u3", title: "Song 3", artist: undefined, duration_s: undefined, thumbnail: undefined },
    ]);
  });

  it("sends pasted lyrics with their song and nothing for the rest", () => {
    const links = [link("u1"), link("u2"), link("u3")];
    const lyrics: Record<string, LinkLyrics> = {
      u1: { kind: "pasted", text: "made up line one\nmade up line two" },
      u2: { kind: "found", track: "Song 2", artist: "A", lines: 20 },
    };
    const items = linkItems(links, new Set(["u1", "u2", "u3"]), lyrics);
    expect(items.map((i) => i.lyrics_text)).toEqual(["made up line one\nmade up line two", undefined, undefined]);
  });

  it("labels each song's lyrics, lookup on or off", () => {
    expect(lyricsCell({ kind: "found", track: "T", artist: "A", lines: 12 }, true)).toMatchObject({ icon: "ready", label: "On LRCLIB" });
    expect(lyricsCell({ kind: "missing" }, true).label).toContain("will transcribe");
    expect(lyricsCell(undefined, true)).toMatchObject({ icon: "working" });
    expect(lyricsCell({ kind: "found", track: "T", artist: "A", lines: 12 }, false).label).toBe("Will transcribe");
    expect(lyricsCell({ kind: "pasted", text: "a\n\nb\n" }, false)).toMatchObject({ label: "Pasted", tip: "2 lines you pasted" });
  });

  it("sums up where the checked songs' lyrics come from", () => {
    const links = [link("u1"), link("u2"), link("u3"), link("u4"), link("u5")];
    const lyrics: Record<string, LinkLyrics> = {
      u1: { kind: "found", track: "x", artist: "y", lines: 9 },
      u2: { kind: "pasted", text: "x" },
      u3: { kind: "missing" },
      u4: { kind: "checking" },
    };
    const all = new Set(["u1", "u2", "u3", "u4", "u5"]);
    expect(lyricsSummary(links, all, lyrics, true)).toBe("5 songs · 1 with lyrics from LRCLIB · 1 pasted · 2 still checking · 1 will be transcribed");
    expect(lyricsSummary(links, all, lyrics, false)).toBe("5 songs · 1 pasted · 4 will be transcribed");
    expect(lyricsSummary(links, new Set(["u1"]), lyrics, true)).toBe("1 song · 1 with lyrics from LRCLIB");
  });

  it("names sites the way people do", () => {
    expect(siteLabel("Youtube")).toBe("YouTube");
    expect(siteLabel("YoutubeTab")).toBe("YouTube");
    expect(siteLabel("ArchiveOrg")).toBe("Internet Archive");
    expect(siteLabel("generic:html5")).toBe("generic");
  });
});
