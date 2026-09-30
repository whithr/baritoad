import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings } from "./settings";

describe("parseSettings", () => {
  it("returns defaults for missing or corrupt blobs", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
  });

  it("defaults new installs to the Classic scheme with the pixel font", () => {
    expect(DEFAULT_SETTINGS.scheme).toBe("classic");
    expect(DEFAULT_SETTINGS.pixelFont).toBe(true);
    expect(DEFAULT_SETTINGS.uiScale).toBe("normal");
  });

  it("migrates the pre-98 light/dark theme to classic/night", () => {
    expect(parseSettings(JSON.stringify({ theme: "light" })).scheme).toBe("classic");
    expect(parseSettings(JSON.stringify({ theme: "dark" })).scheme).toBe("night");
  });

  it("prefers an explicit scheme over a leftover legacy theme", () => {
    expect(parseSettings(JSON.stringify({ theme: "dark", scheme: "classic" })).scheme).toBe("classic");
  });

  it("keeps valid fields and resets invalid ones individually", () => {
    const s = parseSettings(
      JSON.stringify({
        scheme: "night",
        pixelFont: false,
        uiScale: "huge",
        benchView: "focus",
        shiftScope: "sideways",
        importOn: "cpu",
      }),
    );
    expect(s).toEqual({
      scheme: "night",
      pixelFont: false,
      uiScale: "normal",
      benchView: "focus",
      shiftScope: "line",
      importOn: "cpu",
    });
  });

  it("imports on the graphics card unless the processor was chosen", () => {
    expect(parseSettings(null).importOn).toBe("gpu");
    expect(parseSettings(JSON.stringify({ importOn: "npu" })).importOn).toBe("gpu");
  });

  it("rejects a non-boolean pixelFont", () => {
    expect(parseSettings(JSON.stringify({ pixelFont: "yes" })).pixelFont).toBe(true);
  });
});
