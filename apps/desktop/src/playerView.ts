// Pure view logic for the full-screen player: which line is current, the
// per-word highlight wipe, the wait cues and lead-ins, and the karaoke pages. All times are
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

import {
  sungThroughIndexAt,
  WORD_GRACE_S,
  wordIndexAt,
  type TimedWord,
} from "./highlight";

export interface LineGroup {
  line: number | null;
  indices: number[];
}

/**
 * One row per lyric line: mid-line wrap reads as a line break and wrong-foots
 * the singer, so a line wider than its viewport shrinks its layout size by a
 * static per-line factor instead of wrapping. Below the floor legibility wins
 * (couch-readable type is a PRODUCT.md hard requirement) — that rare
 * over-long line keeps the floor size and wraps after all.
 */
export const LINE_FIT_MIN = 0.55;

export function lineFit(
  naturalPx: number,
  availPx: number,
): { scale: number; wrap: boolean } {
  if (!(naturalPx > 0) || !(availPx > 0) || naturalPx <= availPx) {
    return { scale: 1, wrap: false };
  }
  // floor to 3 decimals so the rounded factor never re-overflows by a pixel
  const raw = Math.floor((availPx / naturalPx) * 1000) / 1000;
  return raw < LINE_FIT_MIN ? { scale: LINE_FIT_MIN, wrap: true } : { scale: raw, wrap: false };
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
  /** Word the glow is easing onto during a pause (null while a word is active). */
  approachWord: number | null;
  /** 0..1 progress of the glow ease-in on `approachWord`. */
  approach: number;
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
  // In a gap: pre-roll only once THIS line is fully sung. A pause mid-line
  // must never flip the view to the next row and back when the pause happens
  // to sit within the lead window of the next line's onset.
  const group = lines[current];
  if (anchor !== group.indices[group.indices.length - 1]) return current;
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

/** The glow ease-in window before a word that follows a pause. */
export const WORD_APPROACH_S = 0.6;

/** Compose the full frame description (one call per rAF tick). */
export function lyricFrameAt(
  lines: LineGroup[],
  words: TimedWord[],
  t: number,
): LyricFrame {
  const activeWord = wordIndexAt(words, t);
  const sungThrough = sungThroughIndexAt(words, t);
  // During a pause the highlight cursor must not park-and-teleport: after
  // the previous word's grace expires, the NEXT word's glow eases in over
  // the last WORD_APPROACH_S before its onset (the fill edge still never
  // moves before the beat — the glow is the anticipatory channel, the fill
  // is the beat truth).
  let approachWord: number | null = null;
  let approach = 0;
  if (activeWord == null && sungThrough != null && sungThrough + 1 < words.length) {
    const prev = words[sungThrough];
    const next = words[sungThrough + 1];
    const from = Math.max(
      Math.max(prev.end, prev.start) + WORD_GRACE_S,
      next.start - WORD_APPROACH_S,
    );
    if (t >= from && t < next.start && next.start > from) {
      approachWord = sungThrough + 1;
      approach = (t - from) / (next.start - from);
    }
  }
  return {
    lineIndex: lineIndexAt(lines, words, t),
    activeWord,
    sungThrough,
    wipe: activeWord != null ? wipeFraction(words[activeWord], t) : 0,
    approachWord,
    approach,
  };
}

// ---- wait cues (gap meters + lead-in pips) --------------------------------
// Long instrumental gaps get a draining wait-meter row between the lines, and
// the line after one gets a 3-2-1 pip countdown into its first word — so a
// singer staring at a chorus gap knows how long to wait. A line after a
// shorter pause gets the lead-in bar instead (below).

/** A silence long enough to earn a wait-meter row between its lines. */
export const GAP_METER_MIN_S = 5;
/** A pause long enough to earn a line the lead-in bar. */
export const LEAD_BAR_MIN_GAP_S = 1.5;
/** The pip countdown window: 3 pips over the last 3 seconds. */
export const CUE_PIPS_LEAD_S = 3;

export interface GapCue {
  /** Line index the gap follows; -1 for the song intro. */
  afterLine: number;
  /** Original-song seconds the wait begins (previous line's last word end; 0 for the intro). */
  start: number;
  /** First-word onset of the line the wait leads into. */
  end: number;
}

const lineStartS = (g: LineGroup, words: TimedWord[]): number =>
  words[g.indices[0]].start;

const lineEndS = (g: LineGroup, words: TimedWord[]): number =>
  g.indices.reduce((m, i) => Math.max(m, words[i].end, words[i].start), 0);

/** Gaps of at least `minS` before a line (including the intro before line 0),
 *  in ascending time order. */
export function gapCues(
  lines: LineGroup[],
  words: TimedWord[],
  minS: number = GAP_METER_MIN_S,
): GapCue[] {
  const gaps: GapCue[] = [];
  for (let li = 0; li < lines.length; li++) {
    const start = li === 0 ? 0 : lineEndS(lines[li - 1], words);
    const end = lineStartS(lines[li], words);
    if (end - start >= minS) gaps.push({ afterLine: li - 1, start, end });
  }
  return gaps;
}

/** How a line is led in after a silence: one after a really long gap (a
 *  wait row's, >= `longGapS`) counts down with pips; one after a shorter
 *  pause (>= `barMinGapS`) gets the lead-in bar; the rest, nothing. The
 *  intro counts as a gap. Indexed by line. */
export type LeadIn = "pips" | "bar" | null;

export function leadInKinds(
  lines: LineGroup[],
  words: TimedWord[],
  barMinGapS: number = LEAD_BAR_MIN_GAP_S,
  longGapS: number = GAP_METER_MIN_S,
): LeadIn[] {
  return lines.map((g, li) => {
    const prevEnd = li === 0 ? 0 : lineEndS(lines[li - 1], words);
    const gap = lineStartS(g, words) - prevEnd;
    return gap >= longGapS ? "pips" : gap >= barMinGapS ? "bar" : null;
  });
}

/** Lit pip count (3 → 2 → 1) at time `t` for a line starting at `startS`;
 *  0 outside the countdown window or once the line has begun. */
export function pipsLitAt(
  startS: number,
  t: number,
  leadS: number = CUE_PIPS_LEAD_S,
): number {
  const dt = startS - t;
  if (dt <= 0 || dt > leadS) return 0;
  return Math.min(3, Math.ceil((dt / leadS) * 3));
}

/** Index of the gap containing time `t`, else null. Gaps are few and sorted —
 *  a linear scan is fine at rAF rate. */
export function activeGapAt(gaps: GapCue[], t: number): number | null {
  for (let i = 0; i < gaps.length; i++) {
    if (t >= gaps[i].start && t < gaps[i].end) return i;
    if (gaps[i].start > t) break;
  }
  return null;
}

// ---- karaoke pages ----------------------------------------------------------
// The stage shows a page at a time, karaoke style: up to PAGE_LINES lines,
// and a wait row (a gap >= GAP_METER_MIN_S) always starts a new page, so a
// verse after an instrumental gets a fresh screen with the counting meter
// above it. Pages turn by jumping the scroller (Four-Hook 1); rows off the
// page hide by class (hook 4).

export const PAGE_LINES = 3;

/** Line indices per page, in order. */
export function pagesOf(
  lines: LineGroup[],
  gaps: GapCue[],
  perPage: number = PAGE_LINES,
): number[][] {
  const waitBefore = new Set(gaps.map((g) => g.afterLine + 1));
  const pages: number[][] = [];
  let page: number[] = [];
  for (let li = 0; li < lines.length; li++) {
    if (page.length && (page.length >= perPage || waitBefore.has(li))) {
      pages.push(page);
      page = [];
    }
    page.push(li);
  }
  if (page.length) pages.push(page);
  return pages;
}

/** What's on screen: the page holding the frame's line — or, while a wait
 *  row counts, that row with the page it leads into. (lineIndexAt already
 *  holds a line until it's sung and pre-rolls the next one, so a page turns
 *  once its last line is done and the next line is close.) */
export function pageViewAt(
  pageOfLine: number[],
  gaps: GapCue[],
  frameLine: number,
  activeGap: number | null,
): { page: number; gap: number | null } {
  if (activeGap != null) {
    return { page: pageOfLine[gaps[activeGap].afterLine + 1] ?? 0, gap: activeGap };
  }
  return { page: pageOfLine[frameLine] ?? 0, gap: null };
}

// ---- the lead-in bar --------------------------------------------------------
// A line after a pause (leadInKinds "bar") gets a bar that runs in at the
// line's singing pace and meets its first word as it starts. Its one
// transform per frame is Four-Hook 7.

/** The lead-in bar's run: at most this long before the line, never more
 *  than the pause itself. */
export const LEAD_BAR_S = 2;

/** Seconds the lead-in bar runs before line `li` (whose kind is "bar"). */
export function leadBarRunS(lines: LineGroup[], words: TimedWord[], li: number): number {
  const prevEnd = li === 0 ? 0 : lineEndS(lines[li - 1], words);
  return Math.max(0, Math.min(LEAD_BAR_S, lineStartS(lines[li], words) - prevEnd));
}

/**
 * The lead-in bar at `t`, if one is running: on a "bar" line among
 * `candidates` (the frame's line and the next — lineIndexAt pre-rolls the
 * upcoming one), `q` 0 → 1 across its run, reaching 1 as the first word
 * starts — so the bar meets the word on the beat and the wipe carries on.
 */
export function leadBarAt(
  lines: LineGroup[],
  words: TimedWord[],
  kinds: LeadIn[],
  candidates: number[],
  t: number,
): { line: number; q: number } | null {
  for (const li of candidates) {
    if (kinds[li] !== "bar" || !lines[li]) continue;
    const start = lineStartS(lines[li], words);
    const run = leadBarRunS(lines, words, li);
    if (run > 0 && t >= start - run && t < start) return { line: li, q: (t - (start - run)) / run };
  }
  return null;
}
