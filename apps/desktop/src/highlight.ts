// Pure timing-map display logic for the review screen: currentTime →
// active-word lookup and line grouping. All times are original-song
// seconds — the map's only time base (PLAN.md §5), and exactly what the
// review player's clock reads (useAudio module docs).

export interface TimedWord {
  start: number;
  end: number;
  unsung: boolean;
  line?: number;
}

/** How long a word stays highlighted past its end (hand-off smoothing). */
export const WORD_GRACE_S = 0.25;

/**
 * Index of the word being sung at time `t`: the last word whose onset is
 * <= t, but only while t is inside (or within `graceS` after) that word —
 * between words nothing is highlighted. Binary search over onsets (the map
 * invariant: onsets are monotonic — core validate()).
 */
export function wordIndexAt(
  words: { start: number; end: number }[],
  t: number,
  graceS: number = WORD_GRACE_S,
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
