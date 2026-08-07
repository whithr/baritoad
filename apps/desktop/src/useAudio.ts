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
  /** Optional overlay track (the vocal stem under the instrumental): a second
   *  element that mirrors the main transport, drift-corrected each frame.
   *  Both files share the original-song time base (same separation output),
   *  so mirrored currentTime keeps them musically aligned. null unloads.
   *  Idempotent for the same URL. */
  setLayer: (src: string | null) => void;
  /** Overlay volume 0..1. 0 pauses the overlay element entirely. */
  setLayerGain: (gain: number) => void;
  layerGain: number;
}

export function useAudio(): AudioController {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const layerRef = useRef<HTMLAudioElement | null>(null);
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

  /** Bring the overlay in line with the main element: paused/playing state,
   *  and position when drifted past `tol` seconds (`0` forces a snap). */
  const syncLayer = useCallback((tol: number) => {
    const el = audioRef.current;
    const l = layerRef.current;
    if (!el || !l || !l.src) return;
    if (layerGainRef.current <= 0 || el.paused) {
      if (!l.paused) l.pause();
      return;
    }
    if (Math.abs(l.currentTime - el.currentTime) > tol) {
      l.currentTime = el.currentTime;
    }
    if (l.paused) l.play().catch(() => undefined);
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
      syncLayer(0);
    };
    const onPause = () => {
      setPlaying(false);
      syncLayer(0);
    };
    const onEnded = () => {
      setPlaying(false);
      syncLayer(0);
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
        el.currentTime = lw.start;
      }
      // Keep the overlay within ~2 frames of the main element; media
      // elements drift a little, and a loop snap above lands here too.
      syncLayer(0.05);
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
      syncLayer(0);
    },
    [syncLayer],
  );

  const setLayer = useCallback(
    (layerSrc: string | null) => {
      let l = layerRef.current;
      if (layerSrc == null) {
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
      if (l.src !== layerSrc) {
        l.src = layerSrc;
        l.volume = Math.min(1, Math.max(0, layerGainRef.current));
        l.load();
      }
      syncLayer(0);
    },
    [syncLayer],
  );

  const setLayerGain = useCallback(
    (gain: number) => {
      const g = Math.min(1, Math.max(0, gain));
      layerGainRef.current = g;
      setLayerGainState(g);
      const l = layerRef.current;
      if (l) l.volume = g;
      syncLayer(0);
    },
    [syncLayer],
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
