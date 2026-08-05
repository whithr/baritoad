// Fix editor (PLAN.md §3 "drag to fix word timings; re-run alignment on a
// selection"; §4 step 4). Hand-rolled DOM drag on per-line timelines — no
// timeline/drag library (CLAUDE.md dependency policy: no new §6 rows).
//
// Interactions:
//  - drag a word chip to move it (start+end); drag its right edge to move
//    just the end. Micro-drags under a few pixels are clicks, and the
//    reducer's epsilon makes zero-effect drags no-ops (snap resistance).
//  - click a word: select + seek there. Space: play/pause. Arrows nudge the
//    selected word ±10 ms (±100 ms with Shift). Ctrl+Z / Ctrl+Y undo/redo.
//  - "Loop line" loops playback over the selected word's line.
//  - checkbox per line selects a contiguous range; "Re-align selection"
//    re-runs the CTC pass over that audio window (CPU) and splices the
//    result back as one undoable edit.
//  - Save validates through core and writes atomically with a .bak.
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
  mapFromEditor,
  NUDGE_COARSE_S,
  NUDGE_S,
} from "../editorState";
import { groupByLine } from "../highlight";
import { ExportButton, EXPORT_FORMATS, fmtTime } from "../reviewUi";
import { useAudio } from "../useAudio";

/** Pointer travel below this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Seconds of context shown either side of a line's words. */
const LINE_PAD_S = 0.6;
/** Audio padding around a re-align selection window. */
const REALIGN_PAD_S = 1.0;

type SourceKind = "vocals" | "instrumental" | "original";

interface DragState {
  index: number;
  edge: "move" | "end";
  originX: number;
  origStart: number;
  origEnd: number;
  pxPerS: number;
  moved: boolean;
  /** Live clamped preview times. */
  start: number;
  end: number;
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

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " ") {
        e.preventDefault();
        audio.toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (state.selected == null) return;
        e.preventDefault();
        const step = (e.shiftKey ? NUDGE_COARSE_S : NUDGE_S) * (e.key === "ArrowLeft" ? -1 : 1);
        dispatch({ type: "nudge", index: state.selected, deltaS: step });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selected, audio.toggle]);

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
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const w = words[index];
    setDrag({
      index,
      edge,
      originX: e.clientX,
      origStart: w.start,
      origEnd: w.end,
      pxPerS: trackEl.getBoundingClientRect().width / spanS,
      moved: false,
      start: w.start,
      end: w.end,
    });
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const deltaPx = e.clientX - drag.originX;
    const moved = drag.moved || Math.abs(deltaPx) >= DRAG_THRESHOLD_PX;
    const deltaS = deltaPx / drag.pxPerS;
    const proposedStart = drag.edge === "move" ? drag.origStart + deltaS : drag.origStart;
    const proposedEnd = drag.origEnd + deltaS;
    const c = clampWord(words, state.duration, drag.index, proposedStart, Math.max(proposedEnd, proposedStart));
    setDrag({ ...drag, moved, start: c.start, end: drag.edge === "move" ? c.end : Math.max(c.end, c.start) });
  };

  const onDragEnd = () => {
    if (!drag) return;
    const { index, moved, start, end } = drag;
    setDrag(null);
    if (moved) {
      dispatch({ type: "commit-drag", index, start, end });
      dispatch({ type: "select", index });
    } else {
      // a click: select + seek to the word
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

  // ---- save / exports / exit ----
  const doSave = async () => {
    setBusy("Saving…");
    setError(null);
    try {
      const newMap = mapFromEditor(map, words);
      await saveTimingMap(mapPath, newMap);
      savedMapRef.current = newMap;
      dispatch({ type: "mark-saved" });
      if (props.songId != null) {
        // fixing timings *is* reviewing them
        await songSetReviewed(props.songId, true).catch(() => {});
      }
      await props.refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
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

  const exit = () => {
    if (dirty && !window.confirm("Discard unsaved timing changes?")) return;
    audio.pause();
    props.onExit(savedMapRef.current);
  };

  // ---- render ----
  const duration = state.duration || audio.duration || 1;
  return (
    <div className="page page-wide editor-page">
      <div className="editor-toolbar">
        <button onClick={exit}>← Done</button>
        <button className="primary" onClick={() => audio.toggle()} disabled={!srcPath}>
          {audio.playing ? "Pause" : "Play"}
        </button>
        <select
          value={srcKind}
          onChange={(e) => setSrcKind(e.target.value as SourceKind)}
          title="What to listen to while fixing"
        >
          {sources?.vocals && <option value="vocals">Vocals</option>}
          {sources?.instrumental && <option value="instrumental">Instrumental</option>}
          {sources?.original && <option value="original">Original</option>}
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={loopLine}
            onChange={(e) => setLoopLine(e.target.checked)}
          />
          Loop line
        </label>
        <span className="editor-time">{fmtTime(audio.time)}</span>
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
        <button className="primary" onClick={doSave} disabled={!dirty || busy != null}>
          {dirty ? "Save" : "Saved"}
        </button>
        {EXPORT_FORMATS.map((f) => (
          <ExportButton
            key={f}
            format={f}
            freshness={props.status ? exportFreshness(props.status, f, dirty) : "none"}
            onClick={() => doExport(f)}
          />
        ))}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {busy && <div className="notice-banner">{busy}</div>}
      <p className="muted small">
        Drag a word to move it, drag its right edge to stretch it. Click a word to jump there ·
        Space plays/pauses · arrows nudge ±10 ms (Shift: ±100 ms) ·{" "}
        <span className="legend unsung">orange</span> = flagged not-sung ·{" "}
        <span className="legend weak">dashed</span> = low-confidence, look here first.
      </p>

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
            title="Flagged span — the aligner wasn't confident here"
          />
        ))}
        <div className="seek-playhead" style={{ left: `${(audio.time / duration) * 100}%` }} />
      </div>

      <div className="editor-lines">
        {lines.map((g, gi) => {
          const lw = g.indices.map((i) => words[i]);
          const lineStart = Math.min(...lw.map((w) => w.start));
          const lineEnd = Math.max(...lw.map((w) => w.end), lineStart + 0.1);
          const winStart = Math.max(0, lineStart - LINE_PAD_S);
          const winEnd = Math.min(Math.max(duration, lineEnd), lineEnd + LINE_PAD_S);
          const span = Math.max(winEnd - winStart, 1);
          const playheadIn = audio.time >= winStart && audio.time <= winEnd;
          return (
            <div className="editor-line" key={gi}>
              <label className="line-head" title="Select this line for re-alignment">
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
              <div
                className="line-track"
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={onDragEnd}
              >
                {playheadIn && (
                  <div
                    className="line-playhead"
                    style={{ left: `${((audio.time - winStart) / span) * 100}%` }}
                  />
                )}
                {g.indices.map((wi) => {
                  const w = words[wi];
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
                        `${w.ad_lib ? " adlib" : ""}`
                      }
                      style={{ left: `${left}%`, width: `${width}%` }}
                      title={`${w.word} · ${fmtTime(w.start)}–${fmtTime(w.end)} · confidence ${(w.confidence * 100).toFixed(0)}%${w.anchored ? " · anchored" : ""}${w.unsung ? " · flagged not-sung" : ""}`}
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
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
