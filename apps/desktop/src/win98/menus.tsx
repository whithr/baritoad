// Menus: the menu bar, right-click menus and toolbar drop-downs all render
// from one command model, so a command is written once and shows up with
// the same label, access key, accelerator and enabled state everywhere.
//
// Keys: accelerators are *displayed* from `accel`; a command is *bound* by
// useAccelerators only when it sets `keys`. Views whose keydown handlers
// already own a shortcut leave `keys` off so nothing fires twice.

import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Glyph } from "./icons";
import { activeDialog } from "./accessKeys";
import { AccessLabel, accessKeyOf, stripAccess } from "./label";
import { accelLabel, chordKey, matchKeys, modKey } from "./keys";

export interface Command {
  /** "&Save" — the & marks the access key. */
  label: string;
  /** Shortcut text shown right-aligned ("Ctrl+S"). */
  accel?: string;
  /** Key spec bound by useAccelerators ("ctrl+s", "f5", "delete", "q"). */
  keys?: string;
  run?: () => void;
  disabled?: boolean;
  /** Checkable item: a check mark (or bullet when `radio`) while true. */
  checked?: boolean;
  radio?: boolean;
  /** Submenu. */
  items?: MenuEntry[];
}

export type MenuEntry = Command | "-";

export interface MenuDef {
  label: string;
  items: MenuEntry[];
}

// ------------------------------------------------------------ item render

/** An access key typed in an open menu: act on the item whose underlined
 *  letter matches, the way a click would — so Base UI runs it and closes
 *  the menu itself (a submenu trigger opens its submenu instead). */
function runAccess(popup: Element | null | undefined, key: string): boolean {
  if (!popup) return false;
  const k = key.toLowerCase();
  const items = popup.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]');
  for (const el of items) {
    if (el.hasAttribute("data-disabled") || el.getAttribute("aria-disabled") === "true") continue;
    if (el.querySelector(".w-ak")?.textContent?.toLowerCase() !== k) continue;
    if (el.getAttribute("aria-haspopup")) {
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    } else {
      el.click();
    }
    return true;
  }
  return false;
}

/** The open menu popup, topmost last. */
const openPopup = () => {
  const pops = document.querySelectorAll(".w-popup.w-menu");
  return pops[pops.length - 1] ?? null;
};

function MenuItems(props: { items: MenuEntry[] }) {
  return (
    <>
      {props.items.map((it, i) => {
        if (it === "-") return <Menu.Separator key={`sep${i}`} className="w-menu-sep" />;
        if (it.items) {
          return (
            <Menu.SubmenuRoot key={it.label}>
              <Menu.SubmenuTrigger className="w-menu-item" disabled={it.disabled} label={stripAccess(it.label)}>
                <span className="w-menu-mark" />
                <span>
                  <AccessLabel text={it.label} />
                </span>
                <span />
                <span className="w-menu-mark">
                  <Glyph name="right" />
                </span>
              </Menu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner sideOffset={-3} alignOffset={-3} style={{ zIndex: 1000 }}>
                  <SubPopup items={it.items} />
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
          );
        }
        const body = (
          <>
            <span />
            <span>
              <AccessLabel text={it.label} />
            </span>
            <span className="w-menu-accel">{it.accel && accelLabel(it.accel)}</span>
            <span />
          </>
        );
        if (it.checked !== undefined) {
          return (
            <Menu.CheckboxItem
              key={it.label}
              className="w-menu-item"
              checked={it.checked}
              disabled={it.disabled}
              label={stripAccess(it.label)}
              onCheckedChange={() => it.run?.()}
              closeOnClick
            >
              <span className="w-menu-mark">
                <Menu.CheckboxItemIndicator>
                  <Glyph name={it.radio ? "bullet" : "check"} />
                </Menu.CheckboxItemIndicator>
              </span>
              <span>
                <AccessLabel text={it.label} />
              </span>
              <span className="w-menu-accel">{it.accel && accelLabel(it.accel)}</span>
              <span />
            </Menu.CheckboxItem>
          );
        }
        return (
          <Menu.Item
            key={it.label}
            className="w-menu-item"
            disabled={it.disabled}
            label={stripAccess(it.label)}
            onClick={() => it.run?.()}
          >
            {body}
          </Menu.Item>
        );
      })}
    </>
  );
}

function SubPopup(props: { items: MenuEntry[] }) {
  return (
    <Menu.Popup className="w-popup w-menu">
      <MenuItems items={props.items} />
    </Menu.Popup>
  );
}

// --------------------------------------------------------------- menu bar

export function MenuBar(props: { menus: MenuDef[]; disabled?: boolean }) {
  const { menus } = props;
  // Menu mode, owned here: only a click (or the keyboard) opens a menu —
  // pointing at other titles never switches menus; a menu stays open until a
  // click elsewhere, a second click on its own title, a command or Esc. Each
  // menu is a standalone Base UI Menu (items, typeahead, submenus, focus);
  // Base UI's Menubar isn't used because it opens menus on hover and its
  // hover-opened menus leave stale mouse-up listeners that close the whole
  // bar on the next click ("cancel-open").
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const openRef = useRef<number | null>(null);
  openRef.current = openIdx;
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);
  const menusRef = useRef(menus);
  menusRef.current = menus;

  // Where focus was before the menu bar took it: a closed menu hands focus
  // back there (the list, the Bench), not to the bar, so the window's own
  // keys work again straight away.
  const lastFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest && !t.closest(".w-menubar, .w-menu")) lastFocus.current = t;
    };
    window.addEventListener("focusin", onFocus);
    return () => window.removeEventListener("focusin", onFocus);
  }, []);
  const restoreFocus = (closing?: number) => {
    // closing because a neighbouring menu opened: that menu takes focus
    if (openRef.current !== null && openRef.current !== closing) return false;
    const el = lastFocus.current;
    return el && el.isConnected ? el : false;
  };

  /** Left/Right along the bar: with a menu open, open the neighbour; with
   *  only a title focused, move focus. */
  const step = (from: number, dir: -1 | 1) => {
    const n = menusRef.current.length;
    const to = (from + dir + n) % n;
    const trigger = triggers.current[to];
    trigger?.focus();
    // open the neighbour the keyboard way, so its first item is highlighted
    if (openRef.current !== null) trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  };

  // Alt+letter opens that menu; F10 (or a lone Alt tap) focuses the bar.
  // Capture phase so the views' bare-letter shortcuts never see Alt chords.
  useEffect(() => {
    if (props.disabled) return;
    let altAlone = false;
    const onDown = (e: KeyboardEvent) => {
      altAlone = e.key === "Alt" && !e.repeat;
      // A dialog owns the keyboard: its buttons take the Alt+letters
      // (accessKeys.ts), and a lone Alt doesn't reach behind it.
      if (activeDialog()) {
        altAlone = false;
        return;
      }
      // A menu is open but focus hasn't reached its items yet (it moves on
      // the next frame): its access keys still work.
      const popup = openPopup();
      if (
        popup &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        e.key.length === 1 &&
        !(document.activeElement as HTMLElement | null)?.closest(".w-menu")
      ) {
        if (runAccess(popup, e.key)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const letter = chordKey(e);
      if (e.altKey && !e.ctrlKey && !e.metaKey && letter.length === 1) {
        const idx = menusRef.current.findIndex((m) => accessKeyOf(m.label) === letter.toLowerCase());
        const trigger = idx >= 0 ? triggers.current[idx] : null;
        if (trigger) {
          e.preventDefault();
          e.stopPropagation();
          // Open it the way the keyboard does (ArrowDown on the focused
          // trigger) so focus lands on the first item and access keys work.
          trigger.focus();
          trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        }
      } else if (e.key === "F10" && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        triggers.current[0]?.focus();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" && altAlone && !openPopup()) {
        e.preventDefault();
        const first = triggers.current[0];
        if (document.activeElement === first) first?.blur();
        else first?.focus();
      }
      altAlone = false;
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [props.disabled]);

  return (
    <div className="w-menubar" role="menubar" aria-orientation="horizontal" aria-disabled={props.disabled || undefined}>
      {menus.map((m, i) => (
        <Menu.Root
          key={m.label}
          modal={false}
          open={openIdx === i}
          disabled={props.disabled}
          onOpenChange={(o) => {
            if (o) setOpenIdx(i);
            else if (openRef.current === i) setOpenIdx(null);
          }}
        >
          <Menu.Trigger
            className="w-menubar-item"
            role="menuitem"
            tabIndex={-1}
            ref={(el: HTMLButtonElement | null) => {
              triggers.current[i] = el;
            }}
            // a click on a title doesn't take focus from the window: the menu
            // takes it while open and hands it back when it closes
            onMouseDown={(e: React.MouseEvent<HTMLButtonElement>) => e.preventDefault()}
            onKeyDown={(e: React.KeyboardEvent<HTMLButtonElement>) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                step(i, e.key === "ArrowRight" ? 1 : -1);
              } else if (e.key === "Escape" && openRef.current === null) {
                e.preventDefault();
                const back = restoreFocus();
                if (back) back.focus();
                else e.currentTarget.blur();
              }
            }}
          >
            <AccessLabel text={m.label} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="start" sideOffset={1} style={{ zIndex: 1000 }}>
              <Menu.Popup
                className="w-popup w-menu"
                finalFocus={() => restoreFocus(i)}
                onKeyDownCapture={(e) => {
                  if (e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
                  if (runAccess(e.currentTarget, e.key)) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                onKeyDown={(e) => {
                  // Left/Right in a top-level menu walk the bar (inside a
                  // submenu, or on a submenu title, Base UI handles them)
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  const t = e.target as HTMLElement;
                  if (t.closest(".w-menu") !== e.currentTarget) return;
                  if (e.key === "ArrowRight" && t.getAttribute("aria-haspopup")) return;
                  e.preventDefault();
                  step(i, e.key === "ArrowRight" ? 1 : -1);
                }}
              >
                <MenuItems items={m.items} />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ))}
    </div>
  );
}

// ---------------------------------------------------------- context menu

/** Right-click (or Shift+F10 / Menu key) anywhere inside `children`. */
export function ContextMenu(props: {
  items: MenuEntry[];
  children: ReactNode;
  onOpen?: () => void;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  return (
    <BaseContextMenu.Root
      disabled={props.disabled}
      onOpenChange={(o) => {
        if (o) props.onOpen?.();
      }}
    >
      <BaseContextMenu.Trigger className={props.className} style={props.style}>
        {props.children}
      </BaseContextMenu.Trigger>
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner style={{ zIndex: 1000 }}>
          <BaseContextMenu.Popup
            className="w-popup w-menu"
            onKeyDownCapture={(e) => {
              if (e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
              if (runAccess(e.currentTarget, e.key)) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            <MenuItems items={props.items} />
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
}

// ------------------------------------------------------ drop-down button

/** A toolbar or push button that opens a menu (Export ▾). */
export function DropdownButton(props: {
  items: MenuEntry[];
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className={props.className ?? "w-btn"} disabled={props.disabled} aria-label={props.ariaLabel}>
        {props.children}
        <Glyph name="down" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={1} style={{ zIndex: 1000 }}>
          <Menu.Popup
            className="w-popup w-menu"
            onKeyDownCapture={(e) => {
              if (e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
              if (runAccess(e.currentTarget, e.key)) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            <MenuItems items={props.items} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// ---------------------------------------------------------- accelerators

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

/** Is focus inside an open menu or a modal dialog? Views' bare-key handlers
 *  should stand down while one is up. */
export function isInOverlay(el: Element | null = document.activeElement): boolean {
  return !!el?.closest('[role="menu"], [role="menubar"], [role="dialog"], [role="alertdialog"], [role="listbox"]');
}

// Matching a key spec, and how shortcuts read on a Mac: keys.ts.

function flatten(entries: (MenuEntry | MenuDef)[], out: Command[] = []): Command[] {
  for (const it of entries) {
    if (it === "-") continue;
    if (it.items) flatten(it.items, out);
    else out.push(it as Command);
  }
  return out;
}

/** Bind every command (in menus or plain lists) that declares `keys`. */
export function useAccelerators(entries: (MenuEntry | MenuDef)[], opts?: { enabled?: boolean }) {
  const ref = useRef<Command[]>([]);
  ref.current = flatten(entries).filter((c) => c.keys);
  const enabled = opts?.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typing = isTyping(document.activeElement);
      // A focused menu-bar title (no menu open) still lets chords and F-keys
      // through; open menus and dialogs own every key.
      const chord = modKey(e) || /^F\d+$/.test(e.key);
      const barOnly = !!document.activeElement?.closest('[role="menubar"]') && !document.querySelector('[role="menu"]');
      if (isInOverlay() && !(barOnly && chord)) return;
      for (const c of ref.current) {
        if (!c.keys || c.disabled) continue;
        const specs = c.keys.split(",").map((s) => s.trim());
        if (!specs.some((s) => matchKeys(e, s))) continue;
        // plain keys never fire while typing; chords with Ctrl (⌘) still do
        if (typing && !modKey(e) && !/^f\d+$/i.test(e.key)) continue;
        e.preventDefault();
        c.run?.();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
