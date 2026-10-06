// Review-bench pure helpers: the cue puck (the "bouncing ball") and the
// shift-scope range resolution. The puck rests on the word being sung and
// arcs to the next word's position so its landing marks the onset — the
// visual answer to "when is the next word due". All times are original-song
// time; the view maps indices to pixels.

export interface PuckWord {
  start: number;
  end: number;
  unsung: boolean;
}

/** Longest flight; shorter gaps fly the whole gap, longer ones rest first. */
export const PUCK_FLIGHT_MAX_S = 0.6;

/** Shortest flight: when the gap to the next onset is tighter than this,
 *  the puck departs early — gliding out of the previous word's tail to land
 *  on the beat — instead of teleporting across a near-zero gap (words whose
 *  ends are cut short right against the next onset). */
export const PUCK_FLIGHT_MIN_S = 0.18;

export type PuckFrame =
  | { kind: "hidden" }
  | { kind: "rest"; index: number }
  /** `from === null` is the arc onto the first word of the song. */
  | { kind: "flight"; from: number | null; to: number; progress: number };

function lastSungAtOrBefore(words: PuckWord[], t: number): number | null {
  // binary search: last index with start <= t
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = found; i >= 0; i--) {
    if (!words[i].unsung) return i;
  }
  return null;
}

function nextSungAfter(words: PuckWord[], i: number): number | null {
  for (let j = i + 1; j < words.length; j++) {
    if (!words[j].unsung) return j;
  }
  return null;
}

export function puckFrameAt(words: PuckWord[], t: number): PuckFrame {
  if (words.length === 0) return { kind: "hidden" };
  const p = lastSungAtOrBefore(words, t);
  const j = nextSungAfter(words, p ?? -1);
  const restEnd = p != null ? Math.max(words[p].end, words[p].start) : 0;

  if (j != null) {
    const gap = Math.max(words[j].start - restEnd, 0);
    // Flight time: the whole gap up to MAX, but never under MIN — leaving
    // early through the previous word's tail beats teleporting. A chain of
    // rapid-fire words caps the flight at the onset-to-onset interval so
    // the puck is never due at a word before it left the one prior.
    const onsetSpan = p != null ? Math.max(words[j].start - words[p].start, 0.01) : Infinity;
    const dur = Math.min(Math.max(gap, PUCK_FLIGHT_MIN_S), PUCK_FLIGHT_MAX_S, onsetSpan);
    const flightStart = words[j].start - dur;
    if (t >= flightStart) {
      return {
        kind: "flight",
        from: p,
        to: j,
        progress: dur > 0 ? Math.min((t - flightStart) / dur, 1) : 1,
      };
    }
  }
  if (p == null) return { kind: "hidden" }; // before the first flight window
  if (j == null && t > restEnd) return { kind: "hidden" }; // song sung out
  return { kind: "rest", index: p }; // on the word, or parked in a long gap
}

// ---------------------------------------------------------------------------
// Shift scopes — WORD | LINE | FROM HERE resolve to a [first, last] range.
// ---------------------------------------------------------------------------

export type ShiftScope = "word" | "line" | "tail";

export function shiftRange(
  words: { line?: number }[],
  selected: number,
  scope: ShiftScope,
): { first: number; last: number } | null {
  if (selected < 0 || selected >= words.length) return null;
  if (scope === "word") return { first: selected, last: selected };
  if (scope === "tail") return { first: selected, last: words.length - 1 };
  const line = words[selected].line;
  // no line structure: a "line" degrades to the word itself
  if (line == null) return { first: selected, last: selected };
  let first = selected;
  while (first > 0 && words[first - 1].line === line) first--;
  let last = selected;
  while (last < words.length - 1 && words[last + 1].line === line) last++;
  return { first, last };
}
