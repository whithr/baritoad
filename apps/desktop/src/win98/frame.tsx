// The window frame: a custom 98 title bar over a frameless Tauri window
// (decorations: false). The caption is a drag region (drag to move, double-
// click to maximize — Tauri's data-tauri-drag-region handles both); the
// caption buttons call the window API directly.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type ReactNode } from "react";
import { Glyph } from "./icons";

export function TitleBar(props: {
  title: string;
  icon?: ReactNode;
  active?: boolean;
  /** Make the caption a window drag region (app windows, not dialogs). */
  drag?: boolean;
  children?: ReactNode;
  /** Rendered as the dialog's accessible title (Base UI Dialog.Title etc.). */
  titleAs?: (text: string) => ReactNode;
}) {
  const drag = props.drag ? { "data-tauri-drag-region": true } : {};
  return (
    <div className="w-titlebar" data-active={props.active === false ? "false" : "true"} {...drag}>
      {props.icon && (
        <span style={{ display: "flex" }} {...drag}>
          {props.icon}
        </span>
      )}
      <span className="w-titlebar-text" {...drag}>
        {props.titleAs ? props.titleAs(props.title) : props.title}
      </span>
      {props.children}
    </div>
  );
}

export function CaptionButton(props: {
  glyph: "min" | "max" | "restore" | "close" | "help";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`w-capbtn${props.glyph === "close" ? " close" : ""}`}
      aria-label={props.label}
      title={props.label}
      tabIndex={-1}
      onClick={props.onClick}
    >
      <Glyph name={props.glyph} />
    </button>
  );
}

/** Tracks the current window's maximized/focused state. */
export function useWindowState() {
  const [maximized, setMaximized] = useState(false);
  const [active, setActive] = useState(() => (typeof document !== "undefined" ? document.hasFocus() : true));
  useEffect(() => {
    let disposed = false;
    const unlisten: (() => void)[] = [];
    const w = getCurrentWindow();
    const sync = () =>
      w
        .isMaximized()
        .then((m) => !disposed && setMaximized(m))
        .catch(() => undefined);
    sync();
    w.onResized(() => sync())
      .then((u) => (disposed ? u() : unlisten.push(u)))
      .catch(() => undefined);
    w.onFocusChanged(({ payload }) => !disposed && setActive(payload))
      .then((u) => (disposed ? u() : unlisten.push(u)))
      .catch(() => undefined);
    const onFocus = () => setActive(true);
    const onBlur = () => setActive(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return { maximized, active };
}

// ------------------------------------------------------------ close guards

/** Resolves true when it's fine to close (e.g. after "Save changes?"). */
export type CloseGuard = () => Promise<boolean> | boolean;

const closeGuards = new Set<CloseGuard>();

/** Ask every mounted guard; the first "no" keeps the window open. */
export async function canClose(): Promise<boolean> {
  for (const g of [...closeGuards]) {
    if (!(await g())) return false;
  }
  return true;
}

/** Register a guard while the component is mounted (pass null for none). */
export function useCloseGuard(guard: CloseGuard | null) {
  useEffect(() => {
    if (!guard) return;
    closeGuards.add(guard);
    return () => {
      closeGuards.delete(guard);
    };
  }, [guard]);
}

/** A top-level app window: title bar with min/max/close, then content. */
export function AppFrame(props: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  /** Close button handler (defaults to closing the window). */
  onClose?: () => void;
}) {
  const { maximized, active } = useWindowState();

  useEffect(() => {
    document.title = props.title;
    getCurrentWindow()
      .setTitle(props.title)
      .catch(() => undefined);
  }, [props.title]);

  // Alt+F4, the caption X and the taskbar all arrive as close-requested;
  // guards (unsaved Bench edits) get a say before the window goes.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        if (!(await canClose())) e.preventDefault();
      })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const w = () => getCurrentWindow();
  return (
    <div className="w98 w-window w-app" data-maximized={maximized}>
      <TitleBar title={props.title} icon={props.icon} active={active} drag>
        <CaptionButton glyph="min" label="Minimize" onClick={() => void w().minimize().catch(() => undefined)} />
        <CaptionButton
          glyph={maximized ? "restore" : "max"}
          label={maximized ? "Restore" : "Maximize"}
          onClick={() => void w().toggleMaximize().catch(() => undefined)}
        />
        <CaptionButton
          glyph="close"
          label="Close"
          onClick={() => (props.onClose ? props.onClose() : void w().close().catch(() => undefined))}
        />
      </TitleBar>
      {props.children}
    </div>
  );
}
