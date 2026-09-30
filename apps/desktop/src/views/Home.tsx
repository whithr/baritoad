// Library: the main window's home. Explorer-style — a tree of places on the
// left (collections, Processing, Needs checking), a sortable list of songs,
// the Up next queue underneath, and a status bar. Every action lives in the
// menu bar; the toolbar, right-click menu and keys are shortcuts to it.
// Adding a song is a wizard; processing reports in a modeless dialog.

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
  exportSong,
  libraryCollections,
  libraryDeleteSong,
  librarySongs,
  queueAdd,
  queueClear,
  queueList,
  queueMoveEntry,
  queueRemove,
  songCollections,
  songSetReviewed,
  type CollectionInfo,
  type QueueEntry,
  type Song,
} from "../api";
import type { Route } from "../App";
import { progressHeadline, type JobProgress, type JobsState } from "../jobEvents";
import { filterSongs, fmtDuration, sortBy, type SortDir } from "../libraryState";
import {
  AppFrame,
  Button,
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
  DropdownButton,
  useAccelerators,
  useMessageBox,
  usePrompt,
  type Column,
  type MenuDef,
  type MenuEntry,
  type TreeNode,
} from "../win98";
import AddSongWizard from "./AddSongWizard";
import ProcessingDialog from "./ProcessingDialog";

const AUDIO_EXTS = ["mp3", "flac", "wav", "m4a", "ogg", "aac", "aiff", "wma"];
const isAudioPath = (p: string) => AUDIO_EXTS.includes((p.split(".").pop() ?? "").toLowerCase());

const EXPORTS: [string, string][] = [
  ["lrc", "&LRC lyrics"],
  ["ass", "&ASS subtitles"],
  ["ultrastar", "&UltraStar .txt"],
];

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

  const [allSongs, setAllSongs] = useState<Song[]>([]);
  const [collSongs, setCollSongs] = useState<Song[] | null>(null);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [node, setNode] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "added", dir: "desc" });
  const [selected, setSelected] = useState<number | null>(null);
  const [inColls, setInColls] = useState<number[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [queueSel, setQueueSel] = useState<number | null>(null);
  const [wizardPath, setWizardPath] = useState<string | null>(null);
  const [procJob, setProcJob] = useState<number | null>(null);
  const [procOpen, setProcOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const watched = useRef(new Set<number>());
  const announced = useRef(new Set<number>());

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

  const loadQueue = useCallback(() => {
    queueList()
      .then((q) => setQueue(q ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    loadQueue();
    window.addEventListener("karascape:queue", loadQueue);
    return () => window.removeEventListener("karascape:queue", loadQueue);
  }, [loadQueue]);
  const queueChanged = () => {
    loadQueue();
    window.dispatchEvent(new Event("karascape:queue"));
  };

  const statuses = useMemo(() => {
    const m = new Map<number, SongStatus>();
    for (const s of allSongs) m.set(s.id, statusFor(s, jobs));
    for (const s of collSongs ?? []) if (!m.has(s.id)) m.set(s.id, statusFor(s, jobs));
    return m;
  }, [allSongs, collSongs, jobs]);
  const statusOf = useCallback((s: Song) => statuses.get(s.id) ?? statusFor(s, jobs), [statuses, jobs]);

  const counts = useMemo(() => {
    let processing = 0;
    let review = 0;
    for (const s of allSongs) {
      const k = statusOf(s).kind;
      if (k === "processing") processing++;
      if (k === "review" || k === "failed" || k === "needs-timings") review++;
    }
    return { processing, review };
  }, [allSongs, statusOf]);

  const rows = useMemo(() => {
    let base = collectionId != null ? (collSongs ?? []) : allSongs;
    if (node === "processing") base = base.filter((s) => statusOf(s).kind === "processing");
    if (node === "review") base = base.filter((s) => ["review", "failed", "needs-timings"].includes(statusOf(s).kind));
    const filtered = filterSongs(base, search);
    const key: Record<SortKey, (s: Song) => string | number | null | undefined> = {
      title: (s) => s.title,
      artist: (s) => s.artist,
      length: (s) => s.duration_s,
      status: (s) => STATUS_RANK[statusOf(s).kind],
      added: (s) => s.date_added,
      played: (s) => s.last_played,
    };
    return sortBy(filtered, key[sort.key], sort.dir);
  }, [allSongs, collSongs, collectionId, node, search, sort, statusOf]);

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
            { id: "later", label: "&Later", cancel: true },
          ],
        }).then((r) => {
          if (r === "check" && p.job.map_path) {
            go({ view: "song", mapPath: p.job.map_path, songId: p.job.library_song_id, title: p.job.title });
          }
        });
      } else if (p.job.status === "failed") {
        announced.current.add(id);
        if (procJob === id) setProcOpen(false);
        void ask({
          kind: "error",
          message: (
            <>
              Karascape couldn't finish <b>{p.job.title}</b>.
            </>
          ),
          detail: p.failure ?? p.job.error ?? "The pipeline stopped without saying why.",
        });
      } else if (p.job.status === "cancelled") {
        announced.current.add(id);
        if (procJob === id) setProcOpen(false);
      }
    }
  }, [jobs, ask, go, procJob]);

  // ----------------------------------------------------------- actions

  const addSong = useCallback(async () => {
    const picked = await open({ multiple: false, filters: [{ name: "Audio", extensions: AUDIO_EXTS }] });
    if (typeof picked === "string") setWizardPath(picked);
  }, []);

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
          const audio = event.payload.paths.find(isAudioPath) ?? event.payload.paths[0];
          if (audio) setWizardPath(audio);
        }
      })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const canOpen = !!song?.timing_map_path && st?.kind !== "processing";
  const openSong = (s: Song | null = song) => {
    if (!s?.timing_map_path || statusOf(s).kind === "processing") return;
    go({ view: "song", mapPath: s.timing_map_path, title: s.title, songId: s.id });
  };
  const sing = (s: Song | null = song) => {
    if (!s?.timing_map_path || statusOf(s).kind === "processing") return;
    go({ view: "play", songId: s.id });
  };
  const addToQueue = async (s: Song | null = song) => {
    if (!s?.timing_map_path) return;
    try {
      await queueAdd(s.id, collectionId ?? undefined);
      queueChanged();
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
      const paths = await exportSong({
        map_path: song.timing_map_path,
        formats: [format],
        title: song.title,
        artist: song.artist ?? undefined,
      });
      await ask({
        kind: "info",
        title: "Export",
        message: `Exported ${paths.length} file${paths.length === 1 ? "" : "s"}.`,
        detail: paths.join("\n"),
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
      queueChanged();
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
  const singNext = async () => {
    const e = qEntry ?? queue[0];
    if (!e) return;
    await queueRemove(e.id).catch(() => undefined);
    queueChanged();
    go({ view: "play", songId: e.song.id });
  };
  const moveQueue = async (delta: number) => {
    if (!qEntry) return;
    const to = qIdx + delta;
    if (to < 0 || to >= queue.length) return;
    await queueMoveEntry(qEntry.id, to).catch((e) => setError(String(e)));
    queueChanged();
  };
  const removeQueued = async () => {
    if (!qEntry) return;
    await queueRemove(qEntry.id).catch(() => undefined);
    queueChanged();
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
      queueChanged();
    }
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "added" || key === "played" ? "desc" : "asc" }));

  // ---------------------------------------------------------- commands

  const songMenu: MenuEntry[] = [
    { label: "&Open in Bench", accel: "Enter", run: () => openSong(), disabled: !canOpen },
    { label: "&Sing", accel: "F5", keys: "f5", run: () => sing(), disabled: !canOpen },
    { label: "Add to &Up next", accel: "Q", run: () => void addToQueue(), disabled: !song?.timing_map_path },
    { label: "&Mark as checked", run: () => void markChecked(), disabled: st?.kind !== "review" },
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
  ];

  const menus: MenuDef[] = [
    {
      label: "&File",
      items: [
        { label: "&Add Song…", accel: "Ctrl+O", keys: "ctrl+o", run: () => void addSong() },
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
      ],
    },
    {
      label: "&Tools",
      items: [
        { label: "Player &Themes…", run: () => go({ view: "themes" }) },
        { label: "&Properties…", run: () => go({ view: "settings" }) },
      ],
    },
    {
      label: "&Help",
      items: [
        { label: "&Keyboard Shortcuts", accel: "F1", keys: "f1", run: () => void showShortcuts() },
        "-",
        { label: "&About Karascape", run: () => void showAbout() },
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
          <span>Open in the Bench</span>
          <span>F5</span>
          <span>Sing</span>
          <span>Q</span>
          <span>Add to Up next</span>
          <span>Del</span>
          <span>Remove from library</span>
          <span>/ or Ctrl+F</span>
          <span>Find</span>
          <span>Ctrl+O</span>
          <span>Add a song</span>
          <span>Alt / F10</span>
          <span>Menus</span>
          <span>Shift+F10</span>
          <span>Right-click menu</span>
        </div>
      ),
    });
  const showAbout = () =>
    ask({
      kind: "info",
      title: "About Karascape",
      message: <b>Karascape</b>,
      detail:
        "Karaoke from the songs you already own. Vocal separation and word timing run on this computer; nothing is uploaded. Source-available.",
    });

  // --------------------------------------------------------------- tree

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
    { id: "processing", label: `Processing (${counts.processing})`, icon: <Icon name="working" />, gap: true },
    { id: "review", label: `Needs checking (${counts.review})`, icon: <Icon name="warn" /> },
  ];
  const onTreeSelect = (id: string) => {
    if (id === "lib") id = "all";
    setNode(id);
  };

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

  const emptyText =
    allSongs.length === 0
      ? "No songs yet. Choose File › Add Song…, or drop an audio file on this window."
      : search
        ? "No songs match your search."
        : node === "processing"
          ? "Nothing is processing."
          : node === "review"
            ? "Every song has been checked."
            : "This collection is empty. Right-click a song › Add to collection.";

  return (
    <AppFrame title={collection ? `Karascape - ${collection.name}` : "Karascape - Library"} icon={<Icon name="app" />}>
      <MenuBar menus={menus} />
      <Hr />
      <Toolbar label="Library">
        <ToolButton icon={<Icon name="disc" />} onClick={() => void addSong()} tip="Add a song (Ctrl+O)">
          Add song…
        </ToolButton>
        <ToolButton icon={<Icon name="tv" />} onClick={() => sing()} disabled={!canOpen} tip="Sing the selected song (F5)">
          Sing
        </ToolButton>
        <ToolButton icon={<Icon name="queue" />} onClick={() => void addToQueue()} disabled={!song?.timing_map_path} tip="Add to Up next (Q)">
          Up next
        </ToolButton>
        <Vr />
        <ToolButton icon={<Icon name="timing" />} onClick={() => openSong()} disabled={!canOpen} tip="Check the timing in the Bench (Enter)">
          Check timing
        </ToolButton>
        <DropdownButton className="w-tool" items={EXPORTS.map(([f, label]) => ({ label, run: () => void doExport(f) }))} disabled={!song?.timing_map_path}>
          <Icon name="floppy" />
          Export
        </DropdownButton>
        <Vr />
        <ToolButton icon={<Icon name="gear" />} onClick={() => go({ view: "settings" })} tip="Properties">
          Properties
        </ToolButton>
        <span className="w-grow" />
        <label htmlFor="lib-find" style={{ marginRight: 4 }}>
          <span className="w-ak">F</span>ind:
        </label>
        <TextField
          id="lib-find"
          ref={searchRef}
          value={search}
          placeholder="Title, artist or language"
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
                  { label: "&Rename…", accel: "F2", run: () => void renameCollection() },
                  { label: "&Delete…", run: () => void deleteCollection() },
                  "-",
                  { label: "&New Collection…", run: () => void newCollection() },
                ]
              : [{ label: "&New Collection…", run: () => void newCollection() }]
          }
        />

        <div style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
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
                <b>{dragOver ? "Let go to add this song" : "Drop a song here"}</b>
                <span>MP3, FLAC, WAV, M4A, OGG, AAC, AIFF or WMA. You bring the music; everything stays on this machine.</span>
              </div>
              <Button onClick={() => void addSong()}>&Browse…</Button>
            </div>
          </GroupBox>

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
            onActivate={(s) => openSong(s)}
            rowDim={(s) => statusOf(s).kind === "processing"}
            sort={sort}
            onSort={(k) => toggleSort(k as SortKey)}
            empty={emptyText}
            contextMenu={songMenu}
            style={{ flexGrow: 1 }}
            onKey={(e) => {
              if ((e.key === "q" || e.key === "Q") && !e.ctrlKey && !e.altKey) {
                void addToQueue();
                e.preventDefault();
                return true;
              }
              if (e.key === "Delete") {
                void removeSong();
                e.preventDefault();
                return true;
              }
              return false;
            }}
          />

          <GroupBox label={`Up next (${queue.length})`} style={{ flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <ListView<QueueEntry>
                ariaLabel="Up next"
                style={{ height: 112, flexGrow: 1 }}
                rows={queue}
                rowKey={(e) => e.id}
                selected={queueSel}
                onSelect={(k) => setQueueSel(k as number)}
                onActivate={() => void singNext()}
                empty="Nothing queued. Select a song and press Q."
                columns={[
                  { key: "pos", label: "#", width: "36px", render: (e) => e.position + 1 },
                  { key: "title", label: "Title", width: "minmax(0, 1.4fr)", render: (e) => e.song.title },
                  { key: "artist", label: "Artist", width: "minmax(0, 1fr)", render: (e) => e.song.artist ?? "" },
                  { key: "len", label: "Length", width: "64px", render: (e) => fmtDuration(e.song.duration_s) ?? "" },
                ]}
                onKey={(e) => {
                  if (e.key === "Delete") {
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
                <Button isDefault onClick={() => void singNext()} disabled={queue.length === 0} style={{ width: "100%" }}>
                  Sing &next
                </Button>
                <Button onClick={() => void moveQueue(-1)} disabled={!qEntry || qIdx === 0} style={{ width: "100%" }}>
                  Move &up
                </Button>
                <Button onClick={() => void moveQueue(1)} disabled={!qEntry || qIdx === queue.length - 1} style={{ width: "100%" }}>
                  Move &down
                </Button>
                <Button onClick={() => void removeQueued()} disabled={!qEntry} style={{ width: "100%" }}>
                  Re&move
                </Button>
                <Button onClick={() => void clearQueue()} disabled={queue.length === 0} style={{ width: "100%" }}>
                  Cl&ear
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
          {activeJob ? (
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
              </button>
            </>
          ) : (
            "Ready"
          )}
        </StatusPane>
        <StatusPane width={250}>
          <Icon name="lock" />
          Local only — nothing is uploaded
        </StatusPane>
      </StatusBar>

      <AddSongWizard
        path={wizardPath}
        onClose={() => setWizardPath(null)}
        onStarted={(jobId) => {
          watched.current.add(jobId);
          setWizardPath(null);
          setProcJob(jobId);
          setProcOpen(true);
        }}
      />
      <ProcessingDialog
        job={procJob != null ? jobs.jobs[procJob] : undefined}
        open={procOpen}
        onHide={() => setProcOpen(false)}
        onCancelJob={(id) => void cancelJob(id)}
      />
    </AppFrame>
  );
}
