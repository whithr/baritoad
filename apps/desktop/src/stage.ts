// The Stage — the TV player's own window (src-tauri/src/stage.rs).
//
// The main window asks Rust to open (or reuse) the stage; the stage window
// renders only the #/play route and follows `load` events. Only Rust unloads
// the engine (when the stage window is destroyed), so the stage's player view
// never unloads on unmount.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface StageRoute {
  song_id?: number | null;
  map_path?: string | null;
  measure?: boolean;
}

export interface StageDisplay {
  name?: string | null;
  x: number;
  y: number;
  fullscreen: boolean;
}

export type StageEvent =
  | { kind: "opened"; route: StageRoute }
  | { kind: "load"; route: StageRoute }
  | { kind: "closed" };

export const STAGE_EVENT = "karascape://stage";

/** Which window this webview is. */
export const ROLE: "main" | "player" = (() => {
  try {
    return getCurrentWindow().label === "player" ? "player" : "main";
  } catch {
    return "main";
  }
})();

// The TV display choice is per machine, in its own key: the main window
// rewrites the whole settings blob and must not clobber it.
const DISPLAY_KEY = "karascape.stage.v1";

export function loadDisplay(): StageDisplay | null {
  try {
    const raw = localStorage.getItem(DISPLAY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StageDisplay>;
    if (typeof v.x !== "number" || typeof v.y !== "number") return null;
    return { name: typeof v.name === "string" ? v.name : null, x: v.x, y: v.y, fullscreen: v.fullscreen === true };
  } catch {
    return null;
  }
}

export function saveDisplay(d: StageDisplay | null): void {
  try {
    if (d) localStorage.setItem(DISPLAY_KEY, JSON.stringify(d));
    else localStorage.removeItem(DISPLAY_KEY);
  } catch {
    // storage unavailable: the choice holds for this session only
  }
}

/** Open the stage on a song (or send it to the open stage). False when the
 *  stage can't open (e.g. the browser harness) — callers fall back to the
 *  in-window #/play route. */
export async function openStage(route: StageRoute): Promise<boolean> {
  try {
    await invoke("stage_open", { route, display: loadDisplay() });
    return true;
  } catch (e) {
    console.warn("stage_open failed; using the in-window player", e);
    return false;
  }
}

export const stageShowOn = (display: StageDisplay) => invoke<void>("stage_show_on", { display });

export const stageFocus = (label: "main" | "player") => invoke<void>("stage_focus", { label }).catch(() => undefined);

export const stageCurrent = () => invoke<StageRoute | null>("stage_current").catch(() => null);

export const onStage = (handler: (e: StageEvent) => void): Promise<UnlistenFn> =>
  listen<StageEvent>(STAGE_EVENT, (e) => handler(e.payload));
