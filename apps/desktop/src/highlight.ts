// Pure timing-map display logic for the review screen: the ~20 s preview
// highlight window (PLAN.md §4 step 4 "Auto-plays a 20-second highlight") and
// currentTime → active-word lookup. All times are original-song seconds — the
// map's only time base (PLAN.md §5), and exactly what the review player's
// clock reads (useAudio module docs).

export interface TimedWord {
  start: number;
  end: number;
  unsung: boolean;
  line?: number;
}

/** Default preview length, seconds. */
export const HIGHLIGHT_WINDOW_S = 20;

/** Lead-in before the first word of the chosen window. */
const LEAD_IN_S = 1.0;

/**
 * Pick the densest-lyrics window: the `windowS`-long span containing the most
 * confidently-sung word onsets (unsung/zero-length words don't count — a
 * preview should showcase the good part). Two-pointer sweep anchored at each
 * word onset, O(n). Returns a playback range with a short lead-in, clamped
 * to the song. Empty/unsung-only maps fall back to the song start.
 */
export function pickHighlightWindow(
  words: TimedWord[],
  duration: number,
  windowS: number = HIGHLIGHT_WINDOW_S,
): { start: number; end: number } {
  const onsets = words
    .filter((w) => !w.unsung && w.end > w.start)
    .map((w) => w.start)
    .sort((a, b) => a - b);
  if (onsets.length === 0) {
    return { start: 0, end: Math.min(windowS, duration || windowS) };
  }
  let best = 0;
  let bestCount = 0;
  let lo = 0;
  for (let hi = 0; hi < onsets.length; hi++) {
    while (onsets[hi] - onsets[lo] > windowS) lo++;
    const count = hi - lo + 1;
    if (count > bestCount) {
      bestCount = count;
      best = onsets[lo];
    }
  }
  const start = Math.max(0, best - LEAD_IN_S);
  const end = duration > 0 ? Math.min(start + windowS, duration) : start + windowS;
  return { start, end };
}

/**
 * Index of the word being sung at time `t`: the last word whose onset is
 * <= t, but only while t is inside (or within `graceS` after) that word —
 * between words nothing is highlighted. Binary search over onsets (the map
 * invariant: onsets are monotonic — core validate()).
 */
export function wordIndexAt(
  words: { start: number; end: number }[],
  t: number,
  graceS: number = 0.25,
): number | null {
  if (words.length === 0) return null;
  let lo = 0;
  let hi = words.length - 1;
  if (t < words[0].start) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  const w = words[lo];
  // zero-length placeholders get the grace window too
  return t <= Math.max(w.end, w.start) + graceS ? lo : null;
}

/**
 * "Sung so far" high-water mark: index of the last word whose onset is <= t,
 * with no grace cutoff — unlike wordIndexAt, this never goes null mid-song.
 * Between words (instrumental breaks, line gaps) it keeps pointing at the
 * word just finished, so already-sung text stays tinted instead of snapping
 * back to the unsung color the moment nobody is singing. Same binary search
 * over the monotonic-onset invariant (core validate()).
 */
export function sungThroughIndexAt(
  words: { start: number }[],
  t: number,
): number | null {
  if (words.length === 0 || t < words[0].start) return null;
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Group word indices by lyric line (falling back to one synthetic line per
 *  run of undefined `line` values), preserving map order. */
export function groupByLine(words: { line?: number }[]): { line: number | null; indices: number[] }[] {
  const groups: { line: number | null; indices: number[] }[] = [];
  for (let i = 0; i < words.length; i++) {
    const key = words[i].line ?? null;
    const last = groups[groups.length - 1];
    if (last && last.line === key && key !== null) last.indices.push(i);
    else groups.push({ line: key, indices: [i] });
  }
  return groups;
}
