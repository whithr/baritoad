// List view (report mode) and tree view. Both are single-select, keep
// selection on the focused container (aria-activedescendant), and follow the
// 98 keyboard model: arrows/Home/End/PgUp/PgDn move, Enter activates,
// Shift+F10 or the Menu key opens the row's context menu. The list can show
// group header rows (rows arrive sorted by group); tree branches collapse
// with the [+]/[-] box, ←/→ or a double-click.

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { armDrag, registerDropTarget, type DragPayload } from "./drag";
import { ContextMenu, type MenuEntry } from "./menus";

// -------------------------------------------------------------- list view

export interface Column<T> {
  key: string;
  label: string;
  /** CSS grid track, e.g. "minmax(0, 1.5fr)" or "72px". */
  width: string;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  align?: "right";
}

export type SortDir = "asc" | "desc";

export function ListView<T>(props: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  selected: string | number | null;
  onSelect: (key: string | number, row: T) => void;
  onActivate?: (row: T) => void;
  /** Extra keys on the focused list (Q, Delete…); return true if handled. */
  onKey?: (e: KeyboardEvent<HTMLDivElement>, row: T | null) => boolean;
  sort?: { key: string; dir: SortDir } | null;
  onSort?: (key: string) => void;
  rowDim?: (row: T) => boolean;
  contextMenu?: MenuEntry[];
  empty?: ReactNode;
  ariaLabel: string;
  style?: React.CSSProperties;
  listRef?: React.Ref<HTMLDivElement>;
  /** Group header label for a row; rows must arrive sorted so each group is
   *  contiguous. A header row (label and count) opens every group. */
  groupOf?: (row: T) => string;
  /** Rows can be dragged (drag.ts); null = this row can't. */
  dragRow?: (row: T) => DragPayload | null;
  /** The list takes drops; `slot` is the insert position among its rows. */
  drop?: { accepts: (p: DragPayload) => boolean; onDrop: (p: DragPayload, slot: number) => void };
}) {
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { listRef } = props;
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      if (typeof listRef === "function") listRef(el);
      else if (listRef) (listRef as MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [listRef],
  );
  const dropRef = useRef(props.drop);
  dropRef.current = props.drop;
  const droppable = !!props.drop;
  useEffect(() => {
    if (!droppable || !rootRef.current) return;
    return registerDropTarget({
      el: rootRef.current,
      accepts: (p) => dropRef.current?.accepts(p) ?? false,
      onDrop: (p, slot) => dropRef.current?.onDrop(p, slot),
    });
  }, [droppable]);
  const idx = props.rows.findIndex((r) => props.rowKey(r) === props.selected);
  const rowId = (k: string | number) => `${id}-r-${k}`;

  useEffect(() => {
    if (props.selected == null) return;
    const el = document.getElementById(rowId(props.selected))?.firstElementChild as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [props.selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (to: number) => {
    if (props.rows.length === 0) return;
    const i = Math.max(0, Math.min(props.rows.length - 1, to));
    const r = props.rows[i];
    props.onSelect(props.rowKey(r), r);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = idx >= 0 ? props.rows[idx] : null;
    if (props.onKey?.(e, row)) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 220) / 22) - 1);
    switch (e.key) {
      case "ArrowDown":
        move(idx < 0 ? 0 : idx + 1);
        break;
      case "ArrowUp":
        move(idx < 0 ? 0 : idx - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(props.rows.length - 1);
        break;
      case "PageDown":
        move((idx < 0 ? 0 : idx) + page);
        break;
      case "PageUp":
        move((idx < 0 ? 0 : idx) - page);
        break;
      case "Enter":
        if (row) props.onActivate?.(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const grid = props.columns.map((c) => c.width).join(" ");
  const groupCounts = props.groupOf
    ? props.rows.reduce((m, r) => {
        const g = props.groupOf!(r);
        return m.set(g, (m.get(g) ?? 0) + 1);
      }, new Map<string, number>())
    : null;
  const body = (
    <div
      ref={setRoot}
      className="w-list"
      role="grid"
      aria-label={props.ariaLabel}
      aria-rowcount={props.rows.length + 1}
      aria-activedescendant={props.selected != null && idx >= 0 ? rowId(props.selected) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={props.style}
    >
      <div className="w-list-scroll" ref={scrollRef}>
        <div className="w-list-grid" style={{ gridTemplateColumns: grid }}>
          <div className="w-list-head" role="row">
            {props.columns.map((c) => {
              const sorted = props.sort?.key === c.key ? props.sort.dir : null;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="columnheader"
                  tabIndex={-1}
                  className="w-list-hcell"
                  aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                  onClick={c.sortable && props.onSort ? () => props.onSort!(c.key) : undefined}
                  style={{ justifyContent: c.align === "right" ? "flex-end" : undefined }}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          {props.rows.map((r, i) => {
            const k = props.rowKey(r);
            const sel = k === props.selected;
            const group = props.groupOf?.(r);
            const opensGroup = group != null && (i === 0 || props.groupOf!(props.rows[i - 1]) !== group);
            return (
              <div key={k} style={{ display: "contents" }}>
              {opensGroup && (
                <div className="w-list-group-row" role="row">
                  <div className="w-list-group" role="gridcell" aria-colspan={props.columns.length} style={{ gridColumn: "1 / -1" }}>
                    {group}
                    <span className="w-list-group-count">({groupCounts?.get(group) ?? 0})</span>
                  </div>
                </div>
              )}
              <div
                id={rowId(k)}
                className="w-list-row"
                role="row"
                aria-selected={sel}
                data-cursor={sel || undefined}
                data-dim={props.rowDim?.(r) || undefined}
                onMouseDown={() => props.onSelect(k, r)}
                onPointerDown={props.dragRow ? (e) => armDrag(e, () => props.dragRow!(r)) : undefined}
                onContextMenu={() => props.onSelect(k, r)}
                onDoubleClick={() => props.onActivate?.(r)}
              >
                {props.columns.map((c) => (
                  <div
                    key={c.key}
                    className="w-list-cell"
                    role="gridcell"
                    style={{ justifyContent: c.align === "right" ? "flex-end" : undefined }}
                  >
                    {c.render(r)}
                  </div>
                ))}
              </div>
              </div>
            );
          })}
        </div>
        {props.rows.length === 0 && props.empty && <div className="w-list-empty">{props.empty}</div>}
      </div>
    </div>
  );

  return props.contextMenu ? (
    <ContextMenu items={props.contextMenu} style={{ display: "flex", flexDirection: "column", minHeight: 0, flexGrow: 1 }}>
      {body}
    </ContextMenu>
  ) : (
    body
  );
}

// -------------------------------------------------------------- tree view

export interface TreeNode {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  children?: TreeNode[];
  /** Extra space above this top-level node. */
  gap?: boolean;
  /** Starts collapsed the first time the node appears. */
  collapsed?: boolean;
}

const hasKids = (n: TreeNode) => !!n.children && n.children.length > 0;

/** Visible rows in order (children of closed nodes skipped), with parents. */
function flat(
  nodes: TreeNode[],
  closed: Set<string>,
  level = 1,
  parent: string | null = null,
  out: { node: TreeNode; level: number; parent: string | null }[] = [],
) {
  for (const n of nodes) {
    out.push({ node: n, level, parent });
    if (hasKids(n) && !closed.has(n.id)) flat(n.children!, closed, level + 1, n.id, out);
  }
  return out;
}

function contains(n: TreeNode, id: string): boolean {
  return !!n.children?.some((c) => c.id === id || contains(c, id));
}

/** The 9-px [+]/[-] box, drawn as crisp rects. */
function Expander(props: { open: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
      <rect x="0.5" y="0.5" width="8" height="8" fill="var(--w-window)" stroke="var(--w-shadow)" />
      <rect x="2" y="4" width="5" height="1" fill="var(--w-text)" />
      {!props.open && <rect x="4" y="2" width="1" height="5" fill="var(--w-text)" />}
    </svg>
  );
}

export function TreeView(props: {
  nodes: TreeNode[];
  selected: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
  onKey?: (e: KeyboardEvent<HTMLDivElement>, id: string) => boolean;
  contextMenu?: MenuEntry[];
  style?: React.CSSProperties;
}) {
  const id = useId();
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const seen = useRef(new Set<string>());
  // Nodes marked `collapsed` start closed the first time they appear (a
  // browse branch that fills in later still starts tidy).
  useEffect(() => {
    const fresh: string[] = [];
    const visit = (ns: TreeNode[]) =>
      ns.forEach((n) => {
        if (!seen.current.has(n.id)) {
          seen.current.add(n.id);
          if (n.collapsed) fresh.push(n.id);
        }
        if (n.children) visit(n.children);
      });
    visit(props.nodes);
    if (fresh.length) setClosed((c) => new Set([...c, ...fresh]));
  }, [props.nodes]);

  const all = flat(props.nodes, closed);
  const idx = all.findIndex((n) => n.node.id === props.selected);
  const nodeId = (k: string) => `${id}-n-${k}`;

  const setOpen = (n: TreeNode, open: boolean) => {
    setClosed((c) => {
      const next = new Set(c);
      if (open) next.delete(n.id);
      else next.add(n.id);
      return next;
    });
    // Folding away the selected node selects the branch, as Explorer does.
    if (!open && contains(n, props.selected)) props.onSelect(n.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (props.onKey?.(e, props.selected)) return;
    const cur = idx >= 0 ? all[idx] : null;
    let to = -1;
    if (e.key === "ArrowDown") to = Math.min(all.length - 1, idx + 1);
    else if (e.key === "ArrowUp") to = Math.max(0, idx - 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = all.length - 1;
    else if (e.key === "ArrowRight" && cur && hasKids(cur.node)) {
      if (closed.has(cur.node.id)) setOpen(cur.node, true);
      else to = idx + 1;
    } else if (e.key === "ArrowLeft" && cur) {
      if (hasKids(cur.node) && !closed.has(cur.node.id)) setOpen(cur.node, false);
      else if (cur.parent) to = all.findIndex((n) => n.node.id === cur.parent);
    } else if ((e.key === "+" || e.key === "-") && cur && hasKids(cur.node)) {
      setOpen(cur.node, e.key === "+");
    } else return;
    e.preventDefault();
    if (to >= 0 && all[to]) props.onSelect(all[to].node.id);
  };

  const renderNodes = (nodes: TreeNode[], level: number): ReactNode =>
    nodes.map((n) => (
      <div key={n.id} role="none">
        <div
          id={nodeId(n.id)}
          className={`w-tree-row${n.gap ? " gap" : ""}`}
          role="treeitem"
          aria-level={level}
          aria-selected={n.id === props.selected}
          aria-expanded={hasKids(n) ? !closed.has(n.id) : undefined}
          onMouseDown={() => props.onSelect(n.id)}
          onContextMenu={() => props.onSelect(n.id)}
          onDoubleClick={() => hasKids(n) && setOpen(n, closed.has(n.id))}
        >
          {hasKids(n) && (
            <span
              className="w-tree-exp"
              onMouseDown={(e) => {
                e.stopPropagation();
                setOpen(n, closed.has(n.id));
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Expander open={!closed.has(n.id)} />
            </span>
          )}
          {n.icon}
          <span className="w-tree-label">{n.label}</span>
        </div>
        {hasKids(n) && !closed.has(n.id) && (
          <div className="w-tree-kids" role="group">
            {renderNodes(n.children!, level + 1)}
          </div>
        )}
      </div>
    ));

  const body = (
    <div
      className="w-tree"
      role="tree"
      aria-label={props.ariaLabel}
      aria-activedescendant={idx >= 0 ? nodeId(props.selected) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={props.contextMenu ? { flexGrow: 1, minHeight: 0 } : props.style}
    >
      {renderNodes(props.nodes, 1)}
    </div>
  );

  return props.contextMenu ? (
    <ContextMenu items={props.contextMenu} style={{ display: "flex", flexDirection: "column", minHeight: 0, ...props.style }}>
      {body}
    </ContextMenu>
  ) : (
    body
  );
}
