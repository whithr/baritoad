import { describe, expect, it } from "vitest";
import {
  coverGradient,
  coverInitials,
  filterSongs,
  fmtDuration,
  moveItem,
  sortBy,
  sortSongs,
  statusFor,
  type SongLike,
} from "./libraryState";
import type { JobSnapshot, JobStatus, Song } from "./api";
import { seedFromSnapshots } from "./jobEvents";

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

describe("sortBy (list view columns)", () => {
  const rows = [
    { id: 1, t: "banana", n: 3 as number | null },
    { id: 2, t: "Apple", n: null },
    { id: 3, t: "cherry", n: 1 },
    { id: 4, t: "apple", n: 3 },
  ];

  it("sorts strings case-insensitively and keeps ties stable", () => {
    expect(sortBy(rows, (r) => r.t, "asc").map((r) => r.id)).toEqual([2, 4, 1, 3]);
    expect(sortBy(rows, (r) => r.t, "desc").map((r) => r.id)).toEqual([3, 1, 2, 4]);
  });

  it("sorts numbers and puts nulls last in both directions", () => {
    expect(sortBy(rows, (r) => r.n, "asc").map((r) => r.id)).toEqual([3, 1, 4, 2]);
    expect(sortBy(rows, (r) => r.n, "desc").map((r) => r.id)).toEqual([1, 4, 3, 2]);
  });

  it("does not mutate its input", () => {
    const before = rows.map((r) => r.id);
    sortBy(rows, (r) => r.n, "asc");
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe("statusFor (library Status column)", () => {
  const lib = (over: Partial<Song> = {}): Song => ({
    id: 7,
    title: "Harvest Moon",
    audio_path: "C:/music/moon.mp3",
    audio_hash: "h",
    job_dir: "C:/music/moon-karaoke",
    timing_map_path: "C:/music/moon-karaoke/moon.map.json",
    language_tag: "en",
    date_added: 1,
    play_count: 0,
    reviewed_at: 5,
    ...over,
  });
  let nextId = 1;
  const job = (status: JobStatus, over: Partial<JobSnapshot> = {}): JobSnapshot => ({
    id: nextId++,
    audio: "C:/music/moon.mp3",
    title: "Harvest Moon",
    out_dir: "C:/music/moon-karaoke",
    status,
    cancel_requested: false,
    queued_unix: 0,
    ...over,
  });
  const kind = (song: Song, ...jobs: JobSnapshot[]) => statusFor(song, seedFromSnapshots(jobs)).kind;

  it("reads the song's own state when no job touches it", () => {
    expect(kind(lib())).toBe("ready");
    expect(kind(lib({ reviewed_at: null }))).toBe("review");
    expect(kind(lib({ timing_map_path: null }))).toBe("needs-timings");
    expect(kind(lib(), job("failed", { audio: "C:/music/other.mp3" }))).toBe("ready");
  });

  it("shows a queued or running job as processing, over any failure", () => {
    expect(kind(lib(), job("running"))).toBe("processing");
    expect(kind(lib(), job("failed"), job("queued"))).toBe("processing");
  });

  it("shows the latest failure, even over existing timing", () => {
    expect(kind(lib(), job("failed"))).toBe("failed");
    expect(kind(lib({ timing_map_path: null }), job("failed"))).toBe("failed");
  });

  it("clears a failure once a later run completes", () => {
    expect(kind(lib({ reviewed_at: null }), job("failed"), job("completed", { library_song_id: 7 }))).toBe("review");
  });

  it("keeps a failure standing when the retry was cancelled", () => {
    expect(kind(lib(), job("failed"), job("cancelled"))).toBe("failed");
  });

  it("matches a completed run by library row even when it ran from a new path", () => {
    expect(kind(lib(), job("failed"), job("completed", { audio: "D:/moved/moon.mp3", library_song_id: 7 }))).toBe("ready");
  });
});
