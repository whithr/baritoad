import { describe, expect, it } from "vitest";
import type { ImportCandidate, JobSnapshot } from "./api";
import {
  batchProgress,
  commonFolder,
  defaultChecked,
  importItems,
  importSummary,
  lyricsLabel,
  summaryText,
} from "./importState";
import type { JobProgress } from "./jobEvents";

const song = (name: string, over: Partial<ImportCandidate> = {}): ImportCandidate => ({
  audio_path: `D:\\Karaoke\\Party\\${name}.mp3`,
  title: name,
  artist: "Someone",
  lyrics: { kind: "text", path: `D:\\Karaoke\\Party\\${name}.txt` },
  collection: "Party",
  in_library: false,
  ...over,
});

const items = [
  song("Waterloo"),
  song("Lithium", { lyrics: { kind: "none" } }),
  song("Rhapsody", { lyrics: { kind: "ultrastar", path: "x.txt" }, collection: "Classics" }),
  song("Old one", { in_library: true }),
];

describe("import review", () => {
  it("labels each lyrics source", () => {
    expect(lyricsLabel({ kind: "text", path: "a" })).toBe("Lyrics (.txt)");
    expect(lyricsLabel({ kind: "ultrastar", path: "a" })).toBe("UltraStar timings");
    expect(lyricsLabel({ kind: "unreadable", path: "a", reason: "duet" })).toBe("Unreadable — transcribe");
    expect(lyricsLabel({ kind: "none" })).toBe("None — transcribe");
  });

  it("checks everything the library doesn't have yet", () => {
    expect([...defaultChecked(items)]).toEqual(items.slice(0, 3).map((i) => i.audio_path));
  });

  it("summarizes the checked songs", () => {
    const s = importSummary(items, defaultChecked(items), true);
    expect(s).toEqual({ count: 3, withLyrics: 2, transcribe: 1, skipped: 1, collections: 2 });
    expect(summaryText(s)).toBe(
      "3 songs · 2 with lyrics · 1 will be transcribed · into 2 collections · 1 already in your library",
    );
    expect(summaryText(importSummary(items, new Set(), false))).toBe("0 songs · 1 already in your library");
  });

  it("builds the request for checked songs, collections optional", () => {
    const checked = new Set([items[0].audio_path, items[2].audio_path]);
    expect(importItems(items, checked, true).map((i) => i.collection)).toEqual(["Party", "Classics"]);
    expect(importItems(items, checked, false).map((i) => i.collection)).toEqual([undefined, undefined]);
  });

  it("names the shared folder", () => {
    expect(commonFolder(items)).toBe("D:\\Karaoke\\Party");
    expect(commonFolder([song("a"), { ...song("b"), audio_path: "D:\\Karaoke\\80s\\b.mp3" }])).toBe("D:\\Karaoke");
    expect(commonFolder([song("a"), { ...song("b"), audio_path: "E:\\b.mp3" }])).toBeNull();
    expect(commonFolder([])).toBeNull();
  });
});

describe("batch progress", () => {
  const job = (id: number, status: JobSnapshot["status"]): JobProgress => ({
    job: { id, audio: "a", title: "t", out_dir: "o", status, cancel_requested: false, queued_unix: 0 },
    stage: "separating",
    fraction: null,
    message: null,
    cleanupSummary: null,
    stageSeconds: {},
    failure: null,
  });

  it("counts outcomes and what's left", () => {
    expect(
      batchProgress([job(1, "completed"), job(2, "failed"), job(3, "running"), job(4, "queued"), job(5, "cancelled"), undefined]),
    ).toEqual({ total: 6, done: 1, failed: 1, cancelled: 1, remaining: 3 });
  });
});
