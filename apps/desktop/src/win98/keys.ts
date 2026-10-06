// Shortcut keys across keyboards. The app's shortcuts are written the
// Windows way — bound as "ctrl+o", shown as "Ctrl+O". On a Mac ⌘ does what
// Ctrl does, Option is Alt, and the labels say so ("⌘O"); elsewhere
// everything passes through unchanged. Each helper takes `mac` so tests don't
// depend on the machine they run on.

export const isMac = typeof navigator !== "undefined" && /^Mac/i.test(navigator.platform ?? "");

/** The shortcut modifier: ⌘ on a Mac, Ctrl elsewhere. */
export function modKey(e: { ctrlKey: boolean; metaKey: boolean }, mac = isMac): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

/** The key an Alt chord means. On a Mac Option types another character
 *  (Option+F is "ƒ", Option+E a dead key), so there the key's place on the
 *  keyboard decides. */
export function chordKey(e: { key: string; code: string; altKey: boolean }, mac = isMac): string {
  if (mac && e.altKey) {
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code);
    if (m) return (m[1] ?? m[2]).toLowerCase();
  }
  return e.key;
}

/** The key that removes things from a list: Delete, or on a Mac the key
 *  marked delete, which browsers call Backspace. */
export function isDeleteKey(e: { key: string }, mac = isMac): boolean {
  return e.key === "Delete" || (mac && e.key === "Backspace");
}

/** Does `e` press `spec` ("ctrl+shift+o", "alt+enter", "f5", "/")? */
export function matchKeys(e: KeyboardEvent, spec: string, mac = isMac): boolean {
  const parts = spec.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const want = { ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), alt: parts.includes("alt") };
  if (modKey(e, mac) !== want.ctrl || e.altKey !== want.alt) return false;
  // On a Mac, Control chords aren't the app's.
  if (mac && e.ctrlKey) return false;
  const k = chordKey(e, mac).toLowerCase();
  // shift only matters for named keys and letters; "/" or "?" carry it implicitly
  if (key.length > 1 || /[a-z]/.test(key)) {
    if (e.shiftKey !== want.shift) return false;
  }
  if (key === "delete") return k === "delete";
  if (key === "enter") return k === "enter";
  if (key === "escape" || key === "esc") return k === "escape";
  return k === key;
}

// Apple's order for modifiers: ⌥ ⇧ ⌘ (⌃ would come first; Ctrl is ⌘ here).
const MAC_MODS: [string, string][] = [
  ["Alt", "⌥"],
  ["Shift", "⇧"],
  ["Ctrl", "⌘"],
];
const MAC_KEYS: Record<string, string> = { Enter: "↩" };

/** Shortcut text as this keyboard writes it, also inside longer text:
 *  "Ctrl+Shift+O" is "⇧⌘O" on a Mac, "Add a song (Ctrl+O)" is
 *  "Add a song (⌘O)". */
export function accelLabel(text: string, mac = isMac): string {
  if (!mac) return text;
  if (text === "Del") return "⌫";
  return (
    text
      // Exit is Quit on a Mac (src-tauri/src/mac_menu.rs), and Redo is ⇧⌘Z.
      .replace(/\bAlt\+F4\b/g, "Ctrl+Q")
      .replace(/\bCtrl\+Y\b/g, "Ctrl+Shift+Z")
      .replace(/\b((?:(?:Ctrl|Alt|Shift)\+)+)([^\s+/)]+)/g, (_, mods: string, key: string) => {
        const held = mods.split("+");
        return MAC_MODS.filter(([name]) => held.includes(name)).map(([, glyph]) => glyph).join("") + (MAC_KEYS[key] ?? key);
      })
      // A lone Alt ("Alt / F10": the menu bar).
      .replace(/^Alt(?=\s)/, "⌥")
  );
}
