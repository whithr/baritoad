// Up Next — the persistent party queue (PLAN.md §3): add from the Library's
// song menu, drag to reorder, remove. Stored in SQLite so it survives app
// restarts mid-party. This list manages order; playing starts from the
// Library or Song detail until queue auto-advance lands (player milestone 4).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  queueClear,
  queueList,
  queueMoveEntry,
  queueRemove,
  readCover,
  type QueueEntry,
} from "../api";
import { coverGradient, coverInitials, fmtDuration, moveItem } from "../libraryState";
import { IconGrip, IconQueue, IconX } from "../icons";
import { ConfirmStrip, SegText } from "../ui";
import type { Route } from "../App";

export default function UpNext({ go }: { go: (r: Route) => void }) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [covers, setCovers] = useState<Record<number, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragFrom = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEntries(await queueList());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    (async () => {
      for (const e of entries) {
        const cp = e.song.cover_path;
        if (!cp || covers[e.song.id]) continue;
        try {
          const url = await readCover(cp);
          if (disposed) return;
          setCovers((c) => ({ ...c, [e.song.id]: url }));
        } catch {
          // gradient fallback
        }
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  const drop = async (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;
    const entry = entries[from];
    setEntries((list) => moveItem(list, from, to)); // optimistic
    try {
      await queueMoveEntry(entry.id, to);
    } catch (e) {
      setError(String(e));
    }
    await refresh();
  };

  const remove = async (entry: QueueEntry) => {
    try {
      await queueRemove(entry.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const [confirmClear, setConfirmClear] = useState(false);

  const clearAll = async () => {
    setConfirmClear(false);
    try {
      await queueClear();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="page">
      <h1>Up Next</h1>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted small">
        Drag to reorder. Start a song from the Library — this list holds who's next.
      </p>
      {confirmClear && (
        <ConfirmStrip
          message="Clear the whole queue?"
          confirmLabel="Clear queue"
          onConfirm={clearAll}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      {loaded && entries.length === 0 && (
        <div className="empty-state">
          <div className="empty-mark">
            <IconQueue size={56} />
          </div>
          <p>Nothing queued. Add songs from the song menu on any Library card.</p>
          <button className="primary" onClick={() => go({ view: "library" })}>
            Browse the library
          </button>
        </div>
      )}

      {entries.length > 0 && (
        <>
          <ol className="queue-list">
            {entries.map((e, i) => (
              <li
                key={e.id}
                className="queue-row"
                draggable
                onDragStart={() => {
                  dragFrom.current = i;
                }}
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={() => drop(i)}
              >
                <SegText className="queue-pos" value={String(i + 1)} />
                <span className="drag-grip" title="Drag to reorder">
                  <IconGrip size={14} />
                </span>
                <div
                  className="queue-cover"
                  style={
                    covers[e.song.id]
                      ? undefined
                      : { background: coverGradient(e.song.title) }
                  }
                >
                  {covers[e.song.id] ? (
                    <img src={covers[e.song.id]} alt="" className="cover-img" />
                  ) : (
                    <span className="cover-initials small-initials">
                      {coverInitials(e.song.title)}
                    </span>
                  )}
                </div>
                <div className="queue-meta">
                  <div className="song-title">{e.song.title}</div>
                  <div className="song-artist">
                    {e.song.artist ?? "—"}
                    {fmtDuration(e.song.duration_s) && ` · ${fmtDuration(e.song.duration_s)}`}
                  </div>
                </div>
                <button className="queue-remove" title="Remove" onClick={() => remove(e)}>
                  <IconX size={14} />
                </button>
              </li>
            ))}
          </ol>
          <div className="actions">
            <button onClick={() => setConfirmClear(true)}>Clear queue</button>
          </div>
        </>
      )}
    </div>
  );
}
