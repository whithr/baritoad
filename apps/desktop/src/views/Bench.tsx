// The bench: one song, lyrics on the audio. Two zoom levels of the same
// surface — Text (structure, no audio) and Lanes (the default: one lane per
// line, words as chips under the vocal waveform; the selected line opens
// up for fine work). Selection, scope, playhead and keys carry across both.
//
// Each command is shown once: the menu bar holds everything, the toolbar
// only the frequent jobs, and modes (nudge scope, save state) live in the
// status bar — no second copy of a menu item on the work surface.
//
// State is the tested editorState reducer (undo/redo/dirty, timing-map
// invariants); playback is the review-screen <audio> hook (original-song
// time — PLAN.md §5); waveforms are the vocal stem's peak envelope.
// Chrome is baritoad 98: every command sits in the menu bar; the toolbar,
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
  envelopeSamples,
  laneAtTime,
  laneGroups,
  laneOfWord,
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
  insertSlot,
  isDirty,
  mapFromEditor,
  NUDGE_COARSE_S,
  NUDGE_S,
} from "../editorState";
import { sungThroughIndexAt, wordIndexAt } from "../highlight";
import { tokenizeLyric } from "../lineEdit";
import { shiftRange, type ShiftScope } from "../previewEditor";
import { fmtTime } from "../format";
import { onStage, openStage } from "../stage";
import { EXPORTS, exportWithSaveAs, folderOf } from "../exportFile";
import { useAudio } from "../useAudio";
import {
  AppFrame,
  Button,
  ContextMenu,
  Glyph,
  GroupBox,
  Hr,
  Icon,
  Lcd,
  LcdText,
  MenuBar,
  ProgressBar,
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
import { useAppDialogs } from "./AppDialogs";

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
/** Dropping a dragged word rolls playback back this far before it and plays
 *  on — the new timing heard in context, not a clip that stops. */
const DROP_RUNUP_S = 1.5;
/** Quiet time after the last arrow nudge before it plays (as a drop does):
 *  longer than the usual ~500 ms key-repeat delay, so a held key doesn't
 *  fire playback between its first press and its repeats. */
const NUDGE_SETTLE_MS = 600;
const LINE_LOOP_PAD_S = 0.3;
const REALIGN_PAD_S = 1.0;
const VOCAL_GUIDE_KEY = "baritoad.bench.vocalGuide";


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

/** A word's start after a stretch of `deltaS` at its left edge: never past
 *  its end minus MIN_WORD_S, never before the previous word's end (sung words
 *  do not overlap) — unless it already starts there, where it stays put. */
function stretchedStart(words: { start: number; end: number }[], i: number, deltaS: number): number {
  const w = words[i];
  const ceil = Math.max(Math.max(w.end, w.start) - MIN_WORD_S, w.start);
  const prevEnd = i > 0 ? Math.max(words[i - 1].end, words[i - 1].start) : 0;
  return Math.max(Math.min(w.start + deltaS, ceil), Math.min(prevEnd, w.start));
}

interface DragState {
  index: number;
  first: number;
  last: number;
  /** "move" shifts the word; "start" / "end" (grabbed by the left / right
   *  edge handle) move only that edge — a length change. */
  mode: "move" | "start" | "end";
  deltaS: number;
  lane: number;
  startX: number;
  moved: boolean;
}

/** An open "new word" box: insert after word `after` (-1 = first) with its
 *  onset at `at`, joining the prev or next word's lyric line. */
interface InsertDraft {
  lane: number;
  after: number;
  at: number;
  join: "prev" | "next";
}

/** Width of the "new word" box; it may overhang neighbouring chips. */
const INSERT_BOX_W = 96;

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
      <AppFrame title={`${title} - baritoad Bench`} icon={<Icon name="app" />}>
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
  const [inserting, setInserting] = useState<InsertDraft | null>(null);
  const [lineLoop, setLineLoop] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewed, setReviewed] = useState(song?.reviewed_at != null);
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
  const wordsRef = useRef(words);
  wordsRef.current = words;
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

  const nudgeTimer = useRef(0);
  const nudge = useCallback(
    (dir: -1 | 1, coarse: boolean) => {
      if (!range) return;
      const first = range.first;
      dispatch({
        type: "nudge-range",
        first,
        last: range.last,
        deltaS: dir * (coarse ? NUDGE_COARSE_S : NUDGE_S),
      });
      // Nudging is also listening: once the keys settle, roll back before
      // the nudged word and play on, as a drag's drop does.
      window.clearTimeout(nudgeTimer.current);
      nudgeTimer.current = window.setTimeout(() => {
        const w = wordsRef.current[first];
        if (w) seekPlay(w.start - DROP_RUNUP_S);
      }, NUDGE_SETTLE_MS);
    },
    [range, seekPlay],
  );
  // Play/pause, a drag or a new-word box inside the settle window wins over
  // a nudge's pending run-up.
  const cancelNudgePlay = useCallback(() => window.clearTimeout(nudgeTimer.current), []);

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

  // ---- new words: double-click a lane where one is sung (inserted at that
  // time), or Ins (right after the selected word, else at the playhead)
  const beginInsertAt = useCallback(
    (k: number, t: number) => {
      const l = lanes[k];
      if (!l) return;
      // After the lane's last word sung by `t`; before its first word the
      // new one still joins this lane's line, not the line before.
      let after = l.indices[0] - 1;
      for (const i of l.indices) if (words[i].start <= t) after = i;
      cancelNudgePlay();
      audioPause();
      setEditing(null);
      setInserting({ lane: k, after, at: t, join: after < l.indices[0] ? "next" : "prev" });
    },
    [lanes, words, cancelNudgePlay, audioPause],
  );
  const beginInsert = useCallback(() => {
    if (selected != null && selLane >= 0) {
      const w = words[selected];
      cancelNudgePlay();
      audioPause();
      setEditing(null);
      setInserting({ lane: selLane, after: selected, at: Math.max(w.end, w.start), join: "prev" });
    } else if (playLane >= 0) {
      beginInsertAt(playLane, audio.time);
    }
  }, [selected, selLane, words, playLane, audio.time, beginInsertAt, cancelNudgePlay, audioPause]);
  const commitInsert = useCallback(
    (text: string) => {
      const d = inserting;
      setInserting(null);
      const n = tokenizeLyric(text).length;
      if (!d || n === 0) return;
      const slot = insertSlot(words, duration, d.after, d.at, n);
      dispatch({ type: "insert-word", after: d.after, word: text, at: d.at, join: d.join });
      // Hear it in context and play on, as after a drop.
      if (slot) seekPlay(slot.start - DROP_RUNUP_S);
    },
    [inserting, words, duration, seekPlay],
  );
  const cancelInsert = useCallback(() => setInserting(null), []);
  // Retyping a word (double-click / F2) pauses, as the new-word box does.
  const beginEdit = useCallback(
    (i: number) => {
      cancelNudgePlay();
      audioPause();
      setInserting(null);
      setEditing(i);
    },
    [cancelNudgePlay, audioPause],
  );

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await saveTimingMap(mapPath, mapFromEditor(map, words));
      dispatch({ type: "mark-saved" });
      if (songId != null) {
        await songSetReviewed(songId, true);
        setReviewed(true);
      }
      setNotice("Saved");
      window.setTimeout(() => setNotice(null), 1500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [map, saving, mapPath, words, songId]);

  // Save doubles as "the timing is right": a song still waiting for its
  // check keeps Save lit with nothing to write, and saving marks it checked
  // (Library › Needs checking) — no hunting for a menu item.
  const canCheck = songId != null && !reviewed;
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
  const saveAndCheck = useCallback(() => (dirty ? save() : markChecked()), [dirty, save, markChecked]);

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

  const ask = useMessageBox();
  const doExport = useCallback(
    async (format: string) => {
      try {
        if (dirty) await save();
        await exportWithSaveAs(ask, {
          mapPath,
          format,
          title: song?.title ?? props.title ?? "song",
          artist: song?.artist,
          nextTo: folderOf(song?.audio_path ?? mapPath),
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [ask, dirty, save, mapPath, song, props.title],
  );

  // ---- drag (direct manipulation, loop while held; on release a move rolls
  // back and plays on, a click or a length change just plays on)
  const laneWidth = useRef<Record<number, number>>({});
  const onWordDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, index: number, laneIdx: number) => {
      if (e.button !== 0 || editing != null) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      cancelNudgePlay();
      // Drag moves the word you grabbed (DESIGN.md bench chips). The Shift
      // scope (word / line / from here) governs the keyboard nudges only —
      // a line-scoped drag read as "I can't move a single word".
      dispatch({ type: "select", index });
      // The edge handles (<=7px, a third of a narrow chip) stretch the start
      // or end; the rest of the chip moves the word (DESIGN.md bench chips).
      const rect = e.currentTarget.getBoundingClientRect();
      const handle = Math.min(7, rect.width / 3);
      const mode = e.clientX >= rect.right - handle ? "end" : e.clientX <= rect.left + handle ? "start" : "move";
      setDrag({ index, first: index, last: index, mode, deltaS: 0, lane: laneIdx, startX: e.clientX, moved: false });
      const loop = loopWindow(words[index], duration);
      audio.setLoop(loop);
      audio.seek(loop.start);
      audio.play();
    },
    [words, audio, duration, editing, cancelNudgePlay],
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
      // Playback never stops here: the hold's loop is cleared and the audio
      // plays on (the Loop toggle is left as it was, so a looped line keeps
      // looping). Only a move rolls back to hear the word in its new place.
      audio.setLoop(null);
      const d = drag;
      setDrag(null);
      if (!d.moved) return;
      const w = words[d.index];
      if (d.mode === "move") {
        dispatch({ type: "nudge-range", first: d.first, last: d.last, deltaS: d.deltaS });
        seekPlay(w.start + d.deltaS - DROP_RUNUP_S);
      } else {
        dispatch({
          type: "commit-drag",
          index: d.index,
          start: d.mode === "start" ? stretchedStart(words, d.index, d.deltaS) : w.start,
          end: d.mode === "end" ? stretchedEnd(words, d.index, duration, d.deltaS) : w.end,
        });
      }
    },
    [drag, audio, words, duration, seekPlay],
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
        void saveAndCheck();
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
          cancelNudgePlay();
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
        case "l":
        case "L":
          setLineLoop((v) => !v);
          if (!audio.playing) audio.play();
          return;
        case "F2":
          if (selected != null && view !== "text") {
            e.preventDefault();
            beginEdit(selected);
          }
          return;
        case "Delete":
        case "Backspace":
          if (selected != null && view !== "text") {
            e.preventDefault();
            dispatch({ type: "delete-word", index: selected });
          }
          return;
        case "Insert":
          if (view !== "text") {
            e.preventDefault();
            beginInsert();
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
  }, [audio, beginEdit, beginInsert, cancelNudgePlay, duration, editing, hearLine, hearWord, lanes, nudge, playLane, saveAndCheck, selLane, select, selected, view, words]);

  // ---- leaving: 98-style "Save changes?" on every way out (Close, the
  // Library button, Alt+F4 / caption X via the window's close guard)
  const dialogs = useAppDialogs();
  const title = song?.title ?? props.title ?? "Untitled";
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    const r = await ask({
      kind: "warning",
      title: "baritoad Bench",
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

  // ---- commands (menus, right-click, accelerators)
  const hasSel = selected != null;
  const selWord = hasSel ? words[selected] : null;
  const onLanes = view !== "text";
  const togglePlay = () => {
    stopAt.current = null;
    cancelNudgePlay();
    audio.toggle();
  };
  const toggleLoop = () => {
    setLineLoop((v) => !v);
    if (!audio.playing) audio.play();
  };
  const exportItems: MenuEntry[] = EXPORTS.map(([f, label]) => ({ label, run: () => void doExport(f) }));
  const wordCommands = {
    hear: { label: "&Hear word", accel: "Enter", run: () => hasSel && hearWord(selected), disabled: !hasSel },
    edit: { label: "&Edit word", accel: "F2", run: () => hasSel && beginEdit(selected), disabled: !hasSel || !onLanes },
    insert: { label: "&Insert word", accel: "Ins", run: beginInsert, disabled: !onLanes || (!hasSel && playLane < 0) },
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
        { label: "&Save", accel: "Ctrl+S", run: () => void saveAndCheck(), disabled: saving || (!dirty && !canCheck) },
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
        wordCommands.insert,
        wordCommands.del,
      ],
    },
    {
      label: "&View",
      items: [
        { label: "&Text", accel: "−", checked: view === "text", radio: true, run: () => setView("text") },
        { label: "&Lanes", accel: "+", checked: view === "lanes", radio: true, run: () => setView("lanes") },
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
        "-",
        wordCommands.realign,
        { label: "Re&flow lines to fit the TV", run: () => dispatch({ type: "reflow-lines" }) },
        "-",
        { label: "&Mark as checked", run: () => void saveAndCheck(), disabled: !canCheck },
      ],
    },
    {
      label: "T&ools",
      items: [
        { label: "Player &Themes…", run: () => dialogs.open("themes") },
        { label: "&Properties…", run: () => dialogs.open("properties") },
      ],
    },
    {
      label: "&Help",
      items: [
        { label: "&Keyboard Shortcuts", accel: "F1", keys: "f1", run: () => void showKeys() },
        "-",
        { label: "&About baritoad", run: () => dialogs.open("about") },
      ],
    },
  ];
  useAccelerators(menus);
  const wordMenu: MenuEntry[] = [
    wordCommands.hear,
    wordCommands.edit,
    wordCommands.insert,
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
              ["F2", "Edit the word"],
              ["Ins", "Add a word after it (or double-click a lane where it's sung)"],
              ["Del", "Delete the word"],
              ["− +", "Text / Lanes"],
              ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
              ["Ctrl+S", "Save (and mark the song checked)"],
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
    onEdit: beginEdit,
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
    inserting,
    onInsertAt: beginInsertAt,
    onInsertCommit: commitInsert,
    onInsertCancel: cancelInsert,
    laneWidth,
    select,
  };

  // A few keys for what you're doing now; F1 has the full list.
  const hints =
    view === "text"
      ? "↑↓ Line · Enter Break line / play · Backspace Join up · + Lanes"
      : hasSel
        ? "← → Nudge · Enter Hear · L Loop · F2 Retype · F1 Keys"
        : "Click a word to select it · Space Play · F1 Keys";
  const scopeName = { word: "Word", line: "Line", tail: "From here on" }[scope];

  return (
    <AppFrame title={`${title} - baritoad Bench`} icon={<Icon name="app" />}>
      <MenuBar menus={menus} />
      <Hr />
      <Toolbar label="Bench">
        <ToolButton icon={<Glyph name="left" />} onClick={() => void exit()} tip="Back to the Library (Ctrl+W)">
          Library
        </ToolButton>
        <ToolButton
          icon={<Icon name="floppy" />}
          onClick={() => void saveAndCheck()}
          disabled={saving || (!dirty && !canCheck)}
          tip={dirty ? "Save (Ctrl+S)" : "Mark the song checked — the timing is right (Ctrl+S)"}
        >
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
          ]}
          className="w-grow"
          panelStyle={{ flexGrow: 1, display: "flex", flexDirection: "column", padding: 8, minHeight: 0 }}
        >
          <div className="b-body">
            {view === "lanes" && (
              <>
                <Overview levels={levels} duration={duration} time={audio.time} loop={audio.loop} onSeek={(t) => audio.seek(t)} />
                <ContextMenu items={wordMenu} className="b-scroll">
                  {lanes.map((l, k) => (
                    <Lane key={l.line ?? `run-${l.indices[0]}`} lane={l} index={k} size={k === selLane ? "focus" : "normal"} {...laneProps} />
                  ))}
                  {lanes.length === 0 && <div className="w-list-empty">No timed words in this map yet.</div>}
                </ContextMenu>
              </>
            )}
            {view === "text" && (
              <TextView lanes={lanes} words={words} selLane={selLane} dispatch={dispatch} select={select} onHearLine={hearLine} />
            )}
          </div>
        </Tabs>
      </div>

      {dialogs.element}
      <StatusBar>
        <StatusPane width={120}>{selLane >= 0 ? `Line ${selLane + 1} of ${lanes.length}` : `${lanes.length} lines`}</StatusPane>
        <StatusPane width={250}>
          {deltaS != null
            ? `Shifting ${deltaS >= 0 ? "+" : "−"}${Math.abs(deltaS).toFixed(3)} s${range ? ` · ${range.last - range.first + 1} moving` : ""}`
            : selWord
              ? `“${selWord.word}” ${fmtTime(selWord.start)} – ${fmtTime(Math.max(selWord.end, selWord.start))}`
              : ""}
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
        {onLanes && (
          <StatusPane width={150} title="What ← → moves: 1 word, 2 line, 3 from here on (Timing › Scope)">
            Nudge: {scopeName}
          </StatusPane>
        )}
        <StatusPane width={150}>
          {dirty ? (
            <>
              <Icon name="warn" />
              {state.past.length} change{state.past.length === 1 ? "" : "s"}
            </>
          ) : canCheck ? (
            <>
              <Icon name="warn" />
              Not checked yet
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
  loop: { start: number; end: number } | null;
  onSeek: (t: number) => void;
}) {
  const { levels, duration, time, loop } = props;
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
        <div className="b-head" style={{ left: pct(time) }} />
      </div>
      <span className="b-overview-t end">{fmtClock(duration, false).main}</span>
    </div>
  );
}

// ---------------------------------------------------------------- lane

/** "focus" is the selected line, opened up for fine work. */
type LaneSize = "normal" | "focus";
const LANE_DIMS: Record<LaneSize, { wave: number; key: number; gap: number; font: number }> = {
  normal: { wave: 24, key: 22, gap: 3, font: 13 },
  focus: { wave: 44, key: 24, gap: 8, font: 13 },
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
  /** Open the retype box on word `i`. */
  onEdit: (i: number) => void;
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
  /** The open "new word" box, if any (drawn in its lane). */
  inserting: InsertDraft | null;
  /** Background double-click in lane `k` at original-song time `t`. */
  onInsertAt: (k: number, t: number) => void;
  onInsertCommit: (text: string) => void;
  onInsertCancel: () => void;
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
  const focused = size === "focus";
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
  const startFor = (i: number) =>
    drag && drag.mode === "start" && drag.moved && i === drag.index
      ? stretchedStart(words, i, drag.deltaS)
      : words[i].start + shiftFor(i);
  const endFor = (i: number) => {
    const w = words[i];
    return drag && drag.mode === "end" && drag.moved && i === drag.index
      ? stretchedEnd(words, i, props.duration, drag.deltaS)
      : Math.max(w.end, w.start);
  };
  const showLoop = loop && loop.end > lane.start && loop.start < lane.end && (inLane || dragging || (selected != null && lane.indices.includes(selected)));
  const draft = props.inserting?.lane === index ? props.inserting : null;
  const draftAt = draft ? (insertSlot(words, props.duration, draft.after, draft.at)?.start ?? null) : null;
  const stripTime = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return r.width > 0 ? lane.start + pxToSec(e.clientX - r.left, lane, r.width) : null;
  };

  return (
    <div className={`b-lane${focused ? " focus" : ""}`}>
      <div className="b-num">{String(index + 1).padStart(2, "0")}</div>
      <div
        ref={stripRef}
        className="b-strip"
        style={{ height }}
        onClick={(e) => {
          // Chips own their clicks (select / drag / edit); the rest of the
          // strip is the track - click to play from that time, double-click
          // to add a missing word there.
          if ((e.target as HTMLElement).closest(".b-word")) return;
          const t = stripTime(e);
          if (t != null) props.onSeekPlay(t);
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest(".b-word")) return;
          const t = stripTime(e);
          if (t != null) props.onInsertAt(index, t);
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
                {dragging ? "Loop — release to play on" : "Loop"}
              </div>
            )}
          </>
        )}
        {lane.indices.map((i, k) => {
          const w = words[i];
          const x0 = px(startFor(i));
          const x1 = Math.max(x0 + 6, px(endFor(i) + shiftFor(i)));
          // A chip is a label first: a short sung span ("in", "my") gets a box
          // too narrow to read, so widen it up to the next word's onset, and
          // past that shrink the type (to a floor) before clipping.
          const next = lane.indices[k + 1];
          const room = (next != null ? px(startFor(next)) : width) - x0 - 2;
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
          return (
            <span key={i}>
              <span className={`b-tick${isSel ? " sel" : ""}`} style={{ left: x0, top: 0, height: keysTop }} />
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
                  className={`b-word ${state}${inScope ? " in-scope" : ""}${dragging && i === dragging.index ? ` dragging ${dragging.mode}` : ""}`}
                  style={{ left: x0, width: boxW, top: keysTop, height: dims.key, fontSize: fontPx }}
                  onPointerDown={(e) => props.onWordDown(e, i, index)}
                  onPointerMove={props.onWordMove}
                  onPointerUp={props.onWordUp}
                  onPointerCancel={props.onWordUp}
                  onContextMenu={() => props.select(i, false)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    props.select(i, false);
                    props.onEdit(i);
                  }}
                  title={`${w.word} · ${w.start.toFixed(2)}–${w.end.toFixed(2)} s`}
                  role="button"
                  tabIndex={-1}
                >
                  <span className="b-word-start" style={{ width: handleW }} aria-hidden />
                  {w.word}
                  <span className="b-word-end" style={{ width: handleW }} aria-hidden />
                </span>
              )}
            </span>
          );
        })}
        {draftAt != null && (
          <>
            <span className="b-tick sel" style={{ left: px(draftAt), top: 0, height: keysTop }} />
            {/* Kept inside the strip: the playhead can sit past the lane's
                window in a gap between lines. */}
            <span
              className="b-word sel inserting"
              style={{ left: Math.max(0, Math.min(px(draftAt), width - INSERT_BOX_W)), width: INSERT_BOX_W, top: keysTop, height: dims.key, fontSize: dims.font }}
            >
              <WordEditor value="" label="New word" onCommit={props.onInsertCommit} onCancel={props.onInsertCancel} />
            </span>
          </>
        )}
        {focused && dragging && dragging.moved && (
          <span className="b-puck" style={{ left: px(dragging.mode === "end" ? endFor(dragging.index) : startFor(dragging.index)), top: dims.wave - 8 }} />
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
      {/* Only the selected line: clicking any lane already plays from there. */}
      <div className="b-ear">
        {focused && (
          <Button size="sm" onClick={() => props.onHearLine(index)} aria-label="Hear this line" title="Hear this line">
            <Glyph name="speaker" />
          </Button>
        )}
      </div>
    </div>
  );
}

function WordEditor(props: { value: string; label?: string; onCommit: (text: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(props.value);
  const ref = useRef<HTMLInputElement>(null);
  // Settles once: Enter / Esc close the box, and the blur that follows (the
  // input unmounting) must not commit again — a second insert, or a commit
  // after Esc.
  const settled = useRef(false);
  const settle = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) props.onCommit(v);
    else props.onCancel();
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      value={v}
      aria-label={props.label ?? "Edit word"}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => settle(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") settle(true);
        else if (e.key === "Escape") settle(false);
        e.stopPropagation();
      }}
      // A double-click inside the box selects text, not a new-word slot.
      onDoubleClick={(e) => e.stopPropagation()}
    />
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
}) {
  const { lanes, words, selLane, dispatch } = props;
  // Stanzas: a gap of REFLOW-ish silence between lines reads as a verse break
  // (drawn as a plain gap — the rule behind it isn't the user's business).
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
            {bi > 0 && <div className="b-stanza-gap" aria-hidden />}
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
    </div>
  );
}
