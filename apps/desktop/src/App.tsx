// App shell: sidebar navigation + tiny hash router (no router dependency —
// four routes don't justify a package and its §6 row).

import { useCallback, useEffect, useMemo, useState } from "react";
import { onJobEvent, listJobs } from "./api";
import { emptyJobsState, reduceJobEvent, seedFromSnapshots, type JobsState } from "./jobEvents";
import Library from "./views/Library";
import NewSong from "./views/NewSong";
import Jobs from "./views/Jobs";
import SongDetail from "./views/SongDetail";
import UpNext from "./views/UpNext";

export type Route =
  | { view: "library" }
  | { view: "new" }
  | { view: "queue" }
  | { view: "jobs" }
  | { view: "song"; mapPath: string; title?: string };

function parseHash(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  if (path === "new") return { view: "new" };
  if (path === "queue") return { view: "queue" };
  if (path === "jobs") return { view: "jobs" };
  if (path === "song") {
    const params = new URLSearchParams(query ?? "");
    const mapPath = params.get("map") ?? "";
    return mapPath
      ? { view: "song", mapPath, title: params.get("title") ?? undefined }
      : { view: "library" };
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
      window.location.hash = `#/song?${q.toString()}`;
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

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">♪</span> Karaoke
        </div>
        <NavButton
          label="Library"
          active={route.view === "library" || route.view === "song"}
          onClick={() => go({ view: "library" })}
        />
        <NavButton label="New Song" active={route.view === "new"} onClick={() => go({ view: "new" })} />
        <NavButton
          label="Up Next"
          active={route.view === "queue"}
          onClick={() => go({ view: "queue" })}
        />
        <NavButton
          label={activeCount > 0 ? `Jobs (${activeCount})` : "Jobs"}
          active={route.view === "jobs"}
          onClick={() => go({ view: "jobs" })}
        />
        <div className="sidebar-foot">local-only · source-available</div>
      </nav>
      <main className="content">
        {route.view === "library" && <Library go={go} jobs={jobs} />}
        {route.view === "new" && <NewSong go={go} />}
        {route.view === "queue" && <UpNext go={go} />}
        {route.view === "jobs" && <Jobs jobs={jobs} go={go} />}
        {route.view === "song" && <SongDetail mapPath={route.mapPath} title={route.title} />}
      </main>
    </div>
  );
}

function NavButton(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-btn${props.active ? " active" : ""}`} onClick={props.onClick}>
      {props.label}
    </button>
  );
}
