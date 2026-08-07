import { describe, expect, it } from "vitest";
import type { WordTiming } from "./api";
import {
  DOC_MAX_WINDOW_S,
  DOC_REALIGN_PAD_S,
  docLineTimes,
  docTextFromWords,
  parseLyricDoc,
  planRealignWindows,
  retimeDocument,
} from "./docEdit";

const w = (
  word: string,
  start: number,
  end: number,
  line: number,
  wordInLine: number,
): WordTiming => ({
  word,
  start,
  end,
  confidence: 0.9,
  anchored: true,
  unsung: false,
  line,
  word_in_line: wordInLine,
  ad_lib: false,
});

// "I wish | money gave you" — two lines, hand-tuned times.
const WORDS: WordTiming[] = [
  w("I", 1.0, 1.2, 0, 0),
  w("wish", 1.3, 1.7, 0, 1),
  w("money", 5.0, 5.6, 1, 0),
  w("gave", 5.7, 6.0, 1, 1),
  w("you", 6.1, 6.3, 1, 2),
];

describe("parseLyricDoc / docTextFromWords", () => {
  it("round-trips the current words through text", () => {
    const text = docTextFromWords(WORDS);
    expect(text).toBe("I wish\nmoney gave you");
    expect(parseLyricDoc(text)).toEqual([
      ["I", "wish"],
      ["money", "gave", "you"],
    ]);
  });

  it("drops blank rows on parse", () => {
    expect(parseLyricDoc("I wish\n\n  \nmoney")).toEqual([["I", "wish"], ["money"]]);
  });
});

describe("retimeDocument", () => {
  it("keeps matched words' timings and takes line links from the text rows", () => {
    // Same words, new break shape: 3 lines instead of 2.
    const commit = retimeDocument(WORDS, [["I"], ["wish", "money"], ["gave", "you"]]);
    expect(commit).not.toBeNull();
    expect(commit!.changed).toEqual([]);
    expect(commit!.words.map((x) => x.start)).toEqual([1.0, 1.3, 5.0, 5.7, 6.1]);
    expect(commit!.words.map((x) => x.line)).toEqual([0, 1, 1, 2, 2]);
    expect(commit!.words.map((x) => x.word_in_line)).toEqual([0, 0, 1, 0, 1]);
  });

  it("marks replaced runs as changed with estimated timings", () => {
    // "gave you" → "bought us": two changed words in line 1.
    const commit = retimeDocument(WORDS, [
      ["I", "wish"],
      ["money", "bought", "us"],
    ])!;
    expect(commit.changed).toEqual([{ first: 3, last: 4 }]);
    // matched words untouched
    expect(commit.words[2].start).toBe(5.0);
    // same-count swap inherits the replaced words' spans 1:1
    expect(commit.words[3].start).toBe(5.7);
    expect(commit.words[4].start).toBe(6.1);
    expect(commit.words[3].word).toBe("bought");
  });

  it("reports several separated changed runs", () => {
    const commit = retimeDocument(WORDS, [
      ["A", "wish"],
      ["money", "gave", "B"],
    ])!;
    expect(commit.changed).toEqual([
      { first: 0, last: 0 },
      { first: 4, last: 4 },
    ]);
  });

  it("returns null for an empty document", () => {
    expect(retimeDocument(WORDS, [])).toBeNull();
  });
});

describe("planRealignWindows", () => {
  it("pads a run's window without swallowing neighbor words", () => {
    const commit = retimeDocument(WORDS, [
      ["I", "wish"],
      ["money", "bought", "us"],
    ])!;
    const [win] = planRealignWindows(commit.words, commit.changed, 30);
    expect(win.first).toBe(3);
    expect(win.last).toBe(4);
    // left edge clamps at the matched neighbor's end ("money" ends 5.6),
    // right edge pads freely (no word after the run)
    expect(win.start).toBe(5.6);
    expect(win.end).toBeCloseTo(6.3 + DOC_REALIGN_PAD_S, 5);
  });

  it("splits a changed run longer than the window cap", () => {
    // 60 changed words spread over 300 s — far past DOC_MAX_WINDOW_S.
    const many: WordTiming[] = Array.from({ length: 60 }, (_, i) =>
      w(`w${i}`, i * 5, i * 5 + 1, 0, i),
    );
    const wins = planRealignWindows(many, [{ first: 0, last: 59 }], 300);
    expect(wins.length).toBeGreaterThan(1);
    for (const win of wins) {
      expect(win.end - win.start).toBeLessThanOrEqual(DOC_MAX_WINDOW_S);
    }
    // chunks tile the run exactly
    expect(wins[0].first).toBe(0);
    expect(wins[wins.length - 1].last).toBe(59);
    for (let i = 1; i < wins.length; i++) {
      expect(wins[i].first).toBe(wins[i - 1].last + 1);
    }
  });

  it("skips a zero-length window instead of sending it to the aligner", () => {
    // A word squeezed exactly between two touching neighbors: no gap.
    const tight: WordTiming[] = [
      w("a", 1.0, 2.0, 0, 0),
      { ...w("x", 2.0, 2.0, 0, 1) },
      w("b", 2.0, 3.0, 0, 2),
    ];
    expect(planRealignWindows(tight, [{ first: 1, last: 1 }], 10)).toEqual([]);
  });
});

describe("docLineTimes", () => {
  it("maps raw rows (blanks included) to their first surviving word's time", () => {
    const times = docLineTimes(WORDS, ["I wish", "", "money gave you"]);
    expect(times).toEqual([1.0, null, 5.0]);
  });

  it("reports null for a row that matches nothing yet", () => {
    const times = docLineTimes(WORDS, ["totally new line", "money gave you"]);
    expect(times).toEqual([null, 5.0]);
  });

  it("follows a line even when its first word was retyped", () => {
    const times = docLineTimes(WORDS, ["I wish", "cash gave you"]);
    // "cash" is new, but "gave" survives — the row reports gave's time.
    expect(times).toEqual([1.0, 5.7]);
  });
});
