// App shell: sidebar navigation + tiny hash router (no router dependency —
// four routes don't justify a package and its §6 row).

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { measurePlan, onJobEvent, listJobs } from "./api";
import { IconJobs, IconLibrary, IconNote, IconQueue } from "./icons";
import { emptyJobsState, reduceJobEvent, seedFromSnapshots, type JobsState } from "./jobEvents";
import Library from "./views/Library";
import NewSong from "./views/NewSong";
import Jobs from "./views/Jobs";
import PlayerView from "./views/PlayerView";
import SongDetail from "./views/SongDetail";
import UpNext from "./views/UpNext";

export type Route =
  | { view: "library" }
  | { view: "new" }
  | { view: "queue" }
  | { view: "jobs" }
  | { view: "song"; mapPath: string; title?: string; songId?: number }
  | { view: "play"; songId?: number; mapPath?: string; measure?: boolean };

function parseHash(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  if (path === "new") return { view: "new" };
  if (path === "queue") return { view: "queue" };
  if (path === "jobs") return { view: "jobs" };
  if (path === "song") {
    const params = new URLSearchParams(query ?? "");
    const mapPath = params.get("map") ?? "";
    const idRaw = params.get("id");
    const songId = idRaw !== null && /^\d+$/.test(idRaw) ? Number(idRaw) : undefined;
    return mapPath
      ? { view: "song", mapPath, title: params.get("title") ?? undefined, songId }
      : { view: "library" };
  }
  if (path === "play") {
    const params = new URLSearchParams(query ?? "");
    const idRaw = params.get("id");
    const songId = idRaw !== null && /^\d+$/.test(idRaw) ? Number(idRaw) : undefined;
    const mapPath = params.get("map") ?? undefined;
    if (songId == null && !mapPath) return { view: "library" };
    return { view: "play", songId, mapPath, measure: params.get("measure") === "1" };
  }
  return { view: "library" };
}

export function navigate(route: Route) {
  switch (route.view) {
    case "library":
      window.location.hash = "#/library";
      break;
    case "new":
      window.location.hash = "#/new";
      break;
    case "queue":
      window.location.hash = "#/queue";
      break;
    case "jobs":
      window.location.hash = "#/jobs";
      break;
    case "song": {
      const q = new URLSearchParams({ map: route.mapPath });
      if (route.title) q.set("title", route.title);
      if (route.songId != null) q.set("id", String(route.songId));
      window.location.hash = `#/song?${q.toString()}`;
      break;
    }
    case "play": {
      const q = new URLSearchParams();
      if (route.songId != null) q.set("id", String(route.songId));
      if (route.mapPath) q.set("map", route.mapPath);
      if (route.measure) q.set("measure", "1");
      window.location.hash = `#/play?${q.toString()}`;
      break;
    }
  }
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [jobs, setJobs] = useState<JobsState>(emptyJobsState);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // One app-lifetime event subscription feeding the reducer; views read the
  // reduced state. Seeded from the queue snapshot so a reloaded webview
  // still shows in-flight jobs.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await onJobEvent((e) => setJobs((s) => reduceJobEvent(s, e)));
      try {
        const list = await listJobs();
        if (!disposed) {
          setJobs((s) => (s.order.length === 0 ? seedFromSnapshots(list.active) : s));
        }
      } catch {
        // registry unavailable is non-fatal; events still stream
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const activeCount = useMemo(
    () =>
      Object.values(jobs.jobs).filter(
        (p) => p.job.status === "queued" || p.job.status === "running",
      ).length,
    [jobs],
  );

  const go = useCallback((r: Route) => navigate(r), []);

  // Dev measurement harness bootstrap: only acts when the app was launched
  // with KARAOKE_MEASURE_* env vars (src-tauri/src/player.rs) — inert for
  // normal users.
  useEffect(() => {
    (async () => {
      try {
        const plan = await measurePlan();
        if (plan) {
          go({
            view: "play",
            songId: plan.song_id ?? undefined,
            mapPath: plan.map_path ?? undefined,
            measure: true,
          });
        }
      } catch {
        // command missing / failed: nothing to do
      }
    })();
  }, [go]);

  // The performance player is full-bleed: no sidebar, no page chrome
  // (PLAN.md §3 full-screen karaoke view, TV-friendly).
  if (route.view === "play") {
    return (
      <PlayerView
        songId={route.songId}
        mapPath={route.mapPath}
        measure={route.measure}
        go={go}
      />
    );
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <IconNote size={18} />
          </span>
          Karascape
        </div>
        <NavButton
          label="Library"
          icon={<IconLibrary />}
          active={route.view === "library" || route.view === "song"}
          onClick={() => go({ view: "library" })}
        />
        <NavButton
          label="New Song"
          icon={<IconNote />}
          active={route.view === "new"}
          onClick={() => go({ view: "new" })}
        />
        <NavButton
          label="Up Next"
          icon={<IconQueue />}
          active={route.view === "queue"}
          onClick={() => go({ view: "queue" })}
        />
        <NavButton
          label={activeCount > 0 ? `Processing (${activeCount})` : "Processing"}
          icon={<IconJobs />}
          active={route.view === "jobs"}
          onClick={() => go({ view: "jobs" })}
        />
        <div className="sidebar-foot">Everything stays on this computer</div>
      </nav>
      <main className="content">
        {route.view === "library" && <Library go={go} jobs={jobs} />}
        {route.view === "new" && <NewSong go={go} />}
        {route.view === "queue" && <UpNext go={go} />}
        {route.view === "jobs" && <Jobs jobs={jobs} go={go} />}
        {route.view === "song" && (
          <SongDetail
            mapPath={route.mapPath}
            title={route.title}
            songId={route.songId}
            go={go}
          />
        )}
      </main>
    </div>
  );
}

function NavButton(props: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav-btn${props.active ? " active" : ""}`} onClick={props.onClick}>
      <span className="nav-icon">{props.icon}</span>
      {props.label}
      <span className="nav-lamp" aria-hidden />
    </button>
  );
}
