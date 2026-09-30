// App shell: the bench is the app. One surface (Home → Bench → Player) and a
// tiny hash router — no router dependency (four routes don't justify a
// package and its §6 row).
//
// Chrome is the hardware-panel language in hw.css (light/dark via
// settings). The performance player and the stage-theme editor keep their
// own legacy stylesheet, loaded on demand the first time either opens.

import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { listJobs, measurePlan, onJobEvent } from "./api";
import { emptyJobsState, reduceJobEvent, seedFromSnapshots, type JobsState } from "./jobEvents";
import { applyAppearance, loadSettings, parseSettings, saveSettings, SETTINGS_KEY, type Settings } from "./settings";
import { publishPrefs, subscribePrefs } from "./prefsSync";
import { ROLE, onStage, openStage, stageCurrent, type StageRoute } from "./stage";
import Home from "./views/Home";
import Bench from "./views/Bench";
import SettingsView from "./views/Settings";
import PlayerView from "./views/PlayerView";
import ThemesView from "./views/ThemesView";
import { AppFrame, Icon, MessageBoxProvider, TipProvider } from "./win98";

// hw.css pins .hw to the viewport; inside the 98 frame it becomes the client
// area instead (until each view moves onto the kit).
const LEGACY_IN_FRAME = { position: "relative", inset: "auto", flexGrow: 1, minHeight: 0 } as const;

// Dev-only parts bin (#/kit); dead code in production builds.
const KitView = import.meta.env.DEV ? lazy(() => import("./views/KitView")) : null;

export type Route =
  | { view: "home" }
  | { view: "library" }
  | { view: "settings" }
  | { view: "themes" }
  | { view: "kit" }
  | { view: "song"; mapPath: string; title?: string; songId?: number; at?: number }
  | { view: "play"; songId?: number; mapPath?: string; measure?: boolean };

function parseHash(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  if (path === "settings") return { view: "settings" };
  if (path === "themes") return { view: "themes" };
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
    case "settings":
      window.location.hash = "#/settings";
      break;
    case "themes":
      window.location.hash = "#/themes";
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

/** The legacy stylesheet (themes editor only, until it moves to the kit). */
let legacyCssLoaded: Promise<unknown> | null = null;
function ensureLegacyCss() {
  if (!legacyCssLoaded) legacyCssLoaded = import("./styles.css");
  return legacyCssLoaded;
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [jobs, setJobs] = useState<JobsState>(emptyJobsState);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [legacyReady, setLegacyReady] = useState(false);
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

  const needsLegacy = route.view === "themes";
  useEffect(() => {
    if (!needsLegacy || legacyReady) return;
    let alive = true;
    ensureLegacyCss().then(() => alive && setLegacyReady(true));
    return () => {
      alive = false;
    };
  }, [needsLegacy, legacyReady]);

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

  const legacyTitle = route.view === "settings" ? "Karascape - Settings" : "Karascape - Player Themes";

  return (
    <SettingsContext.Provider value={settingsCtx}>
      <TipProvider>
        <MessageBoxProvider>
          {route.view === "home" || route.view === "library" ? (
            <Home go={go} jobs={jobs} />
          ) : route.view === "song" ? (
            <Bench
              key={route.mapPath}
              mapPath={route.mapPath}
              title={route.title}
              songId={route.songId}
              startAt={route.at}
              go={go}
            />
          ) : (
            <AppFrame title={legacyTitle} icon={<Icon name="app" />}>
              <div className="hw" style={LEGACY_IN_FRAME}>
                {route.view === "settings" && <SettingsView go={go} />}
                {route.view === "themes" && (legacyReady ? <LegacyThemes go={go} /> : null)}
              </div>
            </AppFrame>
          )}
        </MessageBoxProvider>
      </TipProvider>
    </SettingsContext.Provider>
  );
}

function LegacyThemes(props: { go: (r: Route) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <div className="hw-topbar">
        <button type="button" className="hw-key icon" onClick={() => props.go({ view: "settings" })} aria-label="Back">
          ‹
        </button>
        <span className="hw-title">Player themes</span>
      </div>
      <div style={{ flexGrow: 1, minHeight: 0, overflow: "auto", userSelect: "auto" }}>
        <ThemesView />
      </div>
    </div>
  );
}
