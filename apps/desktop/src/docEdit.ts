// Document-level lyric editing — the fix editor's LYRICS stage: the whole
// lyric as free text, one lyric line per text row, so Enter *is* "break
// here" and deleting a newline *is* "join up". Committing ("Sync to music")
// LCS-diffs the typed document against the current words: matched words
// keep their exact timings and flags (hand fixes survive a typo pass),
// changed runs get estimated timings (lineEdit.retimeTokens) and a plan of
// windowed CTC re-align requests against the vocal stem. A mostly-rewritten
// document therefore degrades gracefully into a near-full re-sync — no
// policy switch needed. All pure; FixEditor drives the actual realign calls
// and commits the result as ONE undo entry (replace-words).

import type { WordTiming } from "./api";
import { groupByLine } from "./highlight";
import { retimeTokens, tokenizeLyric } from "./lineEdit";

/** Padding of audio context around a changed run's re-align window (same
 *  spirit as the timeline editor's re-align selection). */
export const DOC_REALIGN_PAD_S = 1.0;
/** Ceiling per re-align window, under review.rs MAX_WINDOW_S (120 s) with
 *  headroom; longer changed runs split into several windows. */
export const DOC_MAX_WINDOW_S = 100;

/** Tokenized text lines, blanks dropped — the committed line structure. */
export function parseLyricDoc(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map(tokenizeLyric)
    .filter((l) => l.length > 0);
}

/** Regenerate the lyrics-well text from the words (stage entry, and the
 *  "did the draft actually change anything" comparison). */
export function docTextFromWords(words: WordTiming[]): string {
  return groupByLine(words)
    .map((g) => g.indices.map((i) => words[i].word).join(" "))
    .join("\n");
}

export interface DocCommit {
  /** Retimed words with line links from the text's rows. */
  words: WordTiming[];
  /** Runs of new-word indices that did NOT survive the diff — estimated
   *  timings that want a CTC re-align pass. */
  changed: { first: number; last: number }[];
}

/**
 * Diff the typed document against the current words. Matched words keep
 * timing + flags with the typed casing; changed runs carry span-divided
 * estimates. Line/word_in_line come from the text rows, canonical 0..n.
 */
export function retimeDocument(oldWords: WordTiming[], lines: string[][]): DocCommit | null {
  const tokens = lines.flat();
  const r = retimeTokens(oldWords, tokens);
  if (!r) return null;
  const words: WordTiming[] = new Array(tokens.length);
  let k = 0;
  lines.forEach((lineTokens, li) => {
    lineTokens.forEach((_, pos) => {
      words[k] = { ...r.words[k], line: li, word_in_line: pos };
      k++;
    });
  });
  const changed: DocCommit["changed"] = [];
  let runStart = -1;
  for (let i = 0; i < r.matched.length; i++) {
    if (!r.matched[i]) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      changed.push({ first: runStart, last: i - 1 });
      runStart = -1;
    }
  }
  if (runStart >= 0) changed.push({ first: runStart, last: r.matched.length - 1 });
  return { words, changed };
}

export interface RealignWindow {
  first: number;
  last: number;
  /** Original-song seconds (PLAN.md §5). */
  start: number;
  end: number;
}

/**
 * Plan the CTC re-align windows for a commit's changed runs: each run's
 * estimated extent padded by DOC_REALIGN_PAD_S, clamped so a window never
 * swallows a neighbor word's audio (the neighbors are matched words with
 * real timings, so windows can't fight each other), and long runs split to
 * stay under DOC_MAX_WINDOW_S. Zero-length windows (words squeezed into no
 * audible gap) are skipped — those keep their estimates.
 */
export function planRealignWindows(
  words: WordTiming[],
  changed: DocCommit["changed"],
  duration: number,
): RealignWindow[] {
  const out: RealignWindow[] = [];
  for (const run of changed) {
    let first = run.first;
    while (first <= run.last) {
      let last = first;
      while (
        last < run.last &&
        Math.max(words[last + 1].end, words[first].start) - words[first].start +
          2 * DOC_REALIGN_PAD_S <=
          DOC_MAX_WINDOW_S
      ) {
        last++;
      }
      const firstW = words[first];
      const lastW = words[last];
      const prev = first > 0 ? words[first - 1] : null;
      const next = last < words.length - 1 ? words[last + 1] : null;
      let start = Math.max(0, firstW.start - DOC_REALIGN_PAD_S);
      if (prev) start = Math.min(Math.max(start, Math.max(prev.end, prev.start)), firstW.start);
      let end = Math.min(duration, Math.max(lastW.end, firstW.start) + DOC_REALIGN_PAD_S);
      if (next) end = Math.max(Math.min(end, next.start), Math.max(lastW.end, firstW.start));
      if (end > start) out.push({ first, last, start, end });
      first = last + 1;
    }
  }
  return out;
}

/**
 * Start time for each RAW text row (blank rows included, as null): the first
 * word in the row that LCS-survives against the current words reports its
 * current timing. Feeds the lyrics gutter — approximate mid-edit, firm on
 * commit.
 */
export function docLineTimes(oldWords: WordTiming[], rawLines: string[]): (number | null)[] {
  const perLine = rawLines.map(tokenizeLyric);
  const tokens = perLine.flat();
  const r = tokens.length > 0 ? retimeTokens(oldWords, tokens) : null;
  if (!r) return rawLines.map(() => null);
  let k = 0;
  return perLine.map((line) => {
    let t: number | null = null;
    for (let p = 0; p < line.length; p++) {
      if (r.matched[k + p]) {
        t = r.words[k + p].start;
        break;
      }
    }
    k += line.length;
    return t;
  });
}
