import { describe, expect, it } from "vitest";
import type { TimingMap, WordTiming } from "./api";
import { editorReducer, initEditor } from "./editorState";
import {
  breakLineAt,
  joinLineUp,
  reflowLines,
  retimeLine,
  tokenizeLyric,
  REFLOW_MAX_WORDS,
} from "./lineEdit";

const word = (
  text: string,
  start: number,
  end: number,
  line?: number,
  wordInLine?: number,
): WordTiming => ({
  word: text,
  start,
  end,
  confidence: 0.9,
  anchored: true,
  unsung: false,
  line,
  word_in_line: wordInLine,
  ad_lib: false,
});

/** A line every 0.55s starting at t0; words 0.32s long. */
const mkLine = (texts: string[], t0: number, line: number): WordTiming[] =>
  texts.map((t, i) => word(t, t0 + i * 0.55, t0 + i * 0.55 + 0.32, line, i));

describe("tokenizeLyric", () => {
  it("splits on whitespace, dropping empties", () => {
    expect(tokenizeLyric("  sailing   on ")).toEqual(["sailing", "on"]);
    expect(tokenizeLyric("   ")).toEqual([]);
  });
});

describe("retimeLine", () => {
  // The case that started it: "Paper boats drift slow to meet the dark" →
  //               "sailing on to meet the dawn"
  const oldLine = mkLine(["Paper", "boats", "drift", "slow", "to", "meet", "the", "dark"], 10, 3);

  it("keeps timings of words that survive the edit", () => {
    const out = retimeLine(oldLine, tokenizeLyric("sailing on to meet the dawn"));
    expect(out.map((w) => w.word)).toEqual(["sailing", "on", "to", "meet", "the", "dawn"]);
    // "to meet the" matched → original timings intact
    expect(out[2].start).toBeCloseTo(oldLine[4].start);
    expect(out[3].start).toBeCloseTo(oldLine[5].start);
    expect(out[4].start).toBeCloseTo(oldLine[6].start);
    expect(out[4].confidence).toBeCloseTo(0.9); // matched words keep flags
  });

  it("spreads a replacement run across the replaced span", () => {
    const out = retimeLine(oldLine, tokenizeLyric("sailing on to meet the dawn"));
    // "sailing on" replaces "Paper boats drift slow": spans the line start up to
    // the matched "to" onset, divided evenly
    expect(out[0].start).toBeCloseTo(oldLine[0].start);
    expect(out[1].start).toBeGreaterThan(out[0].start);
    expect(out[1].end).toBeLessThanOrEqual(oldLine[4].start + 1e-9);
    // "dawn" replaces "dark" at the tail: keeps the tail span
    expect(out[5].start).toBeCloseTo(oldLine[7].start);
    expect(out[5].confidence).toBe(1); // new word, user-authored
  });

  it("matching ignores case and punctuation but keeps typed casing", () => {
    const out = retimeLine(mkLine(["meet", "the", "dark,"], 5, 0), ["Meet", "the", "dawn"]);
    expect(out[0].word).toBe("Meet");
    expect(out[0].start).toBeCloseTo(5);
    expect(out[2].word).toBe("dawn");
  });

  it("full replacement divides the whole line span", () => {
    const out = retimeLine(mkLine(["a", "b"], 2, 0), ["x", "y", "z"]);
    expect(out).toHaveLength(3);
    expect(out[0].start).toBeCloseTo(2);
    expect(out[2].end).toBeLessThanOrEqual(2 + 0.55 + 0.32 + 1e-9);
    for (let i = 1; i < out.length; i++)
      expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start);
  });

  it("renumbers word_in_line for the new count", () => {
    const out = retimeLine(oldLine, tokenizeLyric("sailing on to meet the dawn"));
    expect(out.map((w) => [w.line, w.word_in_line])).toEqual([
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 4],
      [3, 5],
    ]);
  });
});

describe("breakLineAt / joinLineUp", () => {
  const words = [...mkLine(["a", "b", "c", "d"], 0, 0), ...mkLine(["e", "f"], 5, 1)];

  it("break makes the word a line start and renumbers canonically", () => {
    const out = breakLineAt(words, 2)!;
    expect(out.map((w) => [w.line, w.word_in_line])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
    ]);
    // timings untouched
    expect(out[2].start).toBeCloseTo(words[2].start);
  });

  it("break at a line start or without line structure is a no-op", () => {
    expect(breakLineAt(words, 4)).toBeNull(); // "e" already starts line 1
    expect(breakLineAt([word("a", 0, 1), word("b", 2, 3)], 1)).toBeNull();
  });

  it("join folds a line into the previous one", () => {
    const out = joinLineUp(words, 4)!;
    expect(out.map((w) => [w.line, w.word_in_line])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
    ]);
  });

  it("join on the first line is a no-op", () => {
    expect(joinLineUp(words, 1)).toBeNull();
  });
});

describe("reflowLines", () => {
  it("breaks at silence gaps and terminal punctuation", () => {
    const words = [
      // phrase 1 ends with a comma-free gap
      word("Riding", 0, 0.3),
      word("up", 0.5, 0.8),
      // 1.5s silence
      word("For", 2.3, 2.6),
      word("all.", 2.8, 3.1),
      // punctuation break
      word("New", 3.2, 3.5),
      word("start", 3.7, 4.0),
    ];
    const out = reflowLines(words);
    expect(out.map((w) => w.line)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(out.map((w) => w.word_in_line)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("caps run-on lines at the max word count", () => {
    const texts = Array.from({ length: REFLOW_MAX_WORDS + 3 }, (_, i) => `w${i}`);
    const out = reflowLines(mkLine(texts, 0, 0));
    expect(out[REFLOW_MAX_WORDS].line).toBe(1);
    expect(out[REFLOW_MAX_WORDS].word_in_line).toBe(0);
  });

  it("gives line structure to maps that never had one", () => {
    const words = [word("a", 0, 0.3), word("b", 0.5, 0.8), word("c", 2.5, 2.8)];
    const out = reflowLines(words);
    expect(out.map((w) => w.line)).toEqual([0, 0, 1]);
  });
});

describe("set-line-text through the reducer", () => {
  const map = (words: WordTiming[]): TimingMap => ({
    version: 1,
    time_base: "original-song",
    duration: 30,
    words,
    unsung_spans: [],
  });

  it("splices the retimed line, clears selection, records one undo entry", () => {
    const words = [...mkLine(["intro"], 1, 0), ...mkLine(["Paper", "boats", "drift", "slow"], 10, 1)];
    let s = initEditor(map(words));
    s = editorReducer(s, { type: "select", index: 2 });
    s = editorReducer(s, { type: "set-line-text", first: 1, last: 4, text: "sailing on" });
    expect(s.words.map((w) => w.word)).toEqual(["intro", "sailing", "on"]);
    expect(s.selected).toBeNull();
    expect(s.past).toHaveLength(1);
    // onsets stay monotonic against the untouched neighbor
    expect(s.words[1].start).toBeGreaterThanOrEqual(s.words[0].start);
  });

  it("unchanged text is a no-op", () => {
    const words = mkLine(["meet", "the", "dawn"], 5, 0);
    const s0 = initEditor(map(words));
    expect(
      editorReducer(s0, { type: "set-line-text", first: 0, last: 2, text: "meet the dawn" }),
    ).toBe(s0);
  });
});
