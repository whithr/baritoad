import { describe, expect, it } from "vitest";
import { BAR_COUNT, barHeights, envelopeEnergyAt, pulseRadius } from "./visualizer";

describe("envelopeEnergyAt", () => {
  const bps = 100;
  // 10 s of silence with a full-scale burst at 5.0–5.2 s
  const peaks = Array.from({ length: 1000 }, (_, i) => (i >= 500 && i < 520 ? 255 : 0));

  it("reads the burst at its time and silence elsewhere", () => {
    expect(envelopeEnergyAt(peaks, bps, 5.1)).toBeCloseTo(1, 5);
    expect(envelopeEnergyAt(peaks, bps, 2.0)).toBe(0);
  });

  it("the smoothing window averages across the burst edge", () => {
    const edge = envelopeEnergyAt(peaks, bps, 5.0);
    expect(edge).toBeGreaterThan(0.3);
    expect(edge).toBeLessThan(1);
  });

  it("degenerate input yields zero, never NaN", () => {
    expect(envelopeEnergyAt([], bps, 1)).toBe(0);
    expect(envelopeEnergyAt(peaks, 0, 1)).toBe(0);
    expect(envelopeEnergyAt(peaks, bps, NaN)).toBe(0);
    expect(envelopeEnergyAt(peaks, bps, -50)).toBe(0);
    expect(envelopeEnergyAt(peaks, bps, 9999)).toBe(0);
  });
});

describe("barHeights", () => {
  it("is deterministic in (energy, t) and bounded 0..1", () => {
    const a = barHeights(0.8, 12.34);
    const b = barHeights(0.8, 12.34);
    expect(a).toEqual(b);
    expect(a).toHaveLength(BAR_COUNT);
    for (const h of a) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
    }
  });

  it("bars differ from each other (shimmer, not a block)", () => {
    const h = barHeights(1, 3.0);
    expect(new Set(h.map((v) => v.toFixed(4))).size).toBeGreaterThan(BAR_COUNT / 2);
  });

  it("zero energy flattens every bar", () => {
    expect(barHeights(0, 7).every((h) => h === 0)).toBe(true);
  });
});

describe("pulseRadius", () => {
  it("keeps a quiet floor and clamps loud peaks", () => {
    expect(pulseRadius(0)).toBeCloseTo(0.25, 5);
    expect(pulseRadius(1)).toBeCloseTo(1, 5);
    expect(pulseRadius(5)).toBeCloseTo(1, 5);
  });
});
