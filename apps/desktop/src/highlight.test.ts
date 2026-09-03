import { describe, expect, it } from "vitest";
import { groupByLine, sungThroughIndexAt, wordIndexAt } from "./highlight";

const w = (start: number, end: number, unsung = false, line?: number) => ({
  start,
  end,
  unsung,
  line,
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

describe("sungThroughIndexAt", () => {
  const words = [w(1.0, 1.4), w(1.5, 2.0), w(5.0, 5.6)];

  it("tracks the last word that started", () => {
    expect(sungThroughIndexAt(words, 1.2)).toBe(0);
    expect(sungThroughIndexAt(words, 1.7)).toBe(1);
    expect(sungThroughIndexAt(words, 9)).toBe(2);
  });

  it("holds through gaps where wordIndexAt goes null (sung tint must not vanish)", () => {
    // 3.5 s is the long instrumental gap between words 1 and 2
    expect(wordIndexAt(words, 3.5)).toBeNull();
    expect(sungThroughIndexAt(words, 3.5)).toBe(1);
  });

  it("null only before the first word or in an empty map", () => {
    expect(sungThroughIndexAt(words, 0.5)).toBeNull();
    expect(sungThroughIndexAt([], 1)).toBeNull();
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
