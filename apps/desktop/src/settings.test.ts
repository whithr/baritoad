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
        benchView: "text",
        shiftScope: "sideways",
        importOn: "cpu",
      }),
    );
    expect(s).toEqual({
      scheme: "night",
      pixelFont: false,
      uiScale: "normal",
      benchView: "text",
      shiftScope: "line",
      importOn: "cpu",
      whileGaming: "cpu",
      libraryGroupBy: "none",
      lookupLyrics: false,
      playbackSpeedDownloads: false,
      autoAdvance: true,
      advanceSeconds: 10,
    });
  });

  it("downloads at full speed until playback speed is ticked", () => {
    expect(parseSettings(null).playbackSpeedDownloads).toBe(false);
    expect(parseSettings(JSON.stringify({ playbackSpeedDownloads: true })).playbackSpeedDownloads).toBe(true);
    expect(parseSettings(JSON.stringify({ playbackSpeedDownloads: 1 })).playbackSpeedDownloads).toBe(false);
  });

  it("starts the next song by itself unless that was switched off", () => {
    expect(parseSettings(null).autoAdvance).toBe(true);
    expect(parseSettings(JSON.stringify({ autoAdvance: false })).autoAdvance).toBe(false);
    expect(parseSettings(JSON.stringify({ autoAdvance: "no" })).autoAdvance).toBe(true);
  });

  it("keeps the countdown between 3 and 60 whole seconds", () => {
    expect(parseSettings(JSON.stringify({ advanceSeconds: 15 })).advanceSeconds).toBe(15);
    expect(parseSettings(JSON.stringify({ advanceSeconds: 0 })).advanceSeconds).toBe(3);
    expect(parseSettings(JSON.stringify({ advanceSeconds: 600 })).advanceSeconds).toBe(60);
    expect(parseSettings(JSON.stringify({ advanceSeconds: 7.6 })).advanceSeconds).toBe(8);
    expect(parseSettings(JSON.stringify({ advanceSeconds: "soon" })).advanceSeconds).toBe(10);
  });

  it("remembers what to do while gaming and drops a bogus choice", () => {
    expect(parseSettings(null).whileGaming).toBe("cpu");
    expect(parseSettings(JSON.stringify({ whileGaming: "pause" })).whileGaming).toBe("pause");
    expect(parseSettings(JSON.stringify({ whileGaming: "explode" })).whileGaming).toBe("cpu");
  });

  it("keeps online lyrics lookup off until it's switched on", () => {
    expect(parseSettings(null).lookupLyrics).toBe(false);
    expect(parseSettings(JSON.stringify({ lookupLyrics: true })).lookupLyrics).toBe(true);
    expect(parseSettings(JSON.stringify({ lookupLyrics: "yes" })).lookupLyrics).toBe(false);
  });

  it("remembers a valid Group by and drops a bogus one", () => {
    expect(parseSettings(JSON.stringify({ libraryGroupBy: "decade" })).libraryGroupBy).toBe("decade");
    expect(parseSettings(JSON.stringify({ libraryGroupBy: "mood" })).libraryGroupBy).toBe("none");
  });

  it("opens a bench last left on the removed Focus view in Lanes", () => {
    expect(parseSettings(JSON.stringify({ benchView: "focus" })).benchView).toBe("lanes");
  });

  it("imports on the graphics card unless the processor was chosen", () => {
    expect(parseSettings(null).importOn).toBe("gpu");
    expect(parseSettings(JSON.stringify({ importOn: "npu" })).importOn).toBe("gpu");
  });

  it("rejects a non-boolean pixelFont", () => {
    expect(parseSettings(JSON.stringify({ pixelFont: "yes" })).pixelFont).toBe(true);
  });
});
