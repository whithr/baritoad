// Fix-editor state: pure reducer over the timing map's words (PLAN.md §3
// "drag to fix word timings; re-run alignment on a selection").
//
// Invariants enforced live, mirroring karaoke-core's validate(): times finite,
// inside [0, duration], start <= end, and word ONSETS monotonic — a word can
// never cross its neighbors' onsets. Everything here is original-song time
// (PLAN.md §5); the map is saved back through core, which re-validates.
//
// Undo/redo is an in-memory, per-session stack of word-array snapshots
// (arrays are never mutated in place, so snapshots are cheap references).
// Dirtiness is reference equality against the last-saved array: undoing back
// to the saved state reads as clean again.

import type { TimingMap, WordTiming } from "./api";
import type { RealignedWord } from "./api";

/** Two proposed times closer than this count as "didn't move" — a micro-drag
 *  (accidental wiggle while clicking) neither dirties the map nor spends an
 *  undo slot. 5 ms is far below anything audible. */
export const DRAG_NOOP_EPS_S = 0.005;

/** Keyboard nudge steps (arrows / shift-arrows). */
export const NUDGE_S = 0.01;
export const NUDGE_COARSE_S = 0.1;

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
  | { type: "insert-word"; after: number; word: string }
  | { type: "delete-word"; index: number }
  | { type: "nudge-range"; first: number; last: number; deltaS: number }
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
      const { first, last, timings } = action;
      if (
        first < 0 ||
        last >= state.words.length ||
        last - first + 1 !== timings.length ||
        timings.length === 0
      ) {
        return state;
      }
      const words = state.words.slice();
      // Splice respecting neighbors: onsets stay monotonic against the words
      // outside the selection and within it (running clamp).
      let prevOnset = first > 0 ? words[first - 1].start : 0;
      const nextOnset = last < words.length - 1 ? words[last + 1].start : state.duration;
      for (let k = 0; k < timings.length; k++) {
        const t = timings[k];
        const start = Math.min(Math.max(t.start, prevOnset, 0), nextOnset, state.duration);
        const end = Math.min(Math.max(t.end, start), state.duration);
        words[first + k] = {
          ...words[first + k],
          start,
          end,
          confidence: t.confidence,
          // this pass has no whisper evidence; and the user asserted the
          // selection is sung here, so the unsung flag clears
          anchored: false,
          unsung: false,
        };
        prevOnset = start;
      }
      return withEdit(state, words);
    }

    case "set-text": {
      const cur = state.words[action.index];
      const text = action.text.trim();
      if (!cur || text === "" || text === cur.word) return state;
      const words = state.words.slice();
      words[action.index] = { ...cur, word: text };
      return withEdit(state, words);
    }

    case "insert-word": {
      // Insert after index `after` (-1 = before the first word). Timing sits
      // in the middle half of the neighbor gap; with no audible gap the word
      // lands at the next onset (zero-ish duration — the user nudges it).
      const { after } = action;
      const word = action.word.trim();
      if (word === "" || after < -1 || after >= state.words.length) return state;
      const prev = after >= 0 ? state.words[after] : null;
      const next = after + 1 < state.words.length ? state.words[after + 1] : null;
      if (!prev && !next) return state;
      const prevOnset = prev ? prev.start : 0;
      const nextOnset = next ? next.start : state.duration;
      const gapStart = prev ? Math.max(prev.end, prev.start) : 0;
      const gapEnd = Math.max(nextOnset, gapStart);
      let start: number;
      let end: number;
      if (gapEnd - gapStart > 0.06) {
        const gap = gapEnd - gapStart;
        start = gapStart + gap * 0.25;
        end = gapEnd - gap * 0.25;
      } else {
        start = Math.min(Math.max(gapEnd, prevOnset), state.duration);
        end = Math.min(start + 0.12, state.duration);
      }
      // Lyric link: join prev's line (or next's when inserting at the front),
      // then bump word_in_line for the rest of that line so links keep
      // walking strictly forward (core validate()).
      const line = prev?.line ?? next?.line;
      let wordInLine: number | undefined;
      if (line != null) {
        wordInLine =
          prev?.line === line && prev.word_in_line != null
            ? prev.word_in_line + 1
            : next?.line === line && next.word_in_line != null
              ? next.word_in_line
              : undefined;
      }
      const inserted: WordTiming = {
        word,
        start,
        end,
        confidence: 1,
        anchored: true,
        unsung: false,
        line,
        word_in_line: wordInLine,
        ad_lib: false,
      };
      const words = state.words.slice();
      words.splice(after + 1, 0, inserted);
      if (line != null && wordInLine != null) {
        for (let i = after + 2; i < words.length; i++) {
          const w = words[i];
          if (w.line !== line) break;
          if (w.word_in_line != null) words[i] = { ...w, word_in_line: w.word_in_line + 1 };
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
