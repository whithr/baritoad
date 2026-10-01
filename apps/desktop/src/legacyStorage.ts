// The app was called Karascape until 2026-10-01, and its localStorage keys
// carried that name. Copy each old key to its baritoad key once, so a
// renamed build keeps the user's settings, themes and song pins, Stage
// placement, and vocal guide. The built-in theme id was renamed with it.
// main.tsx imports this first, before any module reads storage. Old keys
// stay put, so an older build still finds its settings.

export const RENAMED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["karascape.settings.v1", "baritoad.settings.v1"],
  ["karascape.themes.v1", "baritoad.themes.v1"],
  ["karascape.stage.v1", "baritoad.stage.v1"],
  ["karascape.bench.vocalGuide", "baritoad.bench.vocalGuide"],
];

export function migrateLegacyStorage(store: Storage | null): void {
  if (!store) return;
  for (const [from, to] of RENAMED_KEYS) {
    try {
      const old = store.getItem(from);
      if (old === null || store.getItem(to) !== null) continue;
      store.setItem(to, old.split('"karascape-98"').join('"baritoad-98"'));
    } catch {
      // Storage blocked or full: the app falls back to its defaults.
    }
  }
}

migrateLegacyStorage(typeof localStorage !== "undefined" ? localStorage : null);
