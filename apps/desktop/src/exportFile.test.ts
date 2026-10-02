import { describe, expect, it } from "vitest";
import { exportFileName, folderOf } from "./exportFile";

describe("exportFileName", () => {
  it("uses the title and the format's extension", () => {
    expect(exportFileName("Waterloo", "lrc")).toBe("Waterloo.lrc");
    expect(exportFileName("Waterloo", "ass")).toBe("Waterloo.ass");
    expect(exportFileName("Waterloo", "ultrastar")).toBe("Waterloo.txt");
  });

  it("drops characters Windows refuses and trailing dots", () => {
    expect(exportFileName('AC/DC: "Back in Black"?', "lrc")).toBe("ACDC Back in Black.lrc");
    expect(exportFileName("Song...", "lrc")).toBe("Song.lrc");
    expect(exportFileName("  ", "lrc")).toBe("song.lrc");
  });
});

describe("folderOf", () => {
  it("is the folder a file is in, either slash", () => {
    expect(folderOf("C:\\Music\\ABBA\\Waterloo.mp3")).toBe("C:\\Music\\ABBA");
    expect(folderOf("/home/h/music/a.mp3")).toBe("/home/h/music");
  });
});
