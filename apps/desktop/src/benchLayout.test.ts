import { describe, expect, it } from "vitest";
import type { WordTiming } from "./api";
import {
  envelopeSamples,
  focusRange,
  laneAtTime,
  laneGroups,
  laneOfWord,
  pxToSec,
  secToPx,
  stepView,
  wordAtCaret,
} from "./benchLayout";
import { parseSettings, DEFAULT_SETTINGS } from "./settings";

const w = (word: string, start: number, end: number, line: number): WordTiming => ({
  word,
  start,
  end,
  confidence: 0.9,
  anchored: false,
  unsung: false,
  line,
  word_in_line: 0,
  ad_lib: false,
});

const words: WordTiming[] = [
  w("She", 10.0, 10.3, 0),
  w("said", 10.4, 10.8, 0),
  w("and", 14.0, 14.2, 1),
  w("I", 14.3, 14.5, 1),
  w("care", 15.0, 15.6, 1),
];

describe("laneGroups", () => {
  it("makes one padded, second-snapped lane per line", () => {
    const lanes = laneGroups(words, 60);
    expect(lanes.length).toBe(2);
    expect(lanes[0].indices).toEqual([0, 1]);
    expect(lanes[0].start).toBe(9); // floor(10.0 - 0.6)
    expect(lanes[0].end).toBe(12); // ceil(10.8 + 0.6)
    expect(lanes[1].start).toBe(13);
    expect(lanes[1].end).toBe(17);
  });
  it("maps seconds to px and back", () => {
    const lane = { start: 9, end: 12 };
    expect(secToPx(10.5, lane, 300)).toBeCloseTo(150);
    expect(pxToSec(100, lane, 300)).toBeCloseTo(1);
  });
  it("finds a word's lane and the lane at a time", () => {
    const lanes = laneGroups(words, 60);
    expect(laneOfWord(lanes, 3)).toBe(1);
    expect(laneAtTime(lanes, words, 10.5)).toBe(0);
    expect(laneAtTime(lanes, words, 11.9)).toBe(0); // padded window
    expect(laneAtTime(lanes, words, 30)).toBe(-1);
  });
  it("never falls through in the gap between two lines", () => {
    const lanes = laneGroups(words, 60);
    expect(laneAtTime(lanes, words, 8)).toBe(-1); // before the first window
    expect(laneAtTime(lanes, words, 12.5)).toBe(0); // gap: stays on the line just sung
    expect(laneAtTime(lanes, words, 13.0)).toBe(1); // next line's lead-in window
    expect(laneAtTime(lanes, words, 14.7)).toBe(1); // between two words of a line
    expect(laneAtTime(lanes, words, 16.5)).toBe(1); // trailing window of the last line
  });
});

describe("view axis", () => {
  it("steps and clamps", () => {
    expect(stepView("lanes", -1)).toBe("text");
    expect(stepView("lanes", 1)).toBe("focus");
    expect(stepView("focus", 1)).toBe("focus");
    expect(stepView("text", -1)).toBe("text");
  });
  it("focusRange clamps to the list", () => {
    expect(focusRange(10, 4, 2)).toEqual({ from: 2, to: 6 });
    expect(focusRange(10, 0, 2)).toEqual({ from: 0, to: 2 });
    expect(focusRange(3, 2, 2)).toEqual({ from: 0, to: 2 });
  });
});

describe("wordAtCaret", () => {
  const t = "The tide came and was turning";
  it("returns the word the caret is in or before", () => {
    expect(wordAtCaret(t, 0)).toBeNull();
    expect(wordAtCaret(t, 4)).toBe(1); // "The |tide"
    expect(wordAtCaret(t, 6)).toBe(1); // "The ti|de"
    expect(wordAtCaret(t, 9)).toBe(2); // "The tide |came"
    expect(wordAtCaret(t, t.length)).toBeNull();
  });
});

describe("envelopeSamples", () => {
  it("takes the max bin per sample and zero outside", () => {
    const peaks = [0, 255, 51, 0, 0, 102, 0, 0, 0, 0]; // 10 bins @ 10/s = 1 s
    const s = envelopeSamples(peaks, 10, 0, 1, 5);
    expect(Array.from(s).map((v) => Math.round(v * 100))).toEqual([100, 20, 40, 0, 0]);
    const outside = envelopeSamples(peaks, 10, 5, 6, 2);
    expect(Array.from(outside)).toEqual([0, 0]);
  });
});

describe("settings", () => {
  it("falls back per field", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ theme: "dark", benchView: "bogus" }))).toEqual({
      ...DEFAULT_SETTINGS,
      scheme: "night",
    });
  });
});
