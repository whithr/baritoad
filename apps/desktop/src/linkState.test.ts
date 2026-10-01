import { describe, expect, it } from "vitest";
import type { FoundLink } from "./api";
import { defaultCheckedLinks, linkItems, parseLinks, siteLabel } from "./linkState";

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

  it("names sites the way people do", () => {
    expect(siteLabel("Youtube")).toBe("YouTube");
    expect(siteLabel("YoutubeTab")).toBe("YouTube");
    expect(siteLabel("ArchiveOrg")).toBe("Internet Archive");
    expect(siteLabel("generic:html5")).toBe("generic");
  });
});
