// Fix-editor state: pure reducer over the timing map's words (drag to
// fix word timings; re-run alignment on a selection).
//
// Invariants enforced live, mirroring karaoke-core's validate(): times finite,
// inside [0, duration], start <= end, and word ONSETS monotonic — a word can
// never cross its neighbors' onsets. Everything here is original-song time;
// the map is saved back through core, which re-validates.
//
// Undo/redo is an in-memory, per-session stack of word-array snapshots
// (arrays are never mutated in place, so snapshots are cheap references).
// Dirtiness is reference equality against the last-saved array: undoing back
// to the saved state reads as clean again.

import type { TimingMap, WordTiming } from "./api";
import type { RealignedWord } from "./api";
import {
  breakLineAt,
  joinLineUp,
  moveWordsDown,
  moveWordsUp,
  reflowLines,
  retimeLine,
  tokenizeLyric,
} from "./lineEdit";

/** Two proposed times closer than this count as "didn't move" — a micro-drag
 *  (accidental wiggle while clicking) neither dirties the map nor spends an
 *  undo slot. 5 ms is far below anything audible. */
export const DRAG_NOOP_EPS_S = 0.005;

/** Keyboard nudge steps (arrows / shift-arrows). */
export const NUDGE_S = 0.01;
export const NUDGE_COARSE_S = 0.1;

/** Seconds of context shown either side of a line's words in the editor. */
export const LINE_PAD_S = 0.6;

/**
 * A line track's visible time window: the line's extent padded by
 * LINE_PAD_S, then snapped OUTWARD to a whole-second grid. The snap is what
 * keeps a row's coordinate system still while its edge words are dragged or
 * nudged — the window only re-maps when a word crosses a second boundary,
 * instead of re-centering on every commit.
 */
export function lineWindow(
  lineStart: number,
  lineEnd: number,
  duration: number,
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(lineStart - LINE_PAD_S));
  const end = Math.min(Math.max(duration, lineEnd), Math.ceil(lineEnd + LINE_PAD_S));
  return { start, end: Math.max(end, start + 1) };
}

const MAX_UNDO = 200;

export interface EditorState {
  words: WordTiming[];
  duration: number;
  selected: number | null;
  past: WordTiming[][];
  future: WordTiming[][];
  /** The words array as last saved (or as loaded). */
  saved: WordTiming[];
}

export type EditorAction =
  | { type: "select"; index: number | null }
  | { type: "commit-drag"; index: number; start: number; end: number }
  | { type: "nudge"; index: number; deltaS: number }
  | { type: "apply-realign"; first: number; last: number; timings: RealignedWord[] }
  | { type: "set-text"; index: number; text: string }
  | { type: "set-line-text"; first: number; last: number; text: string }
  | { type: "break-line"; at: number }
  | { type: "join-line"; at: number }
  | { type: "rewrap-up"; at: number }
  | { type: "rewrap-down"; at: number }
  | { type: "reflow-lines" }
  | {
      type: "insert-word";
      after: number;
      /** One word, or several (whitespace-separated) sharing the slot. */
      word: string;
      /** Onset in original-song seconds; omitted = the neighbor gap. */
      at?: number;
      /** Which neighbor's lyric line the words join (default "prev"). */
      join?: "prev" | "next";
    }
  | { type: "delete-word"; index: number }
  | { type: "nudge-range"; first: number; last: number; deltaS: number }
  | { type: "replace-words"; words: WordTiming[] }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "mark-saved" };

export function initEditor(map: TimingMap): EditorState {
  return {
    words: map.words,
    duration: map.duration,
    selected: null,
    past: [],
    future: [],
    saved: map.words,
  };
}

export const isDirty = (s: EditorState): boolean => s.words !== s.saved;

/**
 * Clamp a proposed (start, end) for word `i` so the map stays valid:
 * onset monotonic against both neighbors, times inside [0, duration],
 * end >= start.
 */
export function clampWord(
  words: WordTiming[],
  duration: number,
  i: number,
  start: number,
  end: number,
): { start: number; end: number } {
  const prevOnset = i > 0 ? words[i - 1].start : 0;
  const nextOnset = i < words.length - 1 ? words[i + 1].start : duration;
  let s = Math.min(Math.max(start, prevOnset, 0), nextOnset, duration);
  let e = Math.min(Math.max(end, s), duration);
  if (!isFinite(s)) s = words[i].start;
  if (!isFinite(e)) e = Math.max(words[i].end, s);
  return { start: s, end: e };
}

/** Sung length given to each word inserted at a chosen time. */
export const INSERT_WORD_S = 0.3;

/**
 * The span `insert-word` fills after index `after` (-1 = before the first
 * word), or null with no neighbor at all. At `at` when given: clamped
 * between the neighbors' onsets, INSERT_WORD_S per word, never past the
 * next onset. Otherwise the middle half of the neighbor gap; with no audible
 * gap, the next onset (zero-ish duration — the user nudges it).
 */
export function insertSlot(
  words: WordTiming[],
  duration: number,
  after: number,
  at?: number,
  count = 1,
): { start: number; end: number } | null {
  const prev = after >= 0 ? words[after] : null;
  const next = after + 1 < words.length ? words[after + 1] : null;
  if (!prev && !next) return null;
  const prevOnset = prev ? prev.start : 0;
  const nextOnset = next ? next.start : duration;
  if (at != null && isFinite(at)) {
    const start = Math.min(Math.max(at, prevOnset, 0), nextOnset, duration);
    return { start, end: Math.max(start, Math.min(start + INSERT_WORD_S * count, nextOnset, duration)) };
  }
  const gapStart = prev ? Math.max(prev.end, prev.start) : 0;
  const gapEnd = Math.max(nextOnset, gapStart);
  if (gapEnd - gapStart > 0.06) {
    const gap = gapEnd - gapStart;
    return { start: gapStart + gap * 0.25, end: gapEnd - gap * 0.25 };
  }
  // No gap: the next onset — never prev's end, which may overrun it.
  const start = Math.min(nextOnset, duration);
  return { start, end: Math.min(start + 0.12, duration) };
}

/**
 * Splice re-aligned timings over words [first..last], respecting neighbors:
 * onsets stay monotonic against the words outside the run and within it
 * (running clamp). Pure — the reducer's apply-realign wraps it with undo,
 * and the lyrics-pass commit uses it directly to fold several windows into
 * one replace-words entry. Returns null for a malformed request.
 */
export function spliceRealignedRun(
  allWords: WordTiming[],
  duration: number,
  first: number,
  last: number,
  timings: RealignedWord[],
): WordTiming[] | null {
  if (first < 0 || last >= allWords.length || last - first + 1 !== timings.length || timings.length === 0) {
    return null;
  }
  const words = allWords.slice();
  let prevOnset = first > 0 ? words[first - 1].start : 0;
  const nextOnset = last < words.length - 1 ? words[last + 1].start : duration;
  for (let k = 0; k < timings.length; k++) {
    const t = timings[k];
    const start = Math.min(Math.max(t.start, prevOnset, 0), nextOnset, duration);
    const end = Math.min(Math.max(t.end, start), duration);
    words[first + k] = {
      ...words[first + k],
      start,
      end,
      confidence: t.confidence,
      // this pass has no whisper evidence; and the user asserted the
      // run is sung here, so the unsung flag clears
      anchored: false,
      unsung: false,
    };
    prevOnset = start;
  }
  return words;
}

function withEdit(state: EditorState, words: WordTiming[]): EditorState {
  return {
    ...state,
    words,
    past: [...state.past.slice(-(MAX_UNDO - 1)), state.words],
    future: [],
  };
}

function moved(a: number, b: number): boolean {
  return Math.abs(a - b) > DRAG_NOOP_EPS_S;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "select":
      return state.selected === action.index ? state : { ...state, selected: action.index };

    case "commit-drag": {
      const { index } = action;
      const cur = state.words[index];
      if (!cur) return state;
      const c = clampWord(state.words, state.duration, index, action.start, action.end);
      // Snap-resistance backstop: a clamped-to-nothing drag is a no-op —
      // no dirty flag, no undo entry.
      if (!moved(c.start, cur.start) && !moved(c.end, cur.end)) return state;
      const words = state.words.slice();
      words[index] = { ...cur, start: c.start, end: c.end };
      return withEdit(state, words);
    }

    case "nudge": {
      const { index, deltaS } = action;
      const cur = state.words[index];
      if (!cur) return state;
      // Nudge moves the whole word; the clamp may shorten the shift at a
      // neighbor's onset (start clamps, duration is preserved best-effort).
      const c = clampWord(
        state.words,
        state.duration,
        index,
        cur.start + deltaS,
        cur.end + deltaS,
      );
      if (!moved(c.start, cur.start) && !moved(c.end, cur.end)) return state;
      const words = state.words.slice();
      words[index] = { ...cur, start: c.start, end: c.end };
      return withEdit(state, words);
    }

    case "apply-realign": {
      const words = spliceRealignedRun(
        state.words,
        state.duration,
        action.first,
        action.last,
        action.timings,
      );
      return words ? withEdit(state, words) : state;
    }

    case "set-text": {
      const cur = state.words[action.index];
      const text = action.text.trim();
      if (!cur || text === "" || text === cur.word) return state;
      const words = state.words.slice();
      words[action.index] = { ...cur, word: text };
      return withEdit(state, words);
    }

    case "set-line-text": {
      // Replace a whole line's text as one sentence: LCS-matched words keep
      // their timing; replaced runs divide their old span evenly (lineEdit).
      const { first, last } = action;
      if (first < 0 || last >= state.words.length || first > last) return state;
      const tokens = tokenizeLyric(action.text);
      if (tokens.length === 0) return state;
      const oldLine = state.words.slice(first, last + 1);
      const newLine = retimeLine(oldLine, tokens);
      if (newLine.length === 0) return state;
      // Clamp the outer onsets against the neighbors so the map stays valid.
      const prevOnset = first > 0 ? state.words[first - 1].start : 0;
      const nextOnset =
        last < state.words.length - 1 ? state.words[last + 1].start : state.duration;
      let prev = prevOnset;
      const clamped = newLine.map((w) => {
        const start = Math.min(Math.max(w.start, prev), nextOnset);
        prev = start;
        return { ...w, start, end: Math.min(Math.max(w.end, start), state.duration) };
      });
      const same =
        clamped.length === oldLine.length &&
        clamped.every(
          (w, k) =>
            w.word === oldLine[k].word &&
            !moved(w.start, oldLine[k].start) &&
            !moved(w.end, oldLine[k].end),
        );
      if (same) return state;
      const words = state.words.slice(0, first).concat(clamped, state.words.slice(last + 1));
      return { ...withEdit(state, words), selected: null };
    }

    case "break-line": {
      const words = breakLineAt(state.words, action.at);
      return words ? withEdit(state, words) : state;
    }

    case "join-line": {
      const words = joinLineUp(state.words, action.at);
      return words ? withEdit(state, words) : state;
    }

    case "rewrap-up": {
      const words = moveWordsUp(state.words, action.at);
      return words ? withEdit(state, words) : state;
    }

    case "rewrap-down": {
      const words = moveWordsDown(state.words, action.at);
      return words ? withEdit(state, words) : state;
    }

    case "reflow-lines": {
      const words = reflowLines(state.words);
      // Reflow only rewrites line links — a no-op map stays clean.
      const changed = words.some(
        (w, i) =>
          w.line !== state.words[i].line || w.word_in_line !== state.words[i].word_in_line,
      );
      return changed ? withEdit(state, words) : state;
    }

    case "insert-word": {
      // Insert after index `after` (-1 = before the first word), timed by
      // insertSlot; several words split the slot evenly.
      const { after } = action;
      const tokens = tokenizeLyric(action.word);
      if (tokens.length === 0 || after < -1 || after >= state.words.length) return state;
      const slot = insertSlot(state.words, state.duration, after, action.at, tokens.length);
      if (!slot) return state;
      const prev = after >= 0 ? state.words[after] : null;
      const next = after + 1 < state.words.length ? state.words[after + 1] : null;
      // Lyric link: join the chosen neighbor's line (the other one's when it
      // has none), then bump word_in_line for the rest of that line so links
      // keep walking strictly forward (core validate()).
      const line = action.join === "next" ? (next?.line ?? prev?.line) : (prev?.line ?? next?.line);
      let wordInLine: number | undefined;
      if (line != null) {
        wordInLine =
          prev?.line === line && prev.word_in_line != null
            ? prev.word_in_line + 1
            : next?.line === line && next.word_in_line != null
              ? next.word_in_line
              : undefined;
      }
      const n = tokens.length;
      const step = (slot.end - slot.start) / n;
      const inserted: WordTiming[] = tokens.map((word, k) => ({
        word,
        start: slot.start + step * k,
        end: k === n - 1 ? slot.end : slot.start + step * (k + 1),
        confidence: 1,
        anchored: true,
        unsung: false,
        line,
        word_in_line: wordInLine != null ? wordInLine + k : undefined,
        ad_lib: false,
      }));
      const words = state.words.slice();
      // Sung words don't overlap: a prev word running past the new onset
      // ends there (a double-click inside its span says it was too long).
      if (prev && prev.end > slot.start) words[after] = { ...prev, end: Math.max(prev.start, slot.start) };
      words.splice(after + 1, 0, ...inserted);
      if (line != null && wordInLine != null) {
        for (let i = after + 1 + n; i < words.length; i++) {
          const w = words[i];
          if (w.line !== line) break;
          if (w.word_in_line != null) words[i] = { ...w, word_in_line: w.word_in_line + n };
        }
      }
      return { ...withEdit(state, words), selected: after + 1 };
    }

    case "delete-word": {
      const cur = state.words[action.index];
      if (!cur) return state;
      const words = state.words.slice();
      words.splice(action.index, 1);
      // Links stay strictly increasing after a removal — no renumber needed.
      const selected =
        words.length === 0 ? null : Math.min(action.index, words.length - 1);
      return { ...withEdit(state, words), selected };
    }

    case "nudge-range": {
      // Shift words [first..last] together, clamped once at the outer
      // boundaries (a group never pins against its own interior words).
      const { first, last } = action;
      if (first < 0 || last >= state.words.length || first > last) return state;
      const prevOnset = first > 0 ? state.words[first - 1].start : 0;
      const nextOnset = last < state.words.length - 1 ? state.words[last + 1].start : state.duration;
      let delta = action.deltaS;
      delta = Math.max(delta, prevOnset - state.words[first].start, -state.words[first].start);
      delta = Math.min(delta, nextOnset - state.words[last].start);
      if (Math.abs(delta) <= DRAG_NOOP_EPS_S) return state;
      const words = state.words.slice();
      for (let i = first; i <= last; i++) {
        const w = words[i];
        const start = Math.min(Math.max(w.start + delta, 0), state.duration);
        const end = Math.min(Math.max(w.end + delta, start), state.duration);
        words[i] = { ...w, start, end };
      }
      return withEdit(state, words);
    }

    case "replace-words": {
      // Whole-document commit (the LYRICS stage's "Sync to music"): the
      // caller computed the retimed + re-aligned array with the pure
      // docEdit/spliceRealignedRun helpers; here it lands as ONE undo entry.
      if (action.words.length === 0 || action.words === state.words) return state;
      return { ...withEdit(state, action.words), selected: null };
    }

    case "undo": {
      if (state.past.length === 0) return state;
      const words = state.past[state.past.length - 1];
      return {
        ...state,
        words,
        past: state.past.slice(0, -1),
        future: [state.words, ...state.future],
      };
    }

    case "redo": {
      if (state.future.length === 0) return state;
      const [words, ...rest] = state.future;
      return {
        ...state,
        words,
        past: [...state.past, state.words],
        future: rest,
      };
    }

    case "mark-saved":
      return { ...state, saved: state.words };
  }
}

/**
 * Rebuild a full map from the editor's words for save/export: unsung spans
 * are recomputed from the words' `unsung` flags (maximal runs), with span
 * times taken from the words — so a span whose words were dragged or
 * re-aligned stays truthful.
 */
export function mapFromEditor(base: TimingMap, words: WordTiming[]): TimingMap {
  const spans: TimingMap["unsung_spans"] = [];
  let i = 0;
  while (i < words.length) {
    if (!words[i].unsung) {
      i++;
      continue;
    }
    const first = i;
    while (i < words.length && words[i].unsung) i++;
    const last = i - 1;
    spans.push({
      first_word: first,
      last_word: last,
      start: words[first].start,
      end: words[last].end,
    });
  }
  return { ...base, words, unsung_spans: spans };
}

// ---------------------------------------------------------------------------
// stale-export detection (pure half of review.rs's exports sidecar)
// ---------------------------------------------------------------------------

export type ExportFreshness = "none" | "fresh" | "stale";

/**
 * An export is fresh iff it still exists on disk AND was rendered from the
 * map content currently on disk (hash match). A missing record = never
 * exported. `dirtyEditor` marks even hash-fresh exports stale: unsaved edits
 * already diverge from what the file says.
 */
export function exportFreshness(
  status: {
    current_map_sha256: string;
    exports: Partial<Record<string, { map_sha256: string; exists: boolean }>>;
  },
  format: string,
  dirtyEditor = false,
): ExportFreshness {
  const rec = status.exports[format];
  if (!rec) return "none";
  if (!rec.exists) return "none";
  return rec.map_sha256 === status.current_map_sha256 && !dirtyEditor ? "fresh" : "stale";
}
