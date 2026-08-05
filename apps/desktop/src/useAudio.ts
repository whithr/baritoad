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
}

export function useAudio(): AudioController {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const loopRef = useRef<LoopWindow | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loop, setLoopState] = useState<LoopWindow | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  // One element per hook instance, torn down with the component.
  useEffect(() => {
    const el = new Audio();
    el.preload = "auto";
    audioRef.current = el;
    const onMeta = () => {
      setDuration(el.duration || 0);
      setReady(true);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
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
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
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
      setTime(el.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing]);

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

  const seek = useCallback((t: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, t);
    setTime(el.currentTime);
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
  };
}
