// Cross-window preference sync. Settings and player themes live in
// localStorage, which both webviews share; a write in one window is
// published as an app event carrying the new value, so the other window
// applies it without re-reading storage (writes land there asynchronously).
// The DOM `storage` event is a second path for the same change.

import { emit, listen } from "@tauri-apps/api/event";

export const PREFS_EVENT = "karascape://prefs";

interface PrefsPayload {
  key: string;
  value: string | null;
  /** Unique per webview, so a window ignores its own echo. */
  from: string;
}

const SELF = Math.random().toString(36).slice(2);

export function publishPrefs(key: string, value: string | null): void {
  emit(PREFS_EVENT, { key, value, from: SELF } satisfies PrefsPayload).catch(() => undefined);
}

/** Calls `handler(value)` when another window changes `key`. */
export function subscribePrefs(key: string, handler: (value: string | null) => void): () => void {
  let last: string | null | undefined;
  const deliver = (value: string | null) => {
    if (value === last) return;
    last = value;
    handler(value);
  };
  let unlisten: (() => void) | undefined;
  let disposed = false;
  listen<PrefsPayload>(PREFS_EVENT, (e) => {
    if (e.payload.from !== SELF && e.payload.key === key) deliver(e.payload.value);
  })
    .then((u) => (disposed ? u() : (unlisten = u)))
    .catch(() => undefined);
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) deliver(e.newValue);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener("storage", onStorage);
  };
}
