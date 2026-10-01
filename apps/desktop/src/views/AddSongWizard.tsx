// Add a Song wizard: details → lyrics, and Finish on the lyrics page starts
// the job (no separate summary page — the golden path is drop, Next, paste,
// Finish). The audio file is already chosen (File › Add Song… opens the file
// dialog first; a drop on the window skips straight here).
//
// Song › Process again… reuses it for a song (or failed job) that needs
// another run: same pages, pre-filled with the song's details and the lyrics
// its last run used, running in the song's own job folder so finished steps
// are reused and the library row updates in place (rows are keyed by the
// audio's hash — a second run never adds a copy).

import { useEffect, useRef, useState } from "react";
import { cleanLyricsPreview, findLyrics, generateSong, jobLyrics, probeAudio, type CleanPreview, type ProbeResult } from "../api";
import { useSettings } from "../App";
import { fmtDuration } from "../libraryState";
import { Button, Checkbox, FieldLabel, Icon, TextArea, TextField, Wizard } from "../win98";

const PAGES = ["details", "lyrics"] as const;

/** What the wizard processes: a new audio file, or a song processed again. */
export interface WizardTarget {
  path: string;
  again?: {
    title: string;
    artist?: string | null;
    /** The job folder the last run used — resuming there reuses its work. */
    outDir: string;
    /** The song has timing that a new run replaces. */
    hasTiming: boolean;
  };
}

export default function AddSongWizard(props: {
  target: WizardTarget | null;
  onClose: () => void;
  onStarted: (jobId: number, title: string) => void;
}) {
  const { target } = props;
  const path = target?.path ?? null;
  const again = target?.again;
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
  /** LRCLIB lookup: what it found (and the text it replaced, for Undo). */
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ note: string; undo?: string } | null>(null);
  const autoLooked = useRef(false);

  // fresh wizard per file
  useEffect(() => {
    if (!target) return;
    const again = target.again;
    setPage(0);
    setProbe(null);
    setTitle(again?.title ?? "");
    setArtist(again?.artist ?? "");
    setLyrics("");
    setPreview(null);
    setHq(false);
    setError(null);
    setFinding(false);
    setFound(null);
    autoLooked.current = false;
    let alive = true;
    probeAudio(target.path)
      .then((p) => {
        if (!alive) return;
        setProbe(p);
        // A song processed again keeps the details the user gave it.
        if (again) return;
        setTitle(p.title);
        setArtist(p.artist ?? "");
      })
      .catch((e) => {
        if (!alive) return;
        const msg = String(e);
        setError(
          again && msg.includes("file not found")
            ? "Karascape can't find this song's audio file. If you moved it, add it from its new place with File › Add Song — the library updates this song instead of adding a copy."
            : msg,
        );
      });
    if (again) {
      jobLyrics(again.outDir)
        .then((text) => alive && text && setLyrics((cur) => (cur === "" ? text : cur)))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [target]);

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
        out_dir: again?.outDir,
        hq_separation: hq || undefined,
        cpu_only: settings.importOn === "cpu" || undefined,
      });
      props.onStarted(snap.id, snap.title || title);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Find Lyrics: LRCLIB by title, artist and length — only these leave the
  // computer. The result lands in the box for a look before Finish.
  const lookUp = async () => {
    if (finding || title.trim() === "") return;
    setFinding(true);
    try {
      const r = await findLyrics({
        title: title.trim(),
        artist: artist.trim() || undefined,
        duration_s: probe?.duration_s ?? undefined,
      });
      if (!r) {
        setFound({ note: "LRCLIB has no lyrics for this song. Paste them, or leave the box empty to transcribe." });
        return;
      }
      const before = lyrics;
      setLyrics(r.text);
      setFound({
        note: `From LRCLIB: \u201c${r.track_name}\u201d by ${r.artist_name}. Check they're for this song.`,
        undo: before.trim() ? before : undefined,
      });
    } catch (e) {
      setFound({ note: `Couldn't reach LRCLIB: ${String(e)}` });
    } finally {
      setFinding(false);
    }
  };

  const which = PAGES[page];

  // With online lookup on (an import dialog's checkbox), reaching an empty
  // lyrics page looks them up once.
  useEffect(() => {
    if (which !== "lyrics" || again || !settings.lookupLyrics || autoLooked.current || lyrics.trim() !== "") return;
    autoLooked.current = true;
    void lookUp();
  }, [which]); // eslint-disable-line react-hooks/exhaustive-deps
  const fileName = path?.split(/[\\/]/).pop() ?? "";
  const last = page === PAGES.length - 1;
  const next = () => (last ? void finish() : setPage((p) => p + 1));

  return (
    <Wizard
      open={!!path}
      title={again ? "Process Again" : "Add a Song"}
      art={<WizardArt />}
      onBack={page > 0 ? () => setPage((p) => p - 1) : undefined}
      onNext={next}
      onCancel={props.onClose}
      nextLabel={last ? "&Finish" : undefined}
      nextDisabled={which === "details" && !probe}
      busy={submitting}
    >
      {which === "details" && (
        <>
          {again ? (
            <>
              <div style={{ fontWeight: 700 }}>Process this song again</div>
              <p style={{ margin: 0, lineHeight: "18px" }}>
                Karascape keeps whatever already finished — usually the separated vocals — and redoes the rest. Check
                the details, then paste or fix the lyrics on the next page.
              </p>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 700 }}>Tell Karascape about this song</div>
              <p style={{ margin: 0, lineHeight: "18px" }}>
                Karascape pulls the vocals away from the music and lines each word up with the singing. The title and
                artist help you find it later.
              </p>
            </>
          )}
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
          {again?.hasTiming && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: "18px" }}>
              <Icon name="warn" />
              <span>This replaces the song's current timing, and any fixes you saved, so it will need checking again.</span>
            </div>
          )}
        </>
      )}
      {which === "lyrics" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontWeight: 700, flexGrow: 1 }}>Paste the lyrics (optional)</div>
            <Button onClick={() => void lookUp()} disabled={finding || title.trim() === ""} tip="Look the lyrics up on LRCLIB by title, artist and length">
              {finding ? "Looking…" : "Look &up Online"}
            </Button>
          </div>
          <FieldLabel htmlFor="add-lyrics" text="&Lyrics — one line per sung line, a blank line between verses:" />
          <TextArea
            id="add-lyrics"
            lyric
            rows={10}
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            placeholder="Leave empty to transcribe from the vocals (slower, rougher)."
            autoFocus
          />
          <div style={{ lineHeight: "18px" }}>
            {preview
              ? `${preview.lines_kept} lines · ${preview.words_kept} words${preview.summary ? ` · ${preview.summary}` : ""}`
              : "Pasted lyrics give the best sync."}
          </div>
          {found && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", lineHeight: "18px" }}>
              <Icon name="globe" />
              <span style={{ flexGrow: 1 }}>{found.note}</span>
              {found.undo !== undefined && (
                <Button
                  slim
                  onClick={() => {
                    setLyrics(found.undo ?? "");
                    setFound(null);
                  }}
                >
                  Undo
                </Button>
              )}
            </div>
          )}
          <Checkbox checked={hq} onChange={setHq} label="&High-quality separation (cleaner, about 3× slower)" />
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
