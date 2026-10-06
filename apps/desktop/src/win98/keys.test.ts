import { describe, expect, it } from "vitest";
import { accelLabel, chordKey, isDeleteKey, matchKeys } from "./keys";

const key = (k: string, mods: Partial<KeyboardEvent> = {}, code = "") =>
  ({ key: k, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("matchKeys", () => {
  it("binds Ctrl on Windows and ⌘ on a Mac", () => {
    expect(matchKeys(key("o", { ctrlKey: true }), "ctrl+o", false)).toBe(true);
    expect(matchKeys(key("o", { metaKey: true }), "ctrl+o", false)).toBe(false);
    expect(matchKeys(key("o", { metaKey: true }), "ctrl+o", true)).toBe(true);
    expect(matchKeys(key("o", { ctrlKey: true }), "ctrl+o", true)).toBe(false);
    expect(matchKeys(key("O", { metaKey: true, shiftKey: true }), "ctrl+shift+o", true)).toBe(true);
  });

  it("keeps plain keys plain", () => {
    expect(matchKeys(key("/"), "ctrl+f, /".split(", ")[1], true)).toBe(true);
    expect(matchKeys(key("q", { metaKey: true }), "q", true)).toBe(false);
    expect(matchKeys(key("q", { ctrlKey: true }), "q", true)).toBe(false);
    expect(matchKeys(key("F5"), "f5", true)).toBe(true);
  });

  it("reads Option chords by the key on a Mac", () => {
    expect(matchKeys(key("Enter", { altKey: true }, "Enter"), "alt+enter", true)).toBe(true);
    expect(chordKey(key("ƒ", { altKey: true }, "KeyF"), true)).toBe("f");
    expect(chordKey(key("Dead", { altKey: true }, "KeyE"), true)).toBe("e");
    expect(chordKey(key("ƒ", { altKey: true }, "KeyF"), false)).toBe("ƒ");
    expect(chordKey(key("f", {}, "KeyF"), true)).toBe("f");
  });
});

describe("isDeleteKey", () => {
  it("takes the Mac's delete key, which browsers call Backspace", () => {
    expect(isDeleteKey(key("Delete"), false)).toBe(true);
    expect(isDeleteKey(key("Backspace"), false)).toBe(false);
    expect(isDeleteKey(key("Backspace"), true)).toBe(true);
  });
});

describe("accelLabel", () => {
  it("leaves Windows text alone", () => {
    expect(accelLabel("Ctrl+Shift+O", false)).toBe("Ctrl+Shift+O");
    expect(accelLabel("Del", false)).toBe("Del");
  });

  it("writes Mac shortcuts in Apple's order", () => {
    expect(accelLabel("Ctrl+O", true)).toBe("⌘O");
    expect(accelLabel("Ctrl+Shift+O", true)).toBe("⇧⌘O");
    expect(accelLabel("Alt+Enter", true)).toBe("⌥↩");
    expect(accelLabel("Alt+↑ ↓", true)).toBe("⌥↑ ↓");
    expect(accelLabel("Shift+F10", true)).toBe("⇧F10");
    expect(accelLabel("Del", true)).toBe("⌫");
    expect(accelLabel("F5", true)).toBe("F5");
  });

  it("uses the Mac's Quit and Redo", () => {
    expect(accelLabel("Alt+F4", true)).toBe("⌘Q");
    expect(accelLabel("Ctrl+Z / Ctrl+Y", true)).toBe("⌘Z / ⇧⌘Z");
  });

  it("works inside longer text", () => {
    expect(accelLabel("Add a song (Ctrl+O)", true)).toBe("Add a song (⌘O)");
    expect(accelLabel("/ or Ctrl+F", true)).toBe("/ or ⌘F");
    expect(accelLabel("Alt / F10", true)).toBe("⌥ / F10");
    expect(accelLabel("Add songs from links — paste a link anywhere, or Ctrl+L", true)).toBe(
      "Add songs from links — paste a link anywhere, or ⌘L",
    );
    expect(accelLabel("Full screen (F) · all keys: F1", true)).toBe("Full screen (F) · all keys: F1");
  });
});
