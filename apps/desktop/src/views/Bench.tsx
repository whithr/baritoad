// The bench: one song, lyrics on the audio. Three zoom levels of the same
// surface — Text (structure, no audio), Lanes (the default: one lane per
// line, words as keycaps under the vocal waveform), Focus (one line blown
// up, neighbours as thin strips, TV preview on top). Selection, scope,
// playhead and keys carry across all three.
//
// State is the tested editorState reducer (undo/redo/dirty, timing-map
// invariants); playback is the review-screen <audio> hook (original-song
// time — PLAN.md §5); waveforms are the vocal stem's peak envelope.

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
  BENCH_VIEWS,
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
import { useAudio, type AudioController } from "../useAudio";
import { Chip, Divider, Icon, Kb, Key, Knob, Label, Lcd, Led, Legend, Seg, fmtClock } from "../hw/ui";

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

const SCOPE_LABEL: Record<ShiftScope, string> = { word: "Word", line: "Line", tail: "From here" };

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

  if (error) {
    return (
      <div className="bench">
        <div className="hw-topbar">
          <Key icon="back" onClick={() => props.go({ view: "home" })} aria-label="Back to library" />
          <span className="hw-title">{props.title ?? "Song"}</span>
        </div>
        <div className="hw-banner error" style={{ margin: 16 }}>
          {error}
        </div>
      </div>
    );
  }
  if (!map || !sources) {
    return (
      <div className="bench">
        <div className="hw-topbar">
          <Key icon="back" onClick={() => props.go({ view: "home" })} aria-label="Back to library" />
          <span className="hw-title">{props.title ?? "Song"}</span>
          <Led on />
          <Label>Loading</Label>
        </div>
      </div>
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

  // Unsaved changes: warn on leave.
  const exit = useCallback(() => {
    if (dirty && !window.confirm("Leave without saving your timing changes?")) return;
    go({ view: "home" });
  }, [dirty, go]);

  const singOnTv = useCallback(async () => {
    if (dirty) await save();
    go({ view: "play", songId, mapPath });
  }, [dirty, save, go, songId, mapPath]);

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

  return (
    <div className="bench">
      <div className="hw-topbar">
        <Key icon="back" onClick={exit} aria-label="Back to library" />
        <div style={{ display: "flex", flexDirection: "column", gap: 1, marginLeft: 2 }}>
          <span className="hw-title">{song?.title ?? props.title ?? "Untitled"}</span>
          <Label>
            {song?.artist ?? ""}
            {song?.artist && duration ? " · " : ""}
            {duration ? total.main : ""}
          </Label>
        </div>
        <div style={{ width: 6 }} />
        <Lcd style={{ width: 134 }}>
          <span>
            {clock.main}
            <span className="dim">{clock.frac}</span>
          </span>
          <span className="dim">/ {total.main}</span>
        </Lcd>
        <span className="hw-grow" />
        <Key icon="prev" onClick={() => audio.seek(Math.max(0, audio.time - 5))} aria-label="Back 5 seconds" />
        <Key icon={audio.playing ? "pause" : "play"} on onClick={() => { stopAt.current = null; audio.toggle(); }} aria-label="Play / pause" style={{ width: 38 }} />
        <Key icon="next" onClick={() => audio.seek(Math.min(duration, audio.time + 5))} aria-label="Forward 5 seconds" />
        <div style={{ width: 6 }} />
        <Key icon="loop" on={lineLoop} onClick={() => setLineLoop((v) => !v)} title="Loop the selected line (L)">
          Loop
        </Key>
        <div style={{ width: 10 }} />
        <Knob value={guide} onChange={setGuide} label="Vocal guide" readout={`${Math.round(guide * 100)}%`} />
        <div style={{ width: 10 }} />
        <ExportKey onExport={doExport} />
        <Key accent icon="tv" onClick={singOnTv}>
          Sing on TV
        </Key>
      </div>

      <div className="hw-subbar">
        <Label>View</Label>
        <Kb>−</Kb>
        <Seg
          ariaLabel="View"
          value={view}
          onChange={setView}
          options={BENCH_VIEWS.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))}
        />
        <Kb>+</Kb>
        <Divider />
        <Label>Shift</Label>
        {(["word", "line", "tail"] as ShiftScope[]).map((s, i) => (
          <Chip key={s} on={scope === s} k={String(i + 1)} onClick={() => setScope(s)}>
            {SCOPE_LABEL[s]}
          </Chip>
        ))}
        <Divider />
        <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--hw-muted)" }}>
          <Kb>←</Kb>
          <Kb>→</Kb>
          <span>10 ms</span>
          <span style={{ margin: "0 6px" }}>·</span>
          <Kb>⇧</Kb>
          <span>100 ms</span>
        </span>
        <span className="hw-grow" />
        {busy && (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Led on />
            <Label>{busy}</Label>
          </span>
        )}
        {notice && <Label style={{ color: "var(--hw-ink)" }}>{notice}</Label>}
        {selLane >= 0 && <Label>Line {String(selLane + 1).padStart(2, "0")}</Label>}
        <Lcd style={{ width: 92 }} title="Shift being applied">
          {deltaS != null ? (
            <>
              <span className="hot">{(deltaS >= 0 ? "+" : "−") + Math.abs(deltaS).toFixed(3)}</span>
              <span className="dim">s</span>
            </>
          ) : (
            <span className="dim">{range ? `${range.last - range.first + 1} move` : "—"}</span>
          )}
        </Lcd>
        <div style={{ width: 6 }} />
        <Key icon="undo" onClick={() => dispatch({ type: "undo" })} disabled={state.past.length === 0} aria-label="Undo" />
        <Key icon="redo" onClick={() => dispatch({ type: "redo" })} disabled={state.future.length === 0} aria-label="Redo" />
        <div style={{ width: 6 }} />
        <Key onClick={save} disabled={!dirty || saving} style={{ width: 78 }}>
          <Led on={dirty} color="yellow" />
          Save
        </Key>
      </div>

      {error && (
        <div className="hw-banner error" style={{ margin: "8px 16px 0" }}>
          {error}
          <span className="hw-grow" />
          <Key small onClick={() => setError(null)}>
            Dismiss
          </Key>
        </div>
      )}

      <div className="bench-body">
        {view === "lanes" && (
          <>
            <Overview levels={levels} duration={duration} time={audio.time} words={words} doubts={doubts} loop={audio.loop} onSeek={(t) => audio.seek(t)} />
            <div className="bench-scroll">
              {lanes.map((l, k) => (
                <Lane key={l.line ?? `run-${l.indices[0]}`} lane={l} index={k} size={k === selLane ? "focus" : "normal"} {...laneProps} />
              ))}
              {lanes.length === 0 && <div className="hw-banner">No timed words in this map yet.</div>}
            </div>
          </>
        )}
        {view === "focus" && (
          <FocusView lanes={lanes} selLane={selLane >= 0 ? selLane : Math.max(0, playLane)} laneProps={laneProps} onSelectLane={(k) => select(lanes[k].indices[0])} onHearLine={hearLine} onRealign={realignLane} lineLoop={lineLoop} setLineLoop={setLineLoop} audio={audio}>
            <Overview levels={levels} duration={duration} time={audio.time} words={words} doubts={doubts} loop={audio.loop} onSeek={(t) => audio.seek(t)} />
          </FocusView>
        )}
        {view === "text" && (
          <TextView lanes={lanes} words={words} selLane={selLane} dispatch={dispatch} select={select} onHearLine={hearLine} onRealign={realignLane} onZoom={() => setView("lanes")} />
        )}
      </div>

      <div className="hw-footer">
        <Legend
          items={
            view === "text"
              ? [["↑↓", "line"], ["↵", "break / play"], ["⌫", "join up"], ["SPC", "play"], ["N", "next doubt"], ["Z", "undo"], ["+", "zoom to lanes"]]
              : [["SPC", "play"], ["↑↓", "line"], ["TAB", "word"], ["1 2 3", "scope"], ["←→", "nudge 10 ms"], ["⇧←→", "100 ms"], ["↵", "hear"], ["L", "loop line"], ["N", "next doubt"], ["F2", "edit"], ["Z", "undo"], ["− +", "view"]]
          }
        />
        <span className="hw-grow" />
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--hw-muted)", whiteSpace: "nowrap" }}>
          <Led on={dirty} color="yellow" />
          {dirty ? `${state.past.length} change${state.past.length === 1 ? "" : "s"} since save` : "saved"}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- export

function ExportKey(props: { onExport: (format: string) => void }) {
  const [openMenu, setOpenMenu] = useState(false);
  return (
    <span style={{ position: "relative" }}>
      <Key onClick={() => setOpenMenu((v) => !v)} aria-haspopup="menu" aria-expanded={openMenu}>
        Export
        <Icon name="down" />
      </Key>
      {openMenu && (
        <div
          role="menu"
          className="hw-card"
          style={{ position: "absolute", right: 0, top: 30, zIndex: 10, minWidth: 150, gap: 4, padding: 6 }}
          onMouseLeave={() => setOpenMenu(false)}
        >
          {[
            ["lrc", "LRC"],
            ["ass", "ASS (subtitles)"],
            ["ultrastar", "UltraStar .txt"],
          ].map(([f, label]) => (
            <Key key={f} small onClick={() => { setOpenMenu(false); props.onExport(f); }} style={{ justifyContent: "flex-start" }}>
              {label}
            </Key>
          ))}
        </div>
      )}
    </span>
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
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
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
    drawEnvelope(c, samples, cssVar("--hw-vocal"));
  }, [levels, duration, width, settings.scheme]);
  const pct = (t: number) => (duration > 0 ? `${(t / duration) * 100}%` : "0%");
  const t0 = fmtClock(0, false);
  const t1 = fmtClock(duration, false);
  return (
    <div className="overview">
      <Label className="t0">{t0.main}</Label>
      <div
        ref={ref}
        className="overview-strip"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          props.onSeek(((e.clientX - r.left) / r.width) * duration);
        }}
      >
        <canvas ref={canvasRef} />
        <div className="played" style={{ width: pct(time) }} />
        {loop && <div className="loop" style={{ left: pct(loop.start), width: pct(loop.end - loop.start) }} />}
        {doubts.map((i) => (
          <span key={i} className="doubt" style={{ left: pct(words[i].start) }} />
        ))}
        <div className="head" style={{ left: pct(time) }} />
      </div>
      <Label className="t1">{t1.main}</Label>
    </div>
  );
}

// ---------------------------------------------------------------- lane

type LaneSize = "thin" | "normal" | "focus" | "big";
const LANE_DIMS: Record<LaneSize, { wave: number; key: number; gap: number; font: number }> = {
  thin: { wave: 14, key: 18, gap: 2, font: 11 },
  normal: { wave: 22, key: 22, gap: 3, font: 12 },
  focus: { wave: 44, key: 22, gap: 8, font: 12 },
  big: { wave: 168, key: 32, gap: 12, font: 14 },
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
    drawEnvelope(c, samples, cssVar("--hw-vocal"));
  }, [levels, lane.start, lane.end, width, settings.scheme]);

  const focused = size === "focus" || size === "big";
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
  const isInstrumental = false;

  return (
    <div className={`lane${focused ? " focus" : ""}${size === "big" ? " big" : ""}`}>
      <div className="lane-num">{String(index + 1).padStart(2, "0")}</div>
      <div
        ref={stripRef}
        className="lane-strip"
        style={{ height }}
        onClick={(e) => {
          // Keycaps own their clicks (select / drag / edit); the rest of the
          // strip is the track - click to play from that time.
          if ((e.target as HTMLElement).closest(".wordkey")) return;
          const r = e.currentTarget.getBoundingClientRect();
          if (r.width <= 0) return;
          props.onSeekPlay(lane.start + pxToSec(e.clientX - r.left, lane, r.width));
        }}
      >
        <div className="lane-wave" style={{ height: dims.wave }}>
          <canvas ref={canvasRef} />
        </div>
        {inLane && <div className="lane-played" style={{ width: px(time), height: dims.wave }} />}
        {showLoop && loop && (
          <>
            <div className="lane-loop" style={{ left: px(loop.start), width: px(loop.end) - px(loop.start), height: dims.wave }} />
            {focused && (
              <div className="lane-loop-label" style={{ left: px(loop.start) + 6 }}>
                <Led on />
                <Label style={{ color: "var(--hw-orange)" }}>{dragging ? "Loop · release to hear once" : "Loop"}</Label>
              </div>
            )}
          </>
        )}
        {!isInstrumental &&
          lane.indices.map((i, k) => {
            const w = words[i];
            const shift = shiftFor(i);
            const x0 = px(w.start + shift);
            const x1 = Math.max(x0 + 6, px(endFor(i) + shift));
            // A keycap is a label first: a short sung span ("in", "my") gets a
            // box too narrow to read, so widen it up to the next word's onset,
            // and past that shrink the type (to a floor) before clipping.
            const next = lane.indices[k + 1];
            const room = (next != null ? px(words[next].start + shiftFor(next)) : width) - x0 - 2;
            // (0.66 em per glyph + 10px of padding/border, measured against
            // Space Grotesk at 11–14px; erring wide only widens a keycap.)
            const need = Math.ceil(w.word.length * dims.font * 0.66 + 12);
            const boxW = Math.max(x1 - x0, Math.min(need, room));
            const fontPx = boxW < need ? Math.max(dims.font * 0.75, (boxW - 11) / (w.word.length * 0.66)) : dims.font;
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
                <span className={`lane-tick ${tickCls}`} style={{ left: x0, top: dims.wave - 6, height: dims.gap + 6 }} />
                {dragging && dragging.moved && i === dragging.index && (
                  <span className="wordghost" style={{ left: px(w.start), width: px(Math.max(w.end, w.start)) - px(w.start), top: keysTop, height: dims.key }} />
                )}
                {editing === i ? (
                  <span className={`wordkey sel${size === "big" ? " big" : ""}`} style={{ left: x0, width: Math.max(x1 - x0, 60), top: keysTop, height: dims.key }}>
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
                    className={`wordkey ${state}${inScope ? " in-scope" : ""}${w.unsung ? " unsung" : ""}${dragging && i === dragging.index ? ` dragging ${dragging.mode}` : ""}${size === "big" ? " big" : ""}`}
                    style={{ left: x0, width: boxW, top: keysTop, height: dims.key, fontSize: fontPx }}
                    onPointerDown={(e) => props.onWordDown(e, i, index)}
                    onPointerMove={props.onWordMove}
                    onPointerUp={props.onWordUp}
                    onPointerCancel={props.onWordUp}
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
                    {isDoubtful(w) && !isSel && <span className="doubt-led" />}
                    <span className="wordkey-end" style={{ width: handleW }} aria-hidden />
                  </span>
                )}
              </span>
            );
          })}
        {focused && dragging && dragging.moved && (
          <span className="puck" style={{ left: px(dragging.mode === "stretch" ? endFor(dragging.index) : words[dragging.index].start + dragging.deltaS), top: dims.wave - 8 }} />
        )}
        {focused && (
          <div className="lane-readout">
            {dragging && dragging.moved ? (
              <Lcd small>
                <span className="hot">{(dragging.deltaS >= 0 ? "+" : "−") + Math.abs(dragging.deltaS).toFixed(3)}</span>
                <span className="dim">s</span>
              </Lcd>
            ) : (
              <Label>
                {lane.indices.length} word{lane.indices.length === 1 ? "" : "s"} · {fmtClock(lane.start, false).main}–{fmtClock(lane.end, false).main}
              </Label>
            )}
            {range && dragging && <Label>{range.last - range.first + 1} move together</Label>}
          </div>
        )}
        {inLane && <div className="lane-head" style={{ left: px(time) }} />}
      </div>
      <div className="lane-ear">
        {size !== "thin" && <Key small icon="ear" onClick={() => props.onHearLine(index)} title="Hear this line" aria-label="Hear this line" />}
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
    <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <div className="tvpreview">
        <div className="corner l">
          <Led on />
          <Label style={{ color: "var(--hw-lcd-dim)" }}>TV preview</Label>
        </div>
        <div className="corner r hw-mono" style={{ fontSize: 10, color: "var(--hw-lcd-dim)" }}>
          {clock.main}
          {clock.frac}
        </div>
        <div className="ctx">{prev ? prev.indices.map((i) => words[i].word).join(" ") : " "}</div>
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
        <div className="ctx">{next ? next.indices.map((i) => words[i].word).join(" ") : " "}</div>
      </div>
      <div className="bench-scroll" style={{ flexGrow: 0, paddingTop: 10 }}>
        {lanes.slice(from, to + 1).map((l, j) => {
          const k = from + j;
          return (
            <div key={l.line ?? `run-${l.indices[0]}`} onClick={k !== selLane ? () => props.onSelectLane(k) : undefined}>
              <Lane lane={l} index={k} size={k === selLane ? "big" : "thin"} {...laneProps} />
            </div>
          );
        })}
      </div>
      <div className="focus-nav">
        <Key kb="↑" onClick={() => props.onSelectLane(Math.max(0, selLane - 1))} disabled={selLane <= 0}>
          Previous line
        </Key>
        <Key kb="↓" onClick={() => props.onSelectLane(Math.min(lanes.length - 1, selLane + 1))} disabled={selLane >= lanes.length - 1}>
          Next line
        </Key>
        <Key icon="ear" onClick={() => props.onHearLine(selLane)}>
          Hear line
        </Key>
        <Key icon="loop" on={props.lineLoop} onClick={() => props.setLineLoop(!props.lineLoop)}>
          Loop line
        </Key>
        <span className="hw-grow" />
        <Label>Word targets 32 px · nudge with ← → · couch-friendly</Label>
        <Key icon="realign" onClick={() => props.onRealign(selLane)}>
          Re-align this line
        </Key>
      </div>
      <div style={{ height: 6 }} />
      {props.children}
      <div className="hw-grow" />
    </div>
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
    <div className="textview" onKeyDown={onKey}>
      <div className="textview-col">
        {blocks.map((b, bi) => (
          <div key={bi} style={{ display: "contents" }}>
            {bi > 0 && (
              <div className="stanza-gap">
                <Label>Stanza · silence ≥ {STANZA_GAP_S} s</Label>
                <i />
              </div>
            )}
            <div className="stanza">
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
          </div>
        ))}
        {lanes.length === 0 && <div className="hw-banner">No lines yet.</div>}
      </div>
      <div className="textview-side">
        <div className="hw-card">
          <span className="hw-card-title">Structure, not timing</span>
          <p>
            Read the song as it will be sung. Line breaks and typos are fixed here; matched words keep their timing, a retyped run
            spreads across the old span.
          </p>
        </div>
        <div className="hw-card">
          <span className="hw-card-title">Line surgery</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--hw-muted)" }}>
            <div>
              <Kb>↵</Kb> mid-line breaks it at the caret
            </div>
            <div>
              <Kb>⌫</Kb> at the start joins with the line above
            </div>
            <div>
              <Kb>↵</Kb> on a selected line plays it
            </div>
          </div>
        </div>
        <div className="hw-card">
          <span className="hw-card-title">Still tied to the audio</span>
          <p>
            Start times and doubt LEDs stay in the margin. <Kb>+</Kb> drops into Lanes on the selected line.
          </p>
        </div>
        <Key onClick={() => dispatch({ type: "reflow-lines" })}>Reflow lines to fit the TV</Key>
        <Key accent icon="realign" onClick={() => selLane >= 0 && props.onRealign(selLane)} disabled={selLane < 0}>
          Re-align selected line
        </Key>
        <Key onClick={props.onZoom} kb="+">
          Zoom to lanes
        </Key>
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
    <div className={`trow${selected ? " sel" : ""}`} onClick={props.onSelect}>
      <span className="handle">
        <Icon name="grip" />
      </span>
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
      {doubt && <Led on color="yellow" />}
    </div>
  );
}
