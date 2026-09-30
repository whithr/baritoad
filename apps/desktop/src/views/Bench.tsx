// The bench: one song, lyrics on the audio. Three zoom levels of the same
// surface — Text (structure, no audio), Lanes (the default: one lane per
// line, words as chips under the vocal waveform), Focus (one line blown
// up, neighbours as thin strips, TV preview on top). Selection, scope,
// playhead and keys carry across all three.
//
// State is the tested editorState reducer (undo/redo/dirty, timing-map
// invariants); playback is the review-screen <audio> hook (original-song
// time — PLAN.md §5); waveforms are the vocal stem's peak envelope.
// Chrome is Karascape 98: every command sits in the menu bar; the toolbar,
// right-click menu and keys are shortcuts to it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  exportSong,
  librarySong,
  playbackSources,
  playerPause,
  readTimingMap,
  realignSelection,
  saveTimingMap,
  songSetReviewed,
  vocalLevels,
  type PlaybackSources,
  type Song,
  type TimingMap,
  type VocalLevels,
  type WordTiming,
} from "../api";
import type { Route } from "../App";
import { useSettings } from "../App";
import {
  doubtfulIndices,
  envelopeSamples,
  focusRange,
  isDoubtful,
  laneAtTime,
  laneGroups,
  laneOfWord,
  nextDoubtful,
  pxToSec,
  secToPx,
  stepView,
  wordAtCaret,
  type BenchView,
  type LaneGroup,
} from "../benchLayout";
import {
  editorReducer,
  initEditor,
  isDirty,
  mapFromEditor,
  NUDGE_COARSE_S,
  NUDGE_S,
} from "../editorState";
import { sungThroughIndexAt, wordIndexAt } from "../highlight";
import { shiftRange, type ShiftScope } from "../previewEditor";
import { fmtTime } from "../format";
import { onStage, openStage } from "../stage";
import { useAudio, type AudioController } from "../useAudio";
import {
  AppFrame,
  Button,
  ContextMenu,
  DropdownButton,
  Glyph,
  GroupBox,
  Hr,
  Icon,
  Lcd,
  LcdText,
  MenuBar,
  ProgressBar,
  RadioGroup,
  StatusBar,
  StatusPane,
  Tabs,
  ToolButton,
  Toolbar,
  Trackbar,
  Vr,
  isInOverlay,
  useAccelerators,
  useCloseGuard,
  useMessageBox,
  type MenuDef,
  type MenuEntry,
} from "../win98";
import "../win98/bench.css";

/** mm:ss and a tenths suffix for the LCD readouts. */
function fmtClock(s: number, tenths = true): { main: string; frac: string } {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const frac = Math.floor((t - Math.floor(t)) * 10);
  return {
    main: `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`,
    frac: tenths ? `.${frac}` : "",
  };
}

const EXPORTS: [string, string][] = [
  ["lrc", "&LRC lyrics"],
  ["ass", "&ASS subtitles"],
  ["ultrastar", "&UltraStar .txt"],
];

// Word chips are lyric text (Barlow 600): measure it rather than guess a
// per-glyph width, so a short sung span still gets a readable chip.
const measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
const measured = new Map<string, number>();
function textWidth(text: string, px: number): number {
  const key = `${px}|${text}`;
  const hit = measured.get(key);
  if (hit != null) return hit;
  if (!measureCtx) return text.length * px * 0.6;
  measureCtx.font = `600 ${px}px Barlow, "Segoe UI", sans-serif`;
  const w = measureCtx.measureText(text).width;
  if (measured.size > 4000) measured.clear();
  measured.set(key, w);
  return w;
}

const LOOP_PRE_S = 0.5;
const LOOP_POST_S = 0.3;
/** Floor on the listen-loop length: a sub-second loop on a short word comes
 *  around faster than a listener can place its onset. Extra length goes
 *  before the word — the run-up is what places it. */
const LOOP_MIN_S = 1.6;
const HEAR_PRE_S = 0.3;
const LINE_LOOP_PAD_S = 0.3;
const REALIGN_PAD_S = 1.0;
const VOCAL_GUIDE_KEY = "karascape.bench.vocalGuide";


interface Props {
  mapPath: string;
  title?: string;
  songId?: number;
  startAt?: number;
  go: (r: Route) => void;
}

/** The listen-loop around one word (held drag, key nudges): run-up before,
 *  tail after, never shorter than LOOP_MIN_S, clamped to the song. */
function loopWindow(w: { start: number; end: number }, duration: number): { start: number; end: number } {
  const end = Math.max(w.end, w.start) + LOOP_POST_S;
  const start = Math.min(w.start - LOOP_PRE_S, end - LOOP_MIN_S);
  return { start: Math.max(0, start), end: Math.min(duration, end) };
}

/** Shortest a stretched word may get (a chip must keep a draggable body). */
const MIN_WORD_S = 0.05;

/** A word's end after a stretch of `deltaS`: never before its start plus
 *  MIN_WORD_S, never past the next word's onset (sung words do not overlap). */
function stretchedEnd(words: { start: number; end: number }[], i: number, duration: number, deltaS: number): number {
  const w = words[i];
  const floor = w.start + MIN_WORD_S;
  const cap = Math.max(i < words.length - 1 ? words[i + 1].start : duration, floor);
  return Math.min(Math.max(w.end + deltaS, floor), cap);
}

interface DragState {
  index: number;
  first: number;
  last: number;
  /** "move" shifts the word; "stretch" (grabbed by the right-edge handle)
   *  moves only the word's end. */
  mode: "move" | "stretch";
  deltaS: number;
  lane: number;
  startX: number;
  moved: boolean;
}

export default function Bench(props: Props) {
  const { mapPath, songId } = props;
  const [map, setMap] = useState<TimingMap | null>(null);
  const [song, setSong] = useState<Song | null>(null);
  const [sources, setSources] = useState<PlaybackSources | null>(null);
  const [levels, setLevels] = useState<VocalLevels | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, s, src] = await Promise.all([
          readTimingMap(mapPath),
          songId != null ? librarySong(songId) : Promise.resolve(null),
          playbackSources({ songId, mapPath }),
        ]);
        if (!alive) return;
        setMap(m);
        setSong(s);
        setSources(src);
        if (src.vocals) {
          vocalLevels(src.vocals).then((l) => alive && setLevels(l)).catch(() => undefined);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [mapPath, songId]);


  if (error || !map || !sources) {
    const title = props.title ?? "Song";
    return (
      <AppFrame title={`${title} - Karascape Bench`} icon={<Icon name="app" />}>
        <div style={{ flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <GroupBox label={error ? "Couldn't open this song" : "Opening"} style={{ width: 420 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, lineHeight: "18px" }}>
              {error ? (
                <div style={{ display: "flex", gap: 12 }}>
                  <Icon name="error" size={32} />
                  <div style={{ userSelect: "text" }}>{error}</div>
                </div>
              ) : (
                <>
                  <div>Loading {title}…</div>
                  <ProgressBar value={null} label="Loading" />
                </>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button isDefault={!!error} onClick={() => props.go({ view: "home" })}>
                  Back to &Library
                </Button>
              </div>
            </div>
          </GroupBox>
        </div>
      </AppFrame>
    );
  }
  return <BenchEditor {...props} map={map} song={song} sources={sources} levels={levels} />;
}


function BenchEditor(props: Props & { map: TimingMap; song: Song | null; sources: PlaybackSources; levels: VocalLevels | null }) {
  const { mapPath, songId, go, map, song, sources, levels } = props;
  const { settings, update } = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<BenchView>(settings.benchView);
  const [scope, setScope] = useState<ShiftScope>(settings.shiftScope);
  const [state, dispatch] = useReducer(editorReducer, map, initEditor);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [lineLoop, setLineLoop] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [guide, setGuide] = useState<number>(() => {
    const raw = localStorage.getItem(VOCAL_GUIDE_KEY);
    const v = raw ? Number(raw) : 0.4;
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.4;
  });
  const audio = useAudio();
  const stopAt = useRef<number | null>(null);
  const loadedOnce = useRef(false);

  const words = state.words;
  const duration = map.duration;
  const dirty = isDirty(state);

  // ---- audio: instrumental (or original) under the vocal stem at guide level
  // Depend on the hook's stable callbacks, never on the `audio` object: it is
  // rebuilt every render, and while playing the bench renders every frame —
  // keyed on it, these effects re-ran per frame, and each run re-snapped the
  // vocal layer's currentTime onto the instrumental (a seek ~80×/s that left
  // the stem perpetually re-buffering — audible as static on the vocal).
  const {
    load: audioLoad,
    setLayer: audioSetLayer,
    setLayerGain: audioSetLayerGain,
    seek: audioSeek,
    play: audioPlay,
    pause: audioPause,
    setLoop: audioSetLoop,
  } = audio;
  useEffect(() => {
    const main = sources.instrumental ?? sources.original ?? sources.vocals;
    if (main && audio.src !== convertFileSrc(main)) audioLoad(convertFileSrc(main));
    if (sources.vocals && sources.instrumental) audioSetLayer(convertFileSrc(sources.vocals));
  }, [sources, audio.src, audioLoad, audioSetLayer]);
  useEffect(() => {
    audioSetLayerGain(guide);
    localStorage.setItem(VOCAL_GUIDE_KEY, String(guide));
  }, [guide, audioSetLayerGain]);
  useEffect(() => {
    if (audio.ready && !loadedOnce.current) {
      loadedOnce.current = true;
      if (props.startAt != null) audioSeek(props.startAt);
    }
  }, [audio.ready, audioSeek, props.startAt]);
  // "hear once" stop point
  useEffect(() => {
    if (stopAt.current != null && audio.time >= stopAt.current) {
      stopAt.current = null;
      audioPause();
    }
  }, [audio.time, audioPause]);

  const playOnce = useCallback(
    (start: number, end: number) => {
      stopAt.current = Math.min(end, duration || end);
      audioSetLoop(null);
      setLineLoop(false);
      audioSeek(Math.max(0, start));
      audioPlay();
    },
    [audioSetLoop, audioSeek, audioPlay, duration],
  );

  // ---- derived
  const lanes = useMemo(() => laneGroups(words, duration), [words, duration]);
  const selected = state.selected;
  const selLane = selected != null ? laneOfWord(lanes, selected) : -1;
  const range = useMemo(
    () => (selected != null ? shiftRange(words, selected, scope) : null),
    [words, selected, scope],
  );
  const doubts = useMemo(() => doubtfulIndices(words), [words]);
  const playLane = laneAtTime(lanes, words, audio.time);
  const sungThrough = sungThroughIndexAt(words, audio.time);
  const nowWord = wordIndexAt(words, audio.time);

  // Line loop follows the selected lane. (Keyed on the stable setLoop, not
  // `audio`: with the per-render object as a dep, setLoop's fresh window
  // object re-rendered the bench, which re-ran this effect — a spin.)
  useEffect(() => {
    if (!lineLoop || selLane < 0) {
      if (!drag) audioSetLoop(null);
      return;
    }
    const l = lanes[selLane];
    const a = words[l.indices[0]].start - LINE_LOOP_PAD_S;
    const b = Math.max(words[l.indices[l.indices.length - 1]].end, a) + LINE_LOOP_PAD_S;
    audioSetLoop({ start: Math.max(0, a), end: Math.min(duration, b) });
  }, [lineLoop, selLane, lanes, words, duration, audioSetLoop, drag]);

  // ---- persist view / scope choices
  useEffect(() => {
    if (view !== settings.benchView) update({ benchView: view });
  }, [view, settings.benchView, update]);
  useEffect(() => {
    if (scope !== settings.shiftScope) update({ shiftScope: scope });
  }, [scope, settings.shiftScope, update]);

  // ---- actions
  const select = useCallback(
    (i: number | null, seek = true) => {
      dispatch({ type: "select", index: i });
      if (i != null && seek && !audio.playing) audio.seek(Math.max(0, words[i].start - 0.05));
    },
    [audio, words],
  );

  const nudge = useCallback(
    (dir: -1 | 1, coarse: boolean) => {
      if (!range) return;
      dispatch({
        type: "nudge-range",
        first: range.first,
        last: range.last,
        deltaS: dir * (coarse ? NUDGE_COARSE_S : NUDGE_S),
      });
      // Nudging is also listening: keep the word looping while keys repeat.
      const w = words[range.first];
      if (w) {
        audio.setLoop(loopWindow(w, duration));
        if (!audio.playing) audio.play();
        window.clearTimeout(nudgeTimer.current);
        nudgeTimer.current = window.setTimeout(() => {
          audio.setLoop(null);
          audio.pause();
        }, 900);
      }
    },
    [range, words, audio, duration],
  );
  const nudgeTimer = useRef(0);

  // Click on a lane's background: play from there (DESIGN.md timing tools).
  // Leaves any loop in place; clears a pending "hear once" stop.
  const seekPlay = useCallback(
    (t: number) => {
      stopAt.current = null;
      audioSeek(Math.max(0, Math.min(duration, t)));
      audioPlay();
    },
    [audioSeek, audioPlay, duration],
  );

  const hearWord = useCallback(
    (i: number) => {
      const w = words[i];
      if (!w) return;
      playOnce(w.start - HEAR_PRE_S, Math.max(w.end, w.start) + LOOP_POST_S);
    },
    [words, playOnce],
  );

  const hearLine = useCallback(
    (k: number) => {
      const l = lanes[k];
      if (!l) return;
      const a = words[l.indices[0]].start - LINE_LOOP_PAD_S;
      const b = Math.max(words[l.indices[l.indices.length - 1]].end, a) + LINE_LOOP_PAD_S;
      playOnce(a, b);
    },
    [lanes, words, playOnce],
  );

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await saveTimingMap(mapPath, mapFromEditor(map, words));
      dispatch({ type: "mark-saved" });
      if (songId != null) await songSetReviewed(songId, true);
      setNotice("Saved");
      window.setTimeout(() => setNotice(null), 1500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [map, saving, mapPath, words, songId]);

  const realignLane = useCallback(
    async (k: number) => {
      const l = lanes[k];
      if (!l || !sources.vocals) return;
      const first = l.indices[0];
      const last = l.indices[l.indices.length - 1];
      const prevEnd = first > 0 ? Math.max(words[first - 1].end, words[first - 1].start) : 0;
      const nextStart = last < words.length - 1 ? words[last + 1].start : duration;
      const windowStart = Math.max(prevEnd, words[first].start - REALIGN_PAD_S, 0);
      const windowEnd = Math.min(nextStart, Math.max(words[last].end, words[last].start) + REALIGN_PAD_S, duration);
      setBusy("Re-aligning…");
      try {
        const timings = await realignSelection({
          vocals_path: sources.vocals,
          window_start: windowStart,
          window_end: windowEnd,
          words: l.indices.map((i) => words[i].word),
        });
        dispatch({ type: "apply-realign", first, last, timings });
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [lanes, sources, words, duration],
  );

  const doExport = useCallback(
    async (format: string) => {
      setBusy(`Exporting ${format}…`);
      try {
        if (dirty) await save();
        const paths = await exportSong({
          map_path: mapPath,
          formats: [format],
          title: song?.title ?? props.title,
          artist: song?.artist ?? undefined,
        });
        setNotice(`Exported ${paths.length} file${paths.length === 1 ? "" : "s"}`);
        window.setTimeout(() => setNotice(null), 2500);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [dirty, save, mapPath, song, props.title],
  );

  // ---- drag (direct manipulation, loop while held, replay once on release)
  const laneWidth = useRef<Record<number, number>>({});
  const onWordDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, index: number, laneIdx: number) => {
      if (e.button !== 0 || editing != null) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      // Drag moves the word you grabbed (DESIGN.md bench chips). The Shift
      // scope (word / line / from here) governs the keyboard nudges only —
      // a line-scoped drag read as "I can't move a single word".
      dispatch({ type: "select", index });
      // The right-edge handle (<=7px, a third of a narrow chip) stretches the
      // end; the rest of the chip moves the word (DESIGN.md bench chips).
      const rect = e.currentTarget.getBoundingClientRect();
      const mode = e.clientX >= rect.right - Math.min(7, rect.width / 3) ? "stretch" : "move";
      setDrag({ index, first: index, last: index, mode, deltaS: 0, lane: laneIdx, startX: e.clientX, moved: false });
      const loop = loopWindow(words[index], duration);
      audio.setLoop(loop);
      audio.seek(loop.start);
      audio.play();
    },
    [words, audio, duration, editing],
  );
  const onWordMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!drag) return;
      const width = laneWidth.current[drag.lane] ?? 1;
      const dx = e.clientX - drag.startX;
      const deltaS = pxToSec(dx, lanes[drag.lane], width);
      setDrag((d) => (d ? { ...d, deltaS, moved: d.moved || Math.abs(dx) > 2 } : d));
    },
    [drag, lanes],
  );
  const onWordUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!drag) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      audio.setLoop(null);
      const d = drag;
      setDrag(null);
      if (d.moved && d.mode === "stretch") {
        const w = words[d.index];
        const end = stretchedEnd(words, d.index, duration, d.deltaS);
        dispatch({ type: "commit-drag", index: d.index, start: w.start, end });
        playOnce(w.start - LOOP_PRE_S, end + LOOP_POST_S);
      } else if (d.moved) {
        dispatch({ type: "nudge-range", first: d.first, last: d.last, deltaS: d.deltaS });
        const w = words[d.index];
        const start = w.start + d.deltaS;
        playOnce(start - LOOP_PRE_S, Math.max(w.end + d.deltaS, start) + LOOP_POST_S);
      } else {
        audio.pause();
        audio.seek(Math.max(0, words[d.index].start - 0.05));
      }
    },
    [drag, audio, words, duration, playOnce],
  );

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Menus and dialogs own the keyboard while open; arrows belong to a
      // focused tab strip, radio group or trackbar.
      if (isInOverlay()) return;
      const t0 = e.target instanceof Element ? e.target : null;
      if (e.key.startsWith("Arrow") && t0?.closest('[role="tablist"], [role="radiogroup"], [role="slider"], [role="spinbutton"]')) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void save();
        return;
      }
      if (typing) return;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        dispatch({ type: "redo" });
        return;
      }
      if (mod) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          stopAt.current = null;
          audio.toggle();
          return;
        case "1":
          setScope("word");
          return;
        case "2":
          setScope("line");
          return;
        case "3":
          setScope("tail");
          return;
        case "-":
        case "_":
          setView((v) => stepView(v, -1));
          return;
        case "=":
        case "+":
          setView((v) => stepView(v, 1));
          return;
        case "z":
          dispatch({ type: "undo" });
          return;
        case "Z":
          dispatch({ type: "redo" });
          return;
        case "Escape":
          if (editing != null) setEditing(null);
          else select(null);
          return;
        case "n":
        case "N": {
          const i = nextDoubtful(words, selected);
          if (i != null) select(i);
          return;
        }
        case "l":
        case "L":
          setLineLoop((v) => !v);
          if (!audio.playing) audio.play();
          return;
        case "F2":
          if (selected != null && view !== "text") {
            e.preventDefault();
            setEditing(selected);
          }
          return;
        case "u":
        case "U":
          if (selected != null) dispatch({ type: "toggle-unsung", index: selected });
          return;
        case "Delete":
        case "Backspace":
          if (selected != null && view !== "text") {
            e.preventDefault();
            dispatch({ type: "delete-word", index: selected });
          }
          return;
        default:
          break;
      }
      if (view === "text") return; // the text view has its own line keys
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          if (selected != null) nudge(-1, e.shiftKey);
          else audio.seek(Math.max(0, audio.time - (e.shiftKey ? 30 : 5)));
          return;
        case "ArrowRight":
          e.preventDefault();
          if (selected != null) nudge(1, e.shiftKey);
          else audio.seek(Math.min(duration, audio.time + (e.shiftKey ? 30 : 5)));
          return;
        case "Tab": {
          e.preventDefault();
          if (words.length === 0) return;
          const i = selected == null ? (e.shiftKey ? words.length - 1 : 0) : (selected + (e.shiftKey ? -1 : 1) + words.length) % words.length;
          select(i);
          return;
        }
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          if (lanes.length === 0) return;
          const cur = selLane >= 0 ? selLane : playLane >= 0 ? playLane : 0;
          const k = Math.min(lanes.length - 1, Math.max(0, cur + (e.key === "ArrowDown" ? 1 : -1)));
          select(lanes[k].indices[0]);
          return;
        }
        case "Enter":
          e.preventDefault();
          if (selected != null) hearWord(selected);
          else if (playLane >= 0) hearLine(playLane);
          return;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [audio, duration, editing, hearLine, hearWord, lanes, nudge, playLane, save, selLane, select, selected, view, words]);

  // ---- leaving: 98-style "Save changes?" on every way out (Close, the
  // Library button, Alt+F4 / caption X via the window's close guard)
  const ask = useMessageBox();
  const [reviewed, setReviewed] = useState(song?.reviewed_at != null);
  const title = song?.title ?? props.title ?? "Untitled";
  const saveAndCheck = useCallback(async () => {
    await save();
    if (songId != null) setReviewed(true);
  }, [save, songId]);
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    const r = await ask({
      kind: "warning",
      title: "Karascape Bench",
      message: (
        <>
          Save changes to <b>{title}</b>?
        </>
      ),
      detail: "Your timing edits haven't been saved yet.",
      buttons: [
        { id: "yes", label: "&Yes", isDefault: true },
        { id: "no", label: "&No" },
        { id: "cancel", label: "Cancel", cancel: true },
      ],
    });
    if (r === "cancel") return false;
    if (r === "yes") await save();
    return true;
  }, [dirty, ask, save, title]);
  useCloseGuard(dirty ? confirmLeave : null);

  const exit = useCallback(async () => {
    if (await confirmLeave()) go({ view: "home" });
  }, [confirmLeave, go]);

  // Sing on TV opens (or reuses) the Stage window; the Bench stays here.
  // Bench audio and the stage never play over each other.
  const [stageOpen, setStageOpen] = useState(false);
  const singOnTv = useCallback(async () => {
    audioPause();
    if (dirty) await save();
    const opened = await openStage({ song_id: songId ?? null, map_path: mapPath });
    if (!opened) go({ view: "play", songId, mapPath });
  }, [audioPause, dirty, save, go, songId, mapPath]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onStage((e) => {
      if (e.kind === "closed") setStageOpen(false);
      else {
        setStageOpen(true);
        audioPause();
      }
    })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [audioPause]);
  useEffect(() => {
    if (stageOpen && audio.playing) playerPause().catch(() => undefined);
  }, [stageOpen, audio.playing]);

  const markChecked = useCallback(async () => {
    if (songId == null) return;
    try {
      await songSetReviewed(songId, true);
      setReviewed(true);
      setNotice("Marked as checked");
      window.setTimeout(() => setNotice(null), 2000);
    } catch (e) {
      setError(String(e));
    }
  }, [songId]);

  // ---- commands (menus, right-click, accelerators)
  const hasSel = selected != null;
  const selWord = hasSel ? words[selected] : null;
  const onLanes = view !== "text";
  const togglePlay = () => {
    stopAt.current = null;
    audio.toggle();
  };
  const toggleLoop = () => {
    setLineLoop((v) => !v);
    if (!audio.playing) audio.play();
  };
  const exportItems: MenuEntry[] = EXPORTS.map(([f, label]) => ({ label, run: () => void doExport(f) }));
  const wordCommands = {
    hear: { label: "&Hear word", accel: "Enter", run: () => hasSel && hearWord(selected), disabled: !hasSel },
    edit: { label: "&Edit word", accel: "F2", run: () => hasSel && setEditing(selected), disabled: !hasSel || !onLanes },
    unsung: {
      label: "Toggle un&sung",
      accel: "U",
      run: () => hasSel && dispatch({ type: "toggle-unsung", index: selected }),
      disabled: !hasSel,
    },
    del: {
      label: "&Delete word",
      accel: "Del",
      run: () => hasSel && dispatch({ type: "delete-word", index: selected }),
      disabled: !hasSel || !onLanes,
    },
    hearLine: { label: "Hear &line", run: () => selLane >= 0 && hearLine(selLane), disabled: selLane < 0 },
    realign: {
      label: "&Re-align line",
      run: () => selLane >= 0 && void realignLane(selLane),
      disabled: selLane < 0 || !sources.vocals,
    },
  };
  const menus: MenuDef[] = [
    {
      label: "&File",
      items: [
        { label: "&Save", accel: "Ctrl+S", run: () => void saveAndCheck(), disabled: saving },
        { label: "&Export", items: exportItems },
        "-",
        { label: "Sing on &TV", accel: "F5", keys: "f5", run: () => void singOnTv() },
        "-",
        { label: "&Close", accel: "Ctrl+W", keys: "ctrl+w", run: () => void exit() },
      ],
    },
    {
      label: "&Edit",
      items: [
        { label: "&Undo", accel: "Ctrl+Z", run: () => dispatch({ type: "undo" }), disabled: state.past.length === 0 },
        { label: "&Redo", accel: "Ctrl+Y", run: () => dispatch({ type: "redo" }), disabled: state.future.length === 0 },
        "-",
        wordCommands.edit,
        wordCommands.del,
        wordCommands.unsung,
      ],
    },
    {
      label: "&View",
      items: [
        { label: "&Text", accel: "−", checked: view === "text", radio: true, run: () => setView("text") },
        { label: "&Lanes", checked: view === "lanes", radio: true, run: () => setView("lanes") },
        { label: "&Focus", accel: "+", checked: view === "focus", radio: true, run: () => setView("focus") },
      ],
    },
    {
      label: "&Play",
      items: [
        { label: audio.playing ? "&Pause" : "&Play", accel: "Space", run: togglePlay },
        {
          label: "&Hear selection",
          accel: "Enter",
          run: () => (hasSel ? hearWord(selected) : playLane >= 0 && hearLine(playLane)),
          disabled: !hasSel && playLane < 0,
        },
        wordCommands.hearLine,
        { label: "&Loop line", accel: "L", checked: lineLoop, run: toggleLoop },
        "-",
        { label: "&Back 5 seconds", accel: hasSel ? undefined : "←", run: () => audio.seek(Math.max(0, audio.time - 5)) },
        { label: "&Forward 5 seconds", accel: hasSel ? undefined : "→", run: () => audio.seek(Math.min(duration, audio.time + 5)) },
      ],
    },
    {
      label: "&Timing",
      items: [
        {
          label: "&Scope",
          items: [
            { label: "&Word", accel: "1", checked: scope === "word", radio: true, run: () => setScope("word") },
            { label: "&Line", accel: "2", checked: scope === "line", radio: true, run: () => setScope("line") },
            { label: "From &here on", accel: "3", checked: scope === "tail", radio: true, run: () => setScope("tail") },
          ],
        },
        { label: "Nudge &earlier", accel: "←", run: () => nudge(-1, false), disabled: !hasSel || !onLanes },
        { label: "Nudge &later", accel: "→", run: () => nudge(1, false), disabled: !hasSel || !onLanes },
        { label: "Nudge earlier by 100 ms", accel: "Shift+←", run: () => nudge(-1, true), disabled: !hasSel || !onLanes },
        { label: "Nudge later by 100 ms", accel: "Shift+→", run: () => nudge(1, true), disabled: !hasSel || !onLanes },
        "-",
        {
          label: "&Next word to check",
          accel: "N",
          run: () => {
            const i = nextDoubtful(words, selected);
            if (i != null) select(i);
          },
          disabled: doubts.length === 0,
        },
        wordCommands.realign,
        { label: "Re&flow lines to fit the TV", run: () => dispatch({ type: "reflow-lines" }) },
        "-",
        { label: "&Mark as checked", run: () => void markChecked(), disabled: songId == null || (reviewed && !dirty) },
      ],
    },
    {
      label: "&Help",
      items: [{ label: "&Keyboard Shortcuts", accel: "F1", keys: "f1", run: () => void showKeys() }],
    },
  ];
  useAccelerators(menus);
  const wordMenu: MenuEntry[] = [
    wordCommands.hear,
    wordCommands.edit,
    wordCommands.unsung,
    wordCommands.del,
    "-",
    wordCommands.hearLine,
    wordCommands.realign,
  ];

  const showKeys = () =>
    ask({
      kind: "info",
      title: "Keyboard Shortcuts",
      message: "Bench",
      detail: (
        <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: "2px 12px" }}>
          {(
            [
              ["Space", "Play / pause"],
              ["↑ ↓", "Previous / next line"],
              ["Tab", "Next word (Shift+Tab back)"],
              ["← →", "Nudge 10 ms (Shift: 100 ms); seek 5 s with nothing selected"],
              ["1 2 3", "Scope: word / line / from here on"],
              ["Enter", "Hear the selected word"],
              ["L", "Loop the line"],
              ["N", "Next word to check"],
              ["F2", "Edit the word"],
              ["U", "Toggle unsung"],
              ["Del", "Delete the word"],
              ["− +", "Text / Lanes / Focus"],
              ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
              ["Ctrl+S", "Save"],
              ["F5", "Sing on TV"],
            ] as [string, string][]
          ).map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <span>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      ),
    });

  // ---- render
  const clock = fmtClock(audio.time);
  const total = fmtClock(duration, false);
  const deltaS = drag?.moved ? drag.deltaS : null;

  const laneProps = {
    words,
    levels,
    selected,
    range,
    drag,
    editing,
    setEditing,
    dispatch,
    sungThrough,
    nowWord,
    time: audio.time,
    playLane,
    duration,
    loop: audio.loop,
    onWordDown,
    onWordMove,
    onWordUp,
    onHearLine: hearLine,
    onSeekPlay: seekPlay,
    onRealign: realignLane,
    laneWidth,
    select,
  };

  const hints =
    view === "text"
      ? "↑↓ Line · Enter Break / play · Backspace Join up · Space Play · N Next to check · + Lanes"
      : "Space Play · ↑↓ Line · Tab Word · 1 2 3 Scope · ←→ Nudge · Enter Hear · L Loop · N Next to check · F2 Edit";

  return (
    <AppFrame title={`${title} - Karascape Bench`} icon={<Icon name="app" />}>
      <MenuBar menus={menus} />
      <Hr />
      <Toolbar label="Bench">
        <ToolButton icon={<Glyph name="left" />} onClick={() => void exit()} tip="Back to the Library (Ctrl+W)">
          Library
        </ToolButton>
        <ToolButton icon={<Icon name="floppy" />} onClick={() => void saveAndCheck()} disabled={!dirty || saving} tip="Save (Ctrl+S)">
          Save
        </ToolButton>
        <Vr />
        <Lcd label="Playback position" style={{ margin: "0 4px" }}>
          <LcdText value={`${clock.main}${clock.frac}`} size={19} />
          <span className="w-lcd-sep">/</span>
          <LcdText value={total.main} size={13} dim />
        </Lcd>
        <Button size="sq" onClick={() => audio.seek(Math.max(0, audio.time - 5))} aria-label="Back 5 seconds" tip="Back 5 seconds">
          <Glyph name="prev" />
        </Button>
        <Button size="sq" onClick={togglePlay} aria-label={audio.playing ? "Pause" : "Play"} tip="Play / pause (Space)">
          <Glyph name={audio.playing ? "pause" : "play"} />
        </Button>
        <Button size="sq" onClick={() => audio.seek(Math.min(duration, audio.time + 5))} aria-label="Forward 5 seconds" tip="Forward 5 seconds">
          <Glyph name="next" />
        </Button>
        <Button size="tall" slim on={lineLoop} onClick={() => setLineLoop((v) => !v)} tip="Loop the selected line (L)">
          Loop line
        </Button>
        <Vr />
        <span style={{ whiteSpace: "nowrap" }}>Vocal guide</span>
        <Trackbar
          value={guide}
          onChange={setGuide}
          min={0}
          max={1}
          step={0.05}
          ariaLabel="Vocal guide"
          ticks={6}
          width={130}
          valueText={`${Math.round(guide * 100)}%`}
        />
        <span style={{ width: 36 }}>{Math.round(guide * 100)}%</span>
        <span className="w-grow" />
        <DropdownButton className="w-btn tall" items={exportItems} ariaLabel="Export">
          <Icon name="floppy" />
          Export
        </DropdownButton>
        <Button isDefault size="tall" icon={<Icon name="tv" />} onClick={() => void singOnTv()} tip="Sing on the TV (F5)">
          Sing on TV
        </Button>
      </Toolbar>
      <Hr />

      {error && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 4px 0" }} role="alert">
          <Icon name="error" />
          <span className="w-grow" style={{ userSelect: "text" }}>
            {error}
          </span>
          <Button slim onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <div style={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "8px 2px 2px" }}>
        <Tabs
          ariaLabel="Bench view"
          value={view}
          onChange={setView}
          tabs={[
            { value: "text", label: "Text" },
            { value: "lanes", label: "Lanes" },
            { value: "focus", label: "Focus" },
          ]}
          className="w-grow"
          panelStyle={{ flexGrow: 1, display: "flex", flexDirection: "column", padding: 8, minHeight: 0 }}
          aside={
            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 5 }}>
              <span>Shift:</span>
              <RadioGroup
                ariaLabel="Shift scope"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "word", label: "Word" },
                  { value: "line", label: "Line" },
                  { value: "tail", label: "From here on" },
                ]}
              />
              <Vr style={{ height: 22 }} />
              <Button slim onClick={() => nudge(-1, false)} disabled={!hasSel || !onLanes} tip="Nudge earlier (←)">
                « 10 ms
              </Button>
              <Button slim onClick={() => nudge(1, false)} disabled={!hasSel || !onLanes} tip="Nudge later (→)">
                10 ms »
              </Button>
              <Vr style={{ height: 22 }} />
              <Button slim onClick={() => dispatch({ type: "undo" })} disabled={state.past.length === 0} tip="Undo (Ctrl+Z)">
                Undo
              </Button>
              <Button slim onClick={() => dispatch({ type: "redo" })} disabled={state.future.length === 0} tip="Redo (Ctrl+Y)">
                Redo
              </Button>
            </div>
          }
        >
          <div className="b-body">
            {view === "lanes" && (
              <>
                <Overview levels={levels} duration={duration} time={audio.time} words={words} doubts={doubts} loop={audio.loop} onSeek={(t) => audio.seek(t)} />
                <ContextMenu items={wordMenu} className="b-scroll">
                  {lanes.map((l, k) => (
                    <Lane key={l.line ?? `run-${l.indices[0]}`} lane={l} index={k} size={k === selLane ? "focus" : "normal"} {...laneProps} />
                  ))}
                  {lanes.length === 0 && <div className="w-list-empty">No timed words in this map yet.</div>}
                </ContextMenu>
              </>
            )}
            {view === "focus" && (
              <FocusView
                lanes={lanes}
                selLane={selLane >= 0 ? selLane : Math.max(0, playLane)}
                laneProps={laneProps}
                onSelectLane={(k) => select(lanes[k].indices[0])}
                onHearLine={hearLine}
                onRealign={realignLane}
                lineLoop={lineLoop}
                setLineLoop={setLineLoop}
                audio={audio}
                wordMenu={wordMenu}
              >
                <Overview levels={levels} duration={duration} time={audio.time} words={words} doubts={doubts} loop={audio.loop} onSeek={(t) => audio.seek(t)} />
              </FocusView>
            )}
            {view === "text" && (
              <TextView lanes={lanes} words={words} selLane={selLane} dispatch={dispatch} select={select} onHearLine={hearLine} onRealign={realignLane} onZoom={() => setView("lanes")} />
            )}
          </div>
        </Tabs>
      </div>

      <StatusBar>
        <StatusPane width={120}>{selLane >= 0 ? `Line ${selLane + 1} of ${lanes.length}` : `${lanes.length} lines`}</StatusPane>
        <StatusPane width={250}>
          {deltaS != null
            ? `Shifting ${deltaS >= 0 ? "+" : "−"}${Math.abs(deltaS).toFixed(3)} s${range ? ` · ${range.last - range.first + 1} moving` : ""}`
            : selWord
              ? `“${selWord.word}” ${fmtTime(selWord.start)} – ${fmtTime(Math.max(selWord.end, selWord.start))}`
              : "No word selected"}
        </StatusPane>
        <StatusPane width={170}>
          <span className="b-doubt-sq" />
          {doubts.length} word{doubts.length === 1 ? "" : "s"} to check
        </StatusPane>
        <StatusPane grow>
          {busy ? (
            <>
              <Icon name="working" />
              {busy}
            </>
          ) : (
            (notice ?? hints)
          )}
        </StatusPane>
        <StatusPane width={150}>
          {dirty ? (
            <>
              <Icon name="warn" />
              {state.past.length} change{state.past.length === 1 ? "" : "s"}
            </>
          ) : (
            <>
              <Icon name="ready" />
              Saved
            </>
          )}
        </StatusPane>
      </StatusBar>
    </AppFrame>
  );
}

// ---------------------------------------------------------------- overview

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function drawEnvelope(canvas: HTMLCanvasElement, samples: Float32Array, color: string) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const n = samples.length;
  if (n === 0) return;
  const mid = h / 2;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i < n; i++) ctx.lineTo((i / (n - 1)) * w, mid - samples[i] * mid * 0.92);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo((i / (n - 1)) * w, mid + samples[i] * mid * 0.92);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#808080";
}

function Overview(props: {
  levels: VocalLevels | null;
  duration: number;
  time: number;
  words: WordTiming[];
  doubts: number[];
  loop: { start: number; end: number } | null;
  onSeek: (t: number) => void;
}) {
  const { levels, duration, time, words, doubts, loop } = props;
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = useWidth(ref);
  const { settings } = useSettings();
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !levels || duration <= 0 || width === 0) return;
    const samples = envelopeSamples(levels.peaks, levels.bins_per_second, 0, duration, Math.max(50, Math.floor(width / 2)));
    drawEnvelope(c, samples, cssVar("--w-wave"));
  }, [levels, duration, width, settings.scheme]);
  const pct = (t: number) => (duration > 0 ? `${(t / duration) * 100}%` : "0%");
  return (
    <div className="b-overview">
      <span className="b-overview-t">{fmtClock(0, false).main}</span>
      <div
        ref={ref}
        className="b-ov-strip"
        title="Whole song — click to seek"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          props.onSeek(((e.clientX - r.left) / r.width) * duration);
        }}
      >
        <canvas ref={canvasRef} />
        <div className="b-played" style={{ width: pct(time), height: "100%" }} />
        {loop && <div className="b-loop" style={{ left: pct(loop.start), width: pct(loop.end - loop.start), height: "100%" }} />}
        {doubts.map((i) => (
          <span key={i} className="b-doubt-mark" style={{ left: pct(words[i].start) }} />
        ))}
        <div className="b-head" style={{ left: pct(time) }} />
      </div>
      <span className="b-overview-t end">{fmtClock(duration, false).main}</span>
    </div>
  );
}

// ---------------------------------------------------------------- lane

type LaneSize = "thin" | "normal" | "focus" | "big";
const LANE_DIMS: Record<LaneSize, { wave: number; key: number; gap: number; font: number }> = {
  thin: { wave: 14, key: 18, gap: 2, font: 12 },
  normal: { wave: 24, key: 22, gap: 3, font: 13 },
  focus: { wave: 44, key: 24, gap: 8, font: 13 },
  big: { wave: 168, key: 32, gap: 12, font: 16 },
};

interface LaneCommon {
  words: WordTiming[];
  /** Song length (the stretch cap for the last word). */
  duration: number;
  levels: VocalLevels | null;
  selected: number | null;
  range: { first: number; last: number } | null;
  drag: DragState | null;
  editing: number | null;
  setEditing: (i: number | null) => void;
  dispatch: React.Dispatch<Parameters<typeof editorReducer>[1]>;
  sungThrough: number | null;
  nowWord: number | null;
  time: number;
  playLane: number;
  loop: { start: number; end: number } | null;
  onWordDown: (e: ReactPointerEvent<HTMLElement>, index: number, lane: number) => void;
  onWordMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onWordUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onHearLine: (k: number) => void;
  /** Background click at original-song time `t`: seek there and play. */
  onSeekPlay: (t: number) => void;
  onRealign: (k: number) => void;
  laneWidth: React.MutableRefObject<Record<number, number>>;
  select: (i: number | null, seek?: boolean) => void;
}

function Lane(props: LaneCommon & { lane: LaneGroup; index: number; size: LaneSize }) {
  const { lane, index, size, words, levels, selected, range, drag, editing, sungThrough, time, playLane, loop } = props;
  const dims = LANE_DIMS[size];
  const stripRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = useWidth(stripRef);
  const { settings } = useSettings();
  const focused = size === "focus" || size === "big";
  useEffect(() => {
    props.laneWidth.current[index] = width;
  }, [width, index, props.laneWidth]);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || width === 0) return;
    if (!levels) {
      const ctx = c.getContext("2d");
      ctx?.clearRect(0, 0, c.width, c.height);
      return;
    }
    const samples = envelopeSamples(levels.peaks, levels.bins_per_second, lane.start, lane.end, Math.max(40, Math.floor(width / 3)));
    drawEnvelope(c, samples, cssVar(focused ? "--w-wave-active" : "--w-wave"));
  }, [levels, lane.start, lane.end, width, settings.scheme, focused]);

  const height = dims.wave + dims.key + dims.gap * 2 + (focused ? 4 : 0);
  const keysTop = dims.wave + dims.gap;
  const px = (t: number) => secToPx(t, lane, width);
  const inLane = playLane === index;
  const dragging = drag && lane.indices.includes(drag.index) ? drag : null;
  const shiftFor = (i: number) => (drag && drag.mode === "move" && drag.moved && i >= drag.first && i <= drag.last ? drag.deltaS : 0);
  const endFor = (i: number) => {
    const w = words[i];
    return drag && drag.mode === "stretch" && drag.moved && i === drag.index
      ? stretchedEnd(words, i, props.duration, drag.deltaS)
      : Math.max(w.end, w.start);
  };
  const showLoop = loop && loop.end > lane.start && loop.start < lane.end && (inLane || dragging || (selected != null && lane.indices.includes(selected)));

  return (
    <div className={`b-lane${focused ? " focus" : ""}`}>
      <div className="b-num">{String(index + 1).padStart(2, "0")}</div>
      <div
        ref={stripRef}
        className="b-strip"
        style={{ height }}
        onClick={(e) => {
          // Chips own their clicks (select / drag / edit); the rest of the
          // strip is the track - click to play from that time.
          if ((e.target as HTMLElement).closest(".b-word")) return;
          const r = e.currentTarget.getBoundingClientRect();
          if (r.width <= 0) return;
          props.onSeekPlay(lane.start + pxToSec(e.clientX - r.left, lane, r.width));
        }}
      >
        <div className="b-wave" style={{ height: dims.wave }}>
          <canvas ref={canvasRef} />
        </div>
        {inLane && <div className="b-played" style={{ width: px(time), height: dims.wave }} />}
        {showLoop && loop && (
          <>
            <div className="b-loop" style={{ left: px(loop.start), width: px(loop.end) - px(loop.start), height: dims.wave }} />
            {focused && (
              <div className="b-loop-label" style={{ left: px(loop.start) + 6 }}>
                {dragging ? "Loop — release to hear once" : "Loop"}
              </div>
            )}
          </>
        )}
        {lane.indices.map((i, k) => {
          const w = words[i];
          const shift = shiftFor(i);
          const x0 = px(w.start + shift);
          const x1 = Math.max(x0 + 6, px(endFor(i) + shift));
          // A chip is a label first: a short sung span ("in", "my") gets a box
          // too narrow to read, so widen it up to the next word's onset, and
          // past that shrink the type (to a floor) before clipping.
          const next = lane.indices[k + 1];
          const room = (next != null ? px(words[next].start + shiftFor(next)) : width) - x0 - 2;
          const need = Math.ceil(textWidth(w.word, dims.font) + 12);
          const boxW = Math.max(x1 - x0, Math.min(need, room));
          const fontPx = boxW < need ? Math.max(dims.font * 0.75, (dims.font * (boxW - 12)) / Math.max(1, need - 12)) : dims.font;
          const handleW = Math.min(7, boxW / 3);
          const isSel = selected === i;
          const inScope = range != null && i >= range.first && i <= range.last;
          // The word under the head lights the moment the head enters it
          // ("now"); "sung" is the trail behind it.
          const state = isSel
            ? "sel"
            : inLane && props.nowWord === i
              ? "now"
              : sungThrough != null && i <= sungThrough && inLane && i < (props.nowWord ?? Infinity)
                ? "sung"
                : "";
          const tickCls = isSel ? "sel" : isDoubtful(w) ? "doubt" : "";
          return (
            <span key={i}>
              <span className={`b-tick ${tickCls}`} style={{ left: x0, top: 0, height: keysTop }} />
              {dragging && dragging.moved && i === dragging.index && (
                <span className="b-ghost" style={{ left: px(w.start), width: px(Math.max(w.end, w.start)) - px(w.start), top: keysTop, height: dims.key }} />
              )}
              {editing === i ? (
                <span className="b-word sel" style={{ left: x0, width: Math.max(x1 - x0, 72), top: keysTop, height: dims.key, fontSize: dims.font }}>
                  <WordEditor
                    value={w.word}
                    onCommit={(text) => {
                      props.dispatch({ type: "set-text", index: i, text });
                      props.setEditing(null);
                    }}
                    onCancel={() => props.setEditing(null)}
                  />
                </span>
              ) : (
                <span
                  className={`b-word ${state}${inScope ? " in-scope" : ""}${w.unsung ? " unsung" : ""}${dragging && i === dragging.index ? ` dragging ${dragging.mode}` : ""}`}
                  style={{ left: x0, width: boxW, top: keysTop, height: dims.key, fontSize: fontPx }}
                  onPointerDown={(e) => props.onWordDown(e, i, index)}
                  onPointerMove={props.onWordMove}
                  onPointerUp={props.onWordUp}
                  onPointerCancel={props.onWordUp}
                  onContextMenu={() => props.select(i, false)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    props.select(i, false);
                    props.setEditing(i);
                  }}
                  title={`${w.word} · ${w.start.toFixed(2)}–${w.end.toFixed(2)} s · confidence ${Math.round(w.confidence * 100)}%`}
                  role="button"
                  tabIndex={-1}
                >
                  {w.word}
                  {isDoubtful(w) && !isSel && <span className="b-doubt" />}
                  <span className="b-word-end" style={{ width: handleW }} aria-hidden />
                </span>
              )}
            </span>
          );
        })}
        {focused && dragging && dragging.moved && (
          <span className="b-puck" style={{ left: px(dragging.mode === "stretch" ? endFor(dragging.index) : words[dragging.index].start + dragging.deltaS), top: dims.wave - 8 }} />
        )}
        {focused && (
          <div className="b-readout">
            {dragging && dragging.moved ? (
              <Lcd>
                <LcdText value={`${dragging.deltaS >= 0 ? "" : "-"}${Math.abs(dragging.deltaS).toFixed(3)}`} size={13} />
              </Lcd>
            ) : (
              <span className="w-muted">
                {lane.indices.length} word{lane.indices.length === 1 ? "" : "s"} · {fmtClock(lane.start, false).main}–{fmtClock(lane.end, false).main}
              </span>
            )}
          </div>
        )}
        {inLane && <div className="b-lane-head" style={{ left: px(time) }} />}
      </div>
      <div className="b-ear">
        {size !== "thin" && (
          <Button size="sm" onClick={() => props.onHearLine(index)} aria-label="Hear this line" title="Hear this line">
            <Glyph name="speaker" />
          </Button>
        )}
      </div>
    </div>
  );
}

function WordEditor(props: { value: string; onCommit: (text: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(props.value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      value={v}
      aria-label="Edit word"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => props.onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onCommit(v);
        else if (e.key === "Escape") props.onCancel();
        e.stopPropagation();
      }}
    />
  );
}

// ---------------------------------------------------------------- focus

function FocusView(props: {
  lanes: LaneGroup[];
  selLane: number;
  laneProps: LaneCommon;
  onSelectLane: (k: number) => void;
  onHearLine: (k: number) => void;
  onRealign: (k: number) => void;
  lineLoop: boolean;
  setLineLoop: (v: boolean) => void;
  audio: AudioController;
  wordMenu: MenuEntry[];
  children: React.ReactNode;
}) {
  const { lanes, selLane, laneProps } = props;
  const { from, to } = focusRange(lanes.length, selLane, 2);
  const words = laneProps.words;
  const cur = lanes[selLane];
  const prev = lanes[selLane - 1];
  const next = lanes[selLane + 1];
  const t = laneProps.time;
  const clock = fmtClock(t);
  return (
    <>
      <div className="b-tv" aria-label="TV preview">
        <div className="b-tv-corner l">
          <Icon name="tv" />
          TV preview
        </div>
        <div className="b-tv-corner r">
          {clock.main}
          {clock.frac}
        </div>
        <div className="ctx">{prev ? prev.indices.map((i) => words[i].word).join(" ") : " "}</div>
        <div className="cur">
          {cur?.indices.map((i) => {
            const w = words[i];
            const cls = laneProps.nowWord === i ? "now" : t >= Math.max(w.end, w.start) ? "sung" : "";
            return (
              <span key={i} className={cls}>
                {w.word}
              </span>
            );
          })}
        </div>
        <div className="ctx">{next ? next.indices.map((i) => words[i].word).join(" ") : " "}</div>
      </div>
      <ContextMenu items={props.wordMenu} className="b-scroll" style={{ flexGrow: 0 }}>
        {lanes.slice(from, to + 1).map((l, j) => {
          const k = from + j;
          return (
            <div key={l.line ?? `run-${l.indices[0]}`} onClick={k !== selLane ? () => props.onSelectLane(k) : undefined}>
              <Lane lane={l} index={k} size={k === selLane ? "big" : "thin"} {...laneProps} />
            </div>
          );
        })}
      </ContextMenu>
      <div className="b-focus-nav">
        <Button onClick={() => props.onSelectLane(Math.max(0, selLane - 1))} disabled={selLane <= 0} tip="Previous line (↑)">
          <Glyph name="up" /> Previous line
        </Button>
        <Button onClick={() => props.onSelectLane(Math.min(lanes.length - 1, selLane + 1))} disabled={selLane >= lanes.length - 1} tip="Next line (↓)">
          <Glyph name="down" /> Next line
        </Button>
        <Button onClick={() => props.onHearLine(selLane)}>
          <Glyph name="speaker" /> Hear line
        </Button>
        <Button on={props.lineLoop} onClick={() => props.setLineLoop(!props.lineLoop)} tip="Loop line (L)">
          Loop line
        </Button>
        <span className="w-grow" />
        <span className="w-muted">Big targets for fine work · nudge with ← →</span>
        <Button onClick={() => props.onRealign(selLane)}>Re-align this line</Button>
      </div>
      {props.children}
    </>
  );
}

// ---------------------------------------------------------------- text

function TextView(props: {
  lanes: LaneGroup[];
  words: WordTiming[];
  selLane: number;
  dispatch: React.Dispatch<Parameters<typeof editorReducer>[1]>;
  select: (i: number | null, seek?: boolean) => void;
  onHearLine: (k: number) => void;
  onRealign: (k: number) => void;
  onZoom: () => void;
}) {
  const { lanes, words, selLane, dispatch } = props;
  // Stanzas: a gap of REFLOW-ish silence between lines reads as a verse break.
  const STANZA_GAP_S = 2.5;
  const blocks: number[][] = [];
  lanes.forEach((l, k) => {
    const prev = lanes[k - 1];
    const gap = prev ? words[l.indices[0]].start - Math.max(words[prev.indices[prev.indices.length - 1]].end, 0) : 0;
    if (!prev || gap > STANZA_GAP_S) blocks.push([k]);
    else blocks[blocks.length - 1].push(k);
  });

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const k = Math.min(lanes.length - 1, Math.max(0, (selLane < 0 ? 0 : selLane) + (e.key === "ArrowDown" ? 1 : -1)));
      props.select(lanes[k].indices[0]);
    }
  };

  return (
    <div className="b-text" onKeyDown={onKey}>
      <div className="b-text-col" role="list" aria-label="Lyric lines">
        {blocks.map((b, bi) => (
          <div key={bi} style={{ display: "contents" }}>
            {bi > 0 && (
              <div className="b-stanza-gap">
                Stanza · silence ≥ {STANZA_GAP_S} s
                <i />
              </div>
            )}
            {b.map((k) => (
              <TextRow
                key={lanes[k].line ?? `run-${lanes[k].indices[0]}`}
                index={k}
                lane={lanes[k]}
                words={words}
                selected={k === selLane}
                onSelect={() => props.select(lanes[k].indices[0])}
                onCommit={(text) => dispatch({ type: "set-line-text", first: lanes[k].indices[0], last: lanes[k].indices[lanes[k].indices.length - 1], text })}
                onBreak={(wordInLine) => dispatch({ type: "break-line", at: lanes[k].indices[wordInLine] })}
                onJoin={() => dispatch({ type: "join-line", at: lanes[k].indices[0] })}
                onHear={() => props.onHearLine(k)}
              />
            ))}
          </div>
        ))}
        {lanes.length === 0 && <div className="w-list-empty">No lines yet.</div>}
      </div>
      <div className="b-text-side">
        <GroupBox label="Structure, not timing">
          Read the song as it will be sung. Fix line breaks and typos here; matched words keep their timing, and a retyped run
          spreads across the old span.
        </GroupBox>
        <GroupBox label="Line surgery">
          <div style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: "4px 8px" }}>
            <b>Enter</b>
            <span>mid-line breaks it at the caret</span>
            <b>Backspace</b>
            <span>at the start joins it to the line above</span>
            <b>Enter</b>
            <span>on an unchanged line plays it</span>
          </div>
        </GroupBox>
        <GroupBox label="Still tied to the audio">
          Start times and check markers stay in the margin. Press + to jump into Lanes on the selected line.
        </GroupBox>
        <Button onClick={() => dispatch({ type: "reflow-lines" })}>Re&flow lines to fit the TV</Button>
        <Button isDefault onClick={() => selLane >= 0 && props.onRealign(selLane)} disabled={selLane < 0}>
          Re-align selected line
        </Button>
        <Button onClick={props.onZoom}>Zoom to Lanes (+)</Button>
      </div>
    </div>
  );
}

function TextRow(props: {
  index: number;
  lane: LaneGroup;
  words: WordTiming[];
  selected: boolean;
  onSelect: () => void;
  onCommit: (text: string) => void;
  onBreak: (wordInLine: number) => void;
  onJoin: () => void;
  onHear: () => void;
}) {
  const { lane, words, selected } = props;
  const text = lane.indices.map((i) => words[i].word).join(" ");
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const doubt = lane.indices.some((i) => isDoubtful(words[i]));
  const start = fmtClock(words[lane.indices[0]].start);
  useEffect(() => {
    if (!selected) setDraft(null);
  }, [selected]);
  const commit = () => {
    if (draft != null && draft.trim() !== "" && draft !== text) props.onCommit(draft);
    setDraft(null);
  };
  return (
    <div className={`b-trow${selected ? " sel" : ""}`} onClick={props.onSelect} role="listitem" aria-current={selected || undefined}>
      <span className="num">{String(props.index + 1).padStart(2, "0")}</span>
      <span className="tm">
        {start.main}
        {start.frac}
      </span>
      <span className="txt">
        {selected ? (
          <input
            ref={inputRef}
            type="text"
            aria-label={`Line ${props.index + 1}`}
            value={draft ?? text}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              const el = e.currentTarget;
              if (e.key === "Enter") {
                e.preventDefault();
                const caret = el.selectionStart ?? 0;
                const at = wordAtCaret(el.value, caret);
                if (draft != null && draft !== text) commit();
                else if (at != null && el.value === text) props.onBreak(at);
                else props.onHear();
              } else if (e.key === "Backspace" && (el.selectionStart ?? 0) === 0 && (el.selectionEnd ?? 0) === 0) {
                e.preventDefault();
                props.onJoin();
              } else if (e.key === "Escape") {
                setDraft(null);
                el.blur();
              }
              e.stopPropagation();
            }}
          />
        ) : (
          text
        )}
      </span>
      {doubt && <span className="b-doubt-sq" title="A word here needs checking" />}
    </div>
  );
}
