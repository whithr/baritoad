// Home: the library as a drawer on the left, the empty bench on the right.
// Dropping a song lands it on the bench (the "landing" panel): metadata,
// pasted lyrics, then processing progress in place — no wizard, no jobs
// page. When the job completes the song opens on the bench.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  cancelJob,
  cleanLyricsPreview,
  generateSong,
  libraryCollections,
  librarySongs,
  probeAudio,
  queueAdd,
  queueList,
  queueRemove,
  readCover,
  type CleanPreview,
  type CollectionInfo,
  type ProbeResult,
  type QueueEntry,
  type Song,
} from "../api";
import type { Route } from "../App";
import { progressHeadline, type JobProgress, type JobsState } from "../jobEvents";
import { coverInitials, filterSongs, fmtDuration, sortSongs } from "../libraryState";
import { Chip, Icon, Key, Label, Led, Legend, Toggle } from "../hw/ui";

const AUDIO_EXTS = ["mp3", "flac", "wav", "m4a", "ogg", "aac", "aiff", "wma"];
const isAudioPath = (p: string) => AUDIO_EXTS.includes((p.split(".").pop() ?? "").toLowerCase());

type SongStatus =
  | { kind: "processing"; p: JobProgress }
  | { kind: "failed"; p: JobProgress }
  | { kind: "needs-timings" }
  | { kind: "review" }
  | { kind: "ready" };

function statusFor(song: Song, jobs: JobsState): SongStatus {
  for (const id of jobs.order) {
    const p = jobs.jobs[id];
    if (!p) continue;
    const mine = p.job.library_song_id === song.id || p.job.audio === song.audio_path;
    if (!mine) continue;
    if (p.job.status === "queued" || p.job.status === "running") return { kind: "processing", p };
    if (p.job.status === "failed") return { kind: "failed", p };
  }
  if (!song.timing_map_path) return { kind: "needs-timings" };
  if (song.reviewed_at == null) return { kind: "review" };
  return { kind: "ready" };
}

export default function Home(props: { go: (r: Route) => void; jobs: JobsState }) {
  const { go, jobs } = props;
  const [songs, setSongs] = useState<Song[]>([]);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [collection, setCollection] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [covers, setCovers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [landing, setLanding] = useState<string | null>(null); // audio path on the bench
  const [dragOver, setDragOver] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        librarySongs({ collection: collection ?? undefined }),
        libraryCollections(),
      ]);
      setSongs(s);
      setCollections(c);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [collection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A completed job registers a library row: refresh the drawer.
  const completedKey = useMemo(
    () => jobs.order.filter((id) => jobs.jobs[id]?.job.status === "completed").join(","),
    [jobs],
  );
  useEffect(() => {
    void refresh();
  }, [completedKey, refresh]);

  useEffect(() => {
    for (const s of songs) {
      if (s.cover_path && covers[s.id] === undefined) {
        readCover(s.cover_path)
          .then((url) => setCovers((c) => ({ ...c, [s.id]: url })))
          .catch(() => setCovers((c) => ({ ...c, [s.id]: "" })));
      }
    }
  }, [songs, covers]);

  const visible = useMemo(() => sortSongs(filterSongs(songs, search), "recently_added"), [songs, search]);

  // Native OS drop lands on the webview, not the DOM.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "over") setDragOver(true);
        else if (event.payload.type === "leave") setDragOver(false);
        else if (event.payload.type === "drop") {
          setDragOver(false);
          const audio = event.payload.paths.find(isAudioPath) ?? event.payload.paths[0];
          if (audio) setLanding(audio);
        }
      });
    })();
    return () => unlisten?.();
  }, []);

  const browse = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "Audio", extensions: AUDIO_EXTS }] });
    if (typeof selected === "string") setLanding(selected);
  };

  const openSong = useCallback(
    (s: Song, at?: number) => {
      if (!s.timing_map_path) return;
      go({ view: "song", mapPath: s.timing_map_path, title: s.title, songId: s.id, at });
    },
    [go],
  );

  // Keyboard: ↑↓ walk the drawer, Enter opens (native button), Q queues, / searches.
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".song-row") ?? []);
    const i = rows.findIndex((r) => r === document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const j = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      rows[j]?.focus();
    } else if ((e.key === "q" || e.key === "Q") && i >= 0) {
      const s = visible[i];
      if (s?.timing_map_path) void queueAdd(s.id).then(() => window.dispatchEvent(new Event("karascape:queue")));
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="hw-topbar">
        <span className="hw-title">Karascape</span>
        <Label>working name</Label>
        <span className="hw-grow" />
        <Key icon="plus" onClick={browse}>
          Add a song
        </Key>
        <Key icon="gear" onClick={() => go({ view: "settings" })} aria-label="Settings" />
      </div>
      <div className="home">
        <div className="home-drawer">
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 8, top: 7, color: "var(--hw-muted)" }}>
              <Icon name="search" />
            </span>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search songs, collections, tags"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: 26 }}
            />
          </div>
          <div className="home-chips">
            <Chip on={collection === null} onClick={() => setCollection(null)}>
              All
            </Chip>
            {collections.map((c) => (
              <Chip key={c.id} on={collection === c.id} onClick={() => setCollection(c.id)}>
                {c.name}
              </Chip>
            ))}
          </div>
          {error && <div className="hw-banner error">{error}</div>}
          <div className="home-songs" ref={listRef} onKeyDown={onListKey}>
            {visible.map((s) => (
              <SongRow
                key={s.id}
                song={s}
                cover={covers[s.id]}
                status={statusFor(s, jobs)}
                onOpen={() => openSong(s)}
                onFix={() => openSong(s)}
              />
            ))}
            {visible.length === 0 && (
              <div className="hw-banner" style={{ justifyContent: "center" }}>
                {songs.length === 0 ? "No songs yet — drop one on the bench." : "Nothing matches."}
              </div>
            )}
          </div>
          <Legend
            items={[
              ["↑↓", "song"],
              ["↵", "open"],
              ["Q", "queue"],
              ["/", "search"],
            ]}
          />
        </div>

        <div className="home-main">
          <div className="home-stage">
            {landing ? (
              <Landing
                audioPath={landing}
                jobs={jobs}
                onCancel={() => setLanding(null)}
                onOpen={(mapPath, songId, title) => {
                  setLanding(null);
                  go({ view: "song", mapPath, songId, title });
                }}
              />
            ) : (
              <div className={`dropwell${dragOver ? " over" : ""}`} onClick={browse} role="button" tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && browse()}>
                <h1>Drop a song here</h1>
                <Label>mp3 · flac · wav · m4a · or an UltraStar / LRC folder</Label>
                <div className="row">
                  <Key icon="folder" onClick={(e) => { e.stopPropagation(); void browse(); }}>
                    Choose a file…
                  </Key>
                </div>
                <p className="hw-muted" style={{ marginTop: 14 }}>
                  You bring the music. Everything stays on this machine.
                </p>
              </div>
            )}
          </div>
          <UpNextTray go={go} />
        </div>
      </div>
    </>
  );
}

function SongRow(props: {
  song: Song;
  cover?: string;
  status: SongStatus;
  onOpen: () => void;
  onFix: () => void;
}) {
  const { song, status } = props;
  const openable = !!song.timing_map_path && status.kind !== "processing";
  let statusEl: React.ReactNode;
  switch (status.kind) {
    case "processing":
      statusEl = (
        <>
          <Led on />
          <span>{progressHeadline(status.p)}</span>
          {status.p.fraction != null && (
            <span className="bar">
              <i style={{ width: `${Math.round(status.p.fraction * 100)}%` }} />
            </span>
          )}
        </>
      );
      break;
    case "failed":
      statusEl = <span style={{ color: "var(--hw-danger)" }}>failed · {status.p.failure ?? status.p.job.error ?? "unknown"}</span>;
      break;
    case "needs-timings":
      statusEl = <span>needs lyrics</span>;
      break;
    case "review":
      statusEl = (
        <>
          <Led on color="yellow" />
          <span>ready · not yet checked</span>
        </>
      );
      break;
    default:
      statusEl = <span>ready{song.duration_s ? ` · ${fmtDuration(song.duration_s)}` : ""}</span>;
  }
  return (
    <button
      type="button"
      className="song-row"
      onClick={openable ? props.onOpen : undefined}
      disabled={!openable}
      title={openable ? "Open on the bench" : undefined}
    >
      <span className="song-cover">
        {props.cover ? <img src={props.cover} alt="" /> : coverInitials(song.title)}
      </span>
      <span className="song-main">
        <span className="song-title">
          {song.title}
          {song.artist ? <span className="hw-muted"> · {song.artist}</span> : null}
        </span>
        <span className="song-status">{statusEl}</span>
      </span>
      {status.kind === "review" && (
        <span className="hw-chip on" style={{ height: 20, fontSize: 10, letterSpacing: 0.5 }}>
          FIX
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------- landing

function Landing(props: {
  audioPath: string;
  jobs: JobsState;
  onCancel: () => void;
  onOpen: (mapPath: string, songId: number | undefined, title: string) => void;
}) {
  const { audioPath, jobs } = props;
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [preview, setPreview] = useState<CleanPreview | null>(null);
  const [hq, setHq] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const debounce = useRef<number>(0);

  useEffect(() => {
    (async () => {
      try {
        const p = await probeAudio(audioPath);
        setProbe(p);
        setTitle(p.title);
        setArtist(p.artist ?? "");
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [audioPath]);

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

  const job = jobId != null ? jobs.jobs[jobId] : undefined;
  const opened = useRef(false);
  useEffect(() => {
    if (!job || opened.current) return;
    if (job.job.status === "completed" && job.job.map_path) {
      opened.current = true;
      props.onOpen(job.job.map_path, job.job.library_song_id, job.job.title);
    }
  }, [job, props]);

  const generate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const snap = await generateSong({
        audio_path: audioPath,
        lyrics_text: lyrics.trim() === "" ? undefined : lyrics,
        title: title.trim() === "" ? undefined : title.trim(),
        artist: artist.trim() === "" ? undefined : artist.trim(),
        hq_separation: hq || undefined,
      });
      setJobId(snap.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const running = job && (job.job.status === "queued" || job.job.status === "running");
  const failed = job && job.job.status === "failed";

  return (
    <div className="landing">
      <div className="landing-head">
        <div className="landing-cover">{probe?.cover_data_url && <img src={probe.cover_data_url} alt="" />}</div>
        <div className="landing-fields">
          <label>
            <Label>Title</Label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!!job} />
          </label>
          <label>
            <Label>Artist</Label>
            <input type="text" value={artist} onChange={(e) => setArtist(e.target.value)} disabled={!!job} />
          </label>
        </div>
        <Label>{probe?.duration_s ? fmtDuration(probe.duration_s) : ""}</Label>
      </div>

      {error && <div className="hw-banner error">{error}</div>}

      {!job && (
        <div className="landing-body">
          <textarea
            placeholder={"Paste the lyrics here — one line per sung line, a blank line between verses.\nLeave empty to transcribe from the vocal (slower, rougher)."}
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
          />
          <div className="landing-side">
            <div className="hw-card">
              <span className="hw-card-title">Lyrics</span>
              {preview ? (
                <p>
                  {preview.lines_kept} lines · {preview.words_kept} words
                  {preview.summary ? ` · ${preview.summary}` : ""}
                </p>
              ) : (
                <p>Pasted lyrics give the best sync. Matched words keep their timing if you edit them later.</p>
              )}
            </div>
            <div className="hw-card">
              <Toggle on={hq} onChange={setHq} label={<span>High-quality separation</span>} />
              <p>Cleaner stems, about 3× slower.</p>
            </div>
            <div className="hw-card">
              <span className="hw-card-title">On this machine</span>
              <p>Vocals are separated and words aligned locally. Nothing is uploaded.</p>
            </div>
          </div>
        </div>
      )}

      {job && (
        <div className="hw-card">
          <div className="landing-actions">
            <Led on={!!running} color={failed ? undefined : "orange"} />
            <span style={{ fontWeight: 600 }}>{progressHeadline(job)}</span>
            {job.fraction != null && (
              <div className="progress-bar">
                <i style={{ width: `${Math.round(job.fraction * 100)}%` }} />
              </div>
            )}
          </div>
          <p>{job.message ?? (running ? "Words land on the bench the moment alignment finishes." : "")}</p>
          {failed && <p style={{ color: "var(--hw-danger)" }}>{job.failure ?? job.job.error}</p>}
        </div>
      )}

      <div className="landing-actions">
        {!job && (
          <Key accent icon="play" onClick={generate} disabled={submitting || !probe}>
            Make it karaoke
          </Key>
        )}
        {running && (
          <Key danger onClick={() => cancelJob(job.job.id)}>
            Cancel
          </Key>
        )}
        <span className="hw-grow" />
        <Key onClick={props.onCancel}>{job ? "Back to library" : "Discard"}</Key>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- up next

function UpNextTray(props: { go: (r: Route) => void }) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [openTray, setOpenTray] = useState(false);
  const load = useCallback(() => {
    queueList().then(setEntries).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("karascape:queue", load);
    return () => window.removeEventListener("karascape:queue", load);
  }, [load]);

  return (
    <div className="tray">
      <div className="tray-head">
        <Icon name="queue" />
        <span className="hw-mono" style={{ fontWeight: 700 }}>{String(entries.length).padStart(2, "0")}</span>
        <Label>Up next</Label>
        <span className="hw-grow" />
        {entries.length > 0 && (
          <Key small accent icon="tv" onClick={() => props.go({ view: "play", songId: entries[0].song.id })}>
            Sing
          </Key>
        )}
        <Key small icon={openTray ? "down" : "up"} onClick={() => setOpenTray((v) => !v)} aria-label="Toggle queue" />
      </div>
      {openTray &&
        entries.map((e) => (
          <div key={e.id} className="tray-row">
            <span className="hw-mono hw-muted">{String(e.position + 1).padStart(2, "0")}</span>
            <span className="t">{e.song.title}</span>
            <Key small icon="x" onClick={() => queueRemove(e.id).then(load)} aria-label="Remove" />
          </div>
        ))}
      {openTray && entries.length === 0 && <div className="tray-row hw-muted">Queue a song with Q</div>}
    </div>
  );
}
