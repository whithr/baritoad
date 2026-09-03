// Audio-reactive stage visualizer (themes.ts `visualizer`): PULSE and BARS
// drawn on a canvas layer behind the lyrics, driven by the INSTRUMENTAL's
// precomputed peak envelope (the same cached-levels sidecar the fix editor's
// VU floor uses) sampled through the player clock — deterministic, tempo-
// change-proof, and no live audio tap.
//
// Honesty note: this is single-band energy with styled per-bar variation,
// not a spectrum — bars move together with the music's loudness, phased so
// they read organically. A real spectral tap is the v2 upgrade.
//
// Per-frame budget: one bounded canvas draw (≤ BAR_COUNT fillRects or one
// radial gradient) — an amended hook beside the Four-Hook set (DESIGN.md
// player section). Everything here is allocation-light pure math so the
// draw itself stays the only work.

export type { VisualizerMode } from "./themes";

/** Envelope energy at time `t`: the mean of the peak bins inside a ±window,
 *  normalized 0..1. The window smooths bin noise without per-frame state
 *  (an attack/release filter would need history; a mean over ±50 ms reads
 *  the same and stays a pure function of `t`). */
export function envelopeEnergyAt(
  peaks: number[],
  binsPerSecond: number,
  t: number,
  windowS = 0.05,
): number {
  if (peaks.length === 0 || binsPerSecond <= 0 || !isFinite(t)) return 0;
  const lo = Math.max(0, Math.floor((t - windowS) * binsPerSecond));
  const hi = Math.min(peaks.length - 1, Math.floor((t + windowS) * binsPerSecond));
  if (hi < lo) return 0;
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += peaks[i];
  return sum / ((hi - lo + 1) * 255);
}

export const BAR_COUNT = 24;

/**
 * Bar heights 0..1 for the BARS mode: overall height rides the energy, and
 * each bar carries a deterministic phase/speed offset so the row shimmers
 * instead of moving as a block. Pure in (t, energy) — no per-frame state.
 */
export function barHeights(energy: number, t: number, n = BAR_COUNT): number[] {
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    const wobble = 0.35 + 0.65 * Math.abs(Math.sin(k * 1.7 + t * (1.3 + (k % 5) * 0.35)));
    out[k] = Math.max(0, Math.min(1, energy * wobble));
  }
  return out;
}

/** PULSE radius factor 0.25..1 — a soft floor keeps quiet passages alive
 *  without flashing on silence. */
export function pulseRadius(energy: number): number {
  return 0.25 + 0.75 * Math.max(0, Math.min(1, energy));
}

// ---------------------------------------------------------------------------
// canvas draw — called from the player's frame loop; bounded work only
// ---------------------------------------------------------------------------

export function drawVisualizerFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: "pulse" | "bars",
  peaks: number[],
  binsPerSecond: number,
  t: number,
  color: string,
): void {
  ctx.clearRect(0, 0, width, height);
  const energy = envelopeEnergyAt(peaks, binsPerSecond, t);
  ctx.save();
  if (mode === "bars") {
    // bottom-anchored segmented bars across the full width, behind the mask
    const heights = barHeights(energy, t);
    const n = heights.length;
    const slot = width / n;
    const barW = Math.max(2, slot * 0.55);
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = color;
    const maxH = height * 0.38;
    for (let k = 0; k < n; k++) {
      const h = Math.max(2, heights[k] * maxH);
      ctx.fillRect(k * slot + (slot - barW) / 2, height - h, barW, h);
    }
  } else {
    // one soft radial pulse behind the current line's zone
    const r = pulseRadius(energy) * Math.min(width, height) * 0.45;
    const cx = width / 2;
    const cy = height * 0.42;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r, 1));
    grad.addColorStop(0, color);
    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
}
