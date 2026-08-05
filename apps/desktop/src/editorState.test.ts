import { describe, expect, it } from "vitest";
import type { TimingMap, WordTiming } from "./api";
import {
  clampWord,
  editorReducer,
  exportFreshness,
  initEditor,
  isDirty,
  mapFromEditor,
  NUDGE_COARSE_S,
  NUDGE_S,
} from "./editorState";

const word = (text: string, start: number, end: number, unsung = false): WordTiming => ({
  word: text,
  start,
  end,
  confidence: 0.9,
  anchored: true,
  unsung,
  ad_lib: false,
});

const map = (words: WordTiming[], duration = 30): TimingMap => ({
  version: 1,
  time_base: "original-song",
  duration,
  words,
  unsung_spans: [],
});

const threeWords = () => map([word("a", 1.0, 1.4), word("b", 2.0, 2.4), word("c", 3.0, 3.4)]);

describe("clampWord (drag monotonicity)", () => {
  it("a word cannot cross its neighbors' onsets", () => {
    const m = threeWords();
    // drag b's start before a's onset → pinned at a.start
    expect(clampWord(m.words, m.duration, 1, 0.2, 2.4).start).toBe(1.0);
    // drag b's start past c's onset → pinned at c.start
    expect(clampWord(m.words, m.duration, 1, 3.7, 3.9).start).toBe(3.0);
  });

  it("end never precedes start, times stay in [0, duration]", () => {
    const m = threeWords();
    const c = clampWord(m.words, m.duration, 1, 2.2, 1.9);
    expect(c.end).toBeGreaterThanOrEqual(c.start);
    expect(clampWord(m.words, m.duration, 0, -5, 1.4).start).toBe(0);
    expect(clampWord(m.words, m.duration, 2, 3.0, 99).end).toBe(m.duration);
  });
});

describe("commit-drag", () => {
  it("applies a real drag and records undo", () => {
    let s = initEditor(threeWords());
    s = editorReducer(s, { type: "commit-drag", index: 1, start: 2.2, end: 2.6 });
    expect(s.words[1].start).toBeCloseTo(2.2);
    expect(s.past).toHaveLength(1);
    expect(isDirty(s)).toBe(true);
  });

  it("micro-drags are no-ops: no dirty, no undo entry (snap resistance)", () => {
    const s0 = initEditor(threeWords());
    const s1 = editorReducer(s0, {
      type: "commit-drag",
      index: 1,
      start: 2.0 + 0.002, // 2 ms wiggle
      end: 2.4 + 0.002,
    });
    expect(s1).toBe(s0);
    expect(isDirty(s1)).toBe(false);
  });

  it("a drag clamped back to where it started is also a no-op", () => {
    const s0 = initEditor(threeWords());
    // b's start dragged way left clamps to a.start=1.0 — a real move; but
    // a's start dragged left clamps to 0→? a.start=1.0 → drag to -3 clamps to 0: real move.
    // The no-op case: c's END dragged beyond duration then back to 3.4.
    const s1 = editorReducer(s0, { type: "commit-drag", index: 2, start: 3.0, end: 3.4 });
    expect(s1).toBe(s0);
  });
});

describe("nudge", () => {
  it("fine and coarse nudges move the whole word", () => {
    let s = initEditor(threeWords());
    s = editorReducer(s, { type: "nudge", index: 1, deltaS: NUDGE_S });
    expect(s.words[1].start).toBeCloseTo(2.01);
    expect(s.words[1].end).toBeCloseTo(2.41);
    s = editorReducer(s, { type: "nudge", index: 1, deltaS: -NUDGE_COARSE_S });
    expect(s.words[1].start).toBeCloseTo(1.91);
  });

  it("nudging into a neighbor clamps at its onset", () => {
    let s = initEditor(threeWords());
    for (let i = 0; i < 20; i++) {
      s = editorReducer(s, { type: "nudge", index: 1, deltaS: 0.1 });
    }
    expect(s.words[1].start).toBe(3.0); // c's onset — cannot cross
  });
});

describe("undo/redo", () => {
  it("round-trips edits and redo clears on a new edit", () => {
    const s0 = initEditor(threeWords());
    let s = editorReducer(s0, { type: "commit-drag", index: 0, start: 1.2, end: 1.6 });
    s = editorReducer(s, { type: "nudge", index: 2, deltaS: 0.1 });
    expect(s.past).toHaveLength(2);

    s = editorReducer(s, { type: "undo" });
    expect(s.words[2].start).toBeCloseTo(3.0);
    expect(s.words[0].start).toBeCloseTo(1.2); // first edit still applied
    expect(s.future).toHaveLength(1);

    s = editorReducer(s, { type: "redo" });
    expect(s.words[2].start).toBeCloseTo(3.1);

    s = editorReducer(s, { type: "undo" });
    s = editorReducer(s, { type: "commit-drag", index: 1, start: 2.5, end: 2.8 });
    expect(s.future).toHaveLength(0); // new edit invalidates redo
  });

  it("undoing back to the saved words reads as clean again", () => {
    const s0 = initEditor(threeWords());
    let s = editorReducer(s0, { type: "commit-drag", index: 0, start: 1.3, end: 1.7 });
    expect(isDirty(s)).toBe(true);
    s = editorReducer(s, { type: "undo" });
    expect(isDirty(s)).toBe(false); // reference equality with the loaded array
  });

  it("mark-saved makes the current words the clean baseline", () => {
    let s = initEditor(threeWords());
    s = editorReducer(s, { type: "commit-drag", index: 0, start: 1.3, end: 1.7 });
    s = editorReducer(s, { type: "mark-saved" });
    expect(isDirty(s)).toBe(false);
    s = editorReducer(s, { type: "undo" });
    expect(isDirty(s)).toBe(true); // undo past the save point is dirty again
  });

  it("undo on a fresh editor is a no-op", () => {
    const s0 = initEditor(threeWords());
    expect(editorReducer(s0, { type: "undo" })).toBe(s0);
    expect(editorReducer(s0, { type: "redo" })).toBe(s0);
  });
});

describe("apply-realign", () => {
  it("splices new timings, clamped to the untouched neighbors", () => {
    const m = map([
      word("keep0", 1.0, 1.4),
      word("x", 5.0, 5.4, true),
      word("y", 5.5, 6.0, true),
      word("keep3", 10.0, 10.5),
    ]);
    let s = initEditor(m);
    s = editorReducer(s, {
      type: "apply-realign",
      first: 1,
      last: 2,
      timings: [
        { word: "x", start: 0.2, end: 4.0, confidence: 0.8 }, // before neighbor: clamps to 1.0
        { word: "y", start: 11.5, end: 12.0, confidence: 0.7 }, // after neighbor: clamps to 10.0
      ],
    });
    expect(s.words[1].start).toBe(1.0);
    expect(s.words[2].start).toBe(10.0);
    // onsets stay monotonic end to end
    for (let i = 1; i < s.words.length; i++) {
      expect(s.words[i].start).toBeGreaterThanOrEqual(s.words[i - 1].start);
    }
    // realigned words: fresh confidence, unsung cleared, anchor dropped
    expect(s.words[1].confidence).toBe(0.8);
    expect(s.words[1].unsung).toBe(false);
    expect(s.words[1].anchored).toBe(false);
    // untouched words untouched
    expect(s.words[0]).toBe(m.words[0]);
    // and it's one undoable step
    const back = editorReducer(s, { type: "undo" });
    expect(back.words[1].unsung).toBe(true);
  });

  it("rejects a length-mismatched splice", () => {
    const s0 = initEditor(threeWords());
    const s1 = editorReducer(s0, {
      type: "apply-realign",
      first: 0,
      last: 2,
      timings: [{ word: "a", start: 1, end: 2, confidence: 1 }],
    });
    expect(s1).toBe(s0);
  });
});

describe("mapFromEditor", () => {
  it("recomputes unsung spans from word flags with truthful times", () => {
    const words = [
      word("a", 1, 2),
      word("b", 3, 4, true),
      word("c", 5, 6, true),
      word("d", 7, 8),
      word("e", 9, 10, true),
    ];
    const out = mapFromEditor(map(words), words);
    expect(out.unsung_spans).toEqual([
      { first_word: 1, last_word: 2, start: 3, end: 6 },
      { first_word: 4, last_word: 4, start: 9, end: 10 },
    ]);
  });

  it("no unsung words → no spans", () => {
    const words = [word("a", 1, 2)];
    expect(mapFromEditor(map(words), words).unsung_spans).toEqual([]);
  });
});

describe("exportFreshness (stale-export detection)", () => {
  const status = {
    current_map_sha256: "aaa",
    exports: {
      lrc: { map_sha256: "aaa", exists: true },
      ass: { map_sha256: "old", exists: true },
      ultrastar: { map_sha256: "aaa", exists: false },
    },
  };

  it("fresh iff hash matches and the file exists", () => {
    expect(exportFreshness(status, "lrc")).toBe("fresh");
    expect(exportFreshness(status, "ass")).toBe("stale"); // map changed since export
    expect(exportFreshness(status, "ultrastar")).toBe("none"); // file deleted
    expect(exportFreshness(status, "never-exported")).toBe("none");
  });

  it("unsaved editor edits mark even hash-fresh exports stale", () => {
    expect(exportFreshness(status, "lrc", true)).toBe("stale");
  });
});
