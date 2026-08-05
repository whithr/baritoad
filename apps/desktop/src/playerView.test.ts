import { describe, expect, it } from "vitest";
import { groupByLine, type TimedWord } from "./highlight";
import {
  lineIndexAt,
  lyricFrameAt,
  scrollStep,
  UPCOMING_LEAD_S,
  wipeFraction,
} from "./playerView";

// Three lines with a long instrumental gap between lines 1 and 2.
//   L0: 1.0–1.4, 1.5–1.9    L1: 2.5–2.9, 3.0–3.4    L2: 10.0–10.4
const words: TimedWord[] = [
  { start: 1.0, end: 1.4, unsung: false, line: 0 },
  { start: 1.5, end: 1.9, unsung: false, line: 0 },
  { start: 2.5, end: 2.9, unsung: false, line: 1 },
  { start: 3.0, end: 3.4, unsung: false, line: 1 },
  { start: 10.0, end: 10.4, unsung: false, line: 2 },
];
const lines = groupByLine(words);

describe("lineIndexAt", () => {
  it("is line 0 before the first word", () => {
    expect(lineIndexAt(lines, words, 0)).toBe(0);
  });

  it("tracks the line of the active word", () => {
    expect(lineIndexAt(lines, words, 1.2)).toBe(0);
    expect(lineIndexAt(lines, words, 3.1)).toBe(1);
    expect(lineIndexAt(lines, words, 10.2)).toBe(2);
  });

  it("holds the finished line early in a gap, then pre-rolls the next line", () => {
    // Gap runs 3.4 → 10.0. Far from the next line: hold line 1.
    expect(lineIndexAt(lines, words, 5.0)).toBe(1);
    // Within the lead window of line 2's start: show line 2 before it starts.
    expect(lineIndexAt(lines, words, 10.0 - UPCOMING_LEAD_S + 0.1)).toBe(2);
  });

  it("stays on the last line after the song's words end", () => {
    expect(lineIndexAt(lines, words, 60)).toBe(2);
  });

  it("handles empty maps", () => {
    expect(lineIndexAt([], [], 5)).toBe(0);
  });
});

describe("wipeFraction", () => {
  it("progresses linearly through a word", () => {
    const w = { start: 2.0, end: 3.0 };
    expect(wipeFraction(w, 1.5)).toBe(0);
    expect(wipeFraction(w, 2.5)).toBeCloseTo(0.5, 9);
    expect(wipeFraction(w, 3.5)).toBe(1);
  });

  it("zero-length placeholders flip 0 → 1 at onset", () => {
    const w = { start: 2.0, end: 2.0 };
    expect(wipeFraction(w, 1.99)).toBe(0);
    expect(wipeFraction(w, 2.0)).toBe(1);
  });
});

describe("lyricFrameAt", () => {
  it("mid-word: active word, its line, and a partial wipe", () => {
    const f = lyricFrameAt(lines, words, 2.7);
    expect(f.activeWord).toBe(2);
    expect(f.lineIndex).toBe(1);
    expect(f.wipe).toBeCloseTo(0.5, 9);
    expect(f.sungThrough).toBe(2);
  });

  it("in a gap: no active word, sung tint held (28a3234 fix applies)", () => {
    const f = lyricFrameAt(lines, words, 5.0);
    expect(f.activeWord).toBeNull();
    expect(f.sungThrough).toBe(3); // last word of line 1 stays tinted
    expect(f.wipe).toBe(0);
  });
});

describe("scrollStep", () => {
  it("approaches the target and eventually snaps", () => {
    let y = 0;
    for (let i = 0; i < 200; i++) y = scrollStep(y, 500, 8.33);
    expect(y).toBe(500);
  });

  it("is frame-rate independent (same trajectory at 60 vs 120 Hz)", () => {
    // Advance 96 ms as 6×16 ms and as 12×8 ms — must land within a pixel.
    let a = 0;
    for (let i = 0; i < 6; i++) a = scrollStep(a, 300, 16, 180, 0);
    let b = 0;
    for (let i = 0; i < 12; i++) b = scrollStep(b, 300, 8, 180, 0);
    expect(Math.abs(a - b)).toBeLessThan(1);
  });

  it("moves monotonically toward the target from either side", () => {
    const up = scrollStep(100, 200, 10);
    expect(up).toBeGreaterThan(100);
    expect(up).toBeLessThan(200);
    const down = scrollStep(200, 100, 10);
    expect(down).toBeLessThan(200);
    expect(down).toBeGreaterThan(100);
  });

  it("snaps within the settle threshold", () => {
    expect(scrollStep(100.4, 100, 8)).toBe(100);
  });
});
