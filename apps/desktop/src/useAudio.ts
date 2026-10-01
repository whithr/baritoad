// REVIEW-SCREEN PLAYER ONLY (Phase 2 milestone 3).
//
// Plain playback of the instrumental / vocal / original files through the
// webview's <audio> element, sourced via Tauri's asset protocol (files are
// individually allowed by the playback_sources command — never a directory).
// There is deliberately NO key or tempo shift here, and none may be added:
// the real performance player is the Phase 3 cpal engine in Rust, where the
// player clock maps device position through stretch ratios (PLAN.md §5).
// Because nothing here stretches (playbackRate stays 1), <audio>.currentTime
// IS original-song time, which is the timing map's only time base — so this
// hook may compare it against map times directly.
//
// currentTime updates are rAF-driven while playing so word highlighting
// tracks the frame rate, not the media element's coarse timeupdate events.
//
// An optional second element (the "layer") can play the vocal stem under the
// instrumental at an adjustable volume. It has no transport of its own: it
// mirrors the main element (play/pause/seek events + per-frame drift
// correction), so every existing control keeps driving one element. Both
// files come from the same separation run and share the original-song time
// base, so mirrored currentTime keeps them musically aligned.
//
// Keeping them aligned (measured 2026-09-30, WebView2): elements started or
// seeked *together* land within ~2 ms; seeking the layer alone while the main
// element plays lands it ~40 ms late, every time (restart latency). The layer
// used to pause at volume 0 and re-seek alone when the guide came back up —
// leaving the vocal 41-43 ms behind its own bleed in the instrumental, just
// under the old 50 ms snap threshold, so it never got fixed: a smeared,
// "bad call" sound until the next seek. So the layer now keeps playing
// (silently) at volume 0, and a sustained drift re-seeks *both* elements.

import { useCallback, useEffect, useRef, useState } from "react";

/** Vocal-vs-instrumental offset that counts as drift. Past ~20 ms the vocal
 *  audibly doubles against its own bleed in the instrumental. */
const DRIFT_TOL_S = 0.02;
/** Drift must last this long before a resync (one-frame jitter isn't drift). */
const DRIFT_SUSTAIN_MS = 300;
/** A resync briefly re-buffers both elements; never do it more often. */
const RESYNC_COOLDOWN_MS = 2000;

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
  /** Optional overlay track (the vocal stem under the instrumental): a second
   *  element that mirrors the main transport, drift-corrected each frame.
   *  Both files share the original-song time base (same separation output),
   *  so mirrored currentTime keeps them musically aligned. null unloads.
   *  Idempotent for the same URL. */
  setLayer: (src: string | null) => void;
  /** Overlay volume 0..1 (at 0 the overlay keeps playing silently, so it's
   *  still in step when it comes back up). */
  setLayerGain: (gain: number) => void;
  layerGain: number;
}

export function useAudio(): AudioController {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const layerRef = useRef<HTMLAudioElement | null>(null);
  /** URL last handed to the layer, as given (the element's `.src` reflects
   *  it back normalized, so it can't be the idempotence check). */
  const layerSrcRef = useRef<string | null>(null);
  const layerGainRef = useRef(0);
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

  /** When the current drift started (performance.now), or null. */
  const driftSinceRef = useRef<number | null>(null);
  const lastResyncRef = useRef(0);

  /** Bring the overlay in line with the main element. `snap` (play, pause,
   *  seek, new source): match play state and position now — the main
   *  element is starting or seeking too, so they land together. Otherwise
   *  (every frame): resync both elements when drift has lasted (module docs). */
  const syncLayer = useCallback((snap: boolean) => {
    const el = audioRef.current;
    const l = layerRef.current;
    if (!el || !l || !l.src) return;
    if (el.paused) {
      if (!l.paused) l.pause();
      driftSinceRef.current = null;
      return;
    }
    if (snap) {
      l.currentTime = el.currentTime;
      if (l.paused) l.play().catch(() => undefined);
      driftSinceRef.current = null;
      return;
    }
    if (l.paused) l.play().catch(() => undefined);
    if (el.seeking || l.seeking || l.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
      driftSinceRef.current = null;
      return;
    }
    if (Math.abs(l.currentTime - el.currentTime) <= DRIFT_TOL_S) {
      driftSinceRef.current = null;
      return;
    }
    const now = performance.now();
    if (driftSinceRef.current == null) driftSinceRef.current = now;
    if (now - driftSinceRef.current >= DRIFT_SUSTAIN_MS && now - lastResyncRef.current >= RESYNC_COOLDOWN_MS) {
      // Seek both to where the listener is — a lone layer seek lands late.
      const t = el.currentTime;
      el.currentTime = t;
      l.currentTime = t;
      lastResyncRef.current = now;
      driftSinceRef.current = null;
    }
  }, []);

  // One element per hook instance, torn down with the component.
  useEffect(() => {
    const el = new Audio();
    el.preload = "auto";
    audioRef.current = el;
    const onMeta = () => {
      setDuration(el.duration || 0);
      setReady(true);
    };
    const onPlay = () => {
      setPlaying(true);
      syncLayer(true);
    };
    const onPause = () => {
      setPlaying(false);
      syncLayer(true);
    };
    const onEnded = () => {
      setPlaying(false);
      syncLayer(true);
    };
    const onErr = () => setError("audio failed to load — the file may have moved");
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onErr);
    return () => {
      el.pause();
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onErr);
      el.src = "";
      audioRef.current = null;
      const l = layerRef.current;
      if (l) {
        l.pause();
        l.src = "";
        layerRef.current = null;
        layerSrcRef.current = null;
      }
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // rAF loop while playing: publish currentTime + enforce the loop window.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const el = audioRef.current;
      if (!el) return;
      const lw = loopRef.current;
      if (lw && el.currentTime >= lw.end) {
        // The loop jump moves both elements in the same frame.
        el.currentTime = lw.start;
        syncLayer(true);
      } else {
        syncLayer(false);
      }
      setTime(el.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, syncLayer]);

  const load = useCallback((newSrc: string) => {
    const el = audioRef.current;
    if (!el) return;
    setReady(false);
    setError(null);
    setTime(0);
    setSrc(newSrc);
    el.src = newSrc;
    el.load();
  }, []);

  const play = useCallback(() => {
    // Autoplay may be rejected before the first user gesture — surface as
    // "not playing" rather than an error; the UI offers a play button.
    audioRef.current?.play().catch(() => setPlaying(false));
  }, []);

  const pause = useCallback(() => audioRef.current?.pause(), []);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setPlaying(false));
    else el.pause();
  }, []);

  const seek = useCallback(
    (t: number) => {
      const el = audioRef.current;
      if (!el) return;
      el.currentTime = Math.max(0, t);
      setTime(el.currentTime);
      syncLayer(true);
    },
    [syncLayer],
  );

  const setLayer = useCallback(
    (layerSrc: string | null) => {
      let l = layerRef.current;
      if (layerSrc == null) {
        layerSrcRef.current = null;
        if (l) {
          l.pause();
          l.src = "";
        }
        return;
      }
      if (!l) {
        l = new Audio();
        l.preload = "auto";
        layerRef.current = l;
      }
      // Only a *new* source needs positioning; a repeat call for the URL
      // already loaded must not touch the element's timeline (a snap is a
      // seek, and a seek per call would keep the stem re-buffering).
      if (layerSrcRef.current !== layerSrc) {
        layerSrcRef.current = layerSrc;
        l.src = layerSrc;
        l.volume = Math.min(1, Math.max(0, layerGainRef.current));
        l.load();
        syncLayer(true);
      }
    },
    [syncLayer],
  );

  const setLayerGain = useCallback(
    (gain: number) => {
      const g = Math.min(1, Math.max(0, gain));
      layerGainRef.current = g;
      setLayerGainState(g);
      const l = layerRef.current;
      // Volume only: the layer keeps playing at 0, so it's still in step
      // when the guide comes back up (module docs).
      if (l) l.volume = g;
    },
    [],
  );

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
