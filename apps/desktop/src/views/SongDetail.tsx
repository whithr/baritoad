// Song detail = the review screen (PLAN.md §3, §4 step 4 "Preview & fix").
//
// Three modes:
//  - edit: the timeline editor (FixEditor.tsx) — the MAIN editor: chip
//    tracks with drag timing, inline word/line retype, insert/delete,
//    break/join/reflow, re-align selection. Entered automatically for
//    songs not yet reviewed.
//  - preview: the review bench — karaoke-style playback check (densest
//    ~20 s or full song) that keeps its lyric console; "Looks good"
//    saves fixes and marks reviewed.
//  - detail: metadata, word list, exports (with freshness badges).
//
// Audio here is the review-screen player only (useAudio module docs): plain
// playback, no key/tempo — the Phase 3 cpal player replaces it for singing.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  cleanLyricsPreview,
  exportSong,
  exportStatus as fetchExportStatus,
  generateSong,
  librarySong,
  playbackSources,
  readTimingMap,
  saveTimingMap,
  songSetReviewed,
  type CleanPreview,
  type ExportStatus,
  type PlaybackSources,
  type Song,
  type TimingMap,
} from "../api";
import {
  editorReducer,
  exportFreshness,
  initEditor,
  isDirty,
  mapFromEditor,
  NUDGE_COARSE_S,
  NUDGE_S,
} from "../editorState";
import {
  groupByLine,
  pickHighlightWindow,
  sungThroughIndexAt,
  wordIndexAt,
} from "../highlight";
import { wipeFraction } from "../playerView";
import { puckFrameAt, shiftRange, type ShiftScope } from "../previewEditor";
import { ExportButton, EXPORT_FORMATS, fmtTime } from "../reviewUi";
import { useAudio } from "../useAudio";
import { IconBack, IconPlay } from "../icons";
import { ConfirmStrip, DashSelect, DashSlider, SegText } from "../ui";
import FixEditor from "./FixEditor";
import type { Route } from "../App";

type Mode = "loading" | "preview" | "detail" | "edit";

/** What the preview plays: the ~20 s highlight loop or the whole song. */
type PreviewScope = "highlight" | "full";

type SourceKind = "instrumental" | "original" | "vocals";

/** Amber advisory strip on auto-transcribed songs: paste the real lyrics
 *  and re-align. The manifest fingerprints the lyrics file, so the re-run
 *  reuses the stems and only cleanup + align + export execute. */
function PasteLyricsStrip({ song, onQueued }: { song: Song; onQueued: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<CleanPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const debounceRef = useRef<number>(0);

  // Debounced live cleanup preview (same cadence as the New Song wizard).
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (text.trim() === "") {
      setPreview(null);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      try {
        setPreview(await cleanLyricsPreview(text));
      } catch {
        setPreview(null);
      }
    }, 250);
    return () => window.clearTimeout(debounceRef.current);
  }, [text]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await generateSong({
        audio_path: song.audio_path,
        out_dir: song.job_dir,
        lyrics_text: text,
        title: song.title,
        artist: song.artist ?? undefined,
      });
      onQueued();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="advice-banner" data-testid="paste-lyrics-strip">
      <div className="advice-msg">
        Lyrics were auto-transcribed, so some words are guesses. Paste the real
        lyrics and this song re-aligns against them — the separated vocals are
        reused, so it takes about a minute.
      </div>
      {!open ? (
        <button onClick={() => setOpen(true)}>Paste lyrics…</button>
      ) : (
        <div className="advice-panel">
          <label className="field">
            <span>Lyrics</span>
            <textarea
              rows={8}
              autoFocus
              value={text}
              placeholder={"[Verse 1]\nNever gonna give…"}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {preview && (
            <div className="cleanup-line" data-testid="paste-cleanup-summary">
              {preview.summary} · {preview.words_kept} words
            </div>
          )}
          {err && <div className="error-banner">{err}</div>}
          <div className="actions">
            <button disabled={busy || text.trim() === ""} onClick={submit}>
              {busy ? "Queueing…" : "Re-align with these lyrics"}
            </button>
            <button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SongDetail(props: {
  mapPath: string;
  title?: string;
  songId?: number;
  go: (r: Route) => void;
}) {
  const { mapPath, songId, go } = props;
  const [map, setMap] = useState<TimingMap | null>(null);
  const [song, setSong] = useState<Song | null>(null);
  const [sources, setSources] = useState<PlaybackSources | null>(null);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [mode, setMode] = useState<Mode>("loading");
  /** Which stage the editor opens on: unreviewed auto-transcribed songs land
   *  on the lyrics pass (their text is the suspect part); every explicit
   *  "Timeline editor" hop lands on timing. */
  const [editStage, setEditStage] = useState<"lyrics" | "timing">("timing");
  const [previewScope, setPreviewScope] = useState<PreviewScope>("highlight");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const title = props.title ?? song?.title ?? "Song";

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await fetchExportStatus(mapPath));
    } catch {
      setStatus(null); // sidecar missing is fine — everything reads "none"
    }
  }, [mapPath]);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const m = await readTimingMap(mapPath);
        if (disposed) return;
        setMap(m);
        let s: Song | null = null;
        if (songId != null) {
          try {
            s = await librarySong(songId);
          } catch {
            s = null; // song row gone — detail still works from the map
          }
        }
        if (disposed) return;
        setSong(s);
        // Golden path: unreviewed songs open straight into the editor —
        // transcribed ones on the lyrics pass, since the words themselves
        // are what auto-transcription gets wrong.
        if (s && s.reviewed_at == null && m.lyric_source === "transcribed") {
          setEditStage("lyrics");
        }
        setMode(s && s.reviewed_at == null ? "edit" : "detail");
        try {
          const src = await playbackSources(
            songId != null ? { songId } : { mapPath },
          );
          if (!disposed) setSources(src);
        } catch {
          // no playable files — preview/editor degrade to silent mode
        }
        await refreshStatus();
      } catch (e) {
        if (!disposed) {
          setError(String(e));
          setMode("detail");
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [mapPath, songId, refreshStatus]);

  const markReviewed = async () => {
    try {
      if (songId != null) {
        await songSetReviewed(songId, true);
        setSong((s) => (s ? { ...s, reviewed_at: Math.floor(Date.now() / 1000) } : s));
      }
      go({ view: "library" });
    } catch (e) {
      setError(String(e));
    }
  };

  const doExport = async (format: string) => {
    setError(null);
    try {
      const written = await exportSong({
        map_path: mapPath,
        formats: [format],
        title,
        artist: song?.artist ?? undefined,
      });
      setNotice(`wrote ${written.join(", ")}`);
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    }
  };

  if (mode === "loading") {
    return (
      <div className="page">
        <h1>{title}</h1>
        {error && <div className="error-banner">{error}</div>}
        <p className="muted">Loading timing map…</p>
      </div>
    );
  }

  if (mode === "edit" && map) {
    return (
      <FixEditor
        map={map}
        mapPath={mapPath}
        songId={songId}
        title={title}
        sources={sources}
        status={status}
        refreshStatus={refreshStatus}
        initialStage={editStage}
        onSaved={(m) => {
          setMap(m);
          if (song) setSong({ ...song, reviewed_at: Math.floor(Date.now() / 1000) });
        }}
        onPreview={() => {
          setPreviewScope("full");
          setMode("preview");
        }}
        onExit={(savedMap) => {
          if (savedMap) {
            setMap(savedMap);
            if (song) setSong({ ...song, reviewed_at: Math.floor(Date.now() / 1000) });
          }
          setMode("detail");
        }}
      />
    );
  }

  if (mode === "preview" && map) {
    return (
      <Preview
        map={map}
        mapPath={mapPath}
        title={title}
        sources={sources}
        initialScope={previewScope}
        onLooksGood={markReviewed}
        onSaved={(m) => setMap(m)}
        onPrecision={() => {
          setEditStage("timing");
          setMode("edit");
        }}
        onSkip={() => setMode("detail")}
      />
    );
  }

  // ---- detail ----
  const lines = map ? groupByLine(map.words) : [];
  return (
    <div className="page">
      <h1>{title}</h1>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}
      {map && (
        <>
          <p className="muted">
            {map.words.length} words · {fmtTime(map.duration)} ·{" "}
            {map.lyric_source === "transcribed" ? "auto-transcribed lyrics" : "pasted lyrics"}
            {map.unsung_spans.length > 0 &&
              ` · ${map.unsung_spans.length} unsung span${map.unsung_spans.length === 1 ? "" : "s"}`}
            {song?.reviewed_at != null && " · reviewed"}
          </p>
          {map.lyric_source === "transcribed" && song && (
            <PasteLyricsStrip song={song} onQueued={() => go({ view: "jobs" })} />
          )}
          <div className="actions">
            <button
              className="primary"
              onClick={() => go({ view: "play", songId, mapPath })}
              title="Full-screen karaoke player"
            >
              Sing it
            </button>
            <button
              onClick={() => {
                setPreviewScope("highlight");
                setMode("preview");
              }}
            >
              Preview again
            </button>
            <button
              onClick={() => {
                setEditStage("timing");
                setMode("edit");
              }}
              title="The editor — timings, words, and lines"
            >
              Fix words &amp; timings
            </button>
            {EXPORT_FORMATS.map((f) => (
              <ExportButton
                key={f}
                format={f}
                freshness={status ? exportFreshness(status, f) : "none"}
                onClick={() => doExport(f)}
              />
            ))}
          </div>
          <div className="word-lines">
            {lines.map((ln, i) => (
              <div className="word-line" key={i}>
                {ln.indices.map((wi) => {
                  const w = map.words[wi];
                  return (
                    <span
                      key={wi}
                      className={`word${w.unsung ? " unsung" : ""}${w.ad_lib ? " adlib" : ""}`}
                      title={`${fmtTime(w.start)} – ${fmtTime(w.end)} · confidence ${(w.confidence * 100).toFixed(0)}%${w.anchored ? " · anchored" : ""}`}
                    >
                      <span className="word-text">{w.word}</span>
                      <span className="word-time">{fmtTime(w.start)}</span>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// preview = the review bench (golden path step 4): the karaoke-style
// playback check — listen while the cue puck arcs onto each upcoming word
// so mistimings are visible before they are explainable. It keeps its lyric
// console (retype, shift, insert/delete, line shaping) for fixes made while
// listening; the timeline FixEditor is the main editor.

type EditFlow = "loop" | "pause" | "roll";
const EDIT_FLOW_KEY = "karascape.editFlow";
/** How the bench cues the active word: the arcing puck ("ball"), the amber
 *  wipe filling the word across its duration ("fill"), or both at once. */
type CueMode = "ball" | "fill" | "both";
const CUE_MODE_KEY = "karascape.previewCue";
type LineGroup = ReturnType<typeof groupByLine>[number];

const fmtOffset = (s: number) => `${s < 0 ? "-" : "+"}${Math.abs(s).toFixed(2)}`;

function Preview(props: {
  map: TimingMap;
  mapPath: string;
  title: string;
  sources: PlaybackSources | null;
  /** Range to open with; the user can switch inside the preview. */
  initialScope?: PreviewScope;
  onLooksGood: () => void;
  /** Parent keeps its map copy in sync after a bench save. */
  onSaved: (m: TimingMap) => void;
  onPrecision: () => void;
  onSkip: () => void;
}) {
  const { map, mapPath, sources } = props;
  const audio = useAudio();
  const [scope, setScope] = useState<PreviewScope>(props.initialScope ?? "highlight");
  const [srcKind, setSrcKind] = useState<SourceKind>(() =>
    sources?.instrumental ? "instrumental" : sources?.original ? "original" : "vocals",
  );
  // Vocal overlay level over the instrumental (0 = pure karaoke; 100%
  // recreates the original song exactly, since instrumental = mix − vocals).
  const [vocalPct, setVocalPct] = useState(0);
  // Position to restore after a source switch reloads the media element.
  const resumeRef = useRef<number | null>(null);
  const hl = useMemo(() => pickHighlightWindow(map.words, map.duration), [map]);
  const src = sources?.[srcKind] ?? null;

  // ---- bench state: the editable words live in the fix-editor reducer ----
  const [ed, dispatch] = useReducer(editorReducer, map, initEditor);
  const words = ed.words;
  const dirty = isDirty(ed);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [insertAfter, setInsertAfter] = useState<number | null>(null);
  const [insertDraft, setInsertDraft] = useState("");
  // whole-line sentence editing: {first,last} word indices of the line
  const [lineEdit, setLineEdit] = useState<{ first: number; last: number } | null>(null);
  const [lineDraft, setLineDraft] = useState("");
  const [shiftScope, setShiftScope] = useState<ShiftScope>("word");
  const [editFlow, setEditFlow] = useState<EditFlow>(() => {
    const v = localStorage.getItem(EDIT_FLOW_KEY);
    return v === "loop" || v === "roll" ? v : "pause";
  });
  const [cueMode, setCueMode] = useState<CueMode>(() => {
    const v = localStorage.getItem(CUE_MODE_KEY);
    return v === "ball" || v === "fill" ? v : "both";
  });
  const pickCueMode = (m: CueMode) => {
    setCueMode(m);
    try {
      localStorage.setItem(CUE_MODE_KEY, m);
    } catch {
      // storage unavailable — the toggle still works for this session
    }
  };
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [benchError, setBenchError] = useState<string | null>(null);
  // Baseline onset of the selected word — the shift readout shows the net
  // offset applied since selection (truthful through clamps and undo).
  const shiftBaseRef = useRef<number | null>(null);

  // Load the chosen source; playback (re)starts via the ready effect below.
  // Autoplay may be blocked pre-gesture — the overlay button covers that.
  useEffect(() => {
    if (!src) return;
    audio.load(convertFileSrc(src));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Vocal overlay: a synced second track, only over the instrumental. The
  // stem stays unloaded until the slider first leaves 0.
  useEffect(() => {
    const voc = sources?.vocals;
    if (srcKind === "instrumental" && voc && vocalPct > 0) {
      audio.setLayer(convertFileSrc(voc));
    } else {
      audio.setLayer(null);
    }
    audio.setLayerGain(vocalPct / 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKind, sources?.vocals, vocalPct]);

  // On (re)load or scope switch: aim the loop window and start playing.
  useEffect(() => {
    if (!audio.ready) return;
    audio.setLoop(scope === "highlight" ? hl : null);
    const resume = resumeRef.current;
    resumeRef.current = null;
    audio.seek(resume ?? (scope === "highlight" ? hl.start : 0));
    audio.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio.ready, scope]);

  useEffect(() => {
    shiftBaseRef.current = ed.selected != null ? (words[ed.selected]?.start ?? null) : null;
    // reset only when the selection itself moves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.selected]);
  const shiftOffset =
    ed.selected != null && shiftBaseRef.current != null
      ? (words[ed.selected]?.start ?? shiftBaseRef.current) - shiftBaseRef.current
      : 0;

  const range =
    scope === "highlight"
      ? hl
      : { start: 0, end: audio.duration || map.duration || hl.end };
  const rangeLen = Math.max(range.end - range.start, 0.001);
  const frac = Math.min(1, Math.max(0, (audio.time - range.start) / rangeLen));

  const active = wordIndexAt(words, audio.time);
  const sungThrough = sungThroughIndexAt(words, audio.time);
  const lines = useMemo(() => groupByLine(words), [words]);
  const lineIdx = useMemo(() => {
    if (active != null) return lines.findIndex((g) => g.indices.includes(active));
    const next = words.findIndex((w) => w.start > audio.time);
    if (next === -1) return lines.length - 1;
    return lines.findIndex((g) => g.indices.includes(next));
  }, [active, lines, words, audio.time]);
  const line = lines[Math.max(lineIdx, 0)];
  const prevLine = lineIdx > 0 ? lines[lineIdx - 1] : undefined;
  const nextLine = lines[Math.max(lineIdx, 0) + 1];

  // ---- edit-flow: what playback does the moment you start typing ----
  const enterEditFlow = (wi: number) => {
    if (editFlow === "pause") {
      audio.pause();
    } else if (editFlow === "loop") {
      const g = lines.find((l) => l.indices.includes(wi));
      if (g && g.indices.length > 0) {
        const first = words[g.indices[0]];
        const last = words[g.indices[g.indices.length - 1]];
        audio.setLoop({ start: Math.max(0, first.start - 0.3), end: last.end + 0.3 });
      }
    }
  };
  const exitEditFlow = () => {
    if (editFlow === "loop") audio.setLoop(scope === "highlight" ? hl : null);
  };
  const pickEditFlow = (f: EditFlow) => {
    setEditFlow(f);
    try {
      localStorage.setItem(EDIT_FLOW_KEY, f);
    } catch {
      // storage unavailable — the toggle still works for this session
    }
  };

  // ---- word actions ----
  const selectWord = (wi: number) => {
    dispatch({ type: "select", index: wi });
    if (audio.ready) audio.seek(words[wi].start);
  };
  const beginEdit = (wi: number) => {
    dispatch({ type: "select", index: wi });
    setInsertAfter(null);
    setEditing(wi);
    setDraft(words[wi].word);
    enterEditFlow(wi);
  };
  const commitEdit = () => {
    if (editing != null) dispatch({ type: "set-text", index: editing, text: draft });
    setEditing(null);
    exitEditFlow();
  };
  const cancelEdit = () => {
    setEditing(null);
    exitEditFlow();
  };
  const beginInsert = () => {
    if (ed.selected == null) return;
    setEditing(null);
    setInsertAfter(ed.selected);
    setInsertDraft("");
    enterEditFlow(ed.selected);
  };
  const commitInsert = () => {
    if (insertAfter != null && insertDraft.trim() !== "") {
      dispatch({ type: "insert-word", after: insertAfter, word: insertDraft });
    }
    setInsertAfter(null);
    setInsertDraft("");
    exitEditFlow();
  };
  const cancelInsert = () => {
    setInsertAfter(null);
    setInsertDraft("");
    exitEditFlow();
  };
  const deleteSelected = () => {
    if (ed.selected != null) dispatch({ type: "delete-word", index: ed.selected });
  };
  // ---- line actions ----
  const sel = ed.selected;
  const selGroupIdx = sel != null ? lines.findIndex((g) => g.indices.includes(sel)) : -1;
  const canBreak =
    ed.selected != null &&
    words[ed.selected]?.line != null &&
    selGroupIdx >= 0 &&
    lines[selGroupIdx].indices[0] !== ed.selected;
  const canJoin = ed.selected != null && words[ed.selected]?.line != null && selGroupIdx > 0;
  const beginLineEdit = () => {
    const gi = selGroupIdx >= 0 ? selGroupIdx : Math.max(lineIdx, 0);
    const g = lines[gi];
    if (!g || g.indices.length === 0) return;
    setEditing(null);
    setInsertAfter(null);
    setLineEdit({ first: g.indices[0], last: g.indices[g.indices.length - 1] });
    setLineDraft(g.indices.map((i) => words[i].word).join(" "));
    enterEditFlow(g.indices[0]);
  };
  const commitLineEdit = () => {
    if (lineEdit != null) {
      dispatch({ type: "set-line-text", first: lineEdit.first, last: lineEdit.last, text: lineDraft });
    }
    setLineEdit(null);
    exitEditFlow();
  };
  const cancelLineEdit = () => {
    setLineEdit(null);
    exitEditFlow();
  };
  const nudgeSelected = (dir: 1 | -1, coarse: boolean) => {
    if (ed.selected == null) return;
    const r = shiftRange(words, ed.selected, shiftScope);
    if (!r) return;
    dispatch({
      type: "nudge-range",
      first: r.first,
      last: r.last,
      deltaS: dir * (coarse ? NUDGE_COARSE_S : NUDGE_S),
    });
  };

  // ---- save & exits ----
  const save = async (): Promise<TimingMap | null> => {
    const m2 = mapFromEditor(map, words);
    try {
      await saveTimingMap(mapPath, m2);
      dispatch({ type: "mark-saved" });
      props.onSaved(m2);
      return m2;
    } catch (e) {
      setBenchError(String(e));
      return null;
    }
  };
  const looksGood = async () => {
    audio.pause();
    if (dirty && (await save()) == null) return;
    props.onLooksGood();
  };
  const openPrecision = async () => {
    audio.pause();
    if (dirty && (await save()) == null) return;
    props.onPrecision();
  };
  const skip = () => {
    if (dirty) setConfirmLeave(true);
    else {
      audio.pause();
      props.onSkip();
    }
  };

  // Bench keyboard: registered fresh each render so closures never go stale.
  // Inputs (the inline word editor included) are guarded out by tag.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        e.preventDefault();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        dispatch({ type: "redo" });
        e.preventDefault();
        return;
      }
      if (e.key === " ") {
        audio.toggle();
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const dir: 1 | -1 = e.key === "ArrowRight" ? 1 : -1;
        if (ed.selected != null) nudgeSelected(dir, e.shiftKey);
        else if (audio.ready)
          audio.seek(
            Math.max(range.start, Math.min(range.end, audio.time + dir * (e.shiftKey ? 30 : 5))),
          );
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && e.shiftKey) {
        beginLineEdit();
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && ed.selected != null) {
        beginEdit(ed.selected);
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" && ed.selected != null) {
        deleteSelected();
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") dispatch({ type: "select", index: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // If the word being edited scrolls out of the rendered lines (roll mode),
  // commit rather than lose the typed text.
  const renderedKey = `${prevLine?.indices.join()}|${line?.indices.join()}|${nextLine?.indices.join()}`;
  useEffect(() => {
    const rendered = new Set([
      ...(prevLine?.indices ?? []),
      ...(line?.indices ?? []),
      ...(nextLine?.indices ?? []),
    ]);
    if (editing != null && !rendered.has(editing)) commitEdit();
    if (insertAfter != null && !rendered.has(insertAfter)) commitInsert();
    if (lineEdit != null && !rendered.has(lineEdit.first)) commitLineEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedKey]);

  // ---- cue puck: positioned directly on the DOM after each render ----
  const linesRef = useRef<HTMLDivElement | null>(null);
  const puckRef = useRef<HTMLDivElement | null>(null);
  const wordRefs = useRef(new Map<number, HTMLSpanElement>());
  const setWordRef = (wi: number) => (el: HTMLSpanElement | null) => {
    if (el) wordRefs.current.set(wi, el);
    else wordRefs.current.delete(wi);
  };
  useLayoutEffect(() => {
    const puck = puckRef.current;
    const cont = linesRef.current;
    if (!puck || !cont) return;
    if (cueMode === "fill") {
      puck.style.opacity = "0";
      return;
    }
    const frame = puckFrameAt(words, audio.time);
    const contRect = cont.getBoundingClientRect();
    const centerOf = (i: number) => {
      const r = wordRefs.current.get(i)?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2 - contRect.left, y: r.top - contRect.top } : null;
    };
    let pos: { x: number; y: number } | null = null;
    if (frame.kind === "rest") {
      pos = centerOf(frame.index);
    } else if (frame.kind === "flight") {
      const to = centerOf(frame.to);
      if (to) {
        const from = (frame.from != null ? centerOf(frame.from) : null) ?? {
          x: to.x - 64,
          y: to.y,
        };
        const p = frame.progress;
        pos = {
          x: from.x + (to.x - from.x) * p,
          // the bounce: a sine arc lifting the hop between onsets
          y: from.y + (to.y - from.y) * p - Math.sin(Math.PI * p) * 18,
        };
      }
    }
    if (pos && audio.playing) {
      puck.style.opacity = "1";
      puck.style.transform = `translate(${pos.x - 4}px, ${pos.y - 14}px)`;
    } else {
      puck.style.opacity = "0";
    }
  });

  // ---- word / line rendering ----
  const wordInput = (
    key: string,
    value: string,
    setValue: (v: string) => void,
    commit: () => void,
    cancel: () => void,
    tabNext?: () => void,
  ) => (
    <input
      key={key}
      className="k-word-input"
      value={value}
      size={Math.max(value.length, 2)}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        } else if (e.key === "Tab" && tabNext) {
          e.preventDefault();
          tabNext();
        }
      }}
    />
  );

  const renderWord = (wi: number, kind: "prev" | "current" | "next") => {
    const w = words[wi];
    if (editing === wi) {
      return wordInput(`edit-${wi}`, draft, setDraft, commitEdit, cancelEdit, () => {
        commitEdit();
        if (wi + 1 < words.length) beginEdit(wi + 1);
      });
    }
    const sung =
      kind === "prev"
        ? true
        : kind === "current" &&
          (active != null ? wi < active : sungThrough != null && wi <= sungThrough);
    const isActive = kind === "current" && active === wi;
    // "ball" cue mode drops the wipe: the active word pops solid amber and
    // the puck alone carries the duration read.
    const wipe = isActive && cueMode !== "ball";
    const weak = !w.unsung && (!w.anchored || w.confidence < 0.5);
    return (
      <span
        key={wi}
        ref={setWordRef(wi)}
        className={`k-word${isActive ? " active" : ""}${wipe ? " wipe" : ""}${sung ? " sung" : ""}${w.unsung ? " unsung" : ""}${ed.selected === wi ? " selected" : ""}${weak ? " weak" : ""}`}
        style={
          wipe
            ? ({ "--wipe": `${(wipeFraction(w, audio.time) * 100).toFixed(1)}%` } as CSSProperties)
            : undefined
        }
        onClick={() => selectWord(wi)}
        onDoubleClick={() => beginEdit(wi)}
      >
        {w.word}
      </span>
    );
  };

  const renderLine = (g: LineGroup | undefined, kind: "prev" | "current" | "next") => {
    if (g && lineEdit != null && g.indices[0] === lineEdit.first) {
      return (
        <div className={`preview-line ${kind}`}>
          <input
            key="line-edit"
            className="k-word-input line-input"
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
                cancelLineEdit();
              }
            }}
          />
        </div>
      );
    }
    return (
      <div className={`preview-line ${kind}`}>
        {g?.indices.flatMap((wi) => {
          const out = [renderWord(wi, kind)];
          if (insertAfter === wi) {
            out.push(wordInput(`ins-${wi}`, insertDraft, setInsertDraft, commitInsert, cancelInsert));
          }
          return out;
        })}
      </div>
    );
  };

  const barClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!audio.ready) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.seek(range.start + f * rangeLen);
  };
  const barKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!audio.ready) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const step = (e.key === "ArrowLeft" ? -5 : 5) * (e.shiftKey ? 6 : 1);
      audio.seek(Math.min(range.end, Math.max(range.start, audio.time + step)));
      e.preventDefault();
      e.stopPropagation(); // the bench's global arrows must not also fire
    }
  };

  return (
    <div className="page preview-page">
      <h1>{props.title}</h1>
      {benchError && <div className="error-banner">{benchError}</div>}
      <p className="muted">
        {scope === "highlight"
          ? `Previewing the busiest ${Math.round(hl.end - hl.start)} seconds — click any word to fix it.`
          : "Playing the whole song — click any word to jump there and fix it."}
      </p>
      <div className="preview-stage">
        {!src && (
          <p className="muted">
            No playable audio found for this song (stems may have been moved) — you can still fix
            words and timings below.
          </p>
        )}
        {src && !audio.playing && (
          <button className="primary preview-play" onClick={() => audio.play()}>
            <IconPlay size={14} />
            {scope === "highlight" ? "Play preview" : "Play song"}
          </button>
        )}
        <div className="preview-lines" ref={linesRef}>
          <div className="preview-puck" ref={puckRef} aria-hidden />
          {renderLine(prevLine, "prev")}
          {renderLine(line, "current")}
          {renderLine(nextLine, "next")}
        </div>
        <div
          className="preview-timebar"
          role="slider"
          aria-label="Playback position"
          aria-valuemin={range.start}
          aria-valuemax={range.end}
          aria-valuenow={audio.time}
          tabIndex={src ? 0 : -1}
          onClick={barClick}
          onKeyDown={barKey}
          title="Click to seek · arrows ±5 s (Shift: ±30 s)"
        >
          <div className="preview-timebar-fill" style={{ width: `${frac * 100}%` }} />
        </div>
        <div className="preview-transport">
          <button onClick={() => audio.toggle()} disabled={!src}>
            {audio.playing ? "Pause" : "Play"}
          </button>
          <SegText
            className="preview-clock"
            value={`${fmtTime(audio.time)} / ${fmtTime(range.end)}`}
          />
          <span className="spacer" />
          <div className="scope-toggle" role="group" aria-label="How much of the song to play">
            <button
              className={scope === "highlight" ? "active" : ""}
              onClick={() => setScope("highlight")}
            >
              20 s highlight
            </button>
            <button className={scope === "full" ? "active" : ""} onClick={() => setScope("full")}>
              Full song
            </button>
          </div>
          <DashSelect
            ariaLabel="What to listen to"
            value={srcKind}
            onChange={(v) => {
              resumeRef.current = audio.time;
              setSrcKind(v);
            }}
            disabled={!sources}
            options={[
              ...(sources?.instrumental ? [{ value: "instrumental" as const, label: "Instrumental" }] : []),
              ...(sources?.original ? [{ value: "original" as const, label: "Original" }] : []),
              ...(sources?.vocals ? [{ value: "vocals" as const, label: "Vocals" }] : []),
            ]}
          />
          {srcKind === "instrumental" && sources?.vocals && (
            <div
              className="bench-module"
              title="Blend the vocal stem over the instrumental — 100% recreates the original song"
            >
              <span className="label">Vocals</span>
              <DashSlider
                ariaLabel="Vocal level in the preview"
                min={0}
                max={100}
                step={5}
                value={vocalPct}
                onChange={setVocalPct}
              />
              <SegText value={`${vocalPct}%`} />
            </div>
          )}
        </div>
        <div className="bench-row">
          <div className="bench-module" role="group" aria-label="Shift timing">
            <span className="label">Shift</span>
            <div className="scope-toggle">
              <button
                className={shiftScope === "word" ? "active" : ""}
                onClick={() => setShiftScope("word")}
              >
                Word
              </button>
              <button
                className={shiftScope === "line" ? "active" : ""}
                onClick={() => setShiftScope("line")}
              >
                Line
              </button>
              <button
                className={shiftScope === "tail" ? "active" : ""}
                onClick={() => setShiftScope("tail")}
                title="This word and everything after it"
              >
                From here
              </button>
            </div>
            <button
              className="bench-key"
              disabled={ed.selected == null}
              onClick={(e) => nudgeSelected(-1, e.shiftKey)}
              aria-label="Shift earlier"
              title="Earlier 10 ms (Shift-click: 100 ms)"
            >
              <IconBack size={12} />
            </button>
            <SegText className="bench-offset" value={fmtOffset(shiftOffset)} />
            <button
              className="bench-key bench-key-fwd"
              disabled={ed.selected == null}
              onClick={(e) => nudgeSelected(1, e.shiftKey)}
              aria-label="Shift later"
              title="Later 10 ms (Shift-click: 100 ms)"
            >
              <IconBack size={12} />
            </button>
          </div>
          <div className="bench-module" role="group" aria-label="Edit words">
            <button
              disabled={ed.selected == null}
              onClick={() => ed.selected != null && beginEdit(ed.selected)}
              title="Retype the selected word (Enter)"
            >
              Retype
            </button>
            <button
              disabled={ed.selected == null}
              onClick={beginInsert}
              title="Add a missed word after the selected one"
            >
              + Word
            </button>
            <button
              disabled={ed.selected == null}
              onClick={deleteSelected}
              title="Remove the selected word (Del)"
            >
              Remove
            </button>
            <button
              disabled={ed.past.length === 0}
              onClick={() => dispatch({ type: "undo" })}
              title="Undo (Ctrl+Z)"
            >
              Undo
            </button>
            <button
              disabled={ed.future.length === 0}
              onClick={() => dispatch({ type: "redo" })}
              title="Redo (Ctrl+Y)"
            >
              Redo
            </button>
          </div>
          <div className="bench-module" role="group" aria-label="Shape lines">
            <button
              onClick={beginLineEdit}
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
          <div className="bench-module" role="group" aria-label="How the active word is cued">
            <span className="label">Cue</span>
            <div className="scope-toggle">
              <button
                className={cueMode === "ball" ? "active" : ""}
                onClick={() => pickCueMode("ball")}
                title="The bouncing ball alone — the puck arcs onto each word"
              >
                Ball
              </button>
              <button
                className={cueMode === "fill" ? "active" : ""}
                onClick={() => pickCueMode("fill")}
                title="The word fills to its sung color across the note's length"
              >
                Fill
              </button>
              <button
                className={cueMode === "both" ? "active" : ""}
                onClick={() => pickCueMode("both")}
                title="Ball and fill together"
              >
                Both
              </button>
            </div>
          </div>
          <div className="bench-module" role="group" aria-label="While editing, playback should">
            <span className="label">On edit</span>
            <div className="scope-toggle">
              <button
                className={editFlow === "loop" ? "active" : ""}
                onClick={() => pickEditFlow("loop")}
                title="Loop the line while you type"
              >
                Loop line
              </button>
              <button
                className={editFlow === "pause" ? "active" : ""}
                onClick={() => pickEditFlow("pause")}
                title="Pause while you type"
              >
                Pause
              </button>
              <button
                className={editFlow === "roll" ? "active" : ""}
                onClick={() => pickEditFlow("roll")}
                title="Keep playing while you type"
              >
                Roll
              </button>
            </div>
          </div>
        </div>
      </div>
      <p className="preview-hints muted small">
        Click a word to jump · double-click to retype · Shift+Enter edit the whole line · Tab next
        word · ←/→ shift the selection (Shift: ×10) · Del remove · Space play/pause · Ctrl+Z undo
      </p>
      {confirmLeave && (
        <ConfirmStrip
          message="Discard unsaved lyric fixes?"
          confirmLabel="Discard"
          onConfirm={() => {
            setConfirmLeave(false);
            audio.pause();
            props.onSkip();
          }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
      <div className="preview-actions">
        <button className="primary big" onClick={looksGood}>
          {dirty ? "Save fixes — looks good" : "Looks good"}
        </button>
        <button
          className="linkish"
          onClick={openPrecision}
          title="The main editor — drag timings on chip tracks, re-align, end-stretch"
        >
          Timeline editor
        </button>
        <button className="linkish" onClick={skip}>
          Skip to details
        </button>
      </div>
    </div>
  );
}
