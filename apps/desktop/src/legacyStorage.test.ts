import { describe, expect, it } from "vitest";
import { migrateLegacyStorage } from "./legacyStorage";

// node test env has no DOM — a Map-backed Storage
function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe("migrateLegacyStorage", () => {
  it("copies Karascape-era keys to the baritoad keys and renames the built-in theme id", () => {
    const themes = JSON.stringify({ themes: [], defaultId: "karascape-98", songOverrides: { "7": "karascape-98", "8": "sunset-vhs" } });
    const s = memoryStorage({
      "karascape.settings.v1": '{"scheme":"night"}',
      "karascape.themes.v1": themes,
      "karascape.bench.vocalGuide": "40",
    });
    migrateLegacyStorage(s);
    expect(s.getItem("baritoad.settings.v1")).toBe('{"scheme":"night"}');
    expect(JSON.parse(s.getItem("baritoad.themes.v1")!)).toEqual({
      themes: [],
      defaultId: "baritoad-98",
      songOverrides: { "7": "baritoad-98", "8": "sunset-vhs" },
    });
    expect(s.getItem("baritoad.bench.vocalGuide")).toBe("40");
    expect(s.getItem("baritoad.stage.v1")).toBeNull();
    // Old keys stay for an older build.
    expect(s.getItem("karascape.settings.v1")).toBe('{"scheme":"night"}');
  });

  it("never overwrites a key the renamed build already wrote", () => {
    const s = memoryStorage({ "karascape.settings.v1": '{"scheme":"night"}', "baritoad.settings.v1": '{"scheme":"classic"}' });
    migrateLegacyStorage(s);
    expect(s.getItem("baritoad.settings.v1")).toBe('{"scheme":"classic"}');
  });
});
