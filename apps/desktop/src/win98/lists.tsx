// List view (report mode) and tree view. Both are single-select, keep
// selection on the focused container (aria-activedescendant), and follow the
// 98 keyboard model: arrows/Home/End/PgUp/PgDn move, Enter activates,
// Shift+F10 or the Menu key opens the row's context menu.

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
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
}) {
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const body = (
    <div
      ref={props.listRef}
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
          {props.rows.map((r) => {
            const k = props.rowKey(r);
            const sel = k === props.selected;
            return (
              <div
                key={k}
                id={rowId(k)}
                className="w-list-row"
                role="row"
                aria-selected={sel}
                data-cursor={sel || undefined}
                data-dim={props.rowDim?.(r) || undefined}
                onMouseDown={() => props.onSelect(k, r)}
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
}

function flat(nodes: TreeNode[], level = 1, out: { node: TreeNode; level: number }[] = []) {
  for (const n of nodes) {
    out.push({ node: n, level });
    if (n.children) flat(n.children, level + 1, out);
  }
  return out;
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
  const all = flat(props.nodes);
  const idx = all.findIndex((n) => n.node.id === props.selected);
  const nodeId = (k: string) => `${id}-n-${k}`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (props.onKey?.(e, props.selected)) return;
    let to = -1;
    if (e.key === "ArrowDown") to = Math.min(all.length - 1, idx + 1);
    else if (e.key === "ArrowUp") to = Math.max(0, idx - 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = all.length - 1;
    else return;
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
          aria-expanded={n.children ? true : undefined}
          onMouseDown={() => props.onSelect(n.id)}
          onContextMenu={() => props.onSelect(n.id)}
        >
          {n.icon}
          <span className="w-tree-label">{n.label}</span>
        </div>
        {n.children && n.children.length > 0 && (
          <div className="w-tree-kids" role="group">
            {renderNodes(n.children, level + 1)}
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
      style={props.style}
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
