// Wizard cleanup-preview flow helpers: filename → title/artist and the
// one-line preview under the paste box.

import { describe, expect, it } from "vitest";
import { metaFromFilename, previewLine } from "./songMeta";

describe("metaFromFilename", () => {
  it("splits Artist - Title", () => {
    expect(metaFromFilename("C:\\music\\Robyn - Dancing On My Own.mp3")).toEqual({
      title: "Dancing On My Own",
      artist: "Robyn",
    });
  });

  it("handles forward slashes and underscores", () => {
    expect(metaFromFilename("/home/h/music/back_on_my_bs.mp3")).toEqual({
      title: "back on my bs",
      artist: null,
    });
  });

  it("does not split on a hyphen without spaces", () => {
    expect(metaFromFilename("semi-charmed.flac")).toEqual({
      title: "semi-charmed",
      artist: null,
    });
  });

  it("keeps extra separators in the title", () => {
    expect(metaFromFilename("A - B - C.ogg")).toEqual({ title: "B - C", artist: "A" });
  });

  it("falls back to Untitled for extension-only names", () => {
    expect(metaFromFilename(".mp3").title).toBe("Untitled");
  });
});

describe("previewLine", () => {
  it("renders the cleanup summary with kept counts", () => {
    expect(
      previewLine({
        summary: "removed 4 section headers, expanded one x2 chorus",
        lines_kept: 42,
        words_kept: 213,
      }),
    ).toBe("removed 4 section headers, expanded one x2 chorus — keeping 42 lines, 213 words");
  });

  it("singularizes", () => {
    expect(previewLine({ summary: "no changes", lines_kept: 1, words_kept: 1 })).toBe(
      "no changes — keeping 1 line, 1 word",
    );
  });
});
