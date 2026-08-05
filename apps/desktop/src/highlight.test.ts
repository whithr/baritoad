import { describe, expect, it } from "vitest";
import { groupByLine, pickHighlightWindow, wordIndexAt } from "./highlight";

const w = (start: number, end: number, unsung = false, line?: number) => ({
  start,
  end,
  unsung,
  line,
});

describe("pickHighlightWindow", () => {
  it("picks the densest 20s span, not the first words", () => {
    // sparse intro: 3 words across 0–30 s; dense chorus: 12 words in 60–70 s
    const words = [
      w(2, 2.5),
      w(15, 15.5),
      w(29, 29.5),
      ...Array.from({ length: 12 }, (_, i) => w(60 + i * 0.8, 60.4 + i * 0.8)),
    ];
    const win = pickHighlightWindow(words, 180);
    // window anchors on the chorus (60 s) minus the 1 s lead-in
    expect(win.start).toBeCloseTo(59, 5);
    expect(win.end).toBeCloseTo(79, 5);
  });

  it("ignores unsung words when scoring density", () => {
    const words = [
      // an "unsung" pile early (instrumental mis-alignment)…
      ...Array.from({ length: 20 }, (_, i) => w(5 + i * 0.2, 5.1 + i * 0.2, true)),
      // …and a genuinely sung line later
      ...Array.from({ length: 4 }, (_, i) => w(100 + i, 100.5 + i)),
    ];
    const win = pickHighlightWindow(words, 200);
    expect(win.start).toBeCloseTo(99, 5);
  });

  it("clamps to the song bounds", () => {
    const words = [w(0.2, 0.6), w(1.0, 1.4)];
    const win = pickHighlightWindow(words, 12);
    expect(win.start).toBe(0); // 0.2 - 1s lead-in clamps at 0
    expect(win.end).toBe(12); // 20s window clamps at duration
  });

  it("falls back to the song start for empty or unsung-only maps", () => {
    expect(pickHighlightWindow([], 90)).toEqual({ start: 0, end: 20 });
    expect(pickHighlightWindow([w(3, 4, true)], 15)).toEqual({ start: 0, end: 15 });
  });
});

describe("wordIndexAt", () => {
  const words = [w(1.0, 1.4), w(1.5, 2.0), w(5.0, 5.6)];

  it("finds the active word inside its span", () => {
    expect(wordIndexAt(words, 1.2)).toBe(0);
    expect(wordIndexAt(words, 1.7)).toBe(1);
    expect(wordIndexAt(words, 5.5)).toBe(2);
  });

  it("keeps the word lit briefly after it ends, then goes dark", () => {
    expect(wordIndexAt(words, 2.1)).toBe(1); // within 0.25 s grace
    expect(wordIndexAt(words, 3.5)).toBeNull(); // long gap: nothing lit
  });

  it("nothing before the first word or in an empty map", () => {
    expect(wordIndexAt(words, 0.5)).toBeNull();
    expect(wordIndexAt([], 1)).toBeNull();
  });
});

describe("groupByLine", () => {
  it("groups by lyric line and splits unlinked words into singleton lines", () => {
    const words = [
      { line: 0 },
      { line: 0 },
      { line: 1 },
      { line: undefined },
      { line: undefined },
      { line: 2 },
    ];
    const groups = groupByLine(words);
    expect(groups.map((g) => g.indices)).toEqual([[0, 1], [2], [3], [4], [5]]);
    expect(groups[0].line).toBe(0);
    expect(groups[2].line).toBeNull();
  });
});
