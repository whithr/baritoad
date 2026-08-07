// New Song wizard — the golden path (PLAN.md §4): drop/pick a file, the app
// reads its tags (title/artist/cover/duration via probe_audio) and asks
// nothing else — fields come prefilled and editable. Paste lyrics (live
// one-line cleanup preview via clean_lyrics_preview), Generate.

import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  cleanLyricsPreview,
  generateSong,
  probeAudio,
  type CleanPreview,
  type ProbeResult,
} from "../api";
import { metaFromFilename, previewLine } from "../songMeta";
import { fmtDuration } from "../libraryState";
import type { Route } from "../App";

const AUDIO_EXTS = ["mp3", "flac", "wav", "m4a", "ogg", "opus", "aac"];

function isAudioPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTS.includes(ext);
}

export default function NewSong({ go }: { go: (r: Route) => void }) {
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [preview, setPreview] = useState<CleanPreview | null>(null);
  const [showEdits, setShowEdits] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [hq, setHq] = useState(false);
  const debounceRef = useRef<number | undefined>(undefined);

  const pickFile = useCallback((path: string) => {
    if (!isAudioPath(path)) {
      setError(`Not an audio file: ${path}`);
      return;
    }
    setError(null);
    setAudioPath(path);
    setProbe(null);
    // Instant filename-based prefill, then the tag probe refines it
    // (PLAN.md §4 step 1: reads tags, asks nothing else).
    const meta = metaFromFilename(path);
    setTitle(meta.title);
    setArtist(meta.artist ?? "");
    (async () => {
      try {
        const p = await probeAudio(path);
        setProbe(p);
        setTitle(p.title);
        setArtist(p.artist ?? "");
      } catch (e) {
        console.error("probe_audio failed", e);
      }
    })();
  }, []);

  // Native drag-drop from the OS lands on the webview, not the DOM.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "over") setDragOver(true);
        else if (event.payload.type === "leave") setDragOver(false);
        else if (event.payload.type === "drop") {
          setDragOver(false);
          const audio = event.payload.paths.find(isAudioPath) ?? event.payload.paths[0];
          if (audio) pickFile(audio);
        }
      });
    })();
    return () => unlisten?.();
  }, [pickFile]);

  const browse = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXTS }],
    });
    if (typeof selected === "string") pickFile(selected);
  };

  // Debounced live cleanup preview.
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (lyrics.trim() === "") {
      setPreview(null);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      try {
        setPreview(await cleanLyricsPreview(lyrics));
      } catch (e) {
        setPreview(null);
        console.error("clean_lyrics_preview failed", e);
      }
    }, 250);
    return () => window.clearTimeout(debounceRef.current);
  }, [lyrics]);

  const generate = async () => {
    if (!audioPath) return;
    setSubmitting(true);
    setError(null);
    try {
      await generateSong({
        audio_path: audioPath,
        lyrics_text: lyrics.trim() === "" ? undefined : lyrics,
        title: title.trim() === "" ? undefined : title.trim(),
        artist: artist.trim() === "" ? undefined : artist.trim(),
        hq_separation: hq || undefined,
      });
      go({ view: "jobs" });
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <h1>New Song</h1>

      <div
        className={`dropzone${dragOver ? " over" : ""}${audioPath ? " filled" : ""}`}
        onClick={browse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && browse()}
      >
        {audioPath ? (
          <div className="drop-filled">
            {probe?.cover_data_url && (
              <img src={probe.cover_data_url} alt="" className="drop-cover" />
            )}
            <div>
              <div className="drop-title">{audioPath.split(/[\\/]/).pop()}</div>
              {probe && (
                <div className="drop-sub" data-testid="probe-line">
                  {probe.from_tags ? "from file tags" : "from file name"}
                  {probe.album ? ` · ${probe.album}` : ""}
                  {fmtDuration(probe.duration_s) ? ` · ${fmtDuration(probe.duration_s)}` : ""}
                </div>
              )}
              <div className="drop-sub">Click to choose a different file</div>
            </div>
          </div>
        ) : (
          <>
            <div className="drop-title">Drop a song here</div>
            <div className="drop-sub">or click to browse — mp3, flac, wav, m4a, ogg</div>
          </>
        )}
      </div>

      {audioPath && (
        <>
          <div className="field-row">
            <label className="field">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              <span>Artist</span>
              <input
                value={artist}
                placeholder="unknown"
                onChange={(e) => setArtist(e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>
              Paste lyrics <em>(recommended)</em> or leave empty to auto-transcribe
            </span>
            <textarea
              rows={10}
              value={lyrics}
              placeholder={"[Verse 1]\nNever gonna give…"}
              onChange={(e) => setLyrics(e.target.value)}
            />
          </label>

          {preview && (
            <div className="cleanup-line">
              <span data-testid="cleanup-summary">{previewLine(preview)}</span>{" "}
              <button
                className="link-btn"
                onClick={() => setShowEdits((v) => !v)}
                title="Show what the cleanup pass will change"
              >
                {showEdits ? "hide details" : "details"}
              </button>
              {showEdits && (
                <ul className="cleanup-edits">
                  {preview.edits.length === 0 && <li>no changes — lyrics are clean</li>}
                  {preview.edits.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}

          <label className="check-row" title="Runs the fine-tuned separation model with more overlap — several times slower, cleaner instrumental">
            <input
              type="checkbox"
              checked={hq}
              onChange={(e) => setHq(e.target.checked)}
            />
            <span>
              High-quality separation <em>(several times slower)</em>
            </span>
          </label>

          <div className="actions">
            <button className="primary" disabled={submitting} onClick={generate}>
              {submitting ? "Queueing…" : "Generate"}
            </button>
          </div>
        </>
      )}
      {!audioPath && error && <div className="error-banner">{error}</div>}
    </div>
  );
}
