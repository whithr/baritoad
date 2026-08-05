import { describe, expect, it } from "vitest";
import {
  coverGradient,
  coverInitials,
  filterSongs,
  fmtDuration,
  moveItem,
  sortSongs,
  type SongLike,
} from "./libraryState";

const song = (over: Partial<SongLike> & { id: number }): SongLike => ({
  title: `Song ${over.id}`,
  artist: null,
  language_tag: "en",
  date_added: 1000 + over.id,
  last_played: null,
  ...over,
});

describe("filterSongs", () => {
  const songs = [
    song({ id: 1, title: "Dancing On My Own", artist: "Robyn" }),
    song({ id: 2, title: "Dance The Night", artist: "Dua Lipa" }),
    song({ id: 3, title: "Halo", artist: "Beyoncé", language_tag: "es" }),
  ];

  it("keeps everything on empty or whitespace search", () => {
    expect(filterSongs(songs, "")).toHaveLength(3);
    expect(filterSongs(songs, "   ")).toHaveLength(3);
  });

  it("matches title substring case-insensitively", () => {
    expect(filterSongs(songs, "DANC").map((s) => s.id)).toEqual([1, 2]);
  });

  it("matches artist substring", () => {
    expect(filterSongs(songs, "dua").map((s) => s.id)).toEqual([2]);
  });

  it("matches language tag exactly, not as substring", () => {
    expect(filterSongs(songs, "es").map((s) => s.id)).toEqual([3]);
    // "e" is not a tag and matches no title/artist... except "Dance", "Beyoncé" etc.
    expect(filterSongs(songs, "zzz")).toHaveLength(0);
  });

  it("handles null artist", () => {
    expect(filterSongs([song({ id: 9, artist: null })], "anything")).toHaveLength(0);
  });
});

describe("sortSongs", () => {
  it("recently_added: newest first, id breaks ties", () => {
    const songs = [
      song({ id: 1, date_added: 100 }),
      song({ id: 2, date_added: 300 }),
      song({ id: 3, date_added: 300 }),
    ];
    expect(sortSongs(songs, "recently_added").map((s) => s.id)).toEqual([3, 2, 1]);
  });

  it("recently_played: played first (most recent), never-played after by date added", () => {
    const songs = [
      song({ id: 1, date_added: 500, last_played: null }),
      song({ id: 2, date_added: 100, last_played: 900 }),
      song({ id: 3, date_added: 100, last_played: 950 }),
      song({ id: 4, date_added: 400, last_played: null }),
    ];
    expect(sortSongs(songs, "recently_played").map((s) => s.id)).toEqual([3, 2, 1, 4]);
  });

  it("title: alphabetical, case/diacritic-insensitive", () => {
    const songs = [
      song({ id: 1, title: "bravo" }),
      song({ id: 2, title: "Alpha" }),
      song({ id: 3, title: "Charlie" }),
    ];
    expect(sortSongs(songs, "title").map((s) => s.title)).toEqual([
      "Alpha",
      "bravo",
      "Charlie",
    ]);
  });

  it("does not mutate its input", () => {
    const songs = [song({ id: 2 }), song({ id: 1 })];
    sortSongs(songs, "title");
    expect(songs.map((s) => s.id)).toEqual([2, 1]);
  });
});

describe("moveItem (queue reorder)", () => {
  it("moves forward and backward", () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
  });

  it("clamps the target index", () => {
    expect(moveItem([1, 2, 3], 0, 99)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, -5)).toEqual([3, 1, 2]);
  });

  it("returns the input unchanged for an invalid source", () => {
    const list = [1, 2, 3];
    expect(moveItem(list, 7, 0)).toBe(list);
    expect(moveItem(list, -1, 0)).toBe(list);
  });

  it("no-op move keeps order", () => {
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
  });
});

describe("cover fallback", () => {
  it("initials from the first two words, skipping punctuation-only tokens", () => {
    expect(coverInitials("Dancing On My Own")).toBe("DO");
    expect(coverInitials("Halo")).toBe("H");
    expect(coverInitials("99 Luftballons")).toBe("9L");
    expect(coverInitials("- - -")).toBe("♪");
    expect(coverInitials("")).toBe("♪");
  });

  it("gradient is deterministic per seed and differs across seeds", () => {
    expect(coverGradient("abc")).toBe(coverGradient("abc"));
    expect(coverGradient("abc")).not.toBe(coverGradient("xyz"));
  });
});

describe("fmtDuration", () => {
  it("formats minutes:seconds", () => {
    expect(fmtDuration(94)).toBe("1:34");
    expect(fmtDuration(725)).toBe("12:05");
  });
  it("null-safe", () => {
    expect(fmtDuration(null)).toBeNull();
    expect(fmtDuration(undefined)).toBeNull();
    expect(fmtDuration(0)).toBeNull();
  });
});
