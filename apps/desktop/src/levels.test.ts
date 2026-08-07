import { describe, expect, it } from "vitest";
import { AMBER_MIN_LEVEL, AMBER_MIN_RUN_S, levelBars } from "./levels";

// 100 bins/s, like the Rust side serves.
const BPS = 100;

/** An envelope of `seconds` of silence with [from, to) seconds at `level` (0-255). */
function envelope(seconds: number, from: number, to: number, level: number): number[] {
  const peaks = new Array(Math.round(seconds * BPS)).fill(0);
  for (let b = Math.floor(from * BPS); b < Math.ceil(to * BPS); b++) peaks[b] = level;
  return peaks;
}

describe("levelBars", () => {
  it("resamples by max and normalizes 0-255 to 0-1", () => {
    // 1 s window, 10 bars → each bar covers 10 bins.
    const peaks = envelope(1, 0.3, 0.4, 255);
    peaks[35] = 128; // a quieter bin inside the loud region must not win
    const bars = levelBars(peaks, BPS, 0, 1, 10, []);
    expect(bars).toHaveLength(10);
    expect(bars[3].v).toBe(1);
    expect(bars[2].v).toBe(0);
    expect(bars[4].v).toBe(0);
  });

  it("renders bars past the end of the envelope as silence", () => {
    const bars = levelBars(envelope(1, 0, 1, 255), BPS, 9, 10, 10, []);
    expect(bars.every((b) => b.v === 0)).toBe(true);
  });

  it("returns nothing for degenerate windows", () => {
    expect(levelBars([255], BPS, 5, 5, 10, [])).toEqual([]);
    expect(levelBars([255], BPS, 0, 1, 0, [])).toEqual([]);
  });

  it("never tints covered singing", () => {
    const peaks = envelope(2, 0.5, 1.5, 255);
    const bars = levelBars(peaks, BPS, 0, 2, 40, [{ start: 0.5, end: 1.5 }]);
    expect(bars.some((b) => b.amber)).toBe(false);
    expect(bars.some((b) => b.v === 1)).toBe(true);
  });

  it("tints sustained uncovered singing amber", () => {
    // 1 s of loud singing, no word anywhere near it.
    const peaks = envelope(3, 1, 2, 255);
    const bars = levelBars(peaks, BPS, 0, 3, 60, [{ start: 2.5, end: 2.8 }]);
    const litRegion = bars.slice(20, 40);
    expect(litRegion.every((b) => b.amber)).toBe(true);
    expect(bars.slice(0, 20).some((b) => b.amber)).toBe(false);
  });

  it("ignores short blips — a breath must not light up", () => {
    // One bar of loud uncovered energy: 3 s / 60 bars = 50 ms < AMBER_MIN_RUN_S.
    const peaks = envelope(3, 1, 1.05, 255);
    const bars = levelBars(peaks, BPS, 0, 3, 60, []);
    expect((3 / 60) < AMBER_MIN_RUN_S).toBe(true);
    expect(bars.some((b) => b.amber)).toBe(false);
  });

  it("ignores quiet uncovered energy — separation bleed must not light up", () => {
    const quiet = Math.floor(255 * AMBER_MIN_LEVEL) - 1;
    const peaks = envelope(3, 1, 2, quiet);
    const bars = levelBars(peaks, BPS, 0, 3, 60, []);
    expect(bars.some((b) => b.amber)).toBe(false);
    expect(bars.some((b) => b.v > 0)).toBe(true);
  });

  it("classifies amber at bin resolution — coarse bars must not inflate a blip", () => {
    // A 90 ms breath viewed through 500 ms seek-bar bars: the bar it lands
    // in is loud and uncovered, but the underlying run is < AMBER_MIN_RUN_S.
    const peaks = envelope(30, 16.2, 16.29, 255);
    const coarse = levelBars(peaks, BPS, 0, 30, 60, []);
    expect(coarse.some((b) => b.amber)).toBe(false);
    expect(coarse.some((b) => b.v === 1)).toBe(true);
    // The same envelope with sustained singing does tint at coarse zoom.
    const sustained = levelBars(envelope(30, 16, 17, 255), BPS, 0, 30, 60, []);
    expect(sustained.some((b) => b.amber)).toBe(true);
  });

  it("measures a run that straddles the window edge at its full length", () => {
    // Singing 0.9–1.1 s, window ends at 1.0: only 100 ms is visible, but the
    // true run is 200 ms, so the visible tail must still tint.
    const peaks = envelope(2, 0.9, 1.1, 255);
    const bars = levelBars(peaks, BPS, 0, 1, 20, []);
    expect(bars[19].amber).toBe(true);
  });

  it("closes an amber run that reaches the window's end", () => {
    const peaks = envelope(2, 1.5, 2, 255);
    const bars = levelBars(peaks, BPS, 0, 2, 40, []);
    expect(bars[39].amber).toBe(true);
  });
});
