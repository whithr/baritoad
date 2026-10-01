// App shell: Library → Bench in the main window, the TV player in its own
// Stage window (stage.ts), and a tiny hash router — no router dependency
// (three routes don't justify a package and its §6 row).
//
// Chrome is baritoad 98 (win98/, DESIGN.md). Each view draws its own
// window frame, menus and status bar; Properties, Player Themes and About
// are dialogs (views/AppDialogs.tsx), not routes.

import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { listJobs, measurePlan, onJobEvent, setGamePolicy } from "./api";
import { emptyJobsState, reduceJobEvent, seedFromSnapshots, type JobsState } from "./jobEvents";
import { applyAppearance, loadSettings, parseSettings, saveSettings, SETTINGS_KEY, type Settings } from "./settings";
import { publishPrefs, subscribePrefs } from "./prefsSync";
import { ROLE, onStage, openStage, stageCurrent, type StageRoute } from "./stage";
import Home from "./views/Home";
import Bench from "./views/Bench";
import PlayerView from "./views/PlayerView";
import { MessageBoxProvider, TipProvider } from "./win98";

// Dev-only parts bin (#/kit); dead code in production builds.
const KitView = import.meta.env.DEV ? lazy(() => import("./views/KitView")) : null;

export type Route =
  | { view: "home" }
  | { view: "library" }
  | { view: "kit" }
  | { view: "song"; mapPath: string; title?: string; songId?: number; at?: number }
  | { view: "play"; songId?: number; mapPath?: string; measure?: boolean };

function parseHash(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  if (path === "kit" && import.meta.env.DEV) return { view: "kit" };
  if (path === "song") {
    const params = new URLSearchParams(query ?? "");
    const mapPath = params.get("map") ?? "";
    const idRaw = params.get("id");
    const songId = idRaw !== null && /^\d+$/.test(idRaw) ? Number(idRaw) : undefined;
    const atRaw = params.get("at");
    const at = atRaw !== null && /^[\d.]+$/.test(atRaw) ? Number(atRaw) : undefined;
    return mapPath
      ? { view: "song", mapPath, title: params.get("title") ?? undefined, songId, at }
      : { view: "home" };
  }
  if (path === "play") {
    const params = new URLSearchParams(query ?? "");
    const idRaw = params.get("id");
    const songId = idRaw !== null && /^\d+$/.test(idRaw) ? Number(idRaw) : undefined;
    const mapPath = params.get("map") ?? undefined;
    if (songId == null && !mapPath) return { view: "home" };
    return { view: "play", songId, mapPath, measure: params.get("measure") === "1" };
  }
  return { view: "home" };
}

export function navigate(route: Route) {
  switch (route.view) {
    case "home":
    case "library":
      window.location.hash = "#/home";
      break;
    case "kit":
      window.location.hash = "#/kit";
      break;
    case "song": {
      const q = new URLSearchParams({ map: route.mapPath });
      if (route.title) q.set("title", route.title);
      if (route.songId != null) q.set("id", String(route.songId));
      if (route.at != null) q.set("at", String(route.at));
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

export const SettingsContext = createContext<{
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}>({ settings: loadSettings(), update: () => undefined });

export const useSettings = () => useContext(SettingsContext);


export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [jobs, setJobs] = useState<JobsState>(emptyJobsState);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const stage = ROLE === "player";

  // Settings are owned by the main window (it saves and publishes); the
  // stage window only follows along.
  const fromOtherWindow = useRef(false);
  useEffect(() => {
    applyAppearance(settings);
    if (stage) return;
    saveSettings(settings);
    if (fromOtherWindow.current) fromOtherWindow.current = false;
    else publishPrefs(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings, stage]);
  useEffect(
    () =>
      subscribePrefs(SETTINGS_KEY, (v) => {
        fromOtherWindow.current = true;
        setSettings(parseSettings(v));
      }),
    [],
  );

  // Gaming mode's choice lives in the import worker (gaming.rs); the main
  // window tells it at startup and whenever it changes.
  useEffect(() => {
    if (!stage) void setGamePolicy(settings.whileGaming).catch(() => undefined);
  }, [settings.whileGaming, stage]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
  }, []);
  const settingsCtx = useMemo(() => ({ settings, update }), [settings, update]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((r: Route) => navigate(r), []);

  // The stage window follows `load` events (a second Sing reuses it), and
  // asks once at startup in case one was sent before it was listening.
  useEffect(() => {
    if (!stage) return;
    const show = (r: StageRoute | null) => {
      if (!r || (r.song_id == null && !r.map_path)) return;
      go({ view: "play", songId: r.song_id ?? undefined, mapPath: r.map_path ?? undefined, measure: r.measure });
    };
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onStage((e) => e.kind === "load" && show(e.route))
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    void stageCurrent().then((r) => {
      const cur = parseHash(window.location.hash);
      if (r && !(cur.view === "play" && cur.songId === (r.song_id ?? undefined) && cur.mapPath === (r.map_path ?? undefined))) show(r);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [stage, go]);

  // One app-lifetime job-event subscription feeding the reducer; views read
  // the reduced state. Seeded from the queue snapshot so a reloaded webview
  // still shows in-flight jobs. (Main window only.)
  useEffect(() => {
    if (stage) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await onJobEvent((e) => setJobs((s) => reduceJobEvent(s, e)));
      if (disposed) unlisten();
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
  }, [stage]);

  // Dev measurement harness bootstrap (src-tauri/src/player.rs) — inert for
  // normal users. Measures on the stage, like a real sing; falls back to the
  // in-window player if the stage can't open.
  useEffect(() => {
    if (stage) return;
    (async () => {
      try {
        const plan = await measurePlan();
        if (!plan) return;
        const opened = await openStage({ song_id: plan.song_id, map_path: plan.map_path, measure: true });
        if (!opened) {
          go({ view: "play", songId: plan.song_id ?? undefined, mapPath: plan.map_path ?? undefined, measure: true });
        }
      } catch {
        // command missing / failed: nothing to do
      }
    })();
  }, [go, stage]);

  // The performance player is full-bleed: its own chrome, no app frame. The
  // stage window renders nothing else.
  if (route.view === "play" || stage) {
    return (
      <SettingsContext.Provider value={settingsCtx}>
        <TipProvider>
          <MessageBoxProvider>
            {route.view === "play" ? (
              <PlayerView
                key={`${route.songId ?? ""}|${route.mapPath ?? ""}`}
                songId={route.songId}
                mapPath={route.mapPath}
                measure={route.measure}
                go={go}
              />
            ) : (
              <div style={{ position: "fixed", inset: 0, background: "#000010" }} />
            )}
          </MessageBoxProvider>
        </TipProvider>
      </SettingsContext.Provider>
    );
  }

  if (route.view === "kit" && KitView) {
    return (
      <SettingsContext.Provider value={settingsCtx}>
        <TipProvider>
          <MessageBoxProvider>
            <Suspense fallback={null}>
              <KitView />
            </Suspense>
          </MessageBoxProvider>
        </TipProvider>
      </SettingsContext.Provider>
    );
  }

  return (
    <SettingsContext.Provider value={settingsCtx}>
      <TipProvider>
        <MessageBoxProvider>
          {route.view === "song" ? (
            <Bench
              key={route.mapPath}
              mapPath={route.mapPath}
              title={route.title}
              songId={route.songId}
              startAt={route.at}
              go={go}
            />
          ) : (
            <Home go={go} jobs={jobs} />
          )}
        </MessageBoxProvider>
      </TipProvider>
    </SettingsContext.Provider>
  );
}
