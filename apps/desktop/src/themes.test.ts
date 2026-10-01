import { beforeEach, describe, expect, it } from "vitest";
import {
  backgroundProbeColor,
  BUILTIN_THEMES,
  contrastRatio,
  deleteTheme,
  DEFAULT_THEME,
  DIGITAL_DASH,
  duplicateTheme,
  glowColor,
  loadThemeStore,
  mergeThemeDraft,
  resolveTheme,
  saveThemeStore,
  themeCssVars,
  updateTheme,
  type ThemeStore,
} from "./themes";

const emptyStore = (): ThemeStore => ({
  themes: [],
  defaultId: DEFAULT_THEME.id,
  songOverrides: {},
});

describe("resolveTheme", () => {
  it("falls through: song pin → default → baritoad 98", () => {
    let s = emptyStore();
    expect(resolveTheme(s, 7).id).toBe("baritoad-98");
    s = { ...s, defaultId: "neon-stage" };
    expect(resolveTheme(s, 7).id).toBe("neon-stage");
    s = { ...s, songOverrides: { "7": "sunset-vhs" } };
    expect(resolveTheme(s, 7).id).toBe("sunset-vhs");
    // another song still gets the default
    expect(resolveTheme(s, 8).id).toBe("neon-stage");
  });

  it("a dangling id never breaks resolution", () => {
    const s: ThemeStore = {
      themes: [],
      defaultId: "deleted-user-theme",
      songOverrides: { "7": "also-gone" },
    };
    expect(resolveTheme(s, 7).id).toBe("baritoad-98");
  });
});

describe("built-ins", () => {
  it("baritoad 98 is the default and listed first; Digital Dash stays selectable", () => {
    expect(DEFAULT_THEME.id).toBe("baritoad-98");
    expect(BUILTIN_THEMES[0].id).toBe("baritoad-98");
    expect(BUILTIN_THEMES.some((b) => b.id === DIGITAL_DASH.id)).toBe(true);
  });
});

describe("duplicate / update / delete", () => {
  it("duplicating a preset makes an editable copy with a fresh id", () => {
    const s = duplicateTheme(emptyStore(), "neon-stage");
    expect(s).not.toBeNull();
    const copy = s!.themes[0];
    expect(copy.builtin).toBe(false);
    expect(copy.id).not.toBe("neon-stage");
    expect(copy.sung).toBe(BUILTIN_THEMES.find((t) => t.id === "neon-stage")!.sung);
    // second duplicate gets a distinct name and id
    const s2 = duplicateTheme(s!, "neon-stage")!;
    expect(s2.themes[1].id).not.toBe(copy.id);
    expect(s2.themes[1].name).not.toBe(copy.name);
  });

  it("built-ins cannot be updated in place", () => {
    const s = emptyStore();
    expect(updateTheme(s, { ...DIGITAL_DASH, sung: "#ff0000" })).toBe(s);
  });

  it("deleting a theme clears the default and song pins that used it", () => {
    let s = duplicateTheme(emptyStore(), "neon-stage")!;
    const id = s.themes[0].id;
    s = { ...s, defaultId: id, songOverrides: { "3": id, "4": "midnight-snow" } };
    s = deleteTheme(s, id);
    expect(s.themes).toHaveLength(0);
    expect(s.defaultId).toBe(DEFAULT_THEME.id);
    expect(s.songOverrides).toEqual({ "4": "midnight-snow" });
  });
});

describe("store persistence", () => {
  // node test env has no DOM — a Map-backed localStorage shim
  beforeEach(() => {
    const bag = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, String(v)),
      removeItem: (k: string) => void bag.delete(k),
      clear: () => bag.clear(),
    };
  });

  it("round-trips through localStorage and survives garbage", () => {
    const s = duplicateTheme(emptyStore(), "sunset-vhs")!;
    saveThemeStore(s);
    const back = loadThemeStore();
    expect(back.themes).toHaveLength(1);
    expect(back.themes[0].name).toMatch(/Sunset VHS copy/);
    localStorage.setItem("baritoad.themes.v1", "{not json");
    expect(loadThemeStore().defaultId).toBe(DEFAULT_THEME.id);
  });
});

describe("css vars + contrast", () => {
  it("emits the var bag with a quoted font stack only when set", () => {
    const vars = themeCssVars(DIGITAL_DASH);
    expect(vars["--th-sung"]).toBe("#45e0d8");
    expect(vars["--th-glow"]).toBe("1");
    expect(vars["--th-font"]).toBeUndefined();
    const v2 = themeCssVars({ ...DIGITAL_DASH, font: "Comic Sans MS" });
    expect(v2["--th-font"]).toContain('"Comic Sans MS"');
    expect(v2["--th-font"]).toContain("Barlow");
  });

  it("glowColor is the color at halo alpha", () => {
    expect(glowColor("#45e0d8")).toBe("rgba(69, 224, 216, 0.35)");
    expect(glowColor("nonsense")).toContain("rgba(");
  });

  it("contrastRatio matches known WCAG anchors", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(contrastRatio("bad", "#000000")).toBeNull();
  });

  it("every built-in preset's text clears AA on its own background", () => {
    for (const t of BUILTIN_THEMES) {
      const bg = backgroundProbeColor(t.background);
      expect(contrastRatio(t.resting, bg)!).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.sung, bg)!).toBeGreaterThanOrEqual(3); // large text
    }
  });
});

describe("mergeThemeDraft", () => {
  it("keeps pins made meanwhile, drops pins to deleted themes, takes the draft's list and default", () => {
    let draft = duplicateTheme(emptyStore(), "neon-stage")!;
    const copyId = draft.themes[0].id;
    draft = { ...draft, defaultId: copyId };
    const current: ThemeStore = {
      themes: [],
      defaultId: DEFAULT_THEME.id,
      songOverrides: { "1": "sunset-vhs", "2": "user-gone", "3": copyId },
    };
    const merged = mergeThemeDraft(current, draft);
    expect(merged.themes.map((x) => x.id)).toEqual([copyId]);
    expect(merged.defaultId).toBe(copyId);
    expect(merged.songOverrides).toEqual({ "1": "sunset-vhs", "3": copyId });
  });

  it("falls back to the built-in default when the draft's default is unknown", () => {
    const merged = mergeThemeDraft(emptyStore(), { ...emptyStore(), defaultId: "nope" });
    expect(merged.defaultId).toBe(DEFAULT_THEME.id);
  });
});
