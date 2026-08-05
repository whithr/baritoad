// Library — placeholder grid for milestone 1. The real store (SQLite,
// collections, cover art — PLAN.md §3/§5) is the next milestone; until then
// the grid shows finished jobs from the persisted registry so completed
// songs are reachable.

import { useEffect, useState } from "react";
import { listJobs, type RegistryJob } from "../api";
import type { Route } from "../App";

export default function Library({ go }: { go: (r: Route) => void }) {
  const [ready, setReady] = useState<RegistryJob[]>([]);
  const [others, setOthers] = useState<RegistryJob[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const list = await listJobs();
        if (disposed) return;
        setReady(list.registry.filter((j) => j.status === "complete" && j.map_path));
        setOthers(list.registry.filter((j) => !(j.status === "complete" && j.map_path)));
      } catch (e) {
        console.error("list_jobs failed", e);
      } finally {
        if (!disposed) setLoaded(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <div className="page">
      <h1>Library</h1>
      {loaded && ready.length === 0 && (
        <div className="empty-state">
          <div className="empty-mark">♪</div>
          <p>
            No songs yet. Bring a song you own and it lands here, ready to play.
          </p>
          <button className="primary" onClick={() => go({ view: "new" })}>
            Make your first song
          </button>
        </div>
      )}
      {ready.length > 0 && (
        <div className="song-grid">
          {ready.map((j) => (
            <button
              key={j.job_id}
              className="song-card"
              onClick={() => go({ view: "song", mapPath: j.map_path!, title: j.title })}
            >
              <div className="song-cover">♪</div>
              <div className="song-title">{j.title}</div>
              <div className="song-artist">{j.artist ?? "—"}</div>
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <p className="muted small">
          {others.length} unfinished job{others.length === 1 ? "" : "s"} in the registry — see
          Jobs.
        </p>
      )}
      <p className="muted small">
        Collections, cover art, and search arrive with the real library store (next milestone).
      </p>
    </div>
  );
}
