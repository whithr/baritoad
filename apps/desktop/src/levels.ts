// Pure math for the fix editor's vocal level display (the "VU floor"):
// the Rust side serves a normalized peak envelope of the vocal stem
// (api.vocalLevels); this module resamples it into per-bar values for one
// line-track window and classifies each bar as word-covered or uncovered
// singing. Uncovered singing is the actionable signal — a missed word or a
// mistimed line — and gets the editor's amber "look here first" voice.
// Rendering happens in FixEditor's LevelStrip; everything here is testable.

export interface Interval {
  start: number;
  end: number;
}

export interface LevelBar {
  /** 0–1 level: the max of the envelope bins under this bar. */
  v: number;
  /** Sustained singing with no word over it — voiced amber. */
  amber: boolean;
}

// Amber advisory tuning. False alarms are worse than misses — breaths and
// separation bleed must not light up — so the tint needs sustained energy,
// not a blip. Judged against real songs; adjust here, nowhere else.
/** Minimum level (fraction of the stem's own peak) that counts as singing. */
export const AMBER_MIN_LEVEL = 0.2;
/** Uncovered singing must persist this long before it tints amber. */
export const AMBER_MIN_RUN_S = 0.15;

/**
 * Resample the peak envelope into `barCount` bars covering
 * `[winStart, winEnd]`, marking sustained uncovered singing amber.
 * `words` are the map's word intervals (original-song seconds — the only
 * time base, PLAN.md §5); bars outside the envelope render as silence.
 */
export function levelBars(
  peaks: ArrayLike<number>,
  binsPerSecond: number,
  winStart: number,
  winEnd: number,
  barCount: number,
  words: Interval[],
): LevelBar[] {
  const span = winEnd - winStart;
  if (barCount <= 0 || span <= 0 || binsPerSecond <= 0) return [];
  const barDur = span / barCount;

  // Amber classification runs at BIN resolution (10 ms), never bar
  // resolution: a coarse view (the seek bar's ~100 ms bars) must not inflate
  // a breath into a >= AMBER_MIN_RUN_S run. The scan pads one run-length
  // past the window so a run straddling the edge is still measured fully.
  const scan0 = Math.max(0, Math.round((winStart - AMBER_MIN_RUN_S) * binsPerSecond));
  const scan1 = Math.min(
    peaks.length,
    Math.round((winEnd + AMBER_MIN_RUN_S) * binsPerSecond),
  );
  const covered = new Uint8Array(Math.max(0, scan1 - scan0));
  for (const w of words) {
    const b0 = Math.max(scan0, Math.floor(w.start * binsPerSecond));
    const b1 = Math.min(scan1, Math.ceil(w.end * binsPerSecond));
    for (let b = b0; b < b1; b++) covered[b - scan0] = 1;
  }
  const amberBin = new Uint8Array(Math.max(0, scan1 - scan0));
  const minLevel = AMBER_MIN_LEVEL * 255;
  const minRunBins = Math.ceil(AMBER_MIN_RUN_S * binsPerSecond);
  let run = -1;
  const closeRun = (endB: number) => {
    if (run >= 0 && endB - run >= minRunBins) amberBin.fill(1, run - scan0, endB - scan0);
    run = -1;
  };
  for (let b = scan0; b < scan1; b++) {
    if (peaks[b] >= minLevel && !covered[b - scan0]) {
      if (run < 0) run = b;
    } else {
      closeRun(b);
    }
  }
  closeRun(scan1);

  const bars: LevelBar[] = [];
  for (let i = 0; i < barCount; i++) {
    const t0 = winStart + i * barDur;
    const t1 = t0 + barDur;
    // Rounded edges partition the bins exactly (floor/ceil would let FP
    // jitter like 0.3*100 = 30.000…004 bleed one bin across bar boundaries).
    const b0 = Math.max(0, Math.round(t0 * binsPerSecond));
    const b1 = Math.min(peaks.length, Math.max(b0 + 1, Math.round(t1 * binsPerSecond)));
    let peak = 0;
    let amber = false;
    for (let b = b0; b < b1; b++) {
      const p = peaks[b];
      if (p > peak) peak = p;
      if (b >= scan0 && b < scan1 && amberBin[b - scan0]) amber = true;
    }
    bars.push({ v: peak / 255, amber });
  }
  return bars;
}
