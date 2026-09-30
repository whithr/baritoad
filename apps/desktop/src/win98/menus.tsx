// Menus: the menu bar, right-click menus and toolbar drop-downs all render
// from one command model, so a command is written once and shows up with
// the same label, access key, accelerator and enabled state everywhere.
//
// Keys: accelerators are *displayed* from `accel`; a command is *bound* by
// useAccelerators only when it sets `keys`. Views whose keydown handlers
// already own a shortcut leave `keys` off so nothing fires twice.

import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { Menubar } from "@base-ui/react/menubar";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Glyph } from "./icons";
import { AccessLabel, accessKeyOf, stripAccess } from "./label";

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

function runAccess(items: MenuEntry[], key: string, close: () => void): boolean {
  const k = key.toLowerCase();
  const hit = items.find(
    (it): it is Command => it !== "-" && !it.disabled && !it.items && accessKeyOf(it.label) === k,
  );
  if (!hit) return false;
  close();
  // let the menu finish closing (focus returns) before the command runs
  setTimeout(() => hit.run?.(), 0);
  return true;
}

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
            <span className="w-menu-accel">{it.accel}</span>
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
              <span className="w-menu-accel">{it.accel}</span>
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
  const [open, setOpen] = useState<number | null>(null);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);
  const menusRef = useRef(menus);
  menusRef.current = menus;
  const openRef = useRef(open);
  openRef.current = open;

  // Alt+letter opens that menu; F10 (or a lone Alt tap) focuses the bar.
  // Capture phase so the views' bare-letter shortcuts never see Alt chords.
  useEffect(() => {
    if (props.disabled) return;
    let altAlone = false;
    const onDown = (e: KeyboardEvent) => {
      altAlone = e.key === "Alt" && !e.repeat;
      // A menu is open but focus hasn't reached its items yet (it moves on
      // the next frame): its access keys still work.
      const cur = openRef.current;
      if (
        cur !== null &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        e.key.length === 1 &&
        !(document.activeElement as HTMLElement | null)?.closest(".w-menu")
      ) {
        if (runAccess(menusRef.current[cur]?.items ?? [], e.key, () => setOpen(null))) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
        const idx = menusRef.current.findIndex((m) => accessKeyOf(m.label) === e.key.toLowerCase());
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
      if (e.key === "Alt" && altAlone && openRef.current === null) {
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
    <Menubar className="w-menubar" disabled={props.disabled}>
      {menus.map((m, i) => (
        <Menu.Root
          key={m.label}
          open={open === i}
          onOpenChange={(o) => setOpen((cur) => (o ? i : cur === i ? null : cur))}
        >
          <Menu.Trigger
            className="w-menubar-item"
            ref={(el: HTMLButtonElement | null) => {
              triggers.current[i] = el;
            }}
          >
            <AccessLabel text={m.label} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="start" sideOffset={1} style={{ zIndex: 1000 }}>
              <Menu.Popup
                className="w-popup w-menu"
                onKeyDownCapture={(e) => {
                  if (e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
                  if (runAccess(m.items, e.key, () => setOpen(null))) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
              >
                <MenuItems items={m.items} />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ))}
    </Menubar>
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
  const [open, setOpen] = useState(false);
  return (
    <BaseContextMenu.Root
      open={open}
      disabled={props.disabled}
      onOpenChange={(o) => {
        if (o) props.onOpen?.();
        setOpen(o);
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
              if (runAccess(props.items, e.key, () => setOpen(false))) {
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
  const [open, setOpen] = useState(false);
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
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
              if (runAccess(props.items, e.key, () => setOpen(false))) {
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

export function matchKeys(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const want = { ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), alt: parts.includes("alt") };
  if (e.ctrlKey !== want.ctrl || e.altKey !== want.alt) return false;
  const k = e.key.toLowerCase();
  // shift only matters for named keys and letters; "/" or "?" carry it implicitly
  if (key.length > 1 || /[a-z]/.test(key)) {
    if (e.shiftKey !== want.shift) return false;
  }
  if (key === "delete") return k === "delete";
  if (key === "enter") return k === "enter";
  if (key === "escape" || key === "esc") return k === "escape";
  return k === key;
}

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
      if (isInOverlay()) return;
      for (const c of ref.current) {
        if (!c.keys || c.disabled) continue;
        const specs = c.keys.split(",").map((s) => s.trim());
        if (!specs.some((s) => matchKeys(e, s))) continue;
        // plain keys never fire while typing; chords with Ctrl still do
        if (typing && !e.ctrlKey && !/^f\d+$/i.test(e.key)) continue;
        e.preventDefault();
        c.run?.();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
