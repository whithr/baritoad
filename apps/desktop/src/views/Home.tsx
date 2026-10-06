// Library: the main window's home. Explorer-style — a tree of places on the
// left (collections; the Most sung / Never sung / Recently added shelves; a
// Browse branch of artists, decades, genres, languages and singability,
// all derived from the rows — categories.ts; Needs checking), a sortable
// list of songs that View › Group by can split under headers, the Up next
// queue underneath, and a status bar. Every action lives in the menu bar; the
// toolbar holds only the frequent jobs, and the right-click menus and keys
// are shortcuts to the rest. Adding a song is a wizard (the big drop box
// shows only while the library is empty, or while a file is dragged over);
// adding many is File › Import Folder… (or a folder / several files dropped
// on the window) — a scan, one review list, then a queued batch that reports
// once at the end. Processing reports in a modeless dialog.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  cancelJob,
  collectionAddSong,
  collectionCreate,
  collectionDelete,
  collectionRemoveSong,
  collectionRename,
  libraryCollections,
  libraryDeleteSong,
  librarySongs,
  partyNewCode,
  partyStart,
  partyStop,
  queueAdd,
  queueAddMany,
  queueClear,
  queueMoveEntry,
  queuePlay,
  queueRemove,
  queueState,
  onLibraryChanged,
  onQueueChanged,
  retryJob,
  scanImport,
  songCollections,
  songSetReviewed,
  type CollectionInfo,
  type ImportQueued,
  type ImportScan,
  type QueueEntry,
  type QueueState,
  type Song,
} from "../api";
import type { Route } from "../App";
import { useSettings } from "../App";
import {
  categoryContext,
  categoryFilter,
  facets,
  GROUP_BYS,
  groupRows,
  PACE_LABELS,
  searchSongs,
  type GroupBy,
} from "../categories";
import { batchProgress, failureLines } from "../importState";
import { progressHeadline, type JobProgress, type JobsState } from "../jobEvents";
import { fmtDuration, sortBy, statusFor, type SongStatus, type SortDir } from "../libraryState";
import {
  AppFrame,
  Button,
  Glyph,
  GroupBox,
  Hr,
  Icon,
  ListView,
  MenuBar,
  ProgressBar,
  StatusBar,
  StatusPane,
  TextField,
  ToolButton,
  Toolbar,
  TreeView,
  Vr,
  useAccelerators,
  useMessageBox,
  usePrompt,
  accelLabel,
  isDeleteKey,
  type DragPayload,
  type Column,
  type MenuDef,
  type MenuEntry,
  type TreeNode,
} from "../win98";
import { openStage } from "../stage";
import { EMPTY_QUEUE, moveTarget, shuffled, waiting } from "../queueView";
import CollectionPicker from "./CollectionPicker";
import { EXPORTS, exportWithSaveAs, folderOf } from "../exportFile";
import AddSongWizard, { type WizardTarget } from "./AddSongWizard";
import { useAppDialogs } from "./AppDialogs";
import ImportDialog from "./ImportDialog";
import ToadIcon from "../party/ToadIcon";
import { partyLive, usePartyStatus } from "../party/usePartyStatus";
import PartyDialog from "./PartyDialog";
import LinkDialog from "./LinkDialog";
import { parseLinks } from "../linkState";
import ProcessingDialog from "./ProcessingDialog";
import SongProperties from "./SongProperties";

/** The running bulk import's song files (localStorage), so its report
 *  survives a restart. Best-effort: storage can be unavailable. */
const BATCH_KEY = "baritoad.batch.v1";
function rememberBatch(files: (string | undefined)[]) {
  try {
    const keep = [...new Set(files.filter((f): f is string => !!f))];
    if (keep.length > 0) localStorage.setItem(BATCH_KEY, JSON.stringify(keep));
    else localStorage.removeItem(BATCH_KEY);
  } catch {
    // private mode / quota: the report just won't survive a restart
  }
}
function recalledBatch(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(BATCH_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Browse branches: selecting one lists every song, grouped by it. */
const BROWSE_GROUP: Record<string, GroupBy> = {
  "browse:artist": "artist",
  "browse:decade": "decade",
  "browse:genre": "genre",
  "browse:lang": "language",
  "browse:sing": "pace",
};

const GROUP_LABELS: Record<GroupBy, string> = {
  none: "&None",
  artist: "&Artist",
  decade: "&Decade",
  genre: "&Genre",
  language: "&Language",
  pace: "&Pace",
};

// Mirrors karaoke-core import::AUDIO_EXTENSIONS: audio, plus videos whose
// sound is read directly. WMA and Opus/webm have no decoder.
const AUDIO_EXTS = ["mp3", "flac", "wav", "m4a", "ogg", "aac", "aiff", "aif", "mp4", "m4v", "mov", "mkv"];
const FORMATS_TEXT = "MP3, FLAC, WAV, AIFF, M4A, OGG, or the sound of an MP4, MOV or MKV video";
const isAudioPath = (p: string) => AUDIO_EXTS.includes((p.split(".").pop() ?? "").toLowerCase());


const STATUS_RANK: Record<SongStatus["kind"], number> = {
  processing: 0,
  failed: 1,
  review: 2,
  "needs-timings": 3,
  ready: 4,
};

function StatusCell(props: { s: SongStatus }) {
  const { s } = props;
  switch (s.kind) {
    case "processing":
      return (
        <>
          <Icon name="working" />
          <span>{progressHeadline(s.p)}</span>
          {s.p.fraction != null && <ProgressBar small value={s.p.fraction} style={{ width: 80, flexShrink: 0 }} />}
        </>
      );
    case "failed":
      return (
        <>
          <Icon name="failed" />
          <span>Failed</span>
        </>
      );
    case "needs-timings":
      return (
        <>
          <Icon name="warn" />
          <span>Needs lyrics</span>
        </>
      );
    case "review":
      return (
        <>
          <Icon name="warn" />
          <span>Needs checking</span>
        </>
      );
    default:
      return (
        <>
          <Icon name="ready" />
          <span>Ready</span>
        </>
      );
  }
}

const fmtDate = (unix?: number | null) =>
  unix ? new Date(unix * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";

type SortKey = "title" | "artist" | "length" | "status" | "added" | "played";

export default function Home(props: { go: (r: Route) => void; jobs: JobsState }) {
  const { go, jobs } = props;
  const ask = useMessageBox();
  const prompt = usePrompt();
  const dialogs = useAppDialogs();
  const party = usePartyStatus();
  const [partyOpen, setPartyOpen] = useState(false);

  const [allSongs, setAllSongs] = useState<Song[]>([]);
  const [collSongs, setCollSongs] = useState<Song[] | null>(null);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [node, setNode] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "added", dir: "desc" });
  const [selected, setSelected] = useState<number | null>(null);
  const [inColls, setInColls] = useState<number[]>([]);
  const [qstate, setQstate] = useState<QueueState>(EMPTY_QUEUE);
  const queue = qstate.entries;
  /** The song that just became ready, being filed into a collection. */
  const [fileSong, setFileSong] = useState<{ id: number; title: string } | null>(null);
  const [queueSel, setQueueSel] = useState<number | null>(null);
  const [wizard, setWizard] = useState<WizardTarget | null>(null);
  const [procJob, setProcJob] = useState<number | null>(null);
  const [procOpen, setProcOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importScan, setImportScan] = useState<ImportScan | null>(null);
  /** Add from URL: open with this text in its box (null = closed). */
  const [linkText, setLinkText] = useState<string | null>(null);
  const [propsSong, setPropsSong] = useState<Song | null>(null);
  const { settings, update } = useSettings();
  /** What a running folder scan is looking through. */
  const [scanning, setScanning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const watched = useRef(new Set<number>());
  const announced = useRef(new Set<number>());
  /** The current bulk import's jobs — reported once, when all are done. */
  const batch = useRef<number[]>([]);
  /** Since mount, for picking a batch back up after a restart (below). */
  const mountedAt = useRef(Date.now());
  const batchPickedUp = useRef(false);

  const collectionId = node.startsWith("c:") ? Number(node.slice(2)) : null;
  const collection = collections.find((c) => c.id === collectionId) ?? null;

  // ------------------------------------------------------------- data

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([librarySongs(), libraryCollections()]);
      setAllSongs(s);
      setCollections(c);
      setCollSongs(collectionId != null ? await librarySongs({ collection: collectionId }) : null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [collectionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const completedKey = useMemo(
    () => jobs.order.filter((id) => jobs.jobs[id]?.job.status === "completed").join(","),
    [jobs],
  );
  useEffect(() => {
    void refresh();
  }, [completedKey, refresh]);

  // The startup backfill (year / genre / pace for older songs) lands later.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onLibraryChanged(() => void refresh())
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  // Up next is Rust's (library.rs): every change, from either window, comes
  // back as the whole queue. Loaded once here, then followed.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    queueState()
      .then((q) => !disposed && setQstate(q ?? EMPTY_QUEUE))
      .catch(() => undefined);
    onQueueChanged((q) => !disposed && setQstate(q))
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const statuses = useMemo(() => {
    const m = new Map<number, SongStatus>();
    for (const s of allSongs) m.set(s.id, statusFor(s, jobs));
    for (const s of collSongs ?? []) if (!m.has(s.id)) m.set(s.id, statusFor(s, jobs));
    return m;
  }, [allSongs, collSongs, jobs]);
  const statusOf = useCallback((s: Song) => statuses.get(s.id) ?? statusFor(s, jobs), [statuses, jobs]);

  const reviewCount = useMemo(
    () => allSongs.filter((s) => ["review", "failed", "needs-timings"].includes(statusOf(s).kind)).length,
    [allSongs, statusOf],
  );

  const cctx = useMemo(() => categoryContext(allSongs), [allSongs]);
  const groupBy: GroupBy = BROWSE_GROUP[node] ?? settings.libraryGroupBy;
  const { rows, labelOf } = useMemo(() => {
    let base = collectionId != null ? (collSongs ?? []) : allSongs;
    const inCategory = categoryFilter(node, cctx);
    if (node === "review") base = base.filter((s) => ["review", "failed", "needs-timings"].includes(statusOf(s).kind));
    else if (inCategory) base = base.filter(inCategory);
    const filtered = searchSongs(base, search, cctx);
    const key: Record<SortKey, (s: Song) => string | number | null | undefined> = {
      title: (s) => s.title,
      artist: (s) => s.artist,
      length: (s) => s.duration_s,
      status: (s) => STATUS_RANK[statusOf(s).kind],
      added: (s) => s.date_added,
      played: (s) => s.last_played,
    };
    // The Most sung shelf is in play-count order, whatever the column sort.
    const sorted =
      node === "shelf:most"
        ? [...filtered].sort((a, b) => b.play_count - a.play_count || a.title.localeCompare(b.title))
        : sortBy(filtered, key[sort.key], sort.dir);
    return groupRows(sorted, groupBy, cctx);
  }, [allSongs, collSongs, collectionId, node, search, sort, statusOf, cctx, groupBy]);

  const song = rows.find((s) => s.id === selected) ?? null;
  const st = song ? statusOf(song) : null;

  // keep a selection on screen
  useEffect(() => {
    if (rows.length === 0) setSelected(null);
    else if (selected == null || !rows.some((r) => r.id === selected)) setSelected(rows[0].id);
  }, [rows, selected]);

  useEffect(() => {
    if (!song) return setInColls([]);
    let alive = true;
    songCollections(song.id)
      .then((ids) => alive && setInColls(ids ?? []))
      .catch(() => alive && setInColls([]));
    return () => {
      alive = false;
    };
  }, [song?.id, collections]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------- job notices

  useEffect(() => {
    for (const id of watched.current) {
      const p = jobs.jobs[id];
      if (!p || announced.current.has(id)) continue;
      if (p.job.status === "completed") {
        announced.current.add(id);
        if (procJob === id) setProcOpen(false);
        void ask({
          kind: "info",
          message: (
            <>
              <b>{p.job.title}</b> is ready.
            </>
          ),
          detail: "The words are lined up with the singing. Give the timing a quick check before you sing it.",
          buttons: [
            { id: "check", label: "Check &timing", isDefault: true },
            ...(p.job.library_song_id != null ? [{ id: "file", label: "Add to &collection…" }] : []),
            { id: "later", label: "&Later", cancel: true },
          ],
        }).then((r) => {
          if (r === "check" && p.job.map_path) {
            go({ view: "song", mapPath: p.job.map_path, songId: p.job.library_song_id, title: p.job.title });
          } else if (r === "file" && p.job.library_song_id != null) {
            setFileSong({ id: p.job.library_song_id, title: p.job.title });
          }
        });
      } else if (p.job.status === "failed") {
        announced.current.add(id);
        if (procJob === id) setProcOpen(false);
        // A link whose download failed has no file to process again — it
        // tries the download again instead.
        const undownloaded = !!p.job.source_url && !isAudioPath(p.job.audio);
        void ask({
          kind: "error",
          message: (
            <>
              <b>{p.job.title}</b> couldn't be finished.
            </>
          ),
          detail: p.failure ?? p.job.error ?? "The pipeline stopped without saying why.",
          buttons: [
            undownloaded ? { id: "retry", label: "&Try again" } : { id: "again", label: "&Process again…" },
            { id: "ok", label: "OK", isDefault: true, cancel: true },
          ],
        }).then((r) => {
          if (r === "retry") {
            void retryJob(p.job.id)
              .then((s) => {
                watched.current.add(s.id);
                setProcJob(s.id);
                setProcOpen(true);
              })
              .catch((e) => setError(String(e)));
            return;
          }
          if (r !== "again") return;
          const known = allSongs.find((s) => s.audio_path === p.job.audio);
          setWizard({
            path: p.job.audio,
            again: { title: p.job.title, artist: p.job.artist, outDir: p.job.out_dir, hasTiming: !!known?.timing_map_path },
          });
        });
      } else if (p.job.status === "cancelled") {
        announced.current.add(id);
        if (procJob === id) setProcOpen(false);
      }
    }
  }, [jobs, ask, go, procJob, allSongs]);

  // ----------------------------------------------------------- actions

  const addSong = useCallback(async () => {
    const picked = await open({ multiple: false, filters: [{ name: "Songs (audio or video)", extensions: AUDIO_EXTS }] });
    if (typeof picked === "string") setWizard({ path: picked });
  }, []);

  // Bulk import: scan what was picked or dropped, then review it.
  const startImport = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setScanning(paths.length === 1 ? paths[0] : `${paths.length} items`);
      try {
        const scan = await scanImport(paths);
        if (scan.items.length === 0) {
          await ask({
            kind: "info",
            title: "Import Songs",
            message: "No songs found there.",
            detail: `Songs can be ${FORMATS_TEXT}, in the folder or any folder inside it.`,
          });
        } else {
          setImportScan(scan);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setScanning(null);
      }
    },
    [ask],
  );
  const startImportRef = useRef(startImport);
  startImportRef.current = startImport;
  // Links pasted anywhere on the Library (not into a field or a dialog)
  // open Add from URL with them.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest("input, textarea, [contenteditable='true'], [role='dialog'], [role='alertdialog']")) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (parseLinks(text).length === 0) return;
      e.preventDefault();
      setLinkText(text.trim());
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const importFolder = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") void startImport([picked]);
  }, [startImport]);

  // A native drop lands on the webview, not the DOM.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") setDragOver(true);
        else if (event.payload.type === "leave") setDragOver(false);
        else if (event.payload.type === "drop") {
          setDragOver(false);
          // One song → the Add Song wizard; a folder or several files → a
          // scan and the Import Songs review.
          const paths = event.payload.paths;
          if (paths.length === 1 && isAudioPath(paths[0])) setWizard({ path: paths[0] });
          else if (paths.length > 0) void startImportRef.current(paths);
        }
      })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const onImportQueued = (r: ImportQueued) => {
    setImportScan(null);
    batch.current = batch.current.concat(r.jobs.map((j) => j.id));
    rememberBatch(batch.current.map((id) => jobs.jobs[id]?.job.audio).concat(r.jobs.map((j) => j.audio)));
    if (r.jobs.length > 0) {
      setProcJob(r.jobs[0].id);
      setProcOpen(true);
    }
    if (r.failures.length > 0) {
      void ask({
        kind: "warning",
        title: "Import Songs",
        message: `${r.failures.length === 1 ? "1 song" : `${r.failures.length} songs`} couldn't be queued.`,
        detail: r.failures.map((f) => `${f.audio_path.split(/[\\/]/).pop()}: ${f.message}`).join("\n"),
      });
    }
  };

  // A batch outlives a restart: the queue resumes its songs (as new jobs),
  // so the batch is remembered by their files and picked back up here — the
  // report still comes once, at the end. Given up after 10 s (nothing of it
  // left to finish).
  useEffect(() => {
    if (batchPickedUp.current || batch.current.length > 0) return;
    const files = recalledBatch();
    if (files.length === 0) {
      batchPickedUp.current = true;
      return;
    }
    const ids = jobs.order.filter((id) => {
      const p = jobs.jobs[id];
      return !!p && files.includes(p.job.audio) && (p.job.status === "queued" || p.job.status === "running");
    });
    if (ids.length > 0) {
      batchPickedUp.current = true;
      batch.current = ids;
    } else if (Date.now() - mountedAt.current > 10_000) {
      batchPickedUp.current = true;
      rememberBatch([]);
    }
  }, [jobs]);

  useEffect(() => {
    if (batch.current.length === 0) return;
    const b = batchProgress(batch.current.map((id) => jobs.jobs[id]));
    if (b.remaining > 0) return;
    const failed = batch.current.map((id) => jobs.jobs[id]).filter((p) => p?.job.status === "failed");
    batch.current = [];
    rememberBatch([]);
    setProcOpen(false);
    const lines = [
      b.done > 0 ? `${b.done === 1 ? "1 song is" : `${b.done} songs are`} in your library. Songs baritoad timed wait under Needs checking for a quick listen.` : "",
      ...failureLines(failed.map((p) => p!)),
      b.cancelled > 0 ? `${b.cancelled} cancelled.` : "",
    ].filter(Boolean);
    void ask({
      kind: b.failed > 0 ? "warning" : "info",
      title: "Import Songs",
      message:
        b.done === b.total
          ? `Imported ${b.total === 1 ? "1 song" : `${b.total} songs`}.`
          : `Imported ${b.done} of ${b.total === 1 ? "1 song" : `${b.total} songs`}.`,
      detail: lines.join("\n\n"),
      buttons: [
        ...(b.failed > 0 ? [{ id: "retry", label: "&Try those again" }] : []),
        ...(b.done > 0
          ? [
              { id: "review", label: "Show &Needs checking", isDefault: true },
              { id: "ok", label: "OK", cancel: true },
            ]
          : [{ id: "ok", label: "OK", isDefault: true, cancel: true }]),
      ],
    }).then((r) => {
      if (r === "review") setNode("review");
      else if (r === "retry") {
        // Failed songs run again as a new batch; a finished download or
        // lyrics lookup isn't repeated (queue.rs retry).
        void Promise.all(failed.map((p) => retryJob(p!.job.id)))
          .then((snaps) => {
            batch.current = snaps.map((s) => s.id);
            rememberBatch(snaps.map((s) => s.audio));
            if (snaps[0]) {
              setProcJob(snaps[0].id);
              setProcOpen(true);
            }
          })
          .catch((e) => setError(String(e)));
      }
    });
  }, [jobs, ask]);

  const canOpen = !!song?.timing_map_path && st?.kind !== "processing";
  const openSong = (s: Song | null = song) => {
    if (!s?.timing_map_path || statusOf(s).kind === "processing") return;
    go({ view: "song", mapPath: s.timing_map_path, title: s.title, songId: s.id });
  };
  // Sing opens (or reuses) the Stage window; the Library stays here.
  const singSong = async (songId: number) => {
    if (!(await openStage({ song_id: songId }))) go({ view: "play", songId });
  };
  const sing = (s: Song | null = song) => {
    if (!s?.timing_map_path || statusOf(s).kind === "processing") return;
    void singSong(s.id);
  };
  // Process again: the Add Song wizard, reopened on the song's own file and
  // job folder (see AddSongWizard) — how a failed song, or one that still
  // needs lyrics, gets another run.
  const canProcessAgain = !!song && st?.kind !== "processing";
  const processAgain = (s: Song | null = song) => {
    if (!s || statusOf(s).kind === "processing") return;
    setWizard({
      path: s.audio_path,
      again: { title: s.title, artist: s.artist, outDir: s.job_dir, hasTiming: !!s.timing_map_path },
    });
  };
  // Enter / double-click: the song's next step — sing it once it's ready,
  // check its timing while it still needs checking, process it again when it
  // failed or has no timing yet.
  const activate = (s: Song) => {
    const k = statusOf(s).kind;
    if (k === "ready") sing(s);
    else if (k === "review") openSong(s);
    else if (k === "failed" || k === "needs-timings") processAgain(s);
  };
  const addToQueue = async (s: Song | null = song) => {
    if (!s?.timing_map_path) return;
    try {
      await queueAdd(s.id, collectionId ?? undefined);
    } catch (e) {
      setError(String(e));
    }
  };
  const markChecked = async () => {
    if (!song) return;
    await songSetReviewed(song.id, true).catch((e) => setError(String(e)));
    void refresh();
  };
  const doExport = async (format: string) => {
    if (!song?.timing_map_path) return;
    try {
      await exportWithSaveAs(ask, {
        mapPath: song.timing_map_path,
        format,
        title: song.title,
        artist: song.artist,
        nextTo: folderOf(song.audio_path),
      });
    } catch (e) {
      await ask({ kind: "error", title: "Export", message: "The export didn't finish.", detail: String(e) });
    }
  };
  const removeSong = async () => {
    if (!song) return;
    const r = await ask({
      kind: "question",
      title: "Remove song",
      message: (
        <>
          Remove <b>{song.title}</b> from your library?
        </>
      ),
      detail: "Its timing and separated tracks stay on disk, and your original audio file stays where it is.",
      buttons: [
        { id: "remove", label: "&Remove" },
        { id: "keep", label: "&Keep it", isDefault: true, cancel: true },
      ],
    });
    if (r !== "remove") return;
    try {
      await libraryDeleteSong(song.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const newCollection = async (withSong?: Song | null) => {
    const name = await prompt({ title: "New Collection", label: "Collection &name:", okLabel: "Create" });
    if (!name) return;
    try {
      const c = await collectionCreate(name);
      if (withSong && c) await collectionAddSong(c.id, withSong.id);
      await refresh();
      if (!withSong && c) setNode(`c:${c.id}`);
    } catch (e) {
      setError(String(e));
    }
  };
  const toggleInCollection = async (c: CollectionInfo) => {
    if (!song) return;
    try {
      if (inColls.includes(c.id)) await collectionRemoveSong(c.id, song.id);
      else await collectionAddSong(c.id, song.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const renameCollection = async () => {
    if (!collection) return;
    const name = await prompt({ title: "Rename Collection", label: "Collection &name:", value: collection.name, okLabel: "Rename" });
    if (!name || name === collection.name) return;
    await collectionRename(collection.id, name).catch((e) => setError(String(e)));
    void refresh();
  };
  const deleteCollection = async () => {
    if (!collection) return;
    const r = await ask({
      kind: "question",
      title: "Delete collection",
      message: (
        <>
          Delete the collection <b>{collection.name}</b>?
        </>
      ),
      detail: "The songs in it stay in your library.",
      buttons: [
        { id: "delete", label: "&Delete" },
        { id: "keep", label: "&Keep it", isDefault: true, cancel: true },
      ],
    });
    if (r !== "delete") return;
    await collectionDelete(collection.id).catch((e) => setError(String(e)));
    setNode("all");
    void refresh();
  };

  // queue
  const qIdx = queue.findIndex((e) => e.id === queueSel);
  const qEntry = qIdx >= 0 ? queue[qIdx] : null;
  const waitingQueue = waiting(qstate);
  const singNext = async () => {
    const e = qEntry && qEntry.id !== qstate.playing ? qEntry : waitingQueue[0];
    if (!e) return;
    try {
      await queuePlay(e.id);
    } catch (err) {
      setError(String(err));
      return;
    }
    await singSong(e.song.id);
  };
  /** A drag landed on Up next at `slot` (before row `slot`). */
  const dropOnQueue = async (p: DragPayload, slot: number) => {
    try {
      if (p.kind === "song") {
        const e = await queueAdd(p.value as number, collectionId ?? undefined);
        if (slot < queue.length) await queueMoveEntry(e.id, slot);
        setQueueSel(e.id);
      } else if (p.kind === "entry") {
        const from = queue.findIndex((e) => e.id === p.value);
        if (from < 0) return;
        const to = moveTarget(from, slot);
        if (to !== from) await queueMoveEntry(p.value as number, to);
        setQueueSel(p.value as number);
      }
    } catch (e) {
      setError(String(e));
    }
  };
  /** Collection › Add all / Shuffle into Up next, in collection order (or
   *  shuffled); songs that aren't ready to sing stay behind. */
  const queueCollection = async (shuffle: boolean) => {
    if (!collection) return;
    try {
      const songs = await librarySongs({ collection: collection.id, sort: "collection_order" });
      const ready = songs.filter((s) => !!s.timing_map_path);
      if (ready.length === 0) {
        await ask({
          kind: "info",
          title: "Up next",
          message: (
            <>
              None of the songs in <b>{collection.name}</b> are ready to sing yet.
            </>
          ),
          detail: "A song is ready once its words are lined up with the singing.",
        });
        return;
      }
      await queueAddMany((shuffle ? shuffled(ready) : ready).map((s) => s.id), collection.id);
    } catch (e) {
      setError(String(e));
    }
  };
  const moveQueue = async (delta: number) => {
    if (!qEntry) return;
    const to = qIdx + delta;
    if (to < 0 || to >= queue.length) return;
    await queueMoveEntry(qEntry.id, to).catch((e) => setError(String(e)));
  };
  const removeQueued = async () => {
    if (!qEntry) return;
    await queueRemove(qEntry.id).catch(() => undefined);
  };
  const clearQueue = async () => {
    const r = await ask({
      kind: "question",
      title: "Up next",
      message: "Clear the whole Up next list?",
      buttons: [
        { id: "clear", label: "&Clear" },
        { id: "keep", label: "&Keep it", isDefault: true, cancel: true },
      ],
    });
    if (r === "clear") {
      await queueClear().catch(() => undefined);
    }
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "added" || key === "played" ? "desc" : "asc" }));

  // ---------------------------------------------------------- commands

  const songMenu: MenuEntry[] = [
    { label: "&Sing", accel: "F5", keys: "f5", run: () => sing(), disabled: !canOpen },
    { label: "Check &timing", accel: "Ctrl+T", keys: "ctrl+t", run: () => openSong(), disabled: !canOpen },
    { label: "Add to &Up next", accel: "Q", run: () => void addToQueue(), disabled: !song?.timing_map_path },
    { label: "&Mark as checked", run: () => void markChecked(), disabled: st?.kind !== "review" },
    { label: "&Process again…", run: () => processAgain(), disabled: !canProcessAgain },
    "-",
    {
      label: "Add to &collection",
      disabled: !song,
      items: [
        ...collections.map<MenuEntry>((c) => ({ label: c.name.replace(/&/g, "&&"), checked: inColls.includes(c.id), run: () => void toggleInCollection(c) })),
        ...(collections.length ? ["-" as const] : []),
        { label: "&New collection…", run: () => void newCollection(song) },
      ],
    },
    {
      label: "&Export",
      disabled: !song?.timing_map_path,
      items: EXPORTS.map(([f, label]) => ({ label, run: () => void doExport(f) })),
    },
    "-",
    { label: "&Remove from Library…", accel: "Del", run: () => void removeSong(), disabled: !song },
    "-",
    { label: "P&roperties…", accel: "Alt+Enter", keys: "alt+enter", run: () => song && setPropsSong(song), disabled: !song },
  ];

  const menus: MenuDef[] = [
    {
      label: "&File",
      items: [
        { label: "&Add Song…", accel: "Ctrl+O", keys: "ctrl+o", run: () => void addSong() },
        { label: "&Import Folder…", accel: "Ctrl+Shift+O", keys: "ctrl+shift+o", run: () => void importFolder(), disabled: scanning != null },
        { label: "Add from &URL…", accel: "Ctrl+L", keys: "ctrl+l", run: () => setLinkText("") },
        { label: "&New Collection…", run: () => void newCollection() },
        "-",
        { label: "E&xit", accel: "Alt+F4", run: () => void getCurrentWindow().close().catch(() => undefined) },
      ],
    },
    {
      label: "&Edit",
      items: [
        { label: "&Find…", accel: "Ctrl+F", keys: "ctrl+f, /", run: () => searchRef.current?.focus() },
      ],
    },
    {
      label: "&View",
      items: [
        {
          label: "&Sort by",
          items: (
            [
              ["title", "&Title"],
              ["artist", "&Artist"],
              ["length", "&Length"],
              ["status", "&Status"],
              ["added", "Date &added"],
              ["played", "Last &sung"],
            ] as [SortKey, string][]
          ).map(([k, label]) => ({ label, checked: sort.key === k, radio: true, run: () => toggleSort(k) })),
        },
        {
          label: "&Group by",
          items: GROUP_BYS.map((g) => ({
            label: GROUP_LABELS[g],
            checked: settings.libraryGroupBy === g,
            radio: true,
            run: () => update({ libraryGroupBy: g }),
          })),
        },
        "-",
        { label: "&Refresh", accel: "Ctrl+R", keys: "ctrl+r", run: () => void refresh() },
      ],
    },
    { label: "&Song", items: songMenu },
    {
      label: "&Collection",
      items: [
        { label: "&New…", run: () => void newCollection() },
        { label: "&Rename…", accel: "F2", run: () => void renameCollection(), disabled: !collection },
        { label: "&Delete…", run: () => void deleteCollection(), disabled: !collection },
        "-",
        { label: "Add all to &Up next", run: () => void queueCollection(false), disabled: !collection },
        { label: "&Shuffle into Up next", run: () => void queueCollection(true), disabled: !collection },
      ],
    },
    {
      label: "&Party",
      items: [
        {
          label: partyLive(party) ? "Show &party…" : "&Start party…",
          run: () => {
            setPartyOpen(true);
            if (party.phase === "off" || party.phase === "ended") void partyStart().catch((e) => setError(String(e)));
          },
        },
        { label: "&New join code", run: () => void partyNewCode().catch((e) => setError(String(e))), disabled: party.phase !== "open" },
        "-",
        { label: "&End party", run: () => void partyStop(), disabled: party.phase === "off" || party.phase === "ended" },
      ],
    },
    {
      label: "&Tools",
      items: [
        { label: "Player &Themes…", run: () => dialogs.open("themes") },
        { label: "&Models…", run: () => dialogs.open("models") },
        { label: "&Properties…", run: () => dialogs.open("properties") },
      ],
    },
    {
      label: "&Help",
      items: [
        { label: "&Keyboard Shortcuts", accel: "F1", keys: "f1", run: () => void showShortcuts() },
        "-",
        { label: "&About baritoad", run: () => dialogs.open("about") },
      ],
    },
  ];
  useAccelerators(menus);

  const showShortcuts = () =>
    ask({
      kind: "info",
      title: "Keyboard Shortcuts",
      message: "Library",
      detail: (
        <div style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: "2px 12px" }}>
          <span>↑ ↓</span>
          <span>Move through songs</span>
          <span>Enter</span>
          <span>The song's next step: sing it, check its timing, or process it again</span>
          <span>F5</span>
          <span>Sing</span>
          <span>{accelLabel("Ctrl+T")}</span>
          <span>Check the timing</span>
          <span>Q</span>
          <span>Add to Up next</span>
          <span>{accelLabel("Alt+↑ ↓")}</span>
          <span>Move in Up next</span>
          <span>{accelLabel("Del")}</span>
          <span>Remove from the library (or from Up next)</span>
          <span>{accelLabel("Alt+Enter")}</span>
          <span>Song properties (title, artist, year, genre)</span>
          <span>{accelLabel("/ or Ctrl+F")}</span>
          <span>Find</span>
          <span>{accelLabel("Ctrl+O")}</span>
          <span>Add a song</span>
          <span>{accelLabel("Ctrl+Shift+O")}</span>
          <span>Import a folder of songs</span>
          <span>{accelLabel("Alt / F10")}</span>
          <span>Menus</span>
          <span>{accelLabel("Shift+F10")}</span>
          <span>Right-click menu</span>
        </div>
      ),
    });
  // --------------------------------------------------------------- tree

  const count = (id: string) => {
    const f = categoryFilter(id, cctx);
    return f ? allSongs.filter(f).length : 0;
  };
  const facetNodes = (kind: "artist" | "decade" | "genre" | "lang"): TreeNode[] =>
    facets(allSongs, kind).map((f) => ({ id: f.id, label: `${f.label} (${f.count})`, icon: <Icon name="folder" /> }));
  const browse: TreeNode[] = [
    { id: "browse:artist", label: "Artists", icon: <Icon name="folder" />, collapsed: true, children: facetNodes("artist") },
    { id: "browse:decade", label: "Decades", icon: <Icon name="folder" />, collapsed: true, children: facetNodes("decade") },
    { id: "browse:genre", label: "Genres", icon: <Icon name="folder" />, collapsed: true, children: facetNodes("genre") },
    ...(facets(allSongs, "lang").length > 1
      ? [{ id: "browse:lang", label: "Languages", icon: <Icon name="folder" />, collapsed: true, children: facetNodes("lang") }]
      : []),
    {
      id: "browse:sing",
      label: "Singability",
      icon: <Icon name="folder" />,
      collapsed: true,
      children: [
        ...(cctx.bands
          ? (["slow", "fast"] as const).map((p) => ({ id: `sing:${p}`, label: `${PACE_LABELS[p]} (${count(`sing:${p}`)})`, icon: <Icon name="timing" /> }))
          : []),
        { id: "sing:short", label: `Short songs (${count("sing:short")})`, icon: <Icon name="timing" /> },
      ],
    },
  ].filter((b) => b.children.length > 0);
  const tree: TreeNode[] = [
    {
      id: "lib",
      label: "Library",
      icon: <Icon name="app" />,
      children: [
        { id: "all", label: `All songs (${allSongs.length})`, icon: <Icon name="folder" /> },
        ...collections.map((c) => ({ id: `c:${c.id}`, label: `${c.name} (${c.song_count})`, icon: <Icon name="folder" /> })),
      ],
    },
    { id: "shelf:most", label: `Most sung (${count("shelf:most")})`, icon: <Icon name="note" />, gap: true },
    { id: "shelf:never", label: `Never sung (${count("shelf:never")})`, icon: <Icon name="mic" /> },
    { id: "shelf:recent", label: `Recently added (${count("shelf:recent")})`, icon: <Icon name="disc" /> },
    ...(browse.length > 0 ? [{ id: "browse", label: "Browse", icon: <Icon name="folder" />, gap: true, children: browse }] : []),
    { id: "review", label: `Needs checking (${reviewCount})`, icon: <Icon name="warn" />, gap: true },
  ];
  const onTreeSelect = (id: string) => {
    if (id === "lib" || id === "browse") id = "all";
    setNode(id);
  };
  const findLabel = (nodes: TreeNode[], id: string): string | null => {
    for (const n of nodes) {
      if (n.id === id) return typeof n.label === "string" ? n.label.replace(/ \(\d+\)$/, "") : null;
      const hit = n.children ? findLabel(n.children, id) : null;
      if (hit) return hit;
    }
    return null;
  };
  const place = collection?.name ?? (node === "all" ? "Library" : (findLabel(tree, node) ?? "Library"));

  // ------------------------------------------------------------ columns

  const columns: Column<Song>[] = [
    {
      key: "title",
      label: "Title",
      width: "minmax(160px, 1.6fr)",
      sortable: true,
      render: (s) => (
        <>
          <Icon name="disc" />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</span>
        </>
      ),
    },
    { key: "artist", label: "Artist", width: "minmax(110px, 1.2fr)", sortable: true, render: (s) => s.artist ?? <span className="w-muted">Unknown artist</span> },
    { key: "length", label: "Length", width: "72px", sortable: true, render: (s) => fmtDuration(s.duration_s) ?? "" },
    { key: "status", label: "Status", width: "minmax(170px, 1.5fr)", sortable: true, render: (s) => <StatusCell s={statusOf(s)} /> },
    { key: "added", label: "Added", width: "112px", sortable: true, render: (s) => fmtDate(s.date_added) },
    { key: "played", label: "Last sung", width: "112px", sortable: true, render: (s) => fmtDate(s.last_played) },
  ];

  const activeJob = jobs.order
    .map((id) => jobs.jobs[id])
    .find((p) => p && (p.job.status === "running" || p.job.status === "queued"));
  const waitingJobs = jobs.order
    .map((id) => jobs.jobs[id])
    .filter((p): p is JobProgress => !!p && p.job.status === "queued" && p !== activeJob);
  // The Processing dialog follows a batch: once its song is done it shows
  // the batch's song in progress (else whatever is running).
  const procProgress = procJob != null ? jobs.jobs[procJob] : undefined;
  const unfinished = (p: JobProgress | undefined) => !!p && (p.job.status === "queued" || p.job.status === "running");
  const batchNow = (() => {
    const mine = batch.current.map((id) => jobs.jobs[id]);
    return mine.find((p) => p?.job.status === "running") ?? mine.find(unfinished);
  })();
  const shownJob = unfinished(procProgress) ? procProgress : (batchNow ?? activeJob ?? procProgress);
  const cancelAll = async () => {
    const r = await ask({
      kind: "question",
      title: "Import Songs",
      message: "Stop importing?",
      detail: `The song in progress and the ${waitingJobs.length === 1 ? "1 song" : `${waitingJobs.length} songs`} waiting won't be imported. Songs already finished stay in your library.`,
      buttons: [
        { id: "stop", label: "&Stop importing" },
        { id: "keep", label: "&Keep going", isDefault: true, cancel: true },
      ],
    });
    if (r !== "stop") return;
    for (const p of [...waitingJobs, ...(activeJob ? [activeJob] : [])]) void cancelJob(p.job.id).catch(() => undefined);
  };

  const emptyText =
    allSongs.length === 0
      ? "No songs yet."
      : search
        ? "No songs match your search."
        : node === "review"
          ? "Every song has been checked."
          : node === "shelf:most"
            ? "Nothing sung yet. The songs you sing show up here."
            : node === "shelf:never"
              ? "You've sung every song."
              : node === "shelf:recent"
                ? "Nothing added in the last 30 days."
                : collection
                  ? "This collection is empty. Right-click a song › Add to collection."
                  : "No songs here.";

  const queueMenu: MenuEntry[] = [
    { label: "&Sing now", accel: "Enter", run: () => void singNext(), disabled: !qEntry || qEntry.id === qstate.playing },
    "-",
    { label: "Move &up", accel: "Alt+↑", run: () => void moveQueue(-1), disabled: !qEntry || qIdx === 0 },
    { label: "Move &down", accel: "Alt+↓", run: () => void moveQueue(1), disabled: !qEntry || qIdx === queue.length - 1 },
    { label: "&Remove", accel: "Del", run: () => void removeQueued(), disabled: !qEntry },
    "-",
    { label: "&Clear Up next…", run: () => void clearQueue(), disabled: queue.length === 0 },
  ];

  return (
    <AppFrame title={`baritoad - ${place}`} icon={<Icon name="app" />}>
      <MenuBar menus={menus} />
      <Hr />
      <Toolbar label="Library">
        <ToolButton icon={<Icon name="disc" />} onClick={() => void addSong()} tip="Add a song (Ctrl+O)">
          Add song…
        </ToolButton>
        <ToolButton icon={<Icon name="globe" />} onClick={() => setLinkText("")} tip="Add songs from links — paste a link anywhere, or Ctrl+L">
          From URL…
        </ToolButton>
        <Vr />
        <ToolButton icon={<Icon name="tv" />} onClick={() => sing()} disabled={!canOpen} tip="Sing the selected song (F5)">
          Sing
        </ToolButton>
        <ToolButton icon={<Icon name="queue" />} onClick={() => void addToQueue()} disabled={!song?.timing_map_path} tip="Add to Up next (Q)">
          Up next
        </ToolButton>
        <ToolButton icon={<Icon name="timing" />} onClick={() => openSong()} disabled={!canOpen} tip="Check the timing (Ctrl+T)">
          Check timing
        </ToolButton>
        <span className="w-grow" />
        <label htmlFor="lib-find" style={{ marginRight: 4 }}>
          <span className="w-ak">F</span>ind:
        </label>
        <TextField
          id="lib-find"
          ref={searchRef}
          value={search}
          placeholder="Title, artist, genre, 80s, never sung…"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSearch("");
            if (e.key === "ArrowDown" || e.key === "Enter") listRef.current?.focus();
          }}
          style={{ width: 240 }}
        />
      </Toolbar>
      <Hr />

      <div style={{ flexGrow: 1, minHeight: 0, display: "flex", gap: 6, padding: "6px 2px 2px" }}>
        <TreeView
          ariaLabel="Places"
          nodes={tree}
          selected={node === "all" ? "all" : node}
          onSelect={onTreeSelect}
          style={{ width: 220, flexShrink: 0 }}
          onKey={(e) => {
            if (e.key === "F2" && collection) {
              e.preventDefault();
              void renameCollection();
              return true;
            }
            return false;
          }}
          contextMenu={
            collection
              ? [
                  { label: "Add all to &Up next", run: () => void queueCollection(false) },
                  { label: "&Shuffle into Up next", run: () => void queueCollection(true) },
                  "-",
                  { label: "&Rename…", accel: "F2", run: () => void renameCollection() },
                  { label: "&Delete…", run: () => void deleteCollection() },
                  "-",
                  { label: "&New Collection…", run: () => void newCollection() },
                ]
              : [{ label: "&New Collection…", run: () => void newCollection() }]
          }
        />

        <div style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8, position: "relative" }}>
          {allSongs.length === 0 && (
            <GroupBox label="Add a song" style={{ flexShrink: 0 }}>
              <div
                className={dragOver ? "w-dither" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "10px 14px",
                  outline: "1px dotted var(--w-shadow)",
                  outlineOffset: -5,
                  background: dragOver ? undefined : "var(--w-face)",
                  boxShadow: "var(--w-sunken)",
                }}
              >
                <Icon name="disc" size={32} />
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flexGrow: 1, lineHeight: "18px" }}>
                  <b>{dragOver ? "Let go to add them" : "Drop songs or a folder of them here"}</b>
                  <span>Or browse for an audio file you own, or a whole folder.</span>
                </div>
                <Button onClick={() => void addSong()}>&Browse…</Button>
                <Button onClick={() => void importFolder()} disabled={scanning != null}>
                  Import &Folder…
                </Button>
              </div>
            </GroupBox>
          )}
          {dragOver && allSongs.length > 0 && (
            <div
              className="w-dither"
              style={{ position: "absolute", inset: 0, zIndex: 5, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}
            >
              <div className="w-window" style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px" }}>
                <Icon name="disc" size={32} />
                <b>Let go to add them</b>
              </div>
            </div>
          )}

          {error && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }} role="alert">
              <Icon name="error" />
              <span className="w-grow">{error}</span>
              <Button slim onClick={() => setError(null)}>
                Dismiss
              </Button>
            </div>
          )}

          <ListView<Song>
            ariaLabel="Songs"
            listRef={listRef}
            columns={columns}
            rows={rows}
            rowKey={(s) => s.id}
            selected={selected}
            onSelect={(k) => setSelected(k as number)}
            onActivate={activate}
            rowDim={(s) => statusOf(s).kind === "processing"}
            sort={sort}
            onSort={(k) => toggleSort(k as SortKey)}
            groupOf={groupBy !== "none" ? labelOf : undefined}
            empty={emptyText}
            contextMenu={songMenu}
            dragRow={(s) => (s.timing_map_path ? { kind: "song", value: s.id, label: s.title } : null)}
            style={{ flexGrow: 1 }}
            onKey={(e) => {
              if ((e.key === "q" || e.key === "Q") && !e.ctrlKey && !e.metaKey && !e.altKey) {
                void addToQueue();
                e.preventDefault();
                return true;
              }
              if (isDeleteKey(e)) {
                void removeSong();
                e.preventDefault();
                return true;
              }
              return false;
            }}
          />

          <GroupBox label={`Up next (${waitingQueue.length})`} style={{ flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <ListView<QueueEntry>
                ariaLabel="Up next"
                style={{ height: 112, flexGrow: 1 }}
                rows={queue}
                rowKey={(e) => e.id}
                selected={queueSel}
                onSelect={(k) => setQueueSel(k as number)}
                onActivate={() => void singNext()}
                contextMenu={queueMenu}
                dragRow={(e) => (e.id === qstate.playing ? null : { kind: "entry", value: e.id, label: e.song.title })}
                drop={{ accepts: (p) => p.kind === "song" || p.kind === "entry", onDrop: (p, slot) => void dropOnQueue(p, slot) }}
                empty="Nothing queued. Select a song and press Q, or drag it here."
                columns={[
                  {
                    key: "pos",
                    label: "#",
                    width: "36px",
                    // The song on the Stage shows ▶; the rest count from 1.
                    render: (e) =>
                      e.id === qstate.playing ? (
                        <span title="On the Stage now" aria-label="On the Stage now">
                          <Glyph name="play" />
                        </span>
                      ) : (
                        waitingQueue.indexOf(e) + 1
                      ),
                  },
                  { key: "title", label: "Title", width: "minmax(0, 1.4fr)", render: (e) => e.song.title },
                  { key: "artist", label: "Artist", width: "minmax(0, 1fr)", render: (e) => e.song.artist ?? "" },
                  // Party mode: the guest's toad (face, 1×) and name.
                  {
                    key: "singer",
                    label: "Singer",
                    width: "minmax(0, 0.8fr)",
                    render: (e) =>
                      e.singer ? (
                        <span style={{ display: "inline-flex", gap: 4, alignItems: "center", minWidth: 0 }}>
                          {e.toad && <ToadIcon toad={e.toad} />}
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{e.singer}</span>
                        </span>
                      ) : (
                        ""
                      ),
                  },
                  { key: "len", label: "Length", width: "64px", render: (e) => fmtDuration(e.song.duration_s) ?? "" },
                ]}
                onKey={(e) => {
                  if (isDeleteKey(e)) {
                    void removeQueued();
                    return true;
                  }
                  if (e.altKey && e.key === "ArrowUp") {
                    void moveQueue(-1);
                    e.preventDefault();
                    return true;
                  }
                  if (e.altKey && e.key === "ArrowDown") {
                    void moveQueue(1);
                    e.preventDefault();
                    return true;
                  }
                  return false;
                }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 5, width: 112, flexShrink: 0 }}>
                <Button isDefault onClick={() => void singNext()} disabled={waitingQueue.length === 0} style={{ width: "100%" }}>
                  Sing &next
                </Button>
                <Button onClick={() => void removeQueued()} disabled={!qEntry} style={{ width: "100%" }}>
                  Re&move
                </Button>
              </div>
            </div>
          </GroupBox>
        </div>
      </div>

      <StatusBar>
        <StatusPane width={170}>
          {rows.length} song{rows.length === 1 ? "" : "s"}
          {song ? ", 1 selected" : ""}
        </StatusPane>
        <StatusPane grow>
          {scanning ? (
            <>
              <Icon name="working" />
              Looking for songs in {scanning}…
            </>
          ) : activeJob ? (
            <>
              <Icon name="working" />
              <button
                type="button"
                className="w-tool"
                style={{ height: 18, padding: "0 4px" }}
                onClick={() => {
                  setProcJob(activeJob.job.id);
                  setProcOpen(true);
                }}
              >
                {progressHeadline(activeJob)}: {activeJob.job.title}
                {waitingJobs.length > 0 ? ` (${waitingJobs.length} more waiting)` : ""}
              </button>
            </>
          ) : (
            "Ready"
          )}
        </StatusPane>
        {partyLive(party) ? (
          <StatusPane width={330} title={`While the party is open: your song list and Up next go to ${party.relay || "the party relay"}. Never your music, lyrics or files.`}>
            <Icon name="globe" />
            Party open — sharing your song list and Up next
          </StatusPane>
        ) : (
          <StatusPane width={250}>
            <Icon name="lock" />
            Local only — nothing is uploaded
          </StatusPane>
        )}
      </StatusBar>

      <AddSongWizard
        target={wizard}
        onClose={() => setWizard(null)}
        onStarted={(jobId) => {
          watched.current.add(jobId);
          setWizard(null);
          setProcJob(jobId);
          setProcOpen(true);
        }}
      />
      {dialogs.element}
      <PartyDialog open={partyOpen} onClose={() => setPartyOpen(false)} status={party} />
      <ImportDialog scan={importScan} onClose={() => setImportScan(null)} onQueued={onImportQueued} />
      <CollectionPicker song={fileSong} collections={collections} onClose={() => setFileSong(null)} onAdded={() => void refresh()} />
      <LinkDialog
        initialText={linkText}
        onClose={() => setLinkText(null)}
        onQueued={(r) => {
          setLinkText(null);
          onImportQueued(r);
        }}
      />
      <SongProperties
        song={propsSong}
        bands={cctx.bands}
        onClose={() => setPropsSong(null)}
        onSaved={() => {
          setPropsSong(null);
          void refresh();
        }}
      />
      <ProcessingDialog
        job={shownJob}
        waiting={waitingJobs}
        onCancelAll={() => void cancelAll()}
        open={procOpen}
        onHide={() => setProcOpen(false)}
        onCancelJob={(id) => void cancelJob(id)}
      />
    </AppFrame>
  );
}
