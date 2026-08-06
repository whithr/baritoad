// Library — the real SQLite-backed store (PLAN.md §3 "Library & collections"):
// cover-art grid (generated gradient + initials fallback), search, sort,
// collection sidebar (create/rename/delete, membership via the ⋯ menu), and
// live "processing" cards for queued generates (reusing the job-event
// reducer). Click-through to Song detail; "Up next" adds via the card menu.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collectionAddSong,
  collectionCreate,
  collectionDelete,
  collectionRemoveSong,
  collectionRename,
  libraryCollections,
  libraryDeleteSong,
  librarySongs,
  queueAdd,
  readCover,
  songCollections,
  type CollectionInfo,
  type Song,
} from "../api";
import {
  coverGradient,
  coverInitials,
  filterSongs,
  fmtDuration,
  SORT_LABELS,
  sortSongs,
  type LibrarySort,
} from "../libraryState";
import { progressHeadline, type JobProgress, type JobsState } from "../jobEvents";
import { IconBrandNoteLarge, IconDots, IconPencil, IconPlay, IconPlus, IconX } from "../icons";
import {
  ConfirmStrip,
  DashMenu,
  DashMenuCheckItem,
  DashMenuItem,
  DashMenuLabel,
  DashMenuSeparator,
  DashSelect,
  SegText,
} from "../ui";
import type { Route } from "../App";

export default function Library({ go, jobs }: { go: (r: Route) => void; jobs: JobsState }) {
  const [songs, setSongs] = useState<Song[]>([]);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recently_added");
  const [covers, setCovers] = useState<Record<number, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Songs finishing while we watch: refetch when the completed count grows.
  const completedCount = useMemo(
    () => Object.values(jobs.jobs).filter((p) => p.job.status === "completed").length,
    [jobs],
  );
  const processing = useMemo(
    () =>
      jobs.order
        .map((id) => jobs.jobs[id])
        .filter((p) => p && (p.job.status === "queued" || p.job.status === "running")),
    [jobs],
  );

  const refreshCollections = useCallback(async () => {
    try {
      setCollections(await libraryCollections());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshSongs = useCallback(async () => {
    try {
      const list = await librarySongs(
        selected === null
          ? { sort: "recently_added" }
          : { collection: selected, sort: "collection_order" },
      );
      setSongs(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, [selected]);

  useEffect(() => {
    refreshCollections();
  }, [refreshCollections]);

  useEffect(() => {
    refreshSongs();
  }, [refreshSongs, completedCount]);

  // Lazy cover loading — fetch data URLs once per cover path.
  useEffect(() => {
    let disposed = false;
    (async () => {
      for (const s of songs) {
        if (!s.cover_path || covers[s.id]) continue;
        try {
          const url = await readCover(s.cover_path);
          if (disposed) return;
          setCovers((c) => ({ ...c, [s.id]: url }));
        } catch {
          // cover file gone — the gradient fallback covers it
        }
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs]);

  const visible = useMemo(
    () => sortSongs(filterSongs(songs, search), sort),
    [songs, search, sort],
  );

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2500);
  };

  const addToQueue = async (song: Song) => {
    try {
      await queueAdd(song.id, selected ?? undefined);
      flash(`Queued “${song.title}”`);
    } catch (e) {
      setError(String(e));
    }
  };

  const [pendingDelete, setPendingDelete] = useState<Song | null>(null);

  const deleteSong = async (song: Song) => {
    setPendingDelete(null);
    try {
      await libraryDeleteSong(song.id);
      await refreshSongs();
      await refreshCollections();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="page page-wide">
      <h1 className="with-readout">
        Library
        {/* odometer: total songs owned, leading zeros like a trip counter */}
        <span className="lib-odometer">
          <span className="label">Songs</span>
          <SegText value={String(songs.length).padStart(3, "0")} />
        </span>
      </h1>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}
      {pendingDelete && (
        <ConfirmStrip
          message={`Remove “${pendingDelete.title}” from the library? Files on disk stay.`}
          confirmLabel="Remove"
          onConfirm={() => deleteSong(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <div className="library-layout">
        <CollectionSidebar
          collections={collections}
          selected={selected}
          totalSongs={songs.length}
          onSelect={setSelected}
          onChanged={async () => {
            await refreshCollections();
            await refreshSongs();
          }}
          setError={setError}
        />

        <div className="library-main">
          <div className="library-controls">
            <input
              className="search-box"
              type="search"
              placeholder="Search title, artist, or tag…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <DashSelect
              ariaLabel="Sort songs"
              value={sort}
              onChange={setSort}
              options={(Object.keys(SORT_LABELS) as LibrarySort[]).map((k) => ({
                value: k,
                label: SORT_LABELS[k],
              }))}
            />
          </div>

          {loaded && visible.length === 0 && processing.length === 0 && (
            <div className="empty-state">
              <div className="empty-mark">
                <IconBrandNoteLarge size={56} />
              </div>
              <p>
                {search.trim() !== ""
                  ? "Nothing matches that search."
                  : selected !== null
                    ? "This collection is empty — add songs from the song menu on any card."
                    : "No songs yet. Bring a song you own and it lands here, ready to play."}
              </p>
              {search.trim() === "" && selected === null && (
                <button className="primary" onClick={() => go({ view: "new" })}>
                  Make your first song
                </button>
              )}
            </div>
          )}

          <div className="song-grid">
            {processing.map((p) => (
              <ProcessingCard key={`job-${p.job.id}`} p={p} />
            ))}
            {visible.map((s) => (
              <SongCard
                key={s.id}
                song={s}
                cover={covers[s.id]}
                collections={collections}
                inCollection={selected}
                onOpen={() =>
                  s.timing_map_path &&
                  go({ view: "song", mapPath: s.timing_map_path, title: s.title, songId: s.id })
                }
                onPlay={() => go({ view: "play", songId: s.id })}
                onQueue={() => addToQueue(s)}
                onDelete={() => setPendingDelete(s)}
                onMembershipChanged={async () => {
                  await refreshCollections();
                  if (selected !== null) await refreshSongs();
                }}
                setError={setError}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProcessingCard({ p }: { p: JobProgress }) {
  return (
    <div className="song-card processing" aria-busy="true">
      <div className="song-cover" style={{ background: coverGradient(p.job.title) }}>
        <span className="cover-initials">{coverInitials(p.job.title)}</span>
        <div className="processing-overlay">
          <div className="processing-headline">{progressHeadline(p)}</div>
          {p.fraction != null && p.stage === "separating" && (
            <div className="stage-bar">
              <div className="stage-bar-fill" style={{ transform: `scaleX(${p.fraction})` }} />
            </div>
          )}
        </div>
      </div>
      <div className="song-title">{p.job.title}</div>
      <div className="song-artist">{p.job.artist ?? "—"}</div>
    </div>
  );
}

function SongCard(props: {
  song: Song;
  cover?: string;
  collections: CollectionInfo[];
  inCollection: number | null;
  onOpen: () => void;
  /** Straight into the full-screen performance player (ready songs only). */
  onPlay: () => void;
  onQueue: () => void;
  onDelete: () => void;
  onMembershipChanged: () => Promise<void>;
  setError: (e: string | null) => void;
}) {
  const { song } = props;
  const [memberOf, setMemberOf] = useState<number[] | null>(null);

  const onMenuOpenChange = async (open: boolean) => {
    if (!open) return;
    try {
      setMemberOf(await songCollections(song.id));
    } catch {
      setMemberOf([]);
    }
  };

  const toggleCollection = async (c: CollectionInfo) => {
    try {
      const isMember = memberOf?.includes(c.id) ?? false;
      if (isMember) {
        await collectionRemoveSong(c.id, song.id);
        setMemberOf((m) => (m ?? []).filter((id) => id !== c.id));
      } else {
        await collectionAddSong(c.id, song.id);
        setMemberOf((m) => [...(m ?? []), c.id]);
      }
      await props.onMembershipChanged();
    } catch (e) {
      props.setError(String(e));
    }
  };

  const duration = fmtDuration(song.duration_s);
  return (
    <div
      className={`song-card${song.timing_map_path ? " openable" : ""}`}
      onClick={props.onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        // Only the card itself — Enter/Space on inner keys must not also
        // trigger the card (full-keyboard commitment, PRODUCT.md).
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onOpen();
        }
      }}
    >
      <div
        className="song-cover"
        style={props.cover ? undefined : { background: coverGradient(song.title) }}
      >
        {props.cover ? (
          <img src={props.cover} alt="" className="cover-img" />
        ) : (
          <span className="cover-initials">{coverInitials(song.title)}</span>
        )}
        {duration && <SegText className="cover-duration" value={duration} />}
        {song.timing_map_path && (
          <button
            className="card-play-btn"
            title="Play (full-screen karaoke)"
            onClick={(e) => {
              e.stopPropagation();
              props.onPlay();
            }}
          >
            <IconPlay size={16} />
          </button>
        )}
        <span onClick={(e) => e.stopPropagation()}>
          <DashMenu
            trigger={<IconDots />}
            triggerClassName="card-menu-btn"
            triggerTitle="Song actions"
            onOpenChange={onMenuOpenChange}
          >
            {song.timing_map_path && <DashMenuItem onClick={props.onPlay}>Play</DashMenuItem>}
            <DashMenuItem onClick={props.onQueue}>Add to Up Next</DashMenuItem>
            {props.collections.length > 0 && <DashMenuLabel>Collections</DashMenuLabel>}
            {props.collections.map((c) => (
              <DashMenuCheckItem
                key={c.id}
                checked={memberOf?.includes(c.id) ?? false}
                onCheckedChange={() => toggleCollection(c)}
              >
                {c.name}
              </DashMenuCheckItem>
            ))}
            <DashMenuSeparator />
            <DashMenuItem danger onClick={props.onDelete}>
              Remove from library
            </DashMenuItem>
          </DashMenu>
        </span>
      </div>
      <div className="song-title" title={song.title}>
        {song.title}
      </div>
      <div className="song-artist">{song.artist ?? "—"}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CollectionSidebar(props: {
  collections: CollectionInfo[];
  selected: number | null;
  totalSongs: number;
  onSelect: (id: number | null) => void;
  onChanged: () => Promise<void>;
  setError: (e: string | null) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");

  const create = async () => {
    const name = newName.trim();
    if (name === "") {
      setCreating(false);
      return;
    }
    try {
      await collectionCreate(name);
      setNewName("");
      setCreating(false);
      await props.onChanged();
    } catch (e) {
      props.setError(String(e));
    }
  };

  const rename = async (id: number) => {
    const name = renameText.trim();
    setRenamingId(null);
    if (name === "") return;
    try {
      await collectionRename(id, name);
      await props.onChanged();
    } catch (e) {
      props.setError(String(e));
    }
  };

  const [pendingRemove, setPendingRemove] = useState<CollectionInfo | null>(null);

  const remove = async (c: CollectionInfo) => {
    setPendingRemove(null);
    try {
      await collectionDelete(c.id);
      if (props.selected === c.id) props.onSelect(null);
      await props.onChanged();
    } catch (e) {
      props.setError(String(e));
    }
  };

  return (
    <aside className="collection-rail">
      {pendingRemove && (
        <ConfirmStrip
          message={`Delete collection “${pendingRemove.name}”? Its songs stay in the library.`}
          confirmLabel="Delete"
          onConfirm={() => remove(pendingRemove)}
          onCancel={() => setPendingRemove(null)}
        />
      )}
      <button
        className={`coll-btn${props.selected === null ? " active" : ""}`}
        onClick={() => props.onSelect(null)}
      >
        All songs
      </button>
      {props.collections.map((c) =>
        renamingId === c.id ? (
          <input
            key={c.id}
            className="coll-input"
            autoFocus
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={() => rename(c.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename(c.id);
              if (e.key === "Escape") setRenamingId(null);
            }}
          />
        ) : (
          <div key={c.id} className={`coll-row${props.selected === c.id ? " active" : ""}`}>
            <button className="coll-btn coll-name" onClick={() => props.onSelect(c.id)}>
              {c.name} <span className="coll-count">{c.song_count}</span>
            </button>
            <button
              className="coll-icon"
              title="Rename"
              onClick={() => {
                setRenamingId(c.id);
                setRenameText(c.name);
              }}
            >
              <IconPencil size={13} />
            </button>
            <button className="coll-icon" title="Delete" onClick={() => setPendingRemove(c)}>
              <IconX size={13} />
            </button>
          </div>
        ),
      )}
      {creating ? (
        <input
          className="coll-input"
          autoFocus
          placeholder="Collection name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onBlur={create}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") setCreating(false);
          }}
        />
      ) : (
        <button className="coll-btn coll-new" onClick={() => setCreating(true)}>
          <IconPlus size={12} /> New collection
        </button>
      )}
      <p className="muted small rail-note">A song can live in any number of collections.</p>
    </aside>
  );
}
