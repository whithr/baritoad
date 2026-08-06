// Full-screen performance player (Phase 3 milestone 3; PLAN.md §3 "Player",
// §4 step 5). This is the cpal engine's UI — audio never touches the webview
// (the review player in SongDetail keeps its <audio> element and is a
// different thing entirely).
//
// ## Time base
// Everything here runs in ORIGINAL-SONG seconds. The engine clock translates
// device position through stretch ratios before it ever reaches us
// (PLAN.md §5); the UI interpolates between ~10 Hz host reports with
// playerClock.ts and compares the estimate against timing-map times
// directly. No stretch math exists in this file — by design, forever.
//
// ## Render path (spikes/lyric-render/REPORT.md)
// DOM renderer — the spike's winner on Windows/WebView2 (0 over-budget
// frames at 3440px wide vs canvas's 9). Per-frame work must fit ~8 ms
// because WebView2 runs rAF at the panel rate (120 Hz here). So: React
// renders the lyric DOM once per song (LyricStage is memoized), and the rAF
// loop mutates only what changed — word classNames on state transitions, one
// CSS var for the active-word wipe, one transform for the scroll, one width
// for the progress bar. A canvas backend remains a switchable alternative
// (same LyricFrame seam, reference impl in the spike) pending the WebKitGTK
// measurement; WebGL stays dead (spike verdict).
//
// ## Media keys — honest deferral
// Hardware media keys are NOT wired. The webview's navigator.mediaSession
// only receives them when the page itself plays audio (ours plays via cpal),
// and a global-shortcut route needs tauri-plugin-global-shortcut — a new
// dependency (license looks fine, MIT/Apache-2.0, but it earns its §6 row
// when we actually adopt it). Keyboard controls cover v1; revisit with the
// party-mode milestone.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  librarySong,
  measurePlan,
  measureWrite,
  onPlayerEvent,
  playerLoad,
  playerPause,
  playerPlay,
  playerSeek,
  playerSetGuide,
  playerSetPitch,
  playerSetStretchConfig,
  playerSetTempo,
  playerStatus,
  playerUnload,
  readCover,
  readTimingMap,
  type PlayerStatus,
  type Song,
  type StretchConfigName,
  type TimingMap,
} from "../api";
import { groupByLine } from "../highlight";
import { applyReport, estimate, initClock, type InterpClock } from "../playerClock";
import { lyricFrameAt, scrollStep, type LyricFrame } from "../playerView";
import { fmtTime } from "../reviewUi";
import {
  IconBack,
  IconCompress,
  IconExpand,
  IconGear,
  IconPause,
  IconPlay,
} from "../icons";
import { DashSelect, DashSlider } from "../ui";
import type { Route } from "../App";

const SEEK_STEP_S = 5;
const SEEK_STEP_BIG_S = 30;
const GUIDE_STEP = 0.1;
const TEMPO_STEP = 0.05;
const CONTROLS_HIDE_MS = 3500;

export default function PlayerView(props: {
  songId?: number;
  mapPath?: string;
  measure?: boolean;
  go: (r: Route) => void;
}) {
  const { songId, mapPath, go } = props;
  const [map, setMap] = useState<TimingMap | null>(null);
  const [song, setSong] = useState<Song | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [measureNote, setMeasureNote] = useState<string | null>(null);

  // rAF-side state lives in refs — the render loop never touches React.
  const clockRef = useRef<InterpClock>(initClock());
  const statusRef = useRef<PlayerStatus | null>(null);
  const wordEls = useRef<(HTMLSpanElement | null)[]>([]);
  const lineEls = useRef<(HTMLDivElement | null)[]>([]);
  const lineTops = useRef<number[]>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const scrollY = useRef(0);
  const prevFrame = useRef<LyricFrame | null>(null);
  const hideTimer = useRef<number | null>(null);
  // Measurement harness (inert without a launcher-provided plan).
  const rec = useRef<{
    active: boolean;
    startMs: number;
    startStalls: number;
    startCallbacks: number;
    deltas: number[];
    errsMs: number[];
    seconds: number;
  }>({ active: false, startMs: 0, startStalls: 0, startCallbacks: 0, deltas: [], errsMs: [], seconds: 30 });

  const words = map?.words ?? [];
  const lines = useMemo(() => (map ? groupByLine(map.words) : []), [map]);
  const title = song?.title ?? "Karaoke";

  // ---- load: map + metadata, then hand the song to the engine -------------
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        let s: Song | null = null;
        if (songId != null) {
          try {
            s = await librarySong(songId);
          } catch {
            s = null;
          }
        }
        const path = s?.timing_map_path ?? mapPath;
        if (!path) throw new Error("no timing map for this song");
        const m = await readTimingMap(path);
        if (disposed) return;
        setSong(s);
        setMap(m);
        if (s?.cover_path) {
          readCover(s.cover_path)
            .then((url) => !disposed && setCover(url))
            .catch(() => undefined);
        }
        const st = await playerLoad(
          songId != null ? { songId, autoplay: true } : { mapPath: path, autoplay: true },
        );
        if (disposed) return;
        statusRef.current = st;
        setStatus(st);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    })();
    return () => {
      disposed = true;
      playerUnload().catch(() => undefined);
    };
  }, [songId, mapPath]);

  // ---- position transport: 10 Hz host reports → interpolated clock --------
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await onPlayerEvent((e) => {
        if (disposed) return;
        if (e.kind === "status") {
          const st = e.status;
          statusRef.current = st;
          const rate = st.state === "playing" ? st.tempo : 0;
          const before = clockRef.current;
          const after = applyReport(before, st.position, rate, performance.now());
          clockRef.current = after;
          if (rec.current.active && after.corrections > before.corrections) {
            rec.current.errsMs.push(Math.abs(after.lastErrorMs));
          }
          setStatus(st);
        } else if (e.kind === "completed") {
          // Paused-at-end state. NOTE for milestone 4 (queue auto-advance —
          // not built here, deliberately): with stretch active this event
          // leads the audible end by ≤ ~120 ms (ff9ff15 / stretch.rs docs).
        }
      });
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ---- line geometry (measured after layout; re-measured on resize) -------
  const measureLines = useCallback(() => {
    lineTops.current = lineEls.current.map((el) => {
      if (!el) return 0;
      // Center of the line relative to the scroller, offset so the current
      // line sits at ~40% of the viewport height (singer looks slightly up).
      const vh = viewportRef.current?.clientHeight ?? window.innerHeight;
      return el.offsetTop + el.offsetHeight / 2 - vh * 0.4;
    });
  }, []);

  useLayoutEffect(() => {
    measureLines();
    const ro = new ResizeObserver(() => measureLines());
    if (viewportRef.current) ro.observe(viewportRef.current);
    if (scrollerRef.current) ro.observe(scrollerRef.current);
    return () => ro.disconnect();
  }, [map, measureLines]);

  // ---- the render loop ----------------------------------------------------
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    let lastNow = performance.now();
    const wordClass = (i: number, frame: LyricFrame): string => {
      const w = map.words[i];
      let cls = "k-word";
      if (w.unsung) cls += " unsung";
      if (i === frame.activeWord) cls += " active wipe";
      else if (frame.sungThrough != null && i <= frame.sungThrough) cls += " sung";
      return cls;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = now - lastNow;
      lastNow = now;

      const t = estimate(clockRef.current, now);
      const frame = lyricFrameAt(lines, map.words, t);
      const prev = prevFrame.current;

      // Word class transitions: touch only the indices whose state changed.
      if (!prev) {
        for (let i = 0; i < map.words.length; i++) {
          const el = wordEls.current[i];
          if (el) el.className = wordClass(i, frame);
        }
        for (let li = 0; li < lines.length; li++) {
          const el = lineEls.current[li];
          if (el) {
            el.className =
              li === frame.lineIndex
                ? "pk-line current"
                : li === frame.lineIndex + 1
                  ? "pk-line next"
                  : "pk-line";
          }
        }
      } else {
        if (prev.activeWord !== frame.activeWord) {
          if (prev.activeWord != null) {
            const el = wordEls.current[prev.activeWord];
            if (el) el.className = wordClass(prev.activeWord, frame);
          }
          if (frame.activeWord != null) {
            const el = wordEls.current[frame.activeWord];
            if (el) el.className = wordClass(frame.activeWord, frame);
          }
        }
        if (prev.sungThrough !== frame.sungThrough) {
          const a = Math.min(prev.sungThrough ?? -1, frame.sungThrough ?? -1) + 1;
          const b = Math.max(prev.sungThrough ?? -1, frame.sungThrough ?? -1);
          for (let i = Math.max(0, a); i <= b && i < map.words.length; i++) {
            const el = wordEls.current[i];
            if (el) el.className = wordClass(i, frame);
          }
        }
        if (prev.lineIndex !== frame.lineIndex) {
          const p = lineEls.current[prev.lineIndex];
          if (p) p.className = "pk-line";
          const c = lineEls.current[frame.lineIndex];
          if (c) c.className = "pk-line current";
          const n = lineEls.current[frame.lineIndex + 1];
          if (n) n.className = "pk-line next";
          const pn = lineEls.current[prev.lineIndex + 1];
          if (pn && pn !== c && pn !== n) pn.className = "pk-line";
        }
      }
      // Active-word wipe (one CSS var on one element).
      if (frame.activeWord != null) {
        const el = wordEls.current[frame.activeWord];
        if (el) el.style.setProperty("--wipe", `${(frame.wipe * 100).toFixed(1)}%`);
      }
      prevFrame.current = frame;

      // Smooth scroll toward the current line.
      const target = lineTops.current[frame.lineIndex] ?? 0;
      scrollY.current = scrollStep(scrollY.current, target, dt);
      if (scrollerRef.current) {
        scrollerRef.current.style.transform = `translate3d(0, ${-scrollY.current}px, 0)`;
      }

      // Progress + clock text (direct DOM — these spans have no React children).
      const dur = statusRef.current?.duration ?? map.duration ?? 0;
      if (fillRef.current && dur > 0) {
        fillRef.current.style.width = `${Math.min(100, (t / dur) * 100).toFixed(2)}%`;
      }
      if (timeRef.current) {
        timeRef.current.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
      }

      // Measurement harness.
      const r = rec.current;
      if (r.active) {
        r.deltas.push(dt);
        if (now - r.startMs >= r.seconds * 1000) {
          r.active = false;
          void finishMeasurement();
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lines]);

  // ---- measurement harness (dev-only launcher contract, player.rs) --------
  const finishMeasurement = useCallback(async () => {
    const r = rec.current;
    const deltas = r.deltas.slice(1); // first delta spans the pre-play gap
    const sorted = [...deltas].sort((x, y) => x - y);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    const sum = deltas.reduce((a, b) => a + b, 0);
    const errs = [...r.errsMs].sort((x, y) => x - y);
    const qe = (p: number) => errs[Math.min(errs.length - 1, Math.floor(p * errs.length))] ?? 0;
    let finalStatus: PlayerStatus | null = null;
    try {
      finalStatus = await playerStatus();
    } catch {
      finalStatus = statusRef.current;
    }
    const result = {
      kind: "player-render+transport",
      measured_s: sum / 1000,
      frames: deltas.length,
      avg_fps: deltas.length / (sum / 1000),
      frame_ms: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1] ?? 0 },
      over_8ms: deltas.filter((d) => d > 8).length,
      over_panel_budget: deltas.filter((d) => d > 1.5 * q(0.5)).length,
      over_60fps_budget: deltas.filter((d) => d > 16.9).length,
      over_34ms: deltas.filter((d) => d > 34).length,
      transport: {
        reports: clockRef.current.corrections + clockRef.current.snaps,
        corrections: clockRef.current.corrections,
        snaps: clockRef.current.snaps,
        jitter_ms: {
          p50: qe(0.5),
          p95: qe(0.95),
          max: errs[errs.length - 1] ?? 0,
        },
      },
      engine: finalStatus && {
        // Diffed over the measured window (session totals include the debug
        // build's load/engage transitions, which are not steady-state).
        stalls_in_window: finalStatus.stalls - r.startStalls,
        callbacks_in_window: finalStatus.callbacks - r.startCallbacks,
        stalls_session: finalStatus.stalls,
        callbacks: finalStatus.callbacks,
        max_gap_ms: finalStatus.max_gap_ms,
        mmcss: finalStatus.mmcss,
        stretch_engaged: finalStatus.stretch_engaged,
        device: finalStatus.device,
        pitch: finalStatus.pitch,
        tempo: finalStatus.tempo,
      },
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    };
    try {
      await measureWrite(JSON.stringify(result, null, 2));
      setMeasureNote(`measurement written (${result.frames} frames)`);
    } catch (e) {
      setMeasureNote(`measurement failed to write: ${e}`);
    }
    playerPause().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!props.measure || !status || status.state !== "playing" || rec.current.active) return;
    if (rec.current.startMs !== 0) return; // one run per mount
    rec.current.startMs = -1; // claim the run before any await
    (async () => {
      const plan = await measurePlan().catch(() => null);
      const seconds = plan?.seconds ?? 30;
      // Optional stretch settings: lets a run measure with the stretcher
      // engaged (interpolation at rate ≠ 1). Give the ~10 ms ramped engage +
      // priming a moment before the measured window starts.
      if (plan?.fullscreen) {
        await getCurrentWindow().setFullscreen(true).catch(() => undefined);
        setFullscreen(true);
      }
      if (plan?.pitch != null) await playerSetPitch(plan.pitch).catch(() => undefined);
      if (plan?.tempo != null) await playerSetTempo(plan.tempo).catch(() => undefined);
      if (plan?.pitch != null || plan?.tempo != null || plan?.fullscreen) {
        await new Promise((r) => window.setTimeout(r, 750));
      }
      let base: { stalls: number; callbacks: number } | null = null;
      try {
        base = await playerStatus();
      } catch {
        base = statusRef.current;
      }
      rec.current = {
        active: true,
        startMs: performance.now(),
        startStalls: base?.stalls ?? 0,
        startCallbacks: base?.callbacks ?? 0,
        deltas: [],
        errsMs: [],
        seconds,
      };
      setMeasureNote(`measuring ${seconds.toFixed(0)} s…`);
    })();
  }, [props.measure, status]);

  // ---- controls auto-hide -------------------------------------------------
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (statusRef.current?.state === "playing") setControlsVisible(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => {
    pokeControls();
    return () => {
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    };
  }, [pokeControls]);

  // ---- transport helpers --------------------------------------------------
  const togglePlay = useCallback(() => {
    const st = statusRef.current;
    if (!st) return;
    if (st.state === "playing") playerPause().catch((e) => setError(String(e)));
    else playerPlay().catch((e) => setError(String(e)));
  }, []);

  const seekBy = useCallback((delta: number) => {
    const st = statusRef.current;
    if (!st) return;
    const t = estimate(clockRef.current, performance.now());
    playerSeek(Math.max(0, Math.min(st.duration, t + delta))).catch((e) => setError(String(e)));
  }, []);

  const nudgeGuide = useCallback((delta: number) => {
    const st = statusRef.current;
    if (!st) return;
    playerSetGuide(Math.max(0, Math.min(1, st.guide + delta))).catch((e) => setError(String(e)));
  }, []);

  const nudgePitch = useCallback((delta: number) => {
    const st = statusRef.current;
    if (!st) return;
    playerSetPitch(Math.max(-6, Math.min(6, Math.round(st.pitch) + delta))).catch((e) =>
      setError(String(e)),
    );
  }, []);

  const nudgeTempo = useCallback((delta: number) => {
    const st = statusRef.current;
    if (!st) return;
    const next = Math.round((st.tempo + delta) * 100) / 100;
    playerSetTempo(Math.max(0.8, Math.min(1.2, next))).catch((e) => setError(String(e)));
  }, []);

  const toggleFullscreen = useCallback(() => {
    const win = getCurrentWindow();
    setFullscreen((f) => {
      win.setFullscreen(!f).catch(() => undefined);
      return !f;
    });
  }, []);

  const exit = useCallback(() => {
    getCurrentWindow()
      .setFullscreen(false)
      .catch(() => undefined);
    go(songId != null && song?.timing_map_path
      ? { view: "song", mapPath: song.timing_map_path, title: song.title, songId }
      : { view: "library" });
  }, [go, songId, song]);

  // Leaving the component must never strand the window in fullscreen.
  useEffect(
    () => () => {
      getCurrentWindow()
        .setFullscreen(false)
        .catch(() => undefined);
    },
    [],
  );

  // ---- keyboard (PLAN.md §3: keyboard controls; §4 step 5: guide one
  // keypress away). Media keys: deferred — module docs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      pokeControls();
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekBy(e.shiftKey ? -SEEK_STEP_BIG_S : -SEEK_STEP_S);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekBy(e.shiftKey ? SEEK_STEP_BIG_S : SEEK_STEP_S);
          break;
        case "ArrowUp":
          e.preventDefault();
          nudgeGuide(GUIDE_STEP);
          break;
        case "ArrowDown":
          e.preventDefault();
          nudgeGuide(-GUIDE_STEP);
          break;
        case "+":
        case "=":
          nudgePitch(1);
          break;
        case "-":
          nudgePitch(-1);
          break;
        case "[":
          nudgeTempo(-TEMPO_STEP);
          break;
        case "]":
          nudgeTempo(TEMPO_STEP);
          break;
        case "0":
          playerSetPitch(0).catch(() => undefined);
          playerSetTempo(1.0).catch(() => undefined);
          break;
        case "f":
        case "F":
        case "F11":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "Escape":
          if (fullscreen) {
            e.preventDefault();
            toggleFullscreen();
          } else {
            exit();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy, nudgeGuide, nudgePitch, nudgeTempo, toggleFullscreen, exit, fullscreen, pokeControls]);

  // ---- seek bar -----------------------------------------------------------
  const barClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const st = statusRef.current;
    if (!st || st.duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    playerSeek(f * st.duration).catch((err) => setError(String(err)));
  };

  const setWordEl = useCallback((i: number, el: HTMLSpanElement | null) => {
    wordEls.current[i] = el;
  }, []);
  const setLineEl = useCallback((i: number, el: HTMLDivElement | null) => {
    lineEls.current[i] = el;
  }, []);

  const finished = status?.state === "finished";

  return (
    <div
      className={`player-stage${controlsVisible ? "" : " controls-hidden"}`}
      onPointerMove={pokeControls}
      onClick={pokeControls}
    >
      {cover && (
        <div className="pk-backdrop" style={{ backgroundImage: `url(${cover})` }} aria-hidden />
      )}
      <div className="pk-scrim" aria-hidden />

      <header className="pk-header">
        <button className="pk-back" onClick={exit} title="Back (Esc)">
          <IconBack />
        </button>
        {cover && <img className="pk-cover" src={cover} alt="" />}
        <div className="pk-meta">
          <div className="pk-title">{title}</div>
          {song?.artist && <div className="pk-artist">{song.artist}</div>}
        </div>
        {measureNote && <div className="pk-measure-note">{measureNote}</div>}
        <button className="pk-fs" onClick={toggleFullscreen} title="Fullscreen (F / F11)">
          {fullscreen ? <IconCompress /> : <IconExpand />}
        </button>
      </header>

      {error && <div className="error-banner pk-error">{error}</div>}

      <div className="pk-viewport" ref={viewportRef}>
        {map ? (
          <div className="pk-scroller" ref={scrollerRef}>
            <LyricStage
              words={words}
              lines={lines}
              setWordEl={setWordEl}
              setLineEl={setLineEl}
            />
          </div>
        ) : (
          !error && <p className="muted pk-loading">Loading…</p>
        )}
        {finished && (
          <div className="pk-finished">
            <div className="pk-finished-title">That's the song!</div>
            {/* Queue auto-advance is milestone 4 — this stays a paused-at-end
                state on purpose. */}
            <div className="actions">
              <button className="primary big" onClick={() => playerPlay().catch(() => undefined)}>
                Sing it again
              </button>
              <button className="big" onClick={exit}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="pk-controls">
        <div
          className="pk-timebar"
          onClick={barClick}
          title="Click to seek · ←/→ ±5 s (Shift ±30 s)"
          role="slider"
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Math.round(status?.duration ?? 0)}
          aria-valuenow={Math.round(status?.position ?? 0)}
          tabIndex={0}
        >
          <div className="pk-timebar-fill" ref={fillRef} />
        </div>
        <div className="pk-controls-row">
          <button
            className="pk-play primary"
            onClick={togglePlay}
            disabled={!status}
            title="Play/pause (Space)"
          >
            {status?.state === "playing" ? <IconPause size={20} /> : <IconPlay size={20} />}
          </button>
          {/* transport annunciator — re-renders only on play/pause state
              changes (throttled status), never on the rAF path */}
          <span
            className={`pk-transport-word seg14${status?.state === "playing" ? " live" : ""}`}
            aria-hidden
          >
            {status == null ? "LOAD" : status.state === "playing" ? "PLAY" : "PAUS"}
          </span>
          <span className="pk-clock seg" ref={timeRef} />
          <div className="pk-guide" title="Vocal guide — blend the original vocal back in (↑/↓)">
            <span className="label">Guide</span>
            <DashSlider
              ariaLabel="Vocal guide level"
              min={0}
              max={100}
              step={5}
              value={Math.round((status?.guide ?? 0) * 100)}
              disabled={status?.single_source ?? false}
              onChange={(v) => playerSetGuide(v / 100).catch(() => undefined)}
            />
            <span className="pk-guide-val">
              {status?.single_source ? "n/a" : `${Math.round((status?.guide ?? 0) * 100)}%`}
            </span>
          </div>
          <div className="pk-stepper" title="Key change, ±6 semitones (− / +)">
            <button onClick={() => nudgePitch(-1)} disabled={!status} aria-label="Key down">−</button>
            <span>
              <span className="label">Key</span>{" "}
              <span className="seg">
                {status && status.pitch > 0 ? "+" : ""}
                {Math.round(status?.pitch ?? 0)}
              </span>
            </span>
            <button onClick={() => nudgePitch(1)} disabled={!status} aria-label="Key up">+</button>
          </div>
          <div className="pk-stepper" title="Tempo, 0.80–1.20x ([ / ])">
            <button onClick={() => nudgeTempo(-TEMPO_STEP)} disabled={!status} aria-label="Tempo down">−</button>
            <span>
              <span className="seg">{(status?.tempo ?? 1).toFixed(2)}</span>×
            </span>
            <button onClick={() => nudgeTempo(TEMPO_STEP)} disabled={!status} aria-label="Tempo up">+</button>
          </div>
          <span className="spacer" />
          <div className="pk-advanced-wrap">
            <button
              onClick={() => setAdvancedOpen((v) => !v)}
              disabled={!status}
              title="Advanced"
              className="with-icon"
            >
              <IconGear />
            </button>
            {advancedOpen && status && (
              <div className="pk-advanced">
                <div className="pk-advanced-row">
                  <span>Stretch quality</span>
                  <DashSelect
                    ariaLabel="Stretch quality"
                    value={status.stretch_config}
                    onChange={(v) =>
                      playerSetStretchConfig(v as StretchConfigName).catch(() => undefined)
                    }
                    options={[
                      { value: "default", label: "Default (smoothest)" },
                      { value: "low_latency", label: "Low latency (faster response)" },
                    ]}
                  />
                </div>
                <div className="pk-diag">
                  <div>device: {status.device ?? "—"}</div>
                  <div>
                    audio: {status.stalls} stalls · max gap {status.max_gap_ms.toFixed(1)} ms ·
                    mmcss {status.mmcss}
                  </div>
                  <div>
                    stretch: {status.stretch_engaged ? "engaged (−3 dB net, limited)" : "bypassed"}
                  </div>
                  <div>
                    transport jitter: max {clockRef.current.maxAbsErrorMs.toFixed(1)} ms ·{" "}
                    {clockRef.current.corrections} corrections · {clockRef.current.snaps} snaps
                  </div>
                  <div>renderer: DOM (canvas switch pending WebKitGTK numbers)</div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="pk-hints muted small">
          Space play/pause · ←/→ seek · ↑/↓ vocal guide · −/+ key · [ ] tempo · F fullscreen · Esc
          back
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memoized lyric DOM: rendered once per song; every per-frame mutation goes
// through the refs (see the render-loop docs above). Props are stable
// references, so React never reconciles this subtree during playback.
// ---------------------------------------------------------------------------

const LyricStage = memo(function LyricStage(props: {
  words: { word: string; unsung: boolean }[];
  lines: { indices: number[] }[];
  setWordEl: (i: number, el: HTMLSpanElement | null) => void;
  setLineEl: (i: number, el: HTMLDivElement | null) => void;
}) {
  return (
    <>
      {props.lines.map((ln, li) => (
        <div
          key={li}
          className={li === 0 ? "pk-line current" : li === 1 ? "pk-line next" : "pk-line"}
          ref={(el) => props.setLineEl(li, el)}
        >
          {ln.indices.map((wi) => {
            const w = props.words[wi];
            return (
              <span
                key={wi}
                className={`k-word${w.unsung ? " unsung" : ""}`}
                ref={(el) => props.setWordEl(wi, el)}
              >
                {w.word}
              </span>
            );
          })}
        </div>
      ))}
    </>
  );
});
