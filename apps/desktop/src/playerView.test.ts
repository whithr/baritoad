import { describe, expect, it } from "vitest";
import { groupByLine, type TimedWord } from "./highlight";
import {
  activeGapAt,
  CUE_PIPS_MIN_GAP_S,
  cueLineFlags,
  GAP_METER_MIN_S,
  gapCues,
  LINE_FIT_MIN,
  lineFit,
  lineIndexAt,
  lyricFrameAt,
  pipsLitAt,
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

describe("lineFit (one row per lyric line)", () => {
  it("fitting lines keep full size", () => {
    expect(lineFit(800, 1000)).toEqual({ scale: 1, wrap: false });
    expect(lineFit(1000, 1000)).toEqual({ scale: 1, wrap: false });
  });

  it("overflowing lines shrink so the row fits, rounded down", () => {
    const f = lineFit(1234, 1000);
    expect(f.wrap).toBe(false);
    expect(f.scale).toBeLessThanOrEqual(1000 / 1234);
    // never more than 0.1% smaller than the exact fit
    expect(f.scale).toBeGreaterThan(1000 / 1234 - 0.001);
  });

  it("past the floor the line keeps the floor size and wraps", () => {
    expect(lineFit(4000, 1000)).toEqual({ scale: LINE_FIT_MIN, wrap: true });
  });

  it("degenerate measurements fall back to full size", () => {
    expect(lineFit(0, 1000)).toEqual({ scale: 1, wrap: false });
    expect(lineFit(800, 0)).toEqual({ scale: 1, wrap: false });
    expect(lineFit(NaN, 1000)).toEqual({ scale: 1, wrap: false });
  });
});

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

// L0's two words straddle a 2.1 s mid-line pause; L1 starts 0.6 s after L0.
const paused: TimedWord[] = [
  { start: 0.5, end: 0.9, unsung: false, line: 0 },
  { start: 3.0, end: 3.4, unsung: false, line: 0 },
  { start: 4.0, end: 4.4, unsung: false, line: 1 },
];
const pausedLines = groupByLine(paused);

describe("lineIndexAt with a mid-line pause", () => {
  it("never pre-rolls the next row while this row has words left", () => {
    // Mid-line gap with L1's onset inside the lead window — the old
    // look-ahead flipped to row 1 here, then bounced back when word 1
    // started at 3.0 (the owner-reported row jitter).
    expect(lineIndexAt(pausedLines, paused, 2.2)).toBe(0);
    expect(lineIndexAt(pausedLines, paused, 2.9)).toBe(0);
  });

  it("still pre-rolls once the row's last word is sung", () => {
    expect(lineIndexAt(pausedLines, paused, 3.7)).toBe(1);
  });
});

describe("approach glow (lyricFrameAt)", () => {
  const at = (t: number) => lyricFrameAt(pausedLines, paused, t);

  it("is idle while a word is active or in its grace", () => {
    expect(at(0.7).approachWord).toBeNull();
    expect(at(1.1).activeWord).toBe(0); // grace holds word 0 through 1.15
    expect(at(1.1).approachWord).toBeNull();
  });

  it("is idle in the pause before the ease window opens", () => {
    const f = at(2.0); // word 1's window opens at 3.0 − 0.6 = 2.4
    expect(f.activeWord).toBeNull();
    expect(f.approachWord).toBeNull();
  });

  it("ramps 0 → 1 across the last WORD_APPROACH_S before the onset", () => {
    expect(at(2.4).approachWord).toBe(1);
    expect(at(2.4).approach).toBeCloseTo(0, 9);
    expect(at(2.7).approach).toBeCloseTo(0.5, 9);
    expect(at(2.99).approach).toBeCloseTo(0.983, 2);
    // At the onset the word goes active and the approach hands off.
    expect(at(3.0).approachWord).toBeNull();
    expect(at(3.0).activeWord).toBe(1);
  });

  it("starts at the grace boundary when the pause is shorter than the window", () => {
    // Gap L0→L1 is 3.4 → 4.0; grace holds word 1 active until 3.65, so the
    // ease runs 3.65 → 4.0 instead of the full 0.6 s window.
    const f = at(3.7);
    expect(f.approachWord).toBe(2);
    expect(f.approach).toBeCloseTo((3.7 - 3.65) / (4.0 - 3.65), 9);
  });

  it("never approaches past the last word", () => {
    expect(at(5.0).approachWord).toBeNull();
  });

  it("back-to-back words never approach (grace covers the hand-off)", () => {
    // Original fixture: 1.0–1.4 → 1.5–1.9 (0.1 s gap < grace).
    const f = lyricFrameAt(lines, words, 1.45);
    expect(f.activeWord).toBe(0); // still in grace
    expect(f.approachWord).toBeNull();
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

describe("gapCues", () => {
  it("finds the long instrumental gap and the intro", () => {
    // Intro is 0 → 1.0 (too short); L1→L2 gap is 3.4 → 10.0 (6.6 s).
    const gaps = gapCues(lines, words);
    expect(gaps).toEqual([{ afterLine: 1, start: 3.4, end: 10.0 }]);
  });

  it("includes an intro gap of at least the threshold", () => {
    const late: TimedWord[] = [
      { start: 8.0, end: 8.4, unsung: false, line: 0 },
      { start: 12.0, end: 12.4, unsung: false, line: 1 },
    ];
    const gaps = gapCues(groupByLine(late), late);
    expect(gaps).toEqual([{ afterLine: -1, start: 0, end: 8.0 }]);
  });

  it("threshold is inclusive and measured from the previous line's last end", () => {
    const w: TimedWord[] = [
      { start: 0.0, end: 1.0, unsung: false, line: 0 },
      { start: 1.0 + GAP_METER_MIN_S, end: 7.0, unsung: false, line: 1 },
    ];
    expect(gapCues(groupByLine(w), w)).toHaveLength(1);
    const shy: TimedWord[] = [
      { start: 0.0, end: 1.0, unsung: false, line: 0 },
      { start: 0.99 + GAP_METER_MIN_S, end: 7.0, unsung: false, line: 1 },
    ];
    expect(gapCues(groupByLine(shy), shy)).toHaveLength(0);
  });

  it("empty maps have no gaps", () => {
    expect(gapCues([], [])).toEqual([]);
  });
});

describe("cueLineFlags", () => {
  it("flags lines preceded by enough silence, including the intro line", () => {
    // Intro 0→1.0 is under the pip threshold; L0→L1 gap is 1.9→2.5 (0.6 s);
    // L1→L2 gap is 3.4→10.0.
    expect(cueLineFlags(lines, words)).toEqual([false, false, true]);
  });

  it("uses the pip threshold, not the meter threshold", () => {
    const w: TimedWord[] = [
      { start: CUE_PIPS_MIN_GAP_S, end: 3.0, unsung: false, line: 0 },
      { start: 3.2, end: 3.6, unsung: false, line: 1 },
    ];
    expect(cueLineFlags(groupByLine(w), w)).toEqual([true, false]);
  });
});

describe("pipsLitAt", () => {
  it("counts 3 → 2 → 1 over the last three seconds, else 0", () => {
    expect(pipsLitAt(10, 6.9)).toBe(0); // before the window
    expect(pipsLitAt(10, 7.0)).toBe(3);
    expect(pipsLitAt(10, 7.5)).toBe(3);
    expect(pipsLitAt(10, 8.1)).toBe(2);
    expect(pipsLitAt(10, 9.1)).toBe(1);
    expect(pipsLitAt(10, 10.0)).toBe(0); // the word has started
    expect(pipsLitAt(10, 11.0)).toBe(0);
  });
});

describe("activeGapAt", () => {
  const gaps = gapCues(lines, words);

  it("finds the containing gap", () => {
    expect(activeGapAt(gaps, 5.0)).toBe(0);
    expect(activeGapAt(gaps, 3.4)).toBe(0); // start is inclusive
  });

  it("is null outside every gap", () => {
    expect(activeGapAt(gaps, 2.0)).toBeNull();
    expect(activeGapAt(gaps, 10.0)).toBeNull(); // end is exclusive
    expect(activeGapAt([], 5)).toBeNull();
  });
});

describe("scrollStep", () => {
  it("approaches the target and eventually snaps", () => {
    let s = { pos: 0, vel: 0 };
    for (let i = 0; i < 400; i++) s = scrollStep(s.pos, s.vel, 500, 8.33);
    expect(s.pos).toBe(500);
    expect(s.vel).toBe(0);
  });

  it("is frame-rate independent (same trajectory at 60 vs 120 Hz)", () => {
    // Advance 96 ms as 6×16 ms and as 12×8 ms — closed form, so exact.
    let a = { pos: 0, vel: 0 };
    for (let i = 0; i < 6; i++) a = scrollStep(a.pos, a.vel, 300, 16, 8, 0, 0);
    let b = { pos: 0, vel: 0 };
    for (let i = 0; i < 12; i++) b = scrollStep(b.pos, b.vel, 300, 8, 8, 0, 0);
    expect(Math.abs(a.pos - b.pos)).toBeLessThan(1e-6);
    expect(Math.abs(a.vel - b.vel)).toBeLessThan(1e-6);
  });

  it("starts gently from rest — no first-frame kick", () => {
    // One 120 Hz frame: the spring covers ~0.2% of the distance where the
    // old exponential jumped ~3% (the line-switch "kick").
    const s = scrollStep(0, 0, 1000, 8);
    expect(s.pos).toBeGreaterThan(0);
    expect(s.pos).toBeLessThan(5);
  });

  it("keeps position and velocity continuous across a retarget", () => {
    let s = { pos: 0, vel: 0 };
    for (let i = 0; i < 30; i++) s = scrollStep(s.pos, s.vel, 200, 8);
    // Mid-glide the target jumps (a line switch): after a near-zero step
    // the state must be unchanged — no teleport, no velocity kick.
    const after = scrollStep(s.pos, s.vel, 600, 0.01);
    // Position advances by ~vel·dt and velocity by ~accel·dt — both → 0 with
    // dt, which is what continuity means (the old exponential teleported to
    // full retarget speed regardless of dt).
    const dtS = 0.01 / 1000;
    const accel = Math.abs(-2 * 8 * s.vel - 8 * 8 * (s.pos - 600));
    expect(Math.abs(after.pos - s.pos)).toBeLessThan(Math.abs(s.vel) * dtS * 2 + 1e-6);
    expect(Math.abs(after.vel - s.vel)).toBeLessThan(accel * dtS * 2 + 1e-6);
  });

  it("moves monotonically toward the target from rest (no overshoot)", () => {
    let s = { pos: 100, vel: 0 };
    let prev = s.pos;
    for (let i = 0; i < 300; i++) {
      s = scrollStep(s.pos, s.vel, 200, 8.33);
      expect(s.pos).toBeGreaterThanOrEqual(prev);
      expect(s.pos).toBeLessThanOrEqual(200);
      prev = s.pos;
    }
    expect(s.pos).toBe(200);
  });

  it("snaps within the settle threshold", () => {
    expect(scrollStep(100.4, 0, 100, 8)).toEqual({ pos: 100, vel: 0 });
  });
});
