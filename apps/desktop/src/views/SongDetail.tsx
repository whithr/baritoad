// Song detail = the review screen (PLAN.md §3, §4 step 4 "Preview & fix").
//
// Three modes:
//  - preview: auto-plays the densest ~20 s of lyrics with karaoke-style word
//    highlighting; big "Looks good" / "Fix timings" buttons. Entered
//    automatically for songs not yet reviewed.
//  - detail: metadata, word list, exports (with freshness badges), and
//    "Preview again" / "Fix timings" affordances. Reviewed songs land here.
//  - edit: the fix editor (FixEditor.tsx).
//
// Audio here is the review-screen player only (useAudio module docs): plain
// playback, no key/tempo — the Phase 3 cpal player replaces it for singing.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  exportSong,
  exportStatus as fetchExportStatus,
  librarySong,
  playbackSources,
  readTimingMap,
  songSetReviewed,
  type ExportStatus,
  type PlaybackSources,
  type Song,
  type TimingMap,
} from "../api";
import { exportFreshness } from "../editorState";
import {
  groupByLine,
  pickHighlightWindow,
  sungThroughIndexAt,
  wordIndexAt,
} from "../highlight";
import { ExportButton, EXPORT_FORMATS, fmtTime } from "../reviewUi";
import { useAudio } from "../useAudio";
import FixEditor from "./FixEditor";
import type { Route } from "../App";

type Mode = "loading" | "preview" | "detail" | "edit";

/** What the preview plays: the ~20 s highlight loop or the whole song. */
type PreviewScope = "highlight" | "full";

type SourceKind = "instrumental" | "original" | "vocals";

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
        // Golden path: unreviewed songs open straight into the preview.
        setMode(s && s.reviewed_at == null ? "preview" : "detail");
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
        title={title}
        sources={sources}
        initialScope={previewScope}
        onLooksGood={markReviewed}
        onFix={() => setMode("edit")}
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
          <div className="actions">
            <button
              className="primary"
              onClick={() => {
                setPreviewScope("highlight");
                setMode("preview");
              }}
            >
              Preview again
            </button>
            <button
              onClick={() => {
                setPreviewScope("full");
                setMode("preview");
              }}
            >
              Play full song
            </button>
            <button onClick={() => setMode("edit")}>Fix timings</button>
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
// preview (golden path step 4)
// ---------------------------------------------------------------------------

function Preview(props: {
  map: TimingMap;
  title: string;
  sources: PlaybackSources | null;
  /** Range to open with; the user can switch inside the preview. */
  initialScope?: PreviewScope;
  onLooksGood: () => void;
  onFix: () => void;
  onSkip: () => void;
}) {
  const { map, sources } = props;
  const audio = useAudio();
  const [scope, setScope] = useState<PreviewScope>(props.initialScope ?? "highlight");
  const [srcKind, setSrcKind] = useState<SourceKind>(() =>
    sources?.instrumental ? "instrumental" : sources?.original ? "original" : "vocals",
  );
  // Position to restore after a source switch reloads the media element.
  const resumeRef = useRef<number | null>(null);
  const hl = useMemo(
    () => pickHighlightWindow(map.words, map.duration),
    [map],
  );
  const src = sources?.[srcKind] ?? null;

  // Load the chosen source; playback (re)starts via the ready effect below.
  // Autoplay may be blocked pre-gesture — the overlay button covers that.
  useEffect(() => {
    if (!src) return;
    audio.load(convertFileSrc(src));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // On (re)load or scope switch: aim the loop window and start playing.
  // Highlight loops the densest ~20 s; full plays straight through the song.
  useEffect(() => {
    if (!audio.ready) return;
    audio.setLoop(scope === "highlight" ? hl : null);
    const resume = resumeRef.current;
    resumeRef.current = null;
    audio.seek(resume ?? (scope === "highlight" ? hl.start : 0));
    audio.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio.ready, scope]);

  // The range the timebar spans — original-song seconds, the map's only time
  // base, which is also exactly what <audio>.currentTime reports here
  // (useAudio module docs: this player never stretches).
  const range =
    scope === "highlight"
      ? hl
      : { start: 0, end: audio.duration || map.duration || hl.end };
  const rangeLen = Math.max(range.end - range.start, 0.001);
  const frac = Math.min(1, Math.max(0, (audio.time - range.start) / rangeLen));

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
    }
  };

  const active = wordIndexAt(map.words, audio.time);
  // Words at or before this index have been sung — stays put during gaps,
  // so the sung tint doesn't vanish while nobody is singing.
  const sungThrough = sungThroughIndexAt(map.words, audio.time);
  const lines = useMemo(() => groupByLine(map.words), [map]);
  // Line being sung (or the next one coming up).
  const lineIdx = useMemo(() => {
    if (active != null) return lines.findIndex((g) => g.indices.includes(active));
    const next = map.words.findIndex((w) => w.start > audio.time);
    if (next === -1) return lines.length - 1;
    return lines.findIndex((g) => g.indices.includes(next));
  }, [active, lines, map, audio.time]);
  const line = lines[Math.max(lineIdx, 0)];
  const nextLine = lines[Math.max(lineIdx, 0) + 1];

  return (
    <div className="page preview-page">
      <h1>{props.title}</h1>
      <p className="muted">
        {scope === "highlight"
          ? `Previewing the busiest ${Math.round(hl.end - hl.start)} seconds — how do the timings look?`
          : "Playing the whole song — click the bar to jump around and spot-check timings."}
      </p>
      <div className="preview-stage">
        {!src && (
          <p className="muted">
            No playable audio found for this song (stems may have been moved) — you can still
            fix timings or open the detail view.
          </p>
        )}
        {src && !audio.playing && (
          <button className="primary preview-play" onClick={() => audio.play()}>
            {scope === "highlight" ? "▶ Play preview" : "▶ Play song"}
          </button>
        )}
        <div className="preview-lines">
          <div className="preview-line current">
            {line?.indices.map((wi) => {
              const w = map.words[wi];
              const sung =
                active != null
                  ? wi < active
                  : sungThrough != null && wi <= sungThrough;
              return (
                <span
                  key={wi}
                  className={`k-word${active === wi ? " active" : ""}${sung ? " sung" : ""}${w.unsung ? " unsung" : ""}`}
                >
                  {w.word}
                </span>
              );
            })}
          </div>
          <div className="preview-line next">
            {nextLine?.indices.map((wi) => (
              <span key={wi} className="k-word">
                {map.words[wi].word}
              </span>
            ))}
          </div>
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
          <span className="preview-clock">
            {fmtTime(audio.time)} / {fmtTime(range.end)}
          </span>
          <span className="spacer" />
          <div className="scope-toggle" role="group" aria-label="How much of the song to play">
            <button
              className={scope === "highlight" ? "active" : ""}
              onClick={() => setScope("highlight")}
            >
              20 s highlight
            </button>
            <button
              className={scope === "full" ? "active" : ""}
              onClick={() => setScope("full")}
            >
              Full song
            </button>
          </div>
          <select
            value={srcKind}
            onChange={(e) => {
              resumeRef.current = audio.time;
              setSrcKind(e.target.value as SourceKind);
            }}
            title="What to listen to"
            disabled={!sources}
          >
            {sources?.instrumental && <option value="instrumental">Instrumental</option>}
            {sources?.original && <option value="original">Original</option>}
            {sources?.vocals && <option value="vocals">Vocals</option>}
          </select>
        </div>
      </div>
      <div className="preview-actions">
        <button className="primary big" onClick={() => { audio.pause(); props.onLooksGood(); }}>
          Looks good
        </button>
        <button className="big" onClick={() => { audio.pause(); props.onFix(); }}>
          Fix timings
        </button>
        <button className="linkish" onClick={() => { audio.pause(); props.onSkip(); }}>
          Skip to details
        </button>
      </div>
    </div>
  );
}
