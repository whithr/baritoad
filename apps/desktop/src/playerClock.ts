// Position-transport interpolation for the performance player (pure logic;
// PlayerView.tsx owns the wiring).
//
// The Rust host emits a status report on `karaoke://player` at ~10 Hz while
// playing (plus immediately after every state-changing command). Each report
// carries the engine clock's position in ORIGINAL-SONG seconds (PLAN.md §5 —
// the timing map's only time base, already translated through any stretch
// ratio by the engine's clock; the UI never translates). Between reports the
// UI estimates position against performance.now():
//
//     est(now) = basePos + (now − baseAt)/1000 · rate + pending·drained
//
// where `rate` is song-seconds per wall-second: the tempo ratio while
// playing, 0 while paused/stopped. During steady playback the engine clock
// advances at exactly that rate (it derives from device frames), so the only
// error sources are IPC delivery jitter and the report's own quantization —
// which each new report corrects.
//
// Correction policy: a legitimate discontinuity (seek, play/pause, tempo
// change — anything where |err| > SNAP_S or the rate changed) snaps the
// base. A small steady-state error is folded in smoothly: the estimate stays
// continuous and the error drains linearly over CORRECTION_WINDOW_MS, so word
// highlighting never visibly steps. `lastErrorMs` / `maxAbsErrorMs` expose
// the measured transport jitter (the milestone's measured-numbers evidence).

/** Snap threshold: errors above this are treated as real discontinuities. */
export const SNAP_S = 0.25;

/** Small steady-state corrections drain over this window. */
export const CORRECTION_WINDOW_MS = 120;

export interface InterpClock {
  /** Song seconds at `baseAtMs` (already includes drained corrections). */
  basePos: number;
  /** performance.now() timestamp of the base. */
  baseAtMs: number;
  /** Song-seconds per wall-second (tempo while playing, 0 while paused). */
  rate: number;
  /** Undrained correction (song seconds), applied over CORRECTION_WINDOW_MS. */
  pending: number;
  /** Steady-state error of the report that produced this state, ms. */
  lastErrorMs: number;
  /** Max |steady-state error| observed since reset, ms (transport jitter). */
  maxAbsErrorMs: number;
  /** Count of steady-state corrections folded in (excludes snaps). */
  corrections: number;
  /** Count of snaps (legit discontinuities: seek/play/pause/tempo). */
  snaps: number;
}

export function initClock(): InterpClock {
  return {
    basePos: 0,
    baseAtMs: 0,
    rate: 0,
    pending: 0,
    lastErrorMs: 0,
    maxAbsErrorMs: 0,
    corrections: 0,
    snaps: 0,
  };
}

/** Current position estimate (original-song seconds, clamped ≥ 0). */
export function estimate(c: InterpClock, nowMs: number): number {
  const dt = Math.max(0, nowMs - c.baseAtMs);
  const drained = Math.min(1, dt / CORRECTION_WINDOW_MS);
  return Math.max(0, c.basePos + (dt / 1000) * c.rate + c.pending * drained);
}

/**
 * Fold a host report into the clock. `rate` is the new advance rate (tempo
 * ratio if the report says playing, else 0).
 */
export function applyReport(
  c: InterpClock,
  reportPos: number,
  rate: number,
  nowMs: number,
): InterpClock {
  // First report, or a rate change (play/pause/seek/tempo): the estimate's
  // premise changed — snap, and don't count the error as jitter.
  const est = estimate(c, nowMs);
  const err = reportPos - est;
  const isFirst = c.baseAtMs === 0 && c.basePos === 0 && c.rate === 0 && c.pending === 0;
  if (isFirst || rate !== c.rate || Math.abs(err) > SNAP_S) {
    return {
      ...c,
      basePos: reportPos,
      baseAtMs: nowMs,
      rate,
      pending: 0,
      snaps: c.snaps + (isFirst ? 0 : 1),
    };
  }
  // Steady state: stay continuous at `est`, drain the error smoothly.
  return {
    ...c,
    basePos: est,
    baseAtMs: nowMs,
    rate,
    pending: err,
    lastErrorMs: err * 1000,
    maxAbsErrorMs: Math.max(c.maxAbsErrorMs, Math.abs(err) * 1000),
    corrections: c.corrections + 1,
  };
}
