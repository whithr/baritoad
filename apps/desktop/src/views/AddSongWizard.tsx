// Add a Song wizard: details → lyrics → ready → Finish starts the job.
// The audio file is already chosen (File › Add Song… opens the file dialog
// first; a drop on the window skips straight here).

import { useEffect, useRef, useState } from "react";
import { cleanLyricsPreview, generateSong, probeAudio, type CleanPreview, type ProbeResult } from "../api";
import { useSettings } from "../App";
import { fmtDuration } from "../libraryState";
import { Checkbox, FieldLabel, GroupBox, Icon, TextArea, TextField, Wizard } from "../win98";

const PAGES = ["details", "lyrics", "ready"] as const;

export default function AddSongWizard(props: {
  path: string | null;
  onClose: () => void;
  onStarted: (jobId: number, title: string) => void;
}) {
  const { path } = props;
  const [page, setPage] = useState(0);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [preview, setPreview] = useState<CleanPreview | null>(null);
  const [hq, setHq] = useState(false);
  const { settings } = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const debounce = useRef(0);

  // fresh wizard per file
  useEffect(() => {
    if (!path) return;
    setPage(0);
    setProbe(null);
    setTitle("");
    setArtist("");
    setLyrics("");
    setPreview(null);
    setHq(false);
    setError(null);
    let alive = true;
    probeAudio(path)
      .then((p) => {
        if (!alive) return;
        setProbe(p);
        setTitle(p.title);
        setArtist(p.artist ?? "");
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    window.clearTimeout(debounce.current);
    if (lyrics.trim() === "") {
      setPreview(null);
      return;
    }
    debounce.current = window.setTimeout(async () => {
      try {
        setPreview(await cleanLyricsPreview(lyrics));
      } catch {
        setPreview(null);
      }
    }, 250);
    return () => window.clearTimeout(debounce.current);
  }, [lyrics]);

  const finish = async () => {
    if (!path) return;
    setSubmitting(true);
    setError(null);
    try {
      const snap = await generateSong({
        audio_path: path,
        lyrics_text: lyrics.trim() === "" ? undefined : lyrics,
        title: title.trim() === "" ? undefined : title.trim(),
        artist: artist.trim() === "" ? undefined : artist.trim(),
        hq_separation: hq || undefined,
        cpu_separation: settings.separateOn === "cpu" || undefined,
      });
      props.onStarted(snap.id, snap.title || title);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const which = PAGES[page];
  const fileName = path?.split(/[\\/]/).pop() ?? "";
  const next = () => (which === "ready" ? void finish() : setPage((p) => p + 1));

  return (
    <Wizard
      open={!!path}
      title="Add a Song"
      art={<WizardArt />}
      onBack={page > 0 ? () => setPage((p) => p - 1) : undefined}
      onNext={next}
      onCancel={props.onClose}
      nextLabel={which === "ready" ? "&Finish" : undefined}
      nextDisabled={which === "details" && !probe}
      busy={submitting}
    >
      {which === "details" && (
        <>
          <div style={{ fontWeight: 700 }}>Tell Karascape about this song</div>
          <p style={{ margin: 0, lineHeight: "18px" }}>
            Karascape pulls the vocals away from the music and lines each word up with the singing. The title and
            artist help you find it later.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
            <div className="w-sunken" style={{ width: 72, height: 72, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {probe?.cover_data_url ? (
                <img src={probe.cover_data_url} alt="" style={{ width: 68, height: 68, objectFit: "cover" }} />
              ) : (
                <Icon name="disc" size={32} />
              )}
            </div>
            <div style={{ flexGrow: 1, display: "grid", gridTemplateColumns: "64px minmax(0, 1fr)", gap: "6px 8px", alignItems: "center" }}>
              <FieldLabel htmlFor="add-file" text="File:" />
              <TextField id="add-file" value={fileName} readOnly title={path ?? undefined} />
              <FieldLabel htmlFor="add-title" text="&Title:" />
              <TextField id="add-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
              <FieldLabel htmlFor="add-artist" text="&Artist:" />
              <TextField id="add-artist" value={artist} onChange={(e) => setArtist(e.target.value)} />
              <span>Length:</span>
              <span>{probe ? (fmtDuration(probe.duration_s) ?? "unknown") : "Reading the file…"}</span>
            </div>
          </div>
        </>
      )}
      {which === "lyrics" && (
        <>
          <div style={{ fontWeight: 700 }}>Paste the lyrics (optional)</div>
          <FieldLabel htmlFor="add-lyrics" text="&Lyrics — one line per sung line, a blank line between verses:" />
          <TextArea
            id="add-lyrics"
            lyric
            rows={11}
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            placeholder="Leave empty to transcribe from the vocals (slower, rougher)."
            autoFocus
          />
          <div style={{ lineHeight: "18px" }}>
            {preview
              ? `${preview.lines_kept} lines · ${preview.words_kept} words${preview.summary ? ` · ${preview.summary}` : ""}`
              : "Pasted lyrics give the best sync. Matched words keep their timing if you edit them later."}
          </div>
        </>
      )}
      {which === "ready" && (
        <>
          <div style={{ fontWeight: 700 }}>Ready to make it karaoke</div>
          <div style={{ display: "grid", gridTemplateColumns: "64px minmax(0, 1fr)", gap: "6px 8px", lineHeight: "18px" }}>
            <span>Song:</span>
            <span>
              {title || fileName}
              {artist ? ` — ${artist}` : ""}
            </span>
            <span>Lyrics:</span>
            <span>
              {preview
                ? `${preview.lines_kept} lines · ${preview.words_kept} words, pasted`
                : "None pasted — Karascape will transcribe them from the vocals"}
            </span>
          </div>
          <Checkbox checked={hq} onChange={setHq} label="&High-quality separation (cleaner, about 3× slower)" />
          <GroupBox label="On this machine">
            <div style={{ display: "flex", gap: 8, alignItems: "center", lineHeight: "18px" }}>
              <Icon name="lock" />
              Vocals are separated and words aligned locally. Nothing is uploaded.
            </div>
          </GroupBox>
          <div>Click Finish to start. You can keep using Karascape while it works.</div>
        </>
      )}
      {error && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: "auto" }} role="alert">
          <Icon name="error" />
          {error}
        </div>
      )}
    </Wizard>
  );
}

function WizardArt() {
  return (
    <>
      <div style={{ position: "absolute", left: 11, top: 34 }}>
        <svg width="112" height="112" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="7" fill="#dfdfdf" stroke="#000" strokeWidth="0.25" />
          <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5H11a3 3 0 0 0-3-3z" fill="#80ffff" />
          <path d="M8 14.5A6.5 6.5 0 0 1 1.5 8H5a3 3 0 0 0 3 3z" fill="#ff80ff" />
          <circle cx="8" cy="8" r="2" fill="#fff" stroke="#808080" strokeWidth="0.25" />
        </svg>
      </div>
      <div style={{ position: "absolute", left: 70, top: 150 }}>
        <Icon name="mic" size={64} />
      </div>
      <div style={{ position: "absolute", left: 14, top: 280 }}>
        <Icon name="app" size={48} />
      </div>
    </>
  );
}
