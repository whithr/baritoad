// Line-level lyric editing (review bench): replace a line's text as one
// sentence while preserving the timings of words that didn't change,
// reshape line breaks (split / join / reflow). All pure; the editor
// reducer wraps these with undo. Times stay original-song (PLAN.md §5);
// line/word_in_line renumbering is canonical (0..n in order) so core
// validate()'s strict forward walk always holds.

import type { WordTiming } from "./api";

/** Split typed lyric text into word tokens (whitespace-separated). */
export function tokenizeLyric(text: string): string[] {
  return text.split(/\s+/).filter((t) => t !== "");
}

/** Case/punctuation-insensitive comparison key for diffing sung words. */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * Retime a line whose text was replaced: words that survive the edit
 * (matched by longest-common-subsequence on normalized text) keep their
 * timing and flags; each replaced run of new words divides its old run's
 * time span evenly. "Paper boats drift slow" → "sailing on" spreads two words
 * across the four words' span; a matched tail like "to meet the" keeps
 * its alignment untouched.
 */
export function retimeLine(oldWords: WordTiming[], tokens: string[]): WordTiming[] {
  if (tokens.length === 0) return [];
  if (oldWords.length === 0) return [];

  // LCS over normalized tokens.
  const n = oldWords.length;
  const m = tokens.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        norm(oldWords[i].word) === norm(tokens[j])
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const matches: { o: number; t: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(oldWords[i].word) === norm(tokens[j])) {
      matches.push({ o: i, t: j });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }

  const lineStart = oldWords[0].start;
  const lineEnd = Math.max(oldWords[n - 1].end, oldWords[n - 1].start);
  const out: WordTiming[] = new Array(m);

  // Matched words: old timing + flags, the typed text (user's casing wins).
  for (const mt of matches) {
    out[mt.t] = { ...oldWords[mt.o], word: tokens[mt.t] };
  }

  // Each unmatched run of tokens takes over its replaced run's time. A
  // same-count swap ("dark" → "dawn") inherits the old words' timings 1:1;
  // otherwise the run divides the span between its surrounding matches (or
  // the line edges) evenly, 80% voiced so slices don't butt together.
  const newWord = (text: string, start: number, end: number): WordTiming => ({
    word: text,
    start,
    end: Math.max(start, end),
    confidence: 1,
    anchored: true,
    unsung: false,
    line: undefined,
    word_in_line: undefined,
    ad_lib: false,
  });
  let mi = 0;
  let t = 0;
  while (t < m) {
    if (mi < matches.length && matches[mi].t === t) {
      mi++;
      t++;
      continue;
    }
    const runStart = t;
    while (t < m && (mi >= matches.length || matches[mi].t !== t)) t++;
    const count = t - runStart;
    const prevMatch = mi > 0 ? matches[mi - 1] : null;
    const nextMatch = mi < matches.length ? matches[mi] : null;
    const oldRunStart = prevMatch ? prevMatch.o + 1 : 0;
    const oldRunEnd = nextMatch ? nextMatch.o : n; // exclusive
    if (oldRunEnd - oldRunStart === count) {
      for (let k = 0; k < count; k++) {
        const o = oldWords[oldRunStart + k];
        out[runStart + k] = newWord(tokens[runStart + k], o.start, o.end);
      }
    } else {
      const spanStart = prevMatch ? oldWords[prevMatch.o].end : lineStart;
      const spanEnd = Math.max(nextMatch ? oldWords[nextMatch.o].start : lineEnd, spanStart);
      const slice = (spanEnd - spanStart) / count;
      for (let k = 0; k < count; k++) {
        const start = spanStart + k * slice;
        out[runStart + k] = newWord(tokens[runStart + k], start, start + slice * 0.8);
      }
    }
  }

  // Line identity + monotonic onsets (evenly divided runs are already
  // ordered; this guards zero-width spans).
  const lineId = oldWords[0].line;
  let prevOnset = -Infinity;
  for (let k = 0; k < m; k++) {
    const start = Math.max(out[k].start, prevOnset);
    out[k] = {
      ...out[k],
      start,
      end: Math.max(out[k].end, start),
      line: lineId,
      word_in_line: lineId != null ? k : undefined,
    };
    prevOnset = start;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line-break reshaping: regroup, then renumber canonically.
// ---------------------------------------------------------------------------

/** Assign line/word_in_line from an ordered grouping of word indices. */
function renumber(words: WordTiming[], groups: number[][]): WordTiming[] {
  const out = words.slice();
  groups.forEach((g, li) => {
    g.forEach((wi, pos) => {
      out[wi] = { ...out[wi], line: li, word_in_line: pos };
    });
  });
  return out;
}

/** Current grouping by line id (consecutive runs; undefined = own group). */
function currentGroups(words: WordTiming[]): number[][] {
  const groups: number[][] = [];
  let last: number[] | null = null;
  let lastLine: number | undefined | null = null;
  words.forEach((w, i) => {
    if (last && w.line != null && w.line === lastLine) {
      last.push(i);
    } else {
      last = [i];
      lastLine = w.line ?? null;
      groups.push(last);
      if (w.line == null) lastLine = null;
    }
  });
  return groups;
}

/** Break the line before word `at` — it becomes the first word of a new
 *  line. No-op if `at` already starts a line or has no line structure. */
export function breakLineAt(words: WordTiming[], at: number): WordTiming[] | null {
  if (at <= 0 || at >= words.length || words[at].line == null) return null;
  const groups = currentGroups(words);
  const gi = groups.findIndex((g) => g.includes(at));
  const pos = groups[gi].indexOf(at);
  if (pos === 0) return null; // already a line start
  const head = groups[gi].slice(0, pos);
  const tail = groups[gi].slice(pos);
  const next = [...groups.slice(0, gi), head, tail, ...groups.slice(gi + 1)];
  return renumber(words, next);
}

/** Join the line containing `at` onto the previous line. */
export function joinLineUp(words: WordTiming[], at: number): WordTiming[] | null {
  if (at < 0 || at >= words.length || words[at].line == null) return null;
  const groups = currentGroups(words);
  const gi = groups.findIndex((g) => g.includes(at));
  if (gi <= 0) return null;
  const next = [
    ...groups.slice(0, gi - 1),
    [...groups[gi - 1], ...groups[gi]],
    ...groups.slice(gi + 1),
  ];
  return renumber(words, next);
}

// Reflow heuristics: karaoke lines are short poetic phrases. Break at the
// real musical pauses first, then at punctuation, and cap the run-on.
export const REFLOW_GAP_S = 0.8;
export const REFLOW_MAX_WORDS = 8;
export const REFLOW_COMMA_MIN_WORDS = 4;

/**
 * Rebuild every line break from the words themselves: a new line starts
 * after a silence gap (> REFLOW_GAP_S), after terminal punctuation
 * (. ! ? ; :), after a comma once the line has a few words, or when the
 * line hits REFLOW_MAX_WORDS. Also assigns line structure to maps that
 * never had one (auto-transcribed lyrics).
 */
export function reflowLines(words: WordTiming[]): WordTiming[] {
  if (words.length === 0) return words;
  const groups: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (cur.length > 0) {
      const prev = words[i - 1];
      const gap = words[i].start - Math.max(prev.end, prev.start);
      const prevText = prev.word;
      const breakHere =
        gap > REFLOW_GAP_S ||
        /[.!?;:]["')\]]*$/.test(prevText) ||
        (/,["')\]]*$/.test(prevText) && cur.length >= REFLOW_COMMA_MIN_WORDS) ||
        cur.length >= REFLOW_MAX_WORDS;
      if (breakHere) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(i);
  }
  if (cur.length > 0) groups.push(cur);
  return renumber(words, groups);
}
