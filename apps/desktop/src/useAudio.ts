// REVIEW-SCREEN PLAYER ONLY (Phase 2 milestone 3).
//
// Plain playback of the instrumental / vocal / original files for the Bench,
// through the Web Audio API: each file is fetched once through Tauri's asset
// protocol (files are individually allowed by the playback_sources command —
// never a directory), decoded into memory, and played by buffer sources on
// one AudioContext clock.
// There is deliberately NO key or tempo shift here, and none may be added:
// the real performance player is the Phase 3 cpal engine in Rust, where the
// player clock maps device position through stretch ratios.
// Because nothing here stretches (playbackRate stays 1), the position this
// hook reports IS original-song time, which is the timing map's only time
// base — so this hook may compare it against map times directly.
//
// The position is published per animation frame while playing, so word
// highlighting tracks the frame rate. It's the time being *heard*: the
// context's output timestamp, so output latency doesn't put the highlight
// ahead of the sound.
//
// An optional second track (the "layer": the vocal stem under the
// instrumental at an adjustable volume) has no transport of its own. It
// starts and stops with the main track at the same context time, so the two
// are sample-aligned by construction, and it keeps playing at gain 0.
//
// Why not two <audio> elements (what this was until 2026-10-05): media
// elements run on their own clocks. On WebView2, starting or seeking two
// together landed them ~2 ms apart (measured 2026-09-30), and a drift check
// re-seeked both when they slipped. On macOS's WebKit they land on its
// 4096-frame buffer boundaries — 0 or 93–105 ms apart at random, measured on
// the sound itself (the same file in both) — so the check re-seeked every
// 2 s and each re-seek stalled the instrumental ~300 ms: 10.8 s of a 15 s
// stretch actually played (3:37 song, M1 Pro). Speeding up or slowing the
// layer to steer it back didn't work there either. Decoded buffers cost
// memory instead: 4 bytes per sample per channel at the context's rate —
// about 42 MB a minute for both stems at 44.1 kHz (153 MB for that song) —
// and both stems fetched and decoded in ~0.13 s on the same Mac.

import { useCallback, useEffect, useRef, useState } from "react";

export interface LoopWindow {
  start: number;
  end: number;
}

export interface AudioController {
  /** Load a (convertFileSrc'd) URL. Resets position; keeps play state off. */
  load: (src: string) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  /** Loop [start, end): when playback passes end it snaps back to start.
   *  null clears. Used for "loop the line being edited". */
  setLoop: (loop: LoopWindow | null) => void;
  loop: LoopWindow | null;
  /** Original-song seconds (see module docs for why that's true here). */
  time: number;
  duration: number;
  playing: boolean;
  ready: boolean;
  error: string | null;
  /** The URL currently loaded (to avoid redundant load()s). */
  src: string | null;
  /** Optional overlay track (the vocal stem under the instrumental), started
   *  and stopped with the main one on the same clock. Both files share the
   *  original-song time base (same separation output). null unloads.
   *  Idempotent for the same URL. */
  setLayer: (src: string | null) => void;
  /** Overlay volume 0..1 (at 0 the overlay keeps playing silently). */
  setLayerGain: (gain: number) => void;
  layerGain: number;
}

/** Gain changes ramp over about this long, so the guide slider doesn't click. */
const GAIN_RAMP_S = 0.015;

/** The context time being heard now: the output timestamp carried forward
 *  to this moment, or else the render time less the output latency. Only a
 *  running context's timestamp moves on — a suspended one's would go stale
 *  and run ahead of the (stopped) sound. */
function heardTime(ctx: AudioContext): number {
  const ts = ctx.state === "running" && typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
  if (ts?.contextTime && ts.performanceTime) {
    return Math.min(ctx.currentTime, ts.contextTime + (performance.now() - ts.performanceTime) / 1000);
  }
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}

async function fetchDecoded(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ctx.decodeAudioData(await res.arrayBuffer());
}

export function useAudio(): AudioController {
  const ctxRef = useRef<AudioContext | null>(null);
  const mainGainRef = useRef<GainNode | null>(null);
  const layerNodeRef = useRef<GainNode | null>(null);
  /** The decoded files, and the asks for them: a decode lands only while its
   *  ask is still the current one. Asks compare by identity, not URL — React's
   *  StrictMode (dev) tears the hook down and sets it up again on these same
   *  refs, and the second setup asks for the same URLs, so by URL the decode
   *  begun before the teardown landed too: a second vocal source, which kept
   *  playing after pause. */
  const mainBufRef = useRef<AudioBuffer | null>(null);
  const mainAskRef = useRef<{ src: string } | null>(null);
  const layerBufRef = useRef<AudioBuffer | null>(null);
  const layerAskRef = useRef<{ src: string } | null>(null);
  const layerGainRef = useRef(0);
  /** The sources playing now (a buffer source plays once). */
  const mainSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const layerSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playingRef = useRef(false);
  /** While playing: the song time at context time `startCtxRef`. */
  const startCtxRef = useRef(0);
  const startPosRef = useRef(0);
  /** While paused: the song time. */
  const posRef = useRef(0);
  /** play() before the file was decoded: start when it is. */
  const playWhenReadyRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const loopRef = useRef<LoopWindow | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loop, setLoopState] = useState<LoopWindow | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [layerGain, setLayerGainState] = useState(0);

  /** The context and its two gains, made on first use. */
  const context = useCallback((): AudioContext => {
    if (ctxRef.current) return ctxRef.current;
    const ctx = new AudioContext();
    const main = ctx.createGain();
    main.connect(ctx.destination);
    const layer = ctx.createGain();
    layer.gain.value = layerGainRef.current;
    layer.connect(ctx.destination);
    ctxRef.current = ctx;
    mainGainRef.current = main;
    layerNodeRef.current = layer;
    return ctx;
  }, []);

  /** The song time being heard. */
  const position = useCallback((): number => {
    const ctx = ctxRef.current;
    const total = mainBufRef.current?.duration ?? 0;
    if (!playingRef.current || !ctx) return posRef.current;
    const t = startPosRef.current + Math.max(0, heardTime(ctx) - startCtxRef.current);
    return Math.min(t, total);
  }, []);

  const stopSources = useCallback(() => {
    stopSource(mainSourceRef.current);
    stopSource(layerSourceRef.current);
    mainSourceRef.current = null;
    layerSourceRef.current = null;
  }, []);

  /** Start the layer at context time `when`, in step with the main track — in
   *  place of any layer source already going, so pause only ever has one to
   *  stop. */
  const startLayer = useCallback((when: number) => {
    const ctx = ctxRef.current;
    const buf = layerBufRef.current;
    const node = layerNodeRef.current;
    if (!ctx || !buf || !node) return;
    stopSource(layerSourceRef.current);
    layerSourceRef.current = null;
    const at = startPosRef.current + (when - startCtxRef.current);
    if (at >= buf.duration) return;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(node);
    s.start(when, Math.max(0, at));
    layerSourceRef.current = s;
  }, []);

  /** Played to the end: stop there. */
  const finish = useCallback(() => {
    stopSources();
    playingRef.current = false;
    posRef.current = mainBufRef.current?.duration ?? 0;
    setTime(posRef.current);
    setPlaying(false);
  }, [stopSources]);

  /** (Re)start both tracks from song time `at`, now. */
  const startAt = useCallback(
    (at: number) => {
      const ctx = ctxRef.current;
      const buf = mainBufRef.current;
      const node = mainGainRef.current;
      if (!ctx || !buf || !node) return;
      stopSources();
      const when = ctx.currentTime;
      startCtxRef.current = when;
      startPosRef.current = at;
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(node);
      s.onended = () => {
        if (mainSourceRef.current === s) finish();
      };
      s.start(when, at);
      mainSourceRef.current = s;
      startLayer(when);
    },
    [finish, startLayer, stopSources],
  );

  // Torn down with the component: the context and its buffers go with it.
  useEffect(
    () => () => {
      stopSources();
      playingRef.current = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      void ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
      mainGainRef.current = null;
      layerNodeRef.current = null;
      mainBufRef.current = null;
      layerBufRef.current = null;
      mainAskRef.current = null;
      layerAskRef.current = null;
    },
    [stopSources],
  );

  // rAF loop while playing: publish the position + enforce the loop window.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      if (!playingRef.current) return;
      const t = position();
      const lw = loopRef.current;
      if (lw && t >= lw.end) {
        // Both tracks restart together, from memory: no gap to buffer.
        startAt(lw.start);
        setTime(lw.start);
      } else if (t >= (mainBufRef.current?.duration ?? Infinity)) {
        finish();
        return;
      } else {
        setTime(t);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, position, startAt, finish]);

  const play = useCallback(() => {
    if (playingRef.current) return;
    const buf = mainBufRef.current;
    if (!buf) {
      playWhenReadyRef.current = true;
      return;
    }
    const ctx = context();
    // Autoplay rules may hold the context until a user gesture; play() comes
    // from one, and a held context starts the scheduled sources when it runs.
    void ctx.resume().catch(() => undefined);
    // From the end, play starts over (as a media element would).
    if (posRef.current >= buf.duration) posRef.current = 0;
    playingRef.current = true;
    startAt(posRef.current);
    setPlaying(true);
  }, [context, startAt]);

  const pause = useCallback(() => {
    playWhenReadyRef.current = false;
    if (!playingRef.current) return;
    posRef.current = position();
    stopSources();
    playingRef.current = false;
    setTime(posRef.current);
    setPlaying(false);
  }, [position, stopSources]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [play, pause]);

  const seek = useCallback(
    (t: number) => {
      const total = mainBufRef.current?.duration;
      const at = Math.max(0, total != null ? Math.min(t, total) : t);
      if (playingRef.current) startAt(at);
      else posRef.current = at;
      setTime(at);
    },
    [startAt],
  );

  const load = useCallback(
    (newSrc: string) => {
      stopSources();
      playingRef.current = false;
      playWhenReadyRef.current = false;
      mainBufRef.current = null;
      const ask = { src: newSrc };
      mainAskRef.current = ask;
      posRef.current = 0;
      setPlaying(false);
      setReady(false);
      setError(null);
      setTime(0);
      setSrc(newSrc);
      fetchDecoded(context(), newSrc).then(
        (buf) => {
          if (mainAskRef.current !== ask) return;
          mainBufRef.current = buf;
          setDuration(buf.duration);
          setReady(true);
          if (playWhenReadyRef.current) {
            playWhenReadyRef.current = false;
            play();
          }
        },
        () => {
          if (mainAskRef.current === ask) setError("audio failed to load — the file may have moved");
        },
      );
    },
    [context, play, stopSources],
  );

  const setLayer = useCallback(
    (layerSrc: string | null) => {
      // Only a *new* source needs loading; a repeat call for the URL already
      // loaded leaves the playing layer alone.
      if ((layerAskRef.current?.src ?? null) === layerSrc) return;
      layerAskRef.current = null;
      layerBufRef.current = null;
      stopSource(layerSourceRef.current);
      layerSourceRef.current = null;
      if (layerSrc == null) return;
      const ask = { src: layerSrc };
      layerAskRef.current = ask;
      const ctx = context();
      fetchDecoded(ctx, layerSrc).then(
        (buf) => {
          if (layerAskRef.current !== ask) return;
          layerBufRef.current = buf;
          // Already playing: join in at the main track's position.
          if (playingRef.current) startLayer(ctx.currentTime);
        },
        () => undefined, // no guide vocal; the main track plays on
      );
    },
    [context, startLayer],
  );

  const setLayerGain = useCallback((gain: number) => {
    const g = Math.min(1, Math.max(0, gain));
    layerGainRef.current = g;
    setLayerGainState(g);
    const node = layerNodeRef.current;
    const ctx = ctxRef.current;
    if (node && ctx) node.gain.setTargetAtTime(g, ctx.currentTime, GAIN_RAMP_S);
  }, []);

  const setLoop = useCallback((lw: LoopWindow | null) => {
    loopRef.current = lw;
    setLoopState(lw);
  }, []);

  return {
    load,
    play,
    pause,
    toggle,
    seek,
    setLoop,
    loop,
    time,
    duration,
    playing,
    ready,
    error,
    src,
    setLayer,
    setLayerGain,
    layerGain,
  };
}

/** Stop a source for good (it can't be restarted) and let it go. */
function stopSource(s: AudioBufferSourceNode | null) {
  if (!s) return;
  s.onended = null;
  try {
    s.stop();
  } catch {
    // never started
  }
  s.disconnect();
}
