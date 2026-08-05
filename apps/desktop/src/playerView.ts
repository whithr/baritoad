// Pure view logic for the full-screen player: which line is current, the
// per-word highlight wipe, and the smooth-scroll step. All times are
// original-song seconds (PLAN.md §5 — the map's only time base, and exactly
// what the interpolated engine clock reports).
//
// Render-path note (spikes/lyric-render/REPORT.md): the DOM renderer won on
// Windows/WebView2; per-frame work must fit ~8 ms because rAF runs at the
// panel rate (120 Hz here). These functions are the per-frame math — keep
// them allocation-light. A canvas renderer stays a possible alternate
// backend (the spike ships one) pending the WebKitGTK measurement; the
// renderer seam is `LyricFrame` — a canvas backend would consume the same
// frame description. Do not resurrect the WebGL assumption.

import { sungThroughIndexAt, wordIndexAt, type TimedWord } from "./highlight";

export interface LineGroup {
  line: number | null;
  indices: number[];
}

/** Everything the renderer needs to paint one frame. */
export interface LyricFrame {
  /** Line to center: the one being sung, else the one coming up next. */
  lineIndex: number;
  /** Active word index (null between words — grace handled in highlight.ts). */
  activeWord: number | null;
  /** Words at or before this index render as sung (never regresses in gaps). */
  sungThrough: number | null;
  /** 0..1 progress through the active word (the highlight wipe). */
  wipe: number;
}

/**
 * Line to treat as current at time `t`: the line containing the active word;
 * during gaps, the line of the sung-through word until the *next* line's
 * first word is closer than UPCOMING_LEAD_S, then the upcoming line (so the
 * singer is looking at the right line before it starts). Before the first
 * word: line 0. After the last: the last line.
 */
export const UPCOMING_LEAD_S = 2.0;

export function lineIndexAt(
  lines: LineGroup[],
  words: TimedWord[],
  t: number,
): number {
  if (lines.length === 0) return 0;
  const active = wordIndexAt(words, t);
  const anchor = active ?? sungThroughIndexAt(words, t);
  if (anchor == null) return 0; // before the first word
  const current = lines.findIndex((g) => g.indices.includes(anchor));
  if (current === -1) return 0;
  if (active != null) return current;
  // In a gap: look ahead to the next line's start.
  const next = lines[current + 1];
  if (!next) return current;
  const nextStart = words[next.indices[0]]?.start;
  if (nextStart != null && nextStart - t <= UPCOMING_LEAD_S) return current + 1;
  return current;
}

/** 0..1 highlight progress through a word at time `t` (0-length words: 1). */
export function wipeFraction(w: { start: number; end: number }, t: number): number {
  const len = w.end - w.start;
  if (len <= 0) return t >= w.start ? 1 : 0;
  return Math.min(1, Math.max(0, (t - w.start) / len));
}

/** Compose the full frame description (one call per rAF tick). */
export function lyricFrameAt(
  lines: LineGroup[],
  words: TimedWord[],
  t: number,
): LyricFrame {
  const activeWord = wordIndexAt(words, t);
  return {
    lineIndex: lineIndexAt(lines, words, t),
    activeWord,
    sungThrough: sungThroughIndexAt(words, t),
    wipe: activeWord != null ? wipeFraction(words[activeWord], t) : 0,
  };
}

/**
 * One smooth-scroll step: exponential approach of `current` toward `target`
 * with time constant `tauMs` (frame-rate independent — the same trajectory at
 * 60 and 120 Hz). Snaps when within `snapPx` so the transform settles to an
 * exact value instead of asymptoting forever.
 */
export function scrollStep(
  current: number,
  target: number,
  dtMs: number,
  tauMs = 180,
  snapPx = 0.5,
): number {
  const diff = target - current;
  if (Math.abs(diff) <= snapPx) return target;
  const alpha = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return current + diff * alpha;
}
