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
// ## Media keys
// navigator.mediaSession only hears keys when the page itself plays audio
// (ours plays through cpal), so the keys come from the OS media controls in
// Rust (media_keys.rs) as baritoad://media events: Play/Pause as Space,
// Next as the next song in Up next (Sing now between songs), Previous as
// back to the start, Stop as pause. The OS panel hears what's on from here.

import QrCode from "../party/QrCode";
import ToadIcon from "../party/ToadIcon";
import { partyLive, usePartyStatus } from "../party/usePartyStatus";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { availableMonitors, getCurrentWindow, type Monitor } from "@tauri-apps/api/window";
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
  onQueueChanged,
  onMediaKey,
  mediaNowPlaying,
  queueFinish,
  queuePlay,
  queueState,
  queueStop,
  readCover,
  readThemeImage,
  readTimingMap,
  vocalLevels,
  type PartyStatus,
  type PlayerStatus,
  type QueueState,
  type Song,
  type StretchConfigName,
  type TimingMap,
  type QueueEntry,
} from "../api";
import {
  EMPTY_QUEUE,
  due,
  startCountdown,
  tick,
  toggleHold,
  upNextOf,
  waiting,
  type Countdown,
} from "../queueView";
import { drawVisualizerFrame } from "../visualizer";
import {
  loadThemeStore,
  resolveTheme,
  saveThemeStore,
  themeById,
  themeCssVars,
  allThemes,
  DEFAULT_THEME,
  THEME_STORE_KEY,
  type ThemeSpec,
} from "../themes";
import { groupByLine } from "../highlight";
import { applyReport, estimate, initClock, type InterpClock } from "../playerClock";
import {
  activeGapAt,
  cueLineFlags,
  gapCues,
  lineFit,
  lyricFrameAt,
  pipsLitAt,
  scrollStep,
  UPCOMING_LEAD_S,
  type GapCue,
  type LyricFrame,
} from "../playerView";
import { fmtTime } from "../format";
import { useSettings, type Route } from "../App";
import { publishPrefs, subscribePrefs } from "../prefsSync";
import { ROLE, loadDisplay, saveDisplay, stageFocus, stageShowOn } from "../stage";
import {
  Button,
  CaptionButton,
  Checkbox,
  Dialog,
  DialogButtons,
  Glyph,
  GroupBox,
  Icon,
  Lcd,
  LcdText,
  Select,
  Spinner,
  Tip,
  TitleBar,
  Trackbar,
  Vr,
  isInOverlay,
  useMessageBox,
  useWindowState,
} from "../win98";
import "../win98/stage.css";

const SEEK_STEP_S = 5;
const SEEK_STEP_BIG_S = 30;
const GUIDE_STEP = 0.1;
const TEMPO_STEP = 0.05;
const CONTROLS_HIDE_MS = 3500;
/** With stretch on, `finished` can lead the audible end by ≤ ~120 ms, and
 *  loading the next song tears the stream down (player.rs "Song end"). */
const TAIL_MS = 150;

export default function PlayerView(props: {
  songId?: number;
  mapPath?: string;
  measure?: boolean;
  go: (r: Route) => void;
}) {
  const { songId, mapPath, go } = props;
  const [map, setMap] = useState<TimingMap | null>(null);

  // ---- theme: song pin → app default → Digital Dash (themes.ts) ----------
  // Themes restyle the lyric stage (background, colors, glow, font, pips) as
  // CSS vars + a static background layer; the console stays app chrome. The
  // advanced panel can re-pin the song's theme live.
  const [theme, setTheme] = useState<ThemeSpec>(() => resolveTheme(loadThemeStore(), songId));
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [themeBg, setThemeBg] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    if (theme.background.kind === "image") {
      readThemeImage(theme.background.path)
        .then((u) => !disposed && setThemeBg(u))
        .catch(() => !disposed && setThemeBg(null)); // image gone → cover/ground
    } else {
      setThemeBg(null);
    }
    return () => {
      disposed = true;
    };
  }, [theme]);
  // ---- visualizer: instrumental peak envelope → canvas layer -------------
  // Envelope from the cached-levels sidecar (deterministic through the
  // clock, no live audio tap — visualizer.ts docs). Mode/color ride refs so
  // the frame loop never re-registers on a theme change.
  const visCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const visCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const visEnvRef = useRef<{ peaks: number[]; bps: number } | null>(null);
  const visModeRef = useRef<"off" | "pulse" | "bars">("off");
  const visColorRef = useRef("#f2a33c");
  const reducedMotion = useMemo(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    [],
  );
  const visActive = theme.visualizer !== "off" && !reducedMotion;
  useEffect(() => {
    visModeRef.current = visActive ? theme.visualizer : "off";
    visColorRef.current = theme.accent;
    visCtxRef.current = null; // canvas may have (un)mounted with the mode
    const canvas = visCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [theme, visActive]);
  const pinTheme = (id: string) => {
    const store = loadThemeStore();
    if (songId != null) {
      const overrides = { ...store.songOverrides };
      if (id === "") delete overrides[String(songId)];
      else overrides[String(songId)] = id;
      const next = { ...store, songOverrides: overrides };
      saveThemeStore(next);
      publishPrefs(THEME_STORE_KEY, JSON.stringify(next));
      setTheme(resolveTheme(next, songId));
    } else {
      setTheme(themeById(store, id) ?? DEFAULT_THEME);
    }
  };
  // Theme edits made in the other window (Player Themes, a pin) apply live.
  useEffect(
    () =>
      subscribePrefs(THEME_STORE_KEY, () => {
        setTheme(resolveTheme(loadThemeStore(), songId));
      }),
    [songId],
  );
  const [song, setSong] = useState<Song | null>(null);

  // Visualizer envelope: the instrumental's cached peak levels, loaded when
  // the mode is on (visualizer.ts docs). Failure = quiet layer, never an
  // error state.
  useEffect(() => {
    let disposed = false;
    const inst = song?.instrumental_path;
    if (!visActive || !inst) {
      visEnvRef.current = null;
      return;
    }
    vocalLevels(inst)
      .then((l) => {
        if (!disposed) visEnvRef.current = { peaks: l.peaks, bps: l.bins_per_second };
      })
      .catch(() => {
        if (!disposed) visEnvRef.current = null; // no sidecar → quiet layer
      });
    return () => {
      disposed = true;
    };
  }, [visActive, song?.instrumental_path]);
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
  // Wait-cue instruments (gap meters + pips), rAF-mutated like the words.
  const gapRowEls = useRef<(HTMLDivElement | null)[]>([]);
  const gapFillEls = useRef<(HTMLDivElement | null)[]>([]);
  const gapSecsEls = useRef<(HTMLSpanElement | null)[]>([]);
  const gapTops = useRef<number[]>([]);
  const cueEls = useRef<(HTMLSpanElement | null)[]>([]);
  const prevGap = useRef<number | null>(null);
  const prevGapSecs = useRef<number | null>(null);
  const prevPips = useRef<{ line: number | null; lit: number }>({ line: null, lit: 0 });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const scrollY = useRef(0);
  const scrollVel = useRef(0);
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
  const gaps = useMemo(() => (map ? gapCues(lines, map.words) : []), [map, lines]);
  const cues = useMemo(
    () => (map && theme.pips ? cueLineFlags(lines, map.words) : []),
    [map, lines, theme.pips],
  );
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
      // In the stage window only Rust unloads (when the window closes): a
      // late Unload here could silence the next song (stage.rs docs).
      if (ROLE !== "player") playerUnload().catch(() => undefined);
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
        }
        // "completed" needs nothing here: the "finished" status that comes
        // with it drives the end of the song (below), TAIL_MS after it.
      });
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ---- line geometry (measured after layout; re-measured on resize) -------
  // One row per lyric line: each line's --fit shrinks its layout size until
  // the row fits the viewport (playerView.ts lineFit). Static per line — set
  // here and on resize, never in the rAF path, so wrap points stay
  // state-invariant and the Four-Hook contract is untouched.
  const fitLines = useCallback(() => {
    const els = lineEls.current.filter((el): el is HTMLDivElement => el != null);
    // Measure left-justified at --fit 1: with centered flex, start-side
    // overflow is not reliably part of scrollWidth.
    for (const el of els) {
      el.style.justifyContent = "flex-start";
      el.style.setProperty("--fit", "1");
      el.removeAttribute("data-overlong");
    }
    const fits = els.map((el) => lineFit(el.scrollWidth, el.clientWidth));
    els.forEach((el, i) => {
      el.style.justifyContent = "";
      const f = fits[i];
      if (f.scale < 1) el.style.setProperty("--fit", String(f.scale));
      if (f.wrap) el.setAttribute("data-overlong", "");
    });
  }, []);

  const measureLines = useCallback(() => {
    // Center of the element relative to the scroller, offset so the current
    // one sits at ~40% of the viewport height (singer looks slightly up).
    const vh = viewportRef.current?.clientHeight ?? window.innerHeight;
    const centerOf = (el: HTMLElement | null) =>
      el ? el.offsetTop + el.offsetHeight / 2 - vh * 0.4 : 0;
    lineTops.current = lineEls.current.map(centerOf);
    gapTops.current = gapRowEls.current.map(centerOf);
  }, []);

  // Visualizer canvas tracks the viewport size (CSS pixels — soft background
  // decoration doesn't earn DPR-scaled raster cost).
  const sizeVisualizer = useCallback(() => {
    const c = visCanvasRef.current;
    if (c && (c.width !== c.clientWidth || c.height !== c.clientHeight)) {
      c.width = c.clientWidth;
      c.height = c.clientHeight;
    }
  }, []);

  useLayoutEffect(() => {
    // Fit first — a line's --fit changes its height, which the offsets read.
    fitLines();
    measureLines();
    sizeVisualizer();
    const ro = new ResizeObserver(() => {
      fitLines();
      measureLines();
      sizeVisualizer();
    });
    if (viewportRef.current) ro.observe(viewportRef.current);
    if (scrollerRef.current) ro.observe(scrollerRef.current);
    return () => ro.disconnect();
  }, [map, visActive, fitLines, measureLines, sizeVisualizer]);

  // ---- the render loop ----------------------------------------------------
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    let lastNow = performance.now();
    const wordClass = (i: number, frame: LyricFrame): string => {
      let cls = "k-word";
      // The approaching word carries the same classes as the active one —
      // its ::before glow layer is what --glow-in eases in; fill stays 0.
      if (i === frame.activeWord || i === frame.approachWord) cls += " active wipe";
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
            if (el) {
              el.className = wordClass(frame.activeWord, frame);
              // If this word was approached, its glow was mid-ease — the
              // active state owns the full glow (mask carries the sweep).
              el.style.setProperty("--glow-in", "1");
            }
          }
        }
        if (prev.approachWord !== frame.approachWord) {
          if (prev.approachWord != null && prev.approachWord !== frame.activeWord) {
            const el = wordEls.current[prev.approachWord];
            if (el) el.className = wordClass(prev.approachWord, frame);
          }
          if (frame.approachWord != null) {
            const el = wordEls.current[frame.approachWord];
            if (el) {
              el.className = wordClass(frame.approachWord, frame);
              el.style.setProperty("--wipe", "0%");
              el.style.setProperty("--wipe-n", "0");
            }
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
      // Active-word wipe: two CSS vars on one element (--wipe drives the
      // fill gradient; --wipe-n is the same value unitless for the glow
      // mask's length calc — win98/stage.css ::before docs).
      if (frame.activeWord != null) {
        const el = wordEls.current[frame.activeWord];
        if (el) {
          const pct = (frame.wipe * 100).toFixed(1);
          el.style.setProperty("--wipe", `${pct}%`);
          el.style.setProperty("--wipe-n", pct);
        }
      }
      // Approach glow: one var on the single word a pause is leading into
      // (the active-word hook is idle whenever this one runs).
      if (frame.approachWord != null) {
        const el = wordEls.current[frame.approachWord];
        // Reduced motion: no fade toward it; the glow arrives with the word.
        if (el) el.style.setProperty("--glow-in", reducedMotion ? "0" : frame.approach.toFixed(3));
      }
      prevFrame.current = frame;

      // Wait cues (amended render contract — DESIGN.md Four-Hook Rule):
      // the counting gap's meter width + whole-second readout, and the
      // upcoming line's pip count. Each mutates one small element, only on
      // change.
      const gi = activeGapAt(gaps, t);
      if (gi !== prevGap.current) {
        if (prevGap.current != null) {
          gapRowEls.current[prevGap.current]?.classList.remove("counting");
        }
        if (gi != null) gapRowEls.current[gi]?.classList.add("counting");
        prevGap.current = gi;
        prevGapSecs.current = null;
      }
      if (gi != null) {
        const g = gaps[gi];
        const remain = Math.max(0, g.end - t);
        const fill = gapFillEls.current[gi];
        if (fill && g.end > g.start) {
          fill.style.width = `${((remain / (g.end - g.start)) * 100).toFixed(2)}%`;
        }
        const secs = Math.ceil(remain);
        if (secs !== prevGapSecs.current) {
          prevGapSecs.current = secs;
          const el = gapSecsEls.current[gi];
          if (el) el.textContent = String(secs);
        }
      }
      // Pips live on the current or next line only (lineIndexAt pre-rolls
      // the upcoming line, so the countdown target is always one of these).
      let pipLine: number | null = null;
      let pipsLit = 0;
      for (const li of [frame.lineIndex, frame.lineIndex + 1]) {
        if (!cues[li] || !lines[li]) continue;
        const lit = pipsLitAt(map.words[lines[li].indices[0]].start, t);
        if (lit > 0) {
          pipLine = li;
          pipsLit = lit;
          break;
        }
      }
      if (prevPips.current.line !== pipLine || prevPips.current.lit !== pipsLit) {
        if (prevPips.current.line != null && prevPips.current.line !== pipLine) {
          const el = cueEls.current[prevPips.current.line];
          if (el) el.dataset.lit = "0";
        }
        if (pipLine != null) {
          const el = cueEls.current[pipLine];
          if (el) el.dataset.lit = String(pipsLit);
        }
        prevPips.current = { line: pipLine, lit: pipsLit };
      }

      // Smooth scroll toward the current line — or the counting wait-meter,
      // until the upcoming line takes over (same lead as lineIndexAt).
      const target =
        gi != null && gaps[gi].end - t > UPCOMING_LEAD_S
          ? (gapTops.current[gi] ?? lineTops.current[frame.lineIndex] ?? 0)
          : (lineTops.current[frame.lineIndex] ?? 0);
      // Critically damped glide — velocity survives retargeting, so a line
      // switch bends the scroll's trajectory instead of kicking it (owner
      // asked for smoother motion; pace ≈ the old 260 ms glide).
      // Reduced motion: straight to the line, no glide.
      const glide = reducedMotion ? { pos: target, vel: 0 } : scrollStep(scrollY.current, scrollVel.current, target, dt);
      scrollY.current = glide.pos;
      scrollVel.current = glide.vel;
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

      // Visualizer layer: one bounded canvas draw per frame (envelope math
      // in visualizer.ts is pure and allocation-light). Off-mode and no-
      // envelope both skip entirely.
      const visMode = visModeRef.current;
      const visCanvas = visCanvasRef.current;
      const visEnv = visEnvRef.current;
      if (visMode !== "off" && visCanvas && visEnv) {
        const ctx =
          visCtxRef.current ?? (visCtxRef.current = visCanvas.getContext("2d"));
        if (ctx) {
          drawVisualizerFrame(
            ctx,
            visCanvas.width,
            visCanvas.height,
            visMode,
            visEnv.peaks,
            visEnv.bps,
            t,
            visColorRef.current,
          );
        }
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
  }, [map, lines, gaps, cues]);

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
      theme: { id: themeRef.current.id, visualizer: themeRef.current.visualizer, glow: themeRef.current.glow },
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
      // Optional theme (e.g. the heaviest built-in, DESIGN.md Four-Hook Rule):
      // applied for this run only, given the same settle time.
      const measureTheme = plan?.theme ? themeById(loadThemeStore(), plan.theme) : undefined;
      if (measureTheme) setTheme(measureTheme);
      if (plan?.pitch != null || plan?.tempo != null || plan?.fullscreen || measureTheme) {
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
    // Below 0 the guide over-subtracts the vocal estimate — a deeper cut
    // into leftover vocal residue (mixer GUIDE_MIN).
    playerSetGuide(Math.max(-0.5, Math.min(1, st.guide + delta))).catch((e) =>
      setError(String(e)),
    );
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

  // ---- window: full screen, leaving -------------------------------------
  // Full-screen state is read back from the window (the title bar's maximize
  // and the OS can change it too), never assumed.
  useEffect(() => {
    let disposed = false;
    const unlisten: (() => void)[] = [];
    const w = getCurrentWindow();
    const sync = () =>
      w
        .isFullscreen()
        .then((f) => !disposed && setFullscreen(f))
        .catch(() => undefined);
    sync();
    w.onResized(() => sync())
      .then((u) => (disposed ? u() : unlisten.push(u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const win = getCurrentWindow();
    setFullscreen((f) => {
      win.setFullscreen(!f).catch(() => undefined);
      return !f;
    });
  }, []);

  const exit = useCallback(() => {
    // Leaving mid-song: the queued entry stays first in Up next, unmarked.
    queueStop().catch(() => undefined);
    if (ROLE === "player") {
      // Closing the stage unloads the engine (Rust) and hands focus back.
      getCurrentWindow()
        .close()
        .catch(() => undefined);
      return;
    }
    getCurrentWindow()
      .setFullscreen(false)
      .catch(() => undefined);
    go(songId != null && song?.timing_map_path
      ? { view: "song", mapPath: song.timing_map_path, title: song.title, songId }
      : { view: "library" });
  }, [go, songId, song]);

  // Leaving the in-window player must never strand the main window in full
  // screen. (The stage window keeps its full screen across songs.)
  useEffect(
    () => () => {
      if (ROLE === "player") return;
      getCurrentWindow()
        .setFullscreen(false)
        .catch(() => undefined);
    },
    [],
  );

  // ---- queue: the "Up next" caption and what comes after this song -------
  // Rust owns the queue (library.rs) and emits it on every change, from
  // either window; the focus refetch is only a fallback.
  const [queue, setQueue] = useState<QueueState>(EMPTY_QUEUE);
  const party = usePartyStatus();
  const queueRef = useRef(queue);
  queueRef.current = queue;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const load = () =>
      queueState()
        .then((q) => !disposed && setQueue(q ?? EMPTY_QUEUE))
        .catch(() => undefined);
    load();
    onQueueChanged((q) => !disposed && setQueue(q))
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("focus", load);
    };
  }, []);
  const upNext = waiting(queue).find((e) => e.song.id !== songId) ?? null;

  const finishedAt = useRef<number | null>(null);
  const singEntry = useCallback(
    async (e: QueueEntry) => {
      const since = finishedAt.current == null ? Infinity : performance.now() - finishedAt.current;
      if (since < TAIL_MS) await new Promise((r) => window.setTimeout(r, TAIL_MS - since));
      try {
        await queuePlay(e.id);
      } catch (err) {
        setError(String(err));
        return;
      }
      // The same song queued twice: no new route, so play it from here.
      if (e.song.id === songId) playerPlay().catch(() => undefined);
      else if (ROLE === "player") window.location.hash = `#/play?id=${e.song.id}`;
      else go({ view: "play", songId: e.song.id });
    },
    [go, songId],
  );

  // ---- the end of the song ------------------------------------------------
  // The between-songs screen: something queued → it counts down to it (or
  // waits, when automatic advance is off); nothing queued → "That's the
  // song!", until someone queues a song in the Library. It belongs to this
  // view, so it never outlives the song (a message box would).
  const ask = useMessageBox();
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const exitRef = useRef(exit);
  exitRef.current = exit;
  const [between, setBetween] = useState<{ next: QueueEntry | null; cd: Countdown } | null>(null);
  const finished = status?.state === "finished";
  const askedEnd = useRef(false);
  const freshCountdown = () => startCountdown(settingsRef.current.advanceSeconds, settingsRef.current.autoAdvance);

  useEffect(() => {
    if (!finished) {
      askedEnd.current = false;
      finishedAt.current = null;
      setBetween(null);
      return;
    }
    if (askedEnd.current || props.measure) return;
    askedEnd.current = true;
    finishedAt.current = performance.now();
    void (async () => {
      let q = queueRef.current;
      if (songId != null) q = await queueFinish(songId).catch(() => q);
      setQueue(q);
      setBetween({ next: upNextOf(q), cd: freshCountdown() });
    })();
    // Runs once per finish; the rest is read through refs.
  }, [finished, props.measure]); // eslint-disable-line react-hooks/exhaustive-deps

  // Up next changed while the screen is up (someone queued or removed a
  // song in the Library): follow it. A song arriving after "That's the
  // song!" gets a fresh countdown.
  useEffect(() => {
    if (!between) return;
    const next = upNextOf(queue);
    if (next?.id === between.next?.id) return;
    setBetween((b) => b && { next, cd: next && !b.next ? freshCountdown() : b.cd });
  }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!between?.next || between.cd.held) return;
    if (due(between.cd)) {
      const next = between.next;
      setBetween(null);
      void singEntry(next);
      return;
    }
    const t = window.setTimeout(() => setBetween((b) => b && { ...b, cd: tick(b.cd) }), 1000);
    return () => window.clearTimeout(t);
  }, [between, singEntry]);

  const betweenRef = useRef(between);
  betweenRef.current = between;
  const singNow = useCallback(() => {
    const b = betweenRef.current;
    if (!b?.next) return;
    setBetween(null);
    void singEntry(b.next);
  }, [singEntry]);
  const holdOrGo = useCallback(() => setBetween((b) => b && { ...b, cd: toggleHold(b.cd) }), []);
  const singAgain = useCallback(() => {
    setBetween(null);
    playerPlay().catch(() => undefined);
  }, []);
  const doneSinging = useCallback(() => {
    setBetween(null);
    exitRef.current();
  }, []);

  const [nextCover, setNextCover] = useState<string | null>(null);
  const nextCoverPath = between?.next?.song.cover_path ?? null;
  useEffect(() => {
    setNextCover(null);
    if (!nextCoverPath) return;
    let alive = true;
    readCover(nextCoverPath)
      .then((url) => alive && setNextCover(url))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [nextCoverPath]);

  // The key list is F1 (and each control's tooltip) — never a strip of
  // hints on the TV itself.
  const showKeys = useCallback(
    () =>
      ask({
        kind: "info",
        title: "Keyboard Shortcuts",
        message: "Player",
        detail: (
          <div style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: "2px 12px" }}>
            {(
              [
                ["Space", "Play / pause"],
                ["← →", "Back / forward 5 s (Shift: 30 s)"],
                ["↑ ↓", "Vocal guide up / down"],
                ["− +", "Key down / up"],
                ["[ ]", "Slower / faster"],
                ["0", "Reset key and tempo"],
                ["Media keys", "Play / pause, the next song, start over"],
                ["F", "Full screen"],
                ...(ROLE === "player" ? [["F6", "Back to baritoad"]] : []),
                ["Esc", ROLE === "player" ? "Close the stage" : "Back"],
                ["", ""],
                ["Between songs", ""],
                ["Enter", "Sing the next song now"],
                ["Space", "Wait / go on"],
                ["Esc", "Done"],
              ] as [string, string][]
            ).map(([k, v], i) => (
              <div key={i} style={{ display: "contents" }}>
                {v === "" && k !== "" ? <b style={{ gridColumn: "1 / -1" }}>{k}</b> : (
                  <>
                    <span>{k}</span>
                    <span>{v}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        ),
      }),
    [ask],
  );

  // ---- keyboard (PLAN.md §3: keyboard controls; §4 step 5: guide one
  // keypress away). Media keys: deferred — module docs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInOverlay()) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      pokeControls();
      // Between songs: Enter sings the next one now, Space waits (or goes
      // on waiting), Esc is Done. A focused button keeps its own Enter/Space.
      if (betweenRef.current && !(tag === "BUTTON" && (e.key === "Enter" || e.key === " "))) {
        const hasNext = !!betweenRef.current.next;
        if (e.key === "Enter") {
          e.preventDefault();
          if (hasNext) singNow();
          else doneSinging();
          return;
        }
        if (e.key === " ") {
          e.preventDefault();
          if (hasNext) holdOrGo();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          doneSinging();
          return;
        }
      }
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
        case "F6":
          if (ROLE === "player") {
            e.preventDefault();
            void stageFocus("main");
          }
          break;
        case "F1":
          e.preventDefault();
          void showKeys();
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
  }, [togglePlay, seekBy, nudgeGuide, nudgePitch, nudgeTempo, toggleFullscreen, exit, fullscreen, pokeControls, showKeys, singNow, holdOrGo, doneSinging]);

  // ---- media keys (module docs) and the OS "now playing" panel ------------
  const upNextRef = useRef(upNext);
  upNextRef.current = upNext;
  useEffect(() => {
    if (props.measure) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onMediaKey((k) => {
      pokeControls();
      const between = betweenRef.current;
      const st = statusRef.current;
      if (between) {
        if ((k === "play" || k === "toggle" || k === "next") && between.next) singNow();
        else if (k === "pause" && between.next && !between.cd.held) holdOrGo();
        return;
      }
      if (k === "toggle") togglePlay();
      else if (k === "play" && st?.state !== "playing") playerPlay().catch(() => undefined);
      else if ((k === "pause" || k === "stop") && st?.state === "playing") playerPause().catch(() => undefined);
      else if (k === "previous") playerSeek(0).catch(() => undefined);
      else if (k === "next" && upNextRef.current) void singEntry(upNextRef.current);
    })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [props.measure, pokeControls, togglePlay, singNow, holdOrGo, singEntry]);

  const osState = status?.state === "playing" ? "playing" : status?.state === "paused" || status?.state === "finished" ? "paused" : "stopped";
  useEffect(() => {
    if (props.measure) return;
    mediaNowPlaying({
      title: song?.title ?? null,
      artist: song?.artist ?? null,
      duration_s: statusRef.current?.duration ?? song?.duration_s ?? null,
      state: osState,
      position_s: statusRef.current?.position ?? null,
    }).catch(() => undefined);
  }, [song, osState, props.measure]);
  useEffect(
    () => () => {
      mediaNowPlaying({ state: "stopped" }).catch(() => undefined);
    },
    [],
  );

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
  const setGapRowEl = useCallback((i: number, el: HTMLDivElement | null) => {
    gapRowEls.current[i] = el;
  }, []);
  const setGapFillEl = useCallback((i: number, el: HTMLDivElement | null) => {
    gapFillEls.current[i] = el;
  }, []);
  const setGapSecsEl = useCallback((i: number, el: HTMLSpanElement | null) => {
    gapSecsEls.current[i] = el;
  }, []);
  const setCueEl = useCallback((i: number, el: HTMLSpanElement | null) => {
    cueEls.current[i] = el;
  }, []);

  // Themed background layer: color = flat paint; image = imported picture
  // with the theme's blur/dim; cover = the song's art.
  const bg = theme.background;
  const bgFilter =
    bg.kind === "color"
      ? undefined
      : `blur(${bg.blurPx}px) brightness(${Math.max(0, 1 - bg.dim).toFixed(2)})`;
  const bgImage = bg.kind === "image" ? themeBg : bg.kind === "cover" ? cover : null;

  const { active: windowActive } = useWindowState();
  const guide = status?.guide ?? 0;
  const guideText = status?.single_source
    ? "n/a"
    : guide < 0
      ? `cut ${Math.round(-guide * 100)}%`
      : `${Math.round(guide * 100)}%`;

  return (
    <div className="w98" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "#000010" }}>
      {ROLE === "player" && !fullscreen && (
        <StageTitleBar title={song ? `${song.title} - baritoad Stage` : "baritoad Stage"} active={windowActive} onClose={exit} />
      )}
      <div style={{ position: "relative", flexGrow: 1, minHeight: 0 }}>
        <div
          className={`player-stage${controlsVisible ? "" : " controls-hidden"}`}
          style={themeCssVars(theme) as CSSProperties}
          onPointerMove={pokeControls}
          onClick={pokeControls}
        >
          {bg.kind === "color" ? (
            <div className="pk-backdrop flat" style={{ backgroundColor: bg.color }} aria-hidden />
          ) : (
            bgImage && (
              <div
                className="pk-backdrop"
                style={{ backgroundImage: `url(${bgImage})`, filter: bgFilter }}
                aria-hidden
              />
            )
          )}
          <div className="pk-scrim" aria-hidden />
          {visActive && <canvas className="pk-vis" ref={visCanvasRef} aria-hidden />}

          {between && (
            <BetweenSongs
              next={between.next}
              party={party}
              waiting={queue.entries.filter((e) => e.id !== queue.playing)}
              cd={between.cd}
              cover={nextCover}
              onSingNow={singNow}
              onHold={holdOrGo}
              onAgain={singAgain}
              onDone={doneSinging}
            />
          )}

          {!between && (
          <div className="pk-caption left w98 w-window" style={{ width: 320 }}>
            <TitleBar title="Now singing" active />
            <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 8px 6px" }}>
              <div className="w-sunken" style={{ width: 44, height: 44, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#008080" }}>
                {cover ? <img src={cover} alt="" style={{ width: 40, height: 40, objectFit: "cover" }} /> : <Icon name="disc" size={32} />}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <b style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{song?.title ?? (map ? title : error ? "Couldn't load the song" : "Loading…")}</b>
                {song?.artist && <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{song.artist}</span>}
                {measureNote && <span className="w-muted">{measureNote}</span>}
              </div>
            </div>
          </div>
          )}

          {upNext && !between && (
            <div className="pk-caption right w98 w-window" style={{ width: 260 }}>
              <TitleBar title="Up next" active={false} />
              <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                <b style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{upNext.song.title}</b>
                {upNext.song.artist && <span>{upNext.song.artist}</span>}
              </div>
            </div>
          )}

          {error && (
            <div className="pk-caption left w98 w-window" style={{ top: 110, maxWidth: 520 }} role="alert">
              <TitleBar title="baritoad Player" active />
              <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 10, userSelect: "text" }}>
                <Icon name="error" size={32} />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div className="pk-viewport" ref={viewportRef}>
            {map ? (
              <div className="pk-scroller" ref={scrollerRef}>
                <LyricStage
                  words={words}
                  lines={lines}
                  gaps={gaps}
                  cues={cues}
                  setWordEl={setWordEl}
                  setLineEl={setLineEl}
                  setGapRowEl={setGapRowEl}
                  setGapFillEl={setGapFillEl}
                  setGapSecsEl={setGapSecsEl}
                  setCueEl={setCueEl}
                />
              </div>
            ) : (
              !error && <p className="pk-loading">Loading…</p>
            )}
          </div>

          <div className="pk-dock w98 w-window" onPointerMove={pokeControls}>
            <TitleBar title="baritoad Player" icon={<Icon name="app" />} active>
              <CaptionButton glyph="close" label={ROLE === "player" ? "Close the stage (Esc)" : "Back (Esc)"} onClick={exit} />
            </TitleBar>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 6px 4px" }}>
              <Button size="sq" onClick={togglePlay} disabled={!status} aria-label={status?.state === "playing" ? "Pause" : "Play"} tip="Play / pause (Space)">
                <Glyph name={status?.state === "playing" ? "pause" : "play"} />
              </Button>
              <Button size="sq" onClick={() => seekBy(-SEEK_STEP_S)} disabled={!status} aria-label="Back 5 seconds" tip="Back 5 s (←)">
                <Glyph name="prev" />
              </Button>
              <Button size="sq" onClick={() => seekBy(SEEK_STEP_S)} disabled={!status} aria-label="Forward 5 seconds" tip="Forward 5 s (→)">
                <Glyph name="next" />
              </Button>
              <Lcd label="Position">
                <span className="pk-clock" ref={timeRef} style={{ fontSize: 16 }} />
              </Lcd>
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
                {/* Streaming-load progress (throttled status re-render, never
                    the rAF path); gone once fully loaded. */}
                {status != null && status.duration > 0 && status.loaded_seconds < status.duration && (
                  <div
                    className="pk-timebar-loaded"
                    style={{ width: `${Math.min(100, (status.loaded_seconds / status.duration) * 100).toFixed(1)}%` }}
                  />
                )}
                <div className="pk-timebar-fill" ref={fillRef} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px 8px" }}>
              <span title="Blend the original vocal back in; below 0 cuts leftover vocal harder (↑/↓)">Vocal guide</span>
              <Trackbar
                value={Math.round(guide * 100)}
                onChange={(v) => playerSetGuide(v / 100).catch(() => undefined)}
                min={-50}
                max={100}
                step={5}
                ticks={7}
                width={170}
                ariaLabel="Vocal guide level"
                valueText={guideText}
                disabled={!status || status.single_source}
              />
              <span style={{ width: 62 }}>{guideText}</span>
              <Vr style={{ height: 22 }} />
              <Tip tip="Key down / up (− +)">
                <label htmlFor="pk-key">Key</label>
              </Tip>
              <Spinner
                id="pk-key"
                value={Math.round(status?.pitch ?? 0)}
                onChange={(v) => playerSetPitch(Math.max(-6, Math.min(6, Math.round(v)))).catch(() => undefined)}
                min={-6}
                max={6}
                step={1}
                ariaLabel="Key"
                format={{ signDisplay: "exceptZero" }}
                width={64}
                disabled={!status}
              />
              <Vr style={{ height: 22 }} />
              <Tip tip="Slower / faster ([ ])">
                <label htmlFor="pk-tempo">Tempo</label>
              </Tip>
              <Spinner
                id="pk-tempo"
                value={status?.tempo ?? 1}
                onChange={(v) => playerSetTempo(Math.max(0.8, Math.min(1.2, Math.round(v * 100) / 100))).catch(() => undefined)}
                min={0.8}
                max={1.2}
                step={TEMPO_STEP}
                ariaLabel="Tempo"
                format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }}
                width={72}
                disabled={!status}
              />
              <span>×</span>
              <span className="w-grow" />
              <Button onClick={() => setAdvancedOpen(true)} disabled={!status}>
                &Options…
              </Button>
              <Button onClick={toggleFullscreen} tip="Full screen (F) · all keys: F1">
                {fullscreen ? "Exit full screen" : "&Full screen"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {status && (
        <PlayerOptions
          open={advancedOpen}
          onClose={() => setAdvancedOpen(false)}
          status={status}
          themeId={theme.id}
          onTheme={pinTheme}
          jitter={clockRef.current}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stage window's own caption (frameless window; shown when not full
// screen). Drag to move it to the TV; double-click to maximize.
// ---------------------------------------------------------------------------

function StageTitleBar(props: { title: string; active: boolean; onClose: () => void }) {
  const w = () => getCurrentWindow();
  return (
    <div className="w-window" style={{ padding: 3, flexShrink: 0 }}>
      <TitleBar title={props.title} icon={<Icon name="tv" />} active={props.active} drag>
        <CaptionButton glyph="min" label="Minimize" onClick={() => void w().minimize().catch(() => undefined)} />
        <CaptionButton glyph="max" label="Maximize" onClick={() => void w().toggleMaximize().catch(() => undefined)} />
        <CaptionButton glyph="close" label="Close" onClick={props.onClose} />
      </TitleBar>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Between songs (PLAN.md §3 up-next queue): who's next, the countdown, and
// the four ways on. Static React only — the lyric frame loop is idle once a
// song has finished, and the Four-Hook Rule is untouched.
// ---------------------------------------------------------------------------

function BetweenSongs(props: {
  /** Null: nothing is queued — "That's the song!". */
  next: QueueEntry | null;
  /** While a party is open: the join code and who's waiting. */
  party: PartyStatus;
  waiting: QueueEntry[];
  cd: Countdown;
  cover: string | null;
  onSingNow: () => void;
  onHold: () => void;
  onAgain: () => void;
  onDone: () => void;
}) {
  const { next, cd } = props;
  return (
    <div className="pk-between">
      <div className="pk-between-card w98 w-window" role="dialog" aria-labelledby="pk-between-t">
        <TitleBar title={next ? "Up next" : "baritoad Player"} icon={<Icon name={next ? "queue" : "app"} />} active />
        <div className="pk-between-body">
          <div className="w-sunken pk-between-cover">
            {next && props.cover ? <img src={props.cover} alt="" /> : <Icon name="disc" size={96} />}
          </div>
          {next ? (
            <div className="pk-between-text">
              <b id="pk-between-t">{next.song.title}</b>
              {next.song.artist && <span>{next.song.artist}</span>}
              {next.singer && (
                <span className="pk-between-singer">
                  {next.toad && <ToadIcon toad={next.toad} scale={2} />}
                  {next.singer}
                </span>
              )}
              <div className="pk-between-count">
                {cd.held ? (
                  <span>Press Enter when the next singer is ready.</span>
                ) : (
                  <>
                    <span>Starting in</span>
                    <Lcd label="Seconds until the next song">
                      <LcdText value={String(cd.left)} size={40} digits={2} />
                    </Lcd>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="pk-between-text">
              <b id="pk-between-t">That's the song!</b>
              <span>Nothing else is in Up next.</span>
            </div>
          )}
        </div>
        <DialogButtons>
          {next && (
            <>
              <Button isDefault onClick={props.onSingNow}>
                Sing &now
              </Button>
              <Button onClick={props.onHold}>{cd.held ? "&Count down" : "&Wait"}</Button>
            </>
          )}
          <Button onClick={props.onAgain}>Sing it &again</Button>
          <Button isDefault={!next} onClick={props.onDone}>
            &Done
          </Button>
        </DialogButtons>
      </div>
      {partyLive(props.party) && props.party.qr && (
        <div className="pk-join w98 w-window" aria-labelledby="pk-join-t">
          <TitleBar title="Join the party" icon={<Icon name="globe" />} active={false} />
          <div className="pk-join-body">
            <QrCode qr={props.party.qr} px={232} label="QR code: scan with your phone's camera to join" />
            <b id="pk-join-t">Scan to join</b>
            <span className="pk-join-url">{props.party.join_url?.replace(/^https?:\/\//, "")}</span>
            {props.waiting.length > 0 && (
              <ol className="pk-join-queue" aria-label="Up next">
                {props.waiting.slice(0, 5).map((e) => (
                  <li key={e.id}>
                    {e.toad ? <ToadIcon toad={e.toad} scale={2} /> : <span className="pk-join-notoad" />}
                    <span className="pk-join-who">{e.singer ?? "—"}</span>
                    <span className="pk-join-song">{e.song.title}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Player Options: the stage theme for this song and which display the stage
// lives on. Stretch quality and the audio/clock diagnostics are developer
// readouts — dev builds only, never on the party host's screen.
// ---------------------------------------------------------------------------

function PlayerOptions(props: {
  open: boolean;
  onClose: () => void;
  status: PlayerStatus;
  themeId: string;
  onTheme: (id: string) => void;
  jitter: InterpClock;
}) {
  const { status } = props;
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [display, setDisplay] = useState(() => loadDisplay());
  useEffect(() => {
    if (!props.open || ROLE !== "player") return;
    availableMonitors()
      .then((m) => setMonitors(m ?? []))
      .catch(() => setMonitors([]));
  }, [props.open]);
  const keyOf = (m: Monitor) => `${m.position.x},${m.position.y}`;
  const current = display ? `${display.x},${display.y}` : "";
  const showOn = (key: string, fullscreen: boolean) => {
    const m = monitors.find((x) => keyOf(x) === key);
    if (!m) return;
    const d = { name: m.name, x: m.position.x, y: m.position.y, fullscreen };
    setDisplay(d);
    saveDisplay(d);
    stageShowOn(d).catch(() => undefined);
  };
  return (
    <Dialog open={props.open} onClose={props.onClose} title="Player Options" width={460}>
      <div className="w-dialog-body" style={{ gap: 4 }}>
        <GroupBox label="Stage">
          <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 8, alignItems: "center" }}>
            <label htmlFor="po-theme">Theme for this song</label>
            <Select
              id="po-theme"
              value={props.themeId}
              onChange={props.onTheme}
              options={allThemes(loadThemeStore()).map((t) => ({ value: t.id, label: t.name }))}
            />
          </div>
        </GroupBox>
        {ROLE === "player" && (
          <GroupBox label="Display">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 8, alignItems: "center" }}>
                <label htmlFor="po-display">Show on</label>
                <Select
                  id="po-display"
                  value={current}
                  onChange={(k) => showOn(k, display?.fullscreen ?? true)}
                  options={[
                    ...(current && !monitors.some((m) => keyOf(m) === current) ? [{ value: current, label: "Saved display (not connected)" }] : []),
                    ...(current ? [] : [{ value: "", label: "Where I left it" }]),
                    ...monitors.map((m, i) => ({
                      value: keyOf(m),
                      label: `${m.name ?? `Display ${i + 1}`} — ${m.size.width}×${m.size.height}`,
                    })),
                  ]}
                />
              </div>
              <Checkbox
                checked={display?.fullscreen ?? false}
                onChange={(v) => display && showOn(current, v)}
                disabled={!display}
                label="Open &full screen on that display"
              />
            </div>
          </GroupBox>
        )}
        {import.meta.env.DEV && (
          <>
            <GroupBox label="Sound">
              <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 8, alignItems: "center" }}>
                <label htmlFor="po-stretch">Stretch quality</label>
                <Select
                  id="po-stretch"
                  value={status.stretch_config}
                  onChange={(v) => playerSetStretchConfig(v as StretchConfigName).catch(() => undefined)}
                  options={[
                    { value: "default", label: "Default (smoothest)" },
                    { value: "low_latency", label: "Low latency (faster response)" },
                  ]}
                />
              </div>
            </GroupBox>
            <GroupBox label="Diagnostics">
              <div style={{ display: "flex", flexDirection: "column", gap: 4, lineHeight: "16px", userSelect: "text" }}>
                <div>Device: {status.device ?? "—"}</div>
                <div>
                  Audio: {status.stalls} stalls · max gap {status.max_gap_ms.toFixed(1)} ms · MMCSS {status.mmcss}
                </div>
                <div>Stretch: {status.stretch_engaged ? "engaged (−3 dB net, limited)" : "bypassed"}</div>
                <div>
                  Transport jitter: max {props.jitter.maxAbsErrorMs.toFixed(1)} ms · {props.jitter.corrections} corrections ·{" "}
                  {props.jitter.snaps} snaps
                </div>
                <div>Renderer: DOM</div>
              </div>
            </GroupBox>
          </>
        )}
      </div>
      <DialogButtons>
        <Button isDefault onClick={props.onClose}>
          Close
        </Button>
      </DialogButtons>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Memoized lyric DOM: rendered once per song; every per-frame mutation goes
// through the refs (see the render-loop docs above). Props are stable
// references, so React never reconciles this subtree during playback.
// ---------------------------------------------------------------------------

const LyricStage = memo(function LyricStage(props: {
  words: { word: string }[];
  lines: { indices: number[] }[];
  gaps: GapCue[];
  cues: boolean[];
  setWordEl: (i: number, el: HTMLSpanElement | null) => void;
  setLineEl: (i: number, el: HTMLDivElement | null) => void;
  setGapRowEl: (i: number, el: HTMLDivElement | null) => void;
  setGapFillEl: (i: number, el: HTMLDivElement | null) => void;
  setGapSecsEl: (i: number, el: HTMLSpanElement | null) => void;
  setCueEl: (i: number, el: HTMLSpanElement | null) => void;
}) {
  const gapBefore = new Map(props.gaps.map((g, gi) => [g.afterLine + 1, gi]));
  return (
    <>
      {props.lines.map((ln, li) => {
        const gi = gapBefore.get(li);
        return (
          <Fragment key={li}>
            {gi != null && (
              // The wait-meter: a draining segmented amber bar + whole-second
              // readout for long instrumental gaps. Resting rows preview the
              // full wait dimly; the rAF loop drives the counting one.
              <div className="pk-gap" aria-hidden ref={(el) => props.setGapRowEl(gi, el)}>
                <span className="pk-gap-word">Wait</span>
                <div className="pk-gap-meter">
                  <div className="pk-gap-meter-fill" ref={(el) => props.setGapFillEl(gi, el)} />
                </div>
                <span className="pk-gap-secs" ref={(el) => props.setGapSecsEl(gi, el)}>
                  {Math.ceil(props.gaps[gi].end - props.gaps[gi].start)}
                </span>
              </div>
            )}
            <div
              className={li === 0 ? "pk-line current" : li === 1 ? "pk-line next" : "pk-line"}
              ref={(el) => props.setLineEl(li, el)}
            >
              {props.cues[li] && (
                // 3-2-1 countdown pips into the first word (zero-width anchor
                // — showing them never re-flows the line).
                <span
                  className="pk-cue"
                  data-lit="0"
                  aria-hidden
                  ref={(el) => props.setCueEl(li, el)}
                >
                  <span className="pk-cue-pips">
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
              )}
              {ln.indices.map((wi) => {
                const w = props.words[wi];
                return (
                  <span
                    key={wi}
                    className="k-word"
                    /* the active-wipe glow layer (stage.css ::before) re-draws
                       the word as a clipped text-shadow */
                    data-w={w.word}
                    ref={(el) => props.setWordEl(wi, el)}
                  >
                    {w.word}
                  </span>
                );
              })}
            </div>
          </Fragment>
        );
      })}
    </>
  );
});
