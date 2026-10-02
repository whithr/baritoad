// Song › Properties (Alt+Enter): the details a person can fix — title,
// artist, year, genre, language, and the cover picture — plus the facts
// baritoad measured, read only. A cover picked here survives re-imports. Year and genre are what the Library's Browse folders and Group by
// read; an edit here always beats the file's tags on a later re-import.

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { coverImportImage, readCover, songSetCover, songUpdateDetails, type Song } from "../api";
import { languageName, LANGUAGE_NAMES, paceOf, PACE_LABELS, type PaceBands } from "../categories";
import { fmtDuration } from "../libraryState";
import { Button, Dialog, DialogButtons, FieldLabel, GroupBox, Icon, Select, TextField } from "../win98";

const LYRICS_SOURCE: Record<string, string> = {
  pasted: "Pasted lyrics, timed by baritoad",
  transcribed: "Transcribed from the vocals",
  imported: "UltraStar file (hand-made timings)",
};

export default function SongProperties(props: {
  song: Song | null;
  bands: PaceBands | null;
  onClose: () => void;
  onSaved: (song: Song) => void;
}) {
  const { song } = props;
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [year, setYear] = useState("");
  const [genre, setGenre] = useState("");
  const [lang, setLang] = useState("en");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The cover as it will be saved: a stored path (or none) and its preview. */
  const [cover, setCover] = useState<{ path: string | null; url: string | null }>({ path: null, url: null });
  const [coverChanged, setCoverChanged] = useState(false);

  useEffect(() => {
    if (!song) return;
    setCover({ path: song.cover_path ?? null, url: null });
    setCoverChanged(false);
    let alive = true;
    if (song.cover_path) {
      readCover(song.cover_path)
        .then((url) => alive && setCover((c) => (c.path === song.cover_path ? { ...c, url } : c)))
        .catch(() => undefined);
    }
    setTitle(song.title);
    setArtist(song.artist ?? "");
    setYear(song.year != null ? String(song.year) : "");
    setGenre(song.genre ?? "");
    setLang(song.language_tag);
    setError(null);
    setBusy(false);
    return () => {
      alive = false;
    };
  }, [song]);

  const pickCover = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Pictures", extensions: ["jpg", "jpeg", "png", "gif", "bmp", "webp"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const stored = await coverImportImage(picked);
      const url = await readCover(stored);
      setCover({ path: stored, url });
      setCoverChanged(true);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  const removeCover = () => {
    setCover({ path: null, url: null });
    setCoverChanged(true);
  };

  const yearNum = year.trim() === "" ? null : Number(year.trim());
  const yearOk = yearNum === null || (Number.isInteger(yearNum) && yearNum >= 1900 && yearNum <= 2100);
  const canSave = title.trim() !== "" && yearOk && !busy;

  const save = async () => {
    if (!song || !canSave) return;
    setBusy(true);
    try {
      let saved = await songUpdateDetails(song.id, {
        title: title.trim(),
        artist: artist.trim() || null,
        year: yearNum,
        genre: genre.trim() || null,
        language_tag: lang,
      });
      if (coverChanged) saved = await songSetCover(song.id, cover.path);
      props.onSaved(saved);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const languages = Object.keys(LANGUAGE_NAMES)
    .concat(song && !LANGUAGE_NAMES[song.language_tag] ? [song.language_tag] : [])
    .map((tag) => ({ value: tag, label: languageName(tag) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const pace = song ? paceOf(song, props.bands) : null;
  const facts: [string, string][] = song
    ? [
        ["File", song.audio_path],
        ["Length", fmtDuration(song.duration_s) ?? "unknown"],
        [
          "Pace",
          song.pace_wpm != null
            ? `${Math.round(song.pace_wpm)} words a minute while singing${pace ? ` — ${PACE_LABELS[pace].toLowerCase()} for your library` : ""}`
            : "not measured yet",
        ],
        ["Lyrics", LYRICS_SOURCE[song.lyric_source ?? ""] ?? "—"],
        ["Sung", song.play_count === 1 ? "once" : song.play_count > 1 ? `${song.play_count} times` : "never"],
        ["Added", new Date(song.date_added * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })],
      ]
    : [];

  return (
    <Dialog open={!!song} onClose={() => !busy && props.onClose()} title={song ? `${song.title} Properties` : "Properties"} width={480}>
      <div className="w-dialog-body" style={{ gap: 10 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, width: 84, flexShrink: 0 }}>
            <div
              className="w-sunken"
              style={{ width: 84, height: 84, display: "flex", alignItems: "center", justifyContent: "center", background: "#008080" }}
              aria-label={cover.path ? "Cover" : "No cover"}
            >
              {cover.url ? <img src={cover.url} alt="" style={{ width: 80, height: 80, objectFit: "cover" }} /> : <Icon name="disc" size={32} />}
            </div>
            <Button slim onClick={() => void pickCover()} disabled={busy} style={{ width: "100%" }}>
              &Change…
            </Button>
            <Button slim onClick={removeCover} disabled={busy || !cover.path} style={{ width: "100%" }}>
              Re&move
            </Button>
          </div>
          <div style={{ flexGrow: 1, display: "grid", gridTemplateColumns: "72px minmax(0, 1fr)", gap: "6px 8px", alignItems: "center" }}>
            <FieldLabel htmlFor="sp-title" text="&Title:" />
            <TextField id="sp-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            <FieldLabel htmlFor="sp-artist" text="&Artist:" />
            <TextField id="sp-artist" value={artist} onChange={(e) => setArtist(e.target.value)} />
            <FieldLabel htmlFor="sp-year" text="&Year:" />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <TextField
                id="sp-year"
                value={year}
                inputMode="numeric"
                maxLength={4}
                onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, ""))}
                style={{ width: 64 }}
              />
              {!yearOk && <span className="w-muted">1900–2100, or blank</span>}
            </div>
            <FieldLabel htmlFor="sp-genre" text="&Genre:" />
            <TextField id="sp-genre" value={genre} onChange={(e) => setGenre(e.target.value)} />
            <FieldLabel htmlFor="sp-lang" text="&Language:" />
            <Select id="sp-lang" value={lang} onChange={setLang} options={languages} />
          </div>
        </div>
        <GroupBox label="About this song">
          <div style={{ display: "grid", gridTemplateColumns: "72px minmax(0, 1fr)", gap: "4px 8px", lineHeight: "16px" }}>
            {facts.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <span>{k}:</span>
                <span style={{ overflowWrap: "anywhere", userSelect: "text" }}>{v}</span>
              </div>
            ))}
          </div>
        </GroupBox>
        {error && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }} role="alert">
            <Icon name="error" />
            <span style={{ userSelect: "text" }}>{error}</span>
          </div>
        )}
      </div>
      <DialogButtons>
        <Button isDefault onClick={() => void save()} disabled={!canSave}>
          OK
        </Button>
        <Button onClick={props.onClose} disabled={busy}>
          Cancel
        </Button>
      </DialogButtons>
    </Dialog>
  );
}
