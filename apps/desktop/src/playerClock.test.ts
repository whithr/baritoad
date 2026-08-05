import { describe, expect, it } from "vitest";
import {
  applyReport,
  CORRECTION_WINDOW_MS,
  estimate,
  initClock,
  SNAP_S,
} from "./playerClock";

describe("interpolated player clock", () => {
  it("first report snaps without counting jitter", () => {
    const c = applyReport(initClock(), 12.5, 1.0, 1000);
    expect(estimate(c, 1000)).toBe(12.5);
    expect(c.snaps).toBe(0);
    expect(c.corrections).toBe(0);
    expect(c.maxAbsErrorMs).toBe(0);
  });

  it("advances at the report rate between reports", () => {
    const c = applyReport(initClock(), 10, 1.0, 0);
    expect(estimate(c, 500)).toBeCloseTo(10.5, 9);
    // Tempo 0.8: song advances at 0.8 song-seconds per wall second.
    const slow = applyReport(initClock(), 10, 0.8, 0);
    expect(estimate(slow, 1000)).toBeCloseTo(10.8, 9);
  });

  it("holds still while paused (rate 0)", () => {
    const c = applyReport(initClock(), 42, 0, 0);
    expect(estimate(c, 5000)).toBe(42);
  });

  it("steady-state error is folded in smoothly, not stepped", () => {
    let c = applyReport(initClock(), 10, 1.0, 0);
    // Next report 100 ms later says 10.105 — est was 10.100, err = +5 ms.
    c = applyReport(c, 10.105, 1.0, 100);
    // Continuous at the moment of the report…
    expect(estimate(c, 100)).toBeCloseTo(10.1, 9);
    // …fully corrected after the window (est advances + drains the 5 ms).
    const after = estimate(c, 100 + CORRECTION_WINDOW_MS);
    expect(after).toBeCloseTo(10.1 + CORRECTION_WINDOW_MS / 1000 + 0.005, 9);
    expect(c.corrections).toBe(1);
    expect(c.snaps).toBe(0);
    expect(c.lastErrorMs).toBeCloseTo(5, 6);
    expect(c.maxAbsErrorMs).toBeCloseTo(5, 6);
  });

  it("negative corrections keep the estimate monotonic for small errors", () => {
    let c = applyReport(initClock(), 10, 1.0, 0);
    c = applyReport(c, 10.095, 1.0, 100); // est 10.100, err −5 ms
    // The drain (−5 ms over 120 ms) is slower than playback (+120 ms), so
    // time still moves forward every frame.
    let prev = estimate(c, 100);
    for (let t = 108; t <= 300; t += 8) {
      const e = estimate(c, t);
      expect(e).toBeGreaterThan(prev);
      prev = e;
    }
  });

  it("a seek-sized jump snaps and is not counted as jitter", () => {
    let c = applyReport(initClock(), 10, 1.0, 0);
    c = applyReport(c, 55, 1.0, 100); // |err| >> SNAP_S
    expect(estimate(c, 100)).toBe(55);
    expect(c.snaps).toBe(1);
    expect(c.maxAbsErrorMs).toBe(0);
  });

  it("a rate change (pause) snaps even when the position matches", () => {
    let c = applyReport(initClock(), 10, 1.0, 0);
    c = applyReport(c, 10.1, 0, 100); // paused at ~the same position
    expect(c.snaps).toBe(1);
    expect(estimate(c, 600)).toBe(10.1); // frozen
  });

  it("tracks the max absolute error across reports", () => {
    let c = applyReport(initClock(), 0, 1.0, 0);
    c = applyReport(c, 0.103, 1.0, 100); // +3 ms
    c = applyReport(c, 0.196, 1.0, 200); // ~−7 ms vs est
    expect(c.maxAbsErrorMs).toBeGreaterThan(6);
    expect(c.maxAbsErrorMs).toBeLessThan(8.1);
  });

  it("estimate never goes negative", () => {
    const c = applyReport(initClock(), 0, 1.0, 1000);
    expect(estimate(c, 500)).toBe(0); // clock queried before base: clamp dt
  });

  it("snap threshold constant is sane for a 10 Hz transport", () => {
    // At 1.2x tempo a 100 ms report period advances 0.12 s — well inside the
    // snap threshold, so steady playback never misclassifies as a seek.
    expect(SNAP_S).toBeGreaterThan(0.12 * 2);
  });
});
