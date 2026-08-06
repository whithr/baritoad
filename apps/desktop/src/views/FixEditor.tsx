// Timeline editor — the app's MAIN editor (PLAN.md §3 "drag to fix word
// timings; re-run alignment on a selection"; §4 step 4). Hand-rolled DOM
// drag on per-line timelines — no timeline/drag library (CLAUDE.md
// dependency policy: no new §6 rows).
//
// Interactions:
//  - drag a word chip to move it (start+end); drag its right edge to move
//    just the end. Micro-drags under a few pixels are clicks, and the
//    reducer's epsilon makes zero-effect drags no-ops (snap resistance).
//  - drag a chip a row's height up/down to REWRAP: up moves the chip and
//    the words before it in its line onto the row above; down moves the
//    chip and the rest of its line onto the row below (so grabbing the
//    last/first word merges whole rows). Timing is untouched — only the
//    line links move (lineEdit.ts moveWordsUp/Down).
//  - click a word: select + seek there. Double-click (or Enter): retype it
//    in place — Tab commits and hops to the next word. Del removes it;
//    "+ Word" inserts into the gap after the selection.
//  - a line edits as one sentence (the row's EDIT key, Shift+Enter, or
//    double-click the track background): LCS-matched words keep their
//    timing, changed runs divide the replaced span (lineEdit.ts). Break /
//    Join / Reflow reshape line breaks.
//  - Space: play/pause. Arrows nudge the selected word ±10 ms (±100 ms with
//    Shift). Ctrl+Z / Ctrl+Y undo/redo.
//  - "Loop line" loops playback over the selected word's line.
//  - checkbox per line selects a contiguous range; "Re-align selection"
//    re-runs the CTC pass over that audio window (CPU) and splices the
//    result back as one undoable edit.
//  - Save validates through core and writes atomically with a .bak.
//    Preview hops to the karaoke-style review bench (saving first).
//
// All times shown/edited are original-song seconds — the map's only time
// base (PLAN.md §5). The audio element reports the same time base because
// this player never stretches (useAudio module docs).

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  exportSong,
  realignSelection,
  saveTimingMap,
  songSetReviewed,
  type ExportStatus,
  type PlaybackSources,
  type TimingMap,
} from "../api";
import {
  clampWord,
  editorReducer,
  exportFreshness,
  initEditor,
  isDirty,
  lineWindow,
  mapFromEditor,
  NUDGE_COARSE_S,
  NUDGE_S,
} from "../editorState";
import { groupByLine } from "../highlight";
import { ExportButton, EXPORT_FORMATS, fmtTime } from "../reviewUi";
import { useAudio } from "../useAudio";
import { IconBack } from "../icons";
import { ConfirmStrip, DashSelect, SegText } from "../ui";

/** Pointer travel below this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Vertical pointer travel that turns a chip drag into a rewrap onto the
 *  row above/below (row pitch is 46px — 40px track + 6px gap). */
const REWRAP_THRESHOLD_PX = 28;
/** Audio padding around a re-align selection window. */
const REALIGN_PAD_S = 1.0;

type SourceKind = "vocals" | "instrumental" | "original";

interface DragState {
  index: number;
  edge: "move" | "end";
  originX: number;
  originY: number;
  origStart: number;
  origEnd: number;
  pxPerS: number;
  moved: boolean;
  /** Live clamped preview times. */
  start: number;
  end: number;
  /** Vertical rewrap intent: -1 = onto the row above, 1 = below, 0 = none. */
  lineMove: -1 | 0 | 1;
}

export default function FixEditor(props: {
  map: TimingMap;
  mapPath: string;
  songId?: number;
  title: string;
  sources: PlaybackSources | null;
  status: ExportStatus | null;
  refreshStatus: () => Promise<void>;
  onExit: (savedMap: TimingMap | null) => void;
  /** Parent keeps its map copy in sync after a save. */
  onSaved?: (m: TimingMap) => void;
  /** Hop to the karaoke-style review bench (the editor saves first). */
  onPreview?: () => void;
}) {
  const { map, mapPath, sources } = props;
  const [state, dispatch] = useReducer(editorReducer, map, initEditor);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selLines, setSelLines] = useState<Set<number>>(new Set());
  const [loopLine, setLoopLine] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [srcKind, setSrcKind] = useState<SourceKind>(() =>
    sources?.vocals ? "vocals" : sources?.instrumental ? "instrumental" : "original",
  );
  // text editing: inline word retype, gap insert, whole-line sentence edit
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [insertAfter, setInsertAfter] = useState<number | null>(null);
  const [insertDraft, setInsertDraft] = useState("");
  const [lineEdit, setLineEdit] = useState<{ first: number; last: number } | null>(null);
  const [lineDraft, setLineDraft] = useState("");
  const lastClickRef = useRef<{ index: number; t: number } | null>(null);
  const savedMapRef = useRef<TimingMap | null>(null);
  const dirty = isDirty(state);

  // ---- audio (review-screen player only — useAudio module docs) ----
  const audio = useAudio();
  const srcPath = sources?.[srcKind] ?? null;
  useEffect(() => {
    if (srcPath) audio.load(convertFileSrc(srcPath));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcPath]);

  const words = state.words;
  const lines = useMemo(() => groupByLine(words), [words]);

  // Loop over the selected word's line while "Loop line" is on.
  useEffect(() => {
    if (!loopLine || state.selected == null) {
      audio.setLoop(null);
      return;
    }
    const g = lines.find((l) => l.indices.includes(state.selected!));
    if (!g) return;
    const first = words[g.indices[0]];
    const last = words[g.indices[g.indices.length - 1]];
    audio.setLoop({
      start: Math.max(0, first.start - 0.3),
      end: Math.min(state.duration, Math.max(last.end, first.start) + 0.3),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopLine, state.selected, words, lines]);

  // ---- text editing (word + line) ----
  const closeInputs = () => {
    setEditing(null);
    setInsertAfter(null);
    setLineEdit(null);
  };
  const beginEdit = (wi: number) => {
    closeInputs();
    dispatch({ type: "select", index: wi });
    setEditing(wi);
    setDraft(words[wi].word);
  };
  const commitEdit = () => {
    if (editing != null) dispatch({ type: "set-text", index: editing, text: draft });
    setEditing(null);
  };
  const beginInsert = () => {
    if (state.selected == null) return;
    closeInputs();
    setInsertAfter(state.selected);
    setInsertDraft("");
  };
  const commitInsert = () => {
    if (insertAfter != null && insertDraft.trim() !== "") {
      dispatch({ type: "insert-word", after: insertAfter, word: insertDraft });
    }
    setInsertAfter(null);
  };
  const beginLineEdit = (indices: number[]) => {
    if (indices.length === 0) return;
    closeInputs();
    setLineEdit({ first: indices[0], last: indices[indices.length - 1] });
    setLineDraft(indices.map((i) => words[i].word).join(" "));
  };
  const commitLineEdit = () => {
    if (lineEdit != null) {
      dispatch({
        type: "set-line-text",
        first: lineEdit.first,
        last: lineEdit.last,
        text: lineDraft,
      });
    }
    setLineEdit(null);
  };
  const deleteSelected = () => {
    if (state.selected != null) dispatch({ type: "delete-word", index: state.selected });
  };

  const sel = state.selected;
  const selGroupIdx = sel != null ? lines.findIndex((g) => g.indices.includes(sel)) : -1;
  const canBreak =
    sel != null &&
    words[sel]?.line != null &&
    selGroupIdx >= 0 &&
    lines[selGroupIdx].indices[0] !== sel;
  const canJoin = sel != null && words[sel]?.line != null && selGroupIdx > 0;

  // Where the playhead is, as indices — the anchor for selection hops that
  // start with nothing selected.
  const wordAtPlayhead = () => {
    const i = words.findIndex((w) => Math.max(w.end, w.start) >= audio.time);
    return i === -1 ? words.length - 1 : i;
  };
  const lineAtPlayhead = () => {
    const wi = wordAtPlayhead();
    const gi = lines.findIndex((g) => g.indices.includes(wi));
    return gi === -1 ? 0 : gi;
  };
  const selectAndSeek = (wi: number) => {
    dispatch({ type: "select", index: wi });
    audio.seek(words[wi].start);
  };

  // ---- keyboard: registered fresh each render so closures never go stale ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // a focused key handles Enter/Space itself — don't double-fire
      if (tag === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === " ") {
        e.preventDefault();
        audio.toggle();
      } else if (mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        // hop the selection word by word (from the playhead when nothing
        // is selected yet)
        if (words.length === 0) return;
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const wi =
          state.selected == null
            ? wordAtPlayhead()
            : Math.max(0, Math.min(words.length - 1, state.selected + dir));
        selectAndSeek(wi);
      } else if (mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        // hop line by line, landing on the line's first word
        if (lines.length === 0) return;
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const gi =
          selGroupIdx >= 0
            ? Math.max(0, Math.min(lines.length - 1, selGroupIdx + dir))
            : lineAtPlayhead();
        selectAndSeek(lines[gi].indices[0]);
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && busy == null) void doSave();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (state.selected == null) return;
        e.preventDefault();
        const step = (e.shiftKey ? NUDGE_COARSE_S : NUDGE_S) * (e.key === "ArrowLeft" ? -1 : 1);
        dispatch({ type: "nudge", index: state.selected, deltaS: step });
      } else if (e.key === "Enter" && e.shiftKey) {
        if (selGroupIdx >= 0) {
          e.preventDefault();
          beginLineEdit(lines[selGroupIdx].indices);
        }
      } else if (e.key === "Enter") {
        if (state.selected != null) {
          e.preventDefault();
          beginEdit(state.selected);
        }
      } else if (e.key === "Delete") {
        if (state.selected != null) {
          e.preventDefault();
          deleteSelected();
        }
      } else if (e.key === "Escape") {
        dispatch({ type: "select", index: null });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- drag ----
  const beginDrag = (
    e: React.PointerEvent,
    index: number,
    edge: "move" | "end",
    trackEl: HTMLElement,
    spanS: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (edge === "move" && e.altKey) {
      // eraser: Alt+click deletes the word outright, no select-first dance
      dispatch({ type: "delete-word", index });
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const w = words[index];
    setDrag({
      index,
      edge,
      originX: e.clientX,
      originY: e.clientY,
      origStart: w.start,
      origEnd: w.end,
      pxPerS: trackEl.getBoundingClientRect().width / spanS,
      moved: false,
      start: w.start,
      end: w.end,
      lineMove: 0,
    });
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const deltaPx = e.clientX - drag.originX;
    const deltaY = e.clientY - drag.originY;
    // Pulling a chip a row's height up/down turns the gesture into a rewrap:
    // the chip freezes in time and the target row lights up. Returning to
    // the home row resumes the ordinary time drag.
    const lineMove: -1 | 0 | 1 =
      drag.edge === "move"
        ? deltaY <= -REWRAP_THRESHOLD_PX
          ? -1
          : deltaY >= REWRAP_THRESHOLD_PX
            ? 1
            : 0
        : 0;
    const moved = drag.moved || Math.abs(deltaPx) >= DRAG_THRESHOLD_PX || lineMove !== 0;
    if (lineMove !== 0) {
      setDrag({ ...drag, moved, lineMove, start: drag.origStart, end: drag.origEnd });
      return;
    }
    const deltaS = deltaPx / drag.pxPerS;
    const proposedStart = drag.edge === "move" ? drag.origStart + deltaS : drag.origStart;
    const proposedEnd = drag.origEnd + deltaS;
    const c = clampWord(words, state.duration, drag.index, proposedStart, Math.max(proposedEnd, proposedStart));
    setDrag({ ...drag, moved, lineMove: 0, start: c.start, end: drag.edge === "move" ? c.end : Math.max(c.end, c.start) });
  };

  const onDragEnd = () => {
    if (!drag) return;
    const { index, moved, start, end } = drag;
    setDrag(null);
    if (drag.lineMove !== 0) {
      lastClickRef.current = null;
      dispatch({ type: drag.lineMove === -1 ? "rewrap-up" : "rewrap-down", at: index });
      dispatch({ type: "select", index });
      return;
    }
    if (moved) {
      lastClickRef.current = null;
      dispatch({ type: "commit-drag", index, start, end });
      dispatch({ type: "select", index });
      return;
    }
    // A click: select + seek. Two clicks on the same word inside 400 ms are
    // a double-click → retype in place. (Manual detection: beginDrag's
    // preventDefault on pointerdown suppresses native dblclick.)
    const now = performance.now();
    const last = lastClickRef.current;
    if (last && last.index === index && now - last.t < 400) {
      lastClickRef.current = null;
      beginEdit(index);
    } else {
      lastClickRef.current = { index, t: now };
      dispatch({ type: "select", index });
      audio.seek(words[index].start);
    }
  };

  // ---- re-align selection ----
  const selRange = useMemo(() => {
    if (selLines.size === 0) return null;
    const gis = [...selLines].sort((a, b) => a - b);
    const lo = gis[0];
    const hi = gis[gis.length - 1];
    const first = lines[lo]?.indices[0];
    const lastLine = lines[hi];
    const last = lastLine?.indices[lastLine.indices.length - 1];
    if (first == null || last == null) return null;
    return { first, last, lineCount: hi - lo + 1 };
  }, [selLines, lines]);

  const doRealign = async () => {
    if (!selRange || !sources?.vocals) return;
    const { first, last } = selRange;
    const firstW = words[first];
    const lastW = words[last];
    const prev = first > 0 ? words[first - 1] : null;
    const next = last < words.length - 1 ? words[last + 1] : null;
    // Window: pad outward, but never swallow a neighbor word's audio.
    let wStart = Math.max(0, firstW.start - REALIGN_PAD_S);
    if (prev) wStart = Math.min(Math.max(wStart, prev.end), firstW.start);
    let wEnd = Math.min(state.duration, Math.max(lastW.end, firstW.start) + REALIGN_PAD_S);
    if (next) wEnd = Math.max(Math.min(wEnd, next.start), Math.max(lastW.end, firstW.start));
    setBusy("Re-aligning selection…");
    setError(null);
    try {
      const timings = await realignSelection({
        vocals_path: sources.vocals,
        window_start: wStart,
        window_end: wEnd,
        words: words.slice(first, last + 1).map((w) => w.word),
      });
      dispatch({ type: "apply-realign", first, last, timings });
      setSelLines(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  // ---- save / preview / exports / exit ----
  const doSave = async (): Promise<boolean> => {
    setBusy("Saving…");
    setError(null);
    try {
      const newMap = mapFromEditor(map, words);
      await saveTimingMap(mapPath, newMap);
      savedMapRef.current = newMap;
      dispatch({ type: "mark-saved" });
      props.onSaved?.(newMap);
      if (props.songId != null) {
        // fixing timings *is* reviewing them
        await songSetReviewed(props.songId, true).catch(() => {});
      }
      await props.refreshStatus();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const goPreview = async () => {
    if (!props.onPreview) return;
    // The bench mounts from the saved map — save first so no edit is lost.
    if (dirty && !(await doSave())) return;
    audio.pause();
    props.onPreview();
  };

  const doExport = async (format: string) => {
    setError(null);
    try {
      await exportSong({ map_path: mapPath, formats: [format], title: props.title });
      await props.refreshStatus();
    } catch (e) {
      setError(String(e));
    }
  };

  const [confirmExit, setConfirmExit] = useState(false);

  const reallyExit = () => {
    audio.pause();
    props.onExit(savedMapRef.current);
  };

  const exit = () => {
    if (dirty) setConfirmExit(true);
    else reallyExit();
  };

  // ---- render ----
  const duration = state.duration || audio.duration || 1;
  // Rewrap drop target: the row a vertically-dragged chip would land on.
  const dragGi =
    drag != null && drag.lineMove !== 0
      ? lines.findIndex((g) => g.indices.includes(drag.index))
      : -1;
  const dropGi = dragGi >= 0 ? dragGi + (drag?.lineMove ?? 0) : -1;
  // The one row that shows the playhead: the line being sung (the upcoming
  // line during a gap). Rows' grid-snapped windows overlap between close
  // lines, so "every row whose window contains t" would sweep several
  // playheads at once, each at a different x — reading as bad sync.
  const playheadGi = audio.playing || audio.time > 0 ? lineAtPlayhead() : -1;
  return (
    <div className="page page-wide editor-page">
      {/* the console: toolbar + seek + editing keys stay pinned like an
          instrument panel while the line tracks scroll beneath */}
      <div className="editor-console">
      <div className="editor-toolbar">
        <button onClick={exit} className="with-icon">
          <IconBack size={12} /> Done
        </button>
        <button className="primary" onClick={() => audio.toggle()} disabled={!srcPath}>
          {audio.playing ? "Pause" : "Play"}
        </button>
        <DashSelect
          ariaLabel="What to listen to while fixing"
          value={srcKind}
          onChange={setSrcKind}
          options={[
            ...(sources?.vocals ? [{ value: "vocals" as const, label: "Vocals" }] : []),
            ...(sources?.instrumental ? [{ value: "instrumental" as const, label: "Instrumental" }] : []),
            ...(sources?.original ? [{ value: "original" as const, label: "Original" }] : []),
          ]}
        />
        {props.onPreview && (
          <button
            onClick={goPreview}
            disabled={busy != null}
            title="Watch it play karaoke-style — saves your fixes first"
          >
            Preview
          </button>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={loopLine}
            onChange={(e) => setLoopLine(e.target.checked)}
          />
          Loop line
        </label>
        <SegText className="editor-time" value={fmtTime(audio.time)} />
        <span className="spacer" />
        <button onClick={() => dispatch({ type: "undo" })} disabled={state.past.length === 0}>
          Undo
        </button>
        <button onClick={() => dispatch({ type: "redo" })} disabled={state.future.length === 0}>
          Redo
        </button>
        <button
          onClick={doRealign}
          disabled={!selRange || !sources?.vocals || busy != null}
          title={
            !sources?.vocals
              ? "Re-align needs the vocal stem, which wasn't found on disk"
              : "Re-run alignment over the checked lines (CPU, a few seconds)"
          }
        >
          Re-align selection{selRange ? ` (${selRange.lineCount} line${selRange.lineCount > 1 ? "s" : ""})` : ""}
        </button>
        <button
          className="primary"
          onClick={doSave}
          disabled={!dirty || busy != null}
          title="Save the timing map (Ctrl+S)"
        >
          {dirty ? "Save" : "Saved"}
        </button>
      </div>

      {/* global seek bar with unsung spans */}
      <div
        className="seek-bar"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          audio.seek(((e.clientX - r.left) / r.width) * duration);
        }}
      >
        {mapFromEditor(map, words).unsung_spans.map((s, i) => (
          <div
            key={i}
            className="seek-unsung"
            style={{
              left: `${(s.start / duration) * 100}%`,
              width: `${(Math.max(s.end - s.start, 0.5) / duration) * 100}%`,
            }}
            title="Unsung span — the aligner wasn't confident here"
          />
        ))}
        <div className="seek-playhead" style={{ left: `${(audio.time / duration) * 100}%` }} />
      </div>

      <div className="bench-row">
        <div className="bench-module" role="group" aria-label="Edit words">
          <button
            disabled={sel == null}
            onClick={() => sel != null && beginEdit(sel)}
            title="Retype the selected word (Enter)"
          >
            Retype
          </button>
          <button
            disabled={sel == null}
            onClick={beginInsert}
            title="Add a missed word after the selected one"
          >
            + Word
          </button>
          <button
            disabled={sel == null}
            onClick={deleteSelected}
            title="Remove the selected word (Del · or Alt+click any word)"
          >
            Remove
          </button>
        </div>
        <div className="bench-module" role="group" aria-label="Shape lines">
          <button
            disabled={selGroupIdx < 0}
            onClick={() => selGroupIdx >= 0 && beginLineEdit(lines[selGroupIdx].indices)}
            title="Retype the whole line as one sentence — matched words keep their timing (Shift+Enter)"
          >
            Edit line
          </button>
          <button
            disabled={!canBreak}
            onClick={() => sel != null && dispatch({ type: "break-line", at: sel })}
            title="Start a new line at the selected word"
          >
            Break here
          </button>
          <button
            disabled={!canJoin}
            onClick={() => sel != null && dispatch({ type: "join-line", at: sel })}
            title="Fold this line into the previous one"
          >
            Join up
          </button>
          <button
            onClick={() => dispatch({ type: "reflow-lines" })}
            title="Rebuild every line break from punctuation and the song's own pauses — undoable"
          >
            Reflow lines
          </button>
        </div>
        <span className="spacer" />
        <div className="bench-module" role="group" aria-label="Export">
          {EXPORT_FORMATS.map((f) => (
            <ExportButton
              key={f}
              format={f}
              freshness={props.status ? exportFreshness(props.status, f, dirty) : "none"}
              onClick={() => doExport(f)}
            />
          ))}
        </div>
      </div>
      {confirmExit && (
        <ConfirmStrip
          message="Discard unsaved timing changes?"
          confirmLabel="Discard"
          onConfirm={reallyExit}
          onCancel={() => setConfirmExit(false)}
        />
      )}
      {error && <div className="error-banner">{error}</div>}
      {busy && <div className="notice-banner">{busy}</div>}
      </div>

      <p className="muted small">
        Drag a word to move it, its right edge to stretch it, up/down to re-wrap it onto the
        next row · click a word selects &amp; jumps, click the track plays from there ·
        double-click retypes · Shift+Enter edits the whole line · Alt+click deletes ·
        Ctrl+←/→ hop words, Ctrl+↑/↓ lines · Space plays/pauses · arrows nudge ±10 ms
        (Shift: ±100 ms) · Ctrl+S saves ·{" "}
        <span className="legend unsung">amber</span> = unsung ·{" "}
        <span className="legend weak">dashed</span> = low-confidence, look here first.
      </p>

      <div className="editor-lines">
        {lines.map((g, gi) => {
          const lw = g.indices.map((i) => words[i]);
          const lineStart = Math.min(...lw.map((w) => w.start));
          const lineEnd = Math.max(...lw.map((w) => w.end), lineStart + 0.1);
          const win = lineWindow(lineStart, lineEnd, duration);
          const winStart = win.start;
          const winEnd = win.end;
          const span = Math.max(winEnd - winStart, 1);
          const playheadIn = gi === playheadGi && audio.time >= winStart && audio.time <= winEnd;
          const editingThisLine = lineEdit != null && lineEdit.first === g.indices[0];
          return (
            <div className="editor-line" key={gi}>
              <div className="line-head">
                <label className="line-pick" title="Select this line for re-alignment">
                  <input
                    type="checkbox"
                    checked={selLines.has(gi)}
                    onChange={(e) => {
                      setSelLines((prev) => {
                        const nextSel = new Set(prev);
                        if (e.target.checked) nextSel.add(gi);
                        else nextSel.delete(gi);
                        return nextSel;
                      });
                    }}
                  />
                  <span className="line-time">{fmtTime(lineStart)}</span>
                </label>
                <button
                  className="line-edit-key"
                  onClick={() => beginLineEdit(g.indices)}
                  title="Edit this line's words as one sentence — matched words keep their timing"
                >
                  Edit
                </button>
              </div>
              {editingThisLine ? (
                <div className="line-track">
                  <input
                    className="k-word-input line-track-input"
                    value={lineDraft}
                    autoFocus
                    onChange={(e) => setLineDraft(e.target.value)}
                    onBlur={commitLineEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitLineEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setLineEdit(null);
                      }
                    }}
                  />
                </div>
              ) : (
                <div
                  className={`line-track${gi === dropGi && dropGi < lines.length ? " drop-target" : ""}`}
                  title="Click to play from here · double-click to edit the line"
                  onPointerMove={onDragMove}
                  onPointerUp={onDragEnd}
                  onPointerCancel={onDragEnd}
                  onClick={(e) => {
                    // chips suppress native click/dblclick (pointerdown
                    // preventDefault), so these only fire from the background
                    if ((e.target as HTMLElement).closest(".word-chip")) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    audio.seek(winStart + ((e.clientX - r.left) / r.width) * span);
                  }}
                  onDoubleClick={(e) => {
                    if (!(e.target as HTMLElement).closest(".word-chip")) {
                      beginLineEdit(g.indices);
                    }
                  }}
                >
                  {playheadIn && (
                    <div
                      className="line-playhead"
                      style={{ left: `${((audio.time - winStart) / span) * 100}%` }}
                    />
                  )}
                  {g.indices.map((wi) => {
                    const w = words[wi];
                    if (editing === wi) {
                      const editLeft = ((w.start - winStart) / span) * 100;
                      return (
                        <input
                          key={`edit-${wi}`}
                          className="k-word-input chip-input"
                          style={{ left: `${Math.min(editLeft, 82)}%` }}
                          value={draft}
                          size={Math.max(draft.length, 2)}
                          autoFocus
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitEdit();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            } else if (e.key === "Tab") {
                              e.preventDefault();
                              commitEdit();
                              if (wi + 1 < words.length) beginEdit(wi + 1);
                            }
                          }}
                        />
                      );
                    }
                    const dStart = drag?.index === wi ? drag.start : w.start;
                    const dEnd = drag?.index === wi ? drag.end : w.end;
                    const left = ((dStart - winStart) / span) * 100;
                    const width = Math.max(((dEnd - dStart) / span) * 100, 1.2);
                    const weak = !w.unsung && (!w.anchored || w.confidence < 0.5);
                    return (
                      <div
                        key={wi}
                        className={
                          `word-chip${state.selected === wi ? " selected" : ""}` +
                          `${w.unsung ? " unsung" : ""}${weak ? " weak" : ""}` +
                          `${w.ad_lib ? " adlib" : ""}` +
                          `${drag?.index === wi && drag.lineMove !== 0 ? " lifting" : ""}`
                        }
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${w.word} · ${fmtTime(w.start)}–${fmtTime(w.end)} · confidence ${(w.confidence * 100).toFixed(0)}%${w.anchored ? " · anchored" : ""}${w.unsung ? " · unsung" : ""}`}
                        onPointerDown={(e) =>
                          beginDrag(e, wi, "move", e.currentTarget.parentElement as HTMLElement, span)
                        }
                      >
                        <span className="chip-text">{w.word}</span>
                        <span
                          className="chip-handle"
                          title="Drag to adjust the word's end"
                          onPointerDown={(e) =>
                            beginDrag(
                              e,
                              wi,
                              "end",
                              (e.currentTarget.parentElement as HTMLElement)
                                .parentElement as HTMLElement,
                              span,
                            )
                          }
                        />
                      </div>
                    );
                  })}
                  {insertAfter != null && g.indices.includes(insertAfter) && (
                    <input
                      key="insert"
                      className="k-word-input chip-input"
                      style={{
                        left: `${Math.min(
                          ((Math.max(words[insertAfter].end, words[insertAfter].start) - winStart) /
                            span) *
                            100,
                          82,
                        )}%`,
                      }}
                      value={insertDraft}
                      size={Math.max(insertDraft.length, 4)}
                      placeholder="word"
                      autoFocus
                      onChange={(e) => setInsertDraft(e.target.value)}
                      onBlur={commitInsert}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitInsert();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setInsertAfter(null);
                        }
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
