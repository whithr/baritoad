// Pure layout + navigation math for the bench (Text / Lanes).
// All times are original-song seconds; the views map them to
// pixels through the per-lane window from editorState.lineWindow.

import type { WordTiming } from "./api";
import { lineWindow } from "./editorState";
import { groupByLine } from "./highlight";

export type BenchView = "text" | "lanes";
export const BENCH_VIEWS: BenchView[] = ["text", "lanes"];

/** Step the view axis: −1 zooms out (to Text), +1 zooms in (to Lanes). */
export function stepView(view: BenchView, dir: -1 | 1): BenchView {
  const i = BENCH_VIEWS.indexOf(view);
  const j = Math.min(BENCH_VIEWS.length - 1, Math.max(0, i + dir));
  return BENCH_VIEWS[j];
}

export interface LaneGroup {
  /** Lyric line id (null for a run of unlinked words). */
  line: number | null;
  /** Word indices in this lane, map order. */
  indices: number[];
  /** Lane window in original-song seconds. */
  start: number;
  end: number;
}

/** One lane per lyric line, each with its own padded, second-snapped window. */
export function laneGroups(words: WordTiming[], duration: number): LaneGroup[] {
  return groupByLine(words).map((g) => {
    const first = words[g.indices[0]];
    const last = words[g.indices[g.indices.length - 1]];
    const w = lineWindow(first.start, Math.max(last.end, last.start), duration);
    return { line: g.line, indices: g.indices, start: w.start, end: w.end };
  });
}

/** Seconds → px inside a lane of `width` px. */
export function secToPx(t: number, lane: { start: number; end: number }, width: number): number {
  const span = lane.end - lane.start;
  return span > 0 ? ((t - lane.start) / span) * width : 0;
}

/** px delta → seconds delta inside a lane. */
export function pxToSec(dx: number, lane: { start: number; end: number }, width: number): number {
  const span = lane.end - lane.start;
  return width > 0 ? (dx / width) * span : 0;
}

/** Index of the lane containing word `i`, or -1. */
export function laneOfWord(lanes: LaneGroup[], i: number): number {
  return lanes.findIndex((l) => l.indices.includes(i));
}

/** The lane whose window contains `t`, preferring the one whose words
 *  are being sung (windows overlap at their padded edges). */
/**
 * The lane the head is "in" at `t`: the line being sung, else - in the gap
 * between two lines - the line just sung until the next line's lead-in
 * window opens, then that next line. Sticky on purpose: a gap longer than
 * the windows' padding used to fall through to -1, which showed as no line
 * at all between two consecutive rows. -1 only before the first window and
 * after the last.
 */
export function laneAtTime(lanes: LaneGroup[], words: WordTiming[], t: number): number {
  let prev = -1;
  for (let k = 0; k < lanes.length; k++) {
    const l = lanes[k];
    const first = words[l.indices[0]].start;
    const last = Math.max(words[l.indices[l.indices.length - 1]].end, first);
    if (t < first) return t >= l.start ? k : prev;
    if (t <= last) return k;
    prev = k;
  }
  return prev >= 0 && t < lanes[prev].end ? prev : -1;
}

/**
 * For the Text view: which word index a caret position inside a line's
 * text refers to — the word containing (or immediately following) the
 * caret. Enter at that caret breaks the line before that word.
 * Returns null when the caret sits at the very start (nothing to break).
 */
export function wordAtCaret(lineText: string, caret: number): number | null {
  if (caret <= 0 || caret > lineText.length) return null;
  const before = lineText.slice(0, caret);
  const tokensBefore = before.split(/\s+/).filter((t) => t !== "").length;
  const total = lineText.split(/\s+/).filter((t) => t !== "").length;
  const atWordEnd = !/\s$/.test(before) && (caret === lineText.length || /\s/.test(lineText[caret]));
  // In a word's middle → that word; after a word (or in whitespace) → the next one.
  const idx = /\s$/.test(before) || atWordEnd ? tokensBefore : tokensBefore - 1;
  if (idx <= 0 || idx >= total) return null;
  return idx;
}

/**
 * Resample a peak envelope (0–255 per bin) into `n` samples across a
 * window — the lane waveform silhouette. Bins outside the envelope are 0.
 * Each sample is the max of the bins it covers, in 0–1.
 */
export function envelopeSamples(
  peaks: ArrayLike<number>,
  binsPerSecond: number,
  winStart: number,
  winEnd: number,
  n: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, n));
  const span = winEnd - winStart;
  if (n <= 0 || span <= 0 || binsPerSecond <= 0) return out;
  const step = span / n;
  for (let i = 0; i < n; i++) {
    const b0 = Math.floor((winStart + i * step) * binsPerSecond);
    const b1 = Math.max(b0 + 1, Math.ceil((winStart + (i + 1) * step) * binsPerSecond));
    let m = 0;
    for (let b = Math.max(0, b0); b < Math.min(peaks.length, b1); b++) {
      if (peaks[b] > m) m = peaks[b];
    }
    out[i] = m / 255;
  }
  return out;
}
