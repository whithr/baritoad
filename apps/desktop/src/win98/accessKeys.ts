// Access keys in dialogs, the 98 way: Alt+letter — or the bare letter while
// one of the dialog's buttons has focus — presses the button, checkbox or
// field label whose letter is underlined (label.tsx renders the mark). The
// menu bar stands aside while the keyboard is in a dialog (menus.tsx), so
// Alt+C in a box with a Cancel button never opens the Collection menu
// behind it.

const DIALOGS = '[role="dialog"], [role="alertdialog"]';
// A closed dialog stays in the DOM until its exit frame; it no longer counts.
const open = (d: Element) => !d.hasAttribute("data-closed") && (typeof d.checkVisibility !== "function" || d.checkVisibility());

/** The dialog the keyboard is in: the focused one, else the topmost modal. */
export function activeDialog(): HTMLElement | null {
  const focused = document.activeElement?.closest<HTMLElement>(DIALOGS);
  if (focused && open(focused)) return focused;
  const modals = [...document.querySelectorAll<HTMLElement>("[data-modal]")].filter(open);
  return modals[modals.length - 1] ?? null;
}

/** Press whatever in `scope` carries `key` as its access key; false if nothing does. */
export function pressAccessKey(scope: Element, key: string): boolean {
  const k = key.toLowerCase();
  for (const mark of scope.querySelectorAll<HTMLElement>(".w-ak")) {
    if (mark.textContent?.toLowerCase() !== k) continue;
    // Group-box captions are decoration; menus have their own keys.
    if (mark.closest('[aria-hidden="true"], [aria-hidden=""], [role="menu"]')) continue;
    const button = mark.closest<HTMLButtonElement>("button");
    if (button) {
      if (button.disabled || button.getAttribute("aria-disabled") === "true") continue;
      button.focus();
      button.click();
      return true;
    }
    const label = mark.closest("label");
    if (label) {
      // A label passes the click to its control: toggles a checkbox or
      // radio, focuses a field.
      label.click();
      return true;
    }
  }
  return false;
}

let installed = false;

/** One window-level listener for every dialog (dialogs.tsx installs it). */
export function installDialogAccessKeys(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || !/^[a-z0-9]$/i.test(e.key)) return;
      const scope = activeDialog();
      if (!scope) return;
      if (!e.altKey) {
        // Bare letters only while a button has focus: fields, lists and
        // pickers keep their typing.
        const el = document.activeElement;
        if (!el || el.tagName !== "BUTTON" || el.getAttribute("role") || !scope.contains(el)) return;
      }
      if (pressAccessKey(scope, e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
