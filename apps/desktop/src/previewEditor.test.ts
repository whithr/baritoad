import { describe, expect, it } from "vitest";
import {
  PUCK_FLIGHT_MAX_S,
  PUCK_FLIGHT_MIN_S,
  puckFrameAt,
  shiftRange,
  type PuckWord,
} from "./previewEditor";

const w = (start: number, end: number, unsung = false): PuckWord => ({ start, end, unsung });

// a: [1, 1.4]  b: [2, 2.4]  c: [4, 4.4]   (short gap a→b, long gap b→c)
const words = [w(1, 1.4), w(2, 2.4), w(4, 4.4)];

describe("puckFrameAt", () => {
  it("rests on the word being sung", () => {
    expect(puckFrameAt(words, 1.2)).toEqual({ kind: "rest", index: 0 });
  });

  it("flies the whole gap when the gap is short", () => {
    // gap a→b is 0.6s exactly: flight spans [1.4, 2.0]
    const f = puckFrameAt(words, 1.7);
    expect(f.kind).toBe("flight");
    if (f.kind === "flight") {
      expect(f.from).toBe(0);
      expect(f.to).toBe(1);
      expect(f.progress).toBeCloseTo(0.5);
    }
  });

  it("parks on the previous word through a long gap, then launches", () => {
    // gap b→c is [2.4, 4.0]; flight starts at 4.0 - 0.6 = 3.4
    expect(puckFrameAt(words, 3.0)).toEqual({ kind: "rest", index: 1 });
    const f = puckFrameAt(words, 3.7);
    expect(f.kind).toBe("flight");
    if (f.kind === "flight") expect(f.progress).toBeCloseTo((3.7 - 3.4) / PUCK_FLIGHT_MAX_S);
  });

  it("lands exactly at the next onset", () => {
    const f = puckFrameAt(words, 2.0 - 1e-9);
    expect(f.kind).toBe("flight");
    if (f.kind === "flight") expect(f.progress).toBeCloseTo(1);
  });

  it("arcs in from nowhere before the first word", () => {
    // first flight window: [0.4, 1.0]
    expect(puckFrameAt(words, 0.1)).toEqual({ kind: "hidden" });
    const f = puckFrameAt(words, 0.7);
    expect(f.kind).toBe("flight");
    if (f.kind === "flight") expect(f.from).toBeNull();
  });

  it("skips unsung words entirely", () => {
    const withUnsung = [w(1, 1.4), w(2, 2.4, true), w(4, 4.4)];
    const f = puckFrameAt(withUnsung, 3.7);
    expect(f.kind).toBe("flight");
    if (f.kind === "flight") {
      expect(f.from).toBe(0);
      expect(f.to).toBe(2);
    }
    // while the unsung word "plays", the puck still rests on the last sung one
    expect(puckFrameAt(withUnsung, 2.2)).toEqual({ kind: "rest", index: 0 });
  });

  it("goes dark after the last word", () => {
    expect(puckFrameAt(words, 5.0)).toEqual({ kind: "hidden" });
    expect(puckFrameAt([], 1)).toEqual({ kind: "hidden" });
  });

  it("keeps a minimum flight on butted words, departing early", () => {
    // a's end is cut right against b's onset — a zero gap must not teleport;
    // the flight departs through a's tail: [2 - MIN, 2]
    const butted = [w(1, 2), w(2, 2.4), w(4, 4.4)];
    expect(puckFrameAt(butted, 1.5)).toEqual({ kind: "rest", index: 0 });
    const f = puckFrameAt(butted, 2 - PUCK_FLIGHT_MIN_S / 2);
    expect(f.kind).toBe("flight");
    if (f.kind === "flight") {
      expect(f.from).toBe(0);
      expect(f.to).toBe(1);
      expect(f.progress).toBeCloseTo(0.5);
    }
  });

  it("caps chained rapid-fire words at the onset interval", () => {
    // onsets 0.12 s apart: the flight takes the whole interval — continuous
    // motion, and the puck is never due at b before it left a
    const rapid = [w(1, 1.05), w(1.12, 1.2), w(3, 3.4)];
    const f = puckFrameAt(rapid, 1.06);
    expect(f.kind).toBe("flight");
    if (f.kind === "flight") {
      expect(f.from).toBe(0);
      expect(f.to).toBe(1);
      expect(f.progress).toBeCloseTo((1.06 - 1.0) / 0.12);
    }
  });
});

describe("shiftRange", () => {
  const lined = [
    { line: 0 },
    { line: 0 },
    { line: 1 },
    { line: 1 },
    { line: 1 },
    { line: 2 },
  ];

  it("word scope is just the word", () => {
    expect(shiftRange(lined, 3, "word")).toEqual({ first: 3, last: 3 });
  });

  it("line scope spans the whole line", () => {
    expect(shiftRange(lined, 3, "line")).toEqual({ first: 2, last: 4 });
  });

  it("tail scope runs to the end of the song", () => {
    expect(shiftRange(lined, 2, "tail")).toEqual({ first: 2, last: 5 });
  });

  it("line scope degrades to word when the map has no line structure", () => {
    expect(shiftRange([{}, {}, {}], 1, "line")).toEqual({ first: 1, last: 1 });
  });

  it("rejects an out-of-range selection", () => {
    expect(shiftRange(lined, -1, "word")).toBeNull();
    expect(shiftRange(lined, 6, "tail")).toBeNull();
  });
});
