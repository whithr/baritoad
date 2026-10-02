// Dragging rows between list views (a song into Up next, an entry within it).
// Pointer-driven on purpose: the main window keeps Tauri's dragDropEnabled
// for file drops, and on Windows that leaves HTML5 drag-and-drop dead inside
// the page. A press-and-move past a few pixels starts the drag; a plain click
// never does. Esc cancels. Keyboard users have Q and Alt+↑/↓ for the same.

export interface DragPayload {
  kind: string;
  value: unknown;
  /** What the drag image says (a song's title). */
  label: string;
}

export interface DropTarget {
  el: HTMLElement;
  accepts: (p: DragPayload) => boolean;
  /** `slot` is 0..rows: the insert position, slot k = before row k. */
  onDrop: (p: DragPayload, slot: number) => void;
}

const targets = new Set<DropTarget>();

export function registerDropTarget(t: DropTarget): () => void {
  targets.add(t);
  return () => {
    targets.delete(t);
  };
}

const THRESHOLD_PX = 5;

/** List rows are `display: contents`; their first cell has the geometry. */
function rowCells(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(".w-list-row")]
    .map((r) => r.firstElementChild as HTMLElement | null)
    .filter((c): c is HTMLElement => c != null);
}

/** Where a drop at height `y` would insert: rows whose middle is above it. */
export function slotAt(mids: number[], y: number): number {
  let slot = 0;
  for (const m of mids) if (m < y) slot++;
  return slot;
}

function clearMarks() {
  document.querySelectorAll("[data-drop]").forEach((el) => el.removeAttribute("data-drop"));
}

function mark(list: HTMLElement, slot: number) {
  const rows = [...list.querySelectorAll<HTMLElement>(".w-list-row")];
  if (rows.length === 0) list.setAttribute("data-drop", "into");
  else if (slot < rows.length) rows[slot].setAttribute("data-drop", "before");
  else rows[rows.length - 1].setAttribute("data-drop", "after");
}

/** Call from a row's pointerdown. `payload` is asked once the pointer has
 *  moved far enough; null means this row can't be dragged. */
export function armDrag(e: { button: number; clientX: number; clientY: number }, payload: () => DragPayload | null) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let p: DragPayload | null = null;
  let ghost: HTMLDivElement | null = null;
  let over: { t: DropTarget; slot: number } | null = null;

  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    ghost?.remove();
    clearMarks();
    delete document.documentElement.dataset.dragging;
  };
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD_PX) return;
      p = payload();
      if (!p) return cleanup();
      ghost = document.createElement("div");
      ghost.className = "w-drag-ghost";
      ghost.textContent = p.label;
      document.body.appendChild(ghost);
      document.documentElement.dataset.dragging = "";
      window.getSelection()?.removeAllRanges();
    }
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const t = [...targets].find((t) => hit != null && t.el.contains(hit) && t.accepts(p!)) ?? null;
    clearMarks();
    over = null;
    if (t) {
      const mids = rowCells(t.el).map((c) => {
        const r = c.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      over = { t, slot: slotAt(mids, ev.clientY) };
      mark(t.el, over.slot);
    }
    ghost.dataset.ok = t ? "true" : "false";
  };
  const up = () => {
    const drop = over && p ? { t: over.t, slot: over.slot, p } : null;
    cleanup();
    drop?.t.onDrop(drop.p, drop.slot);
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !ghost) return;
    ev.preventDefault();
    ev.stopPropagation();
    over = null;
    cleanup();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}
