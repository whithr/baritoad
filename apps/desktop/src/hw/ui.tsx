// The hardware-panel component kit: keycaps, LEDs, LCD readouts, a knob,
// segmented switches, chips, stroke icons. Everything is plain DOM + hw.css;
// no third-party UI in the new chrome.

import {
  useCallback,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------- icons

const PATHS: Record<string, string> = {
  back: '<path d="M9 3 L4 7 L9 11"/>',
  prev: '<path d="M3.5 3v8"/><path d="M11 3.5 L5.5 7 L11 10.5 Z"/>',
  play: '<path d="M4.5 3 L11.5 7 L4.5 11 Z"/>',
  pause: '<path d="M4.5 3v8"/><path d="M9.5 3v8"/>',
  next: '<path d="M10.5 3v8"/><path d="M3 3.5 L8.5 7 L3 10.5 Z"/>',
  ear: '<path d="M3 6 a4 4 0 0 1 8 0 c0 3 -3 3 -3 5.5 a1.5 1.5 0 0 1 -3 0"/><path d="M5.5 6 a1.5 1.5 0 0 1 3 0"/>',
  tv: '<rect x="1.5" y="2.5" width="11" height="7.5" rx="1"/><path d="M5 12.5h4"/>',
  loop: '<path d="M3 5.5 a4 4 0 0 1 8 0 v1.5 M11 8.5 a4 4 0 0 1 -8 0 v-1.5 M1.5 7 l1.5-2 1.5 2 M9.5 7 l1.5 2 1.5-2"/>',
  undo: '<path d="M5 4 L2 7 L5 10"/><path d="M2 7 h6 a3 3 0 0 1 0 6 h-1"/>',
  redo: '<path d="M9 4 L12 7 L9 10"/><path d="M12 7 h-6 a3 3 0 0 0 0 6 h1"/>',
  gear: '<circle cx="7" cy="7" r="2"/><path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2M3.1 3.1l1.4 1.4M9.5 9.5l1.4 1.4M3.1 10.9l1.4-1.4M9.5 4.5l1.4-1.4"/>',
  plus: '<path d="M7 2.5v9M2.5 7h9"/>',
  x: '<path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/>',
  search: '<circle cx="6" cy="6" r="3.5"/><path d="M8.8 8.8L12.5 12.5"/>',
  check: '<path d="M2.5 7.5 L5.5 10.5 L11.5 4"/>',
  up: '<path d="M3 8.5 L7 4.5 L11 8.5"/>',
  down: '<path d="M3 5.5 L7 9.5 L11 5.5"/>',
  folder: '<path d="M1.5 4 h4 l1.5 1.5 h5.5 v6 h-11 z"/>',
  queue: '<path d="M2 3.5h10M2 7h10M2 10.5h6"/><path d="M10 9.5l2 1-2 1z"/>',
  grip: '<circle cx="5" cy="3" r="1"/><circle cx="9" cy="3" r="1"/><circle cx="5" cy="7" r="1"/><circle cx="9" cy="7" r="1"/><circle cx="5" cy="11" r="1"/><circle cx="9" cy="11" r="1"/>',
  trash: '<path d="M2.5 4h9M5.5 4V2.5h3V4M3.5 4l.7 8h5.6l.7-8"/>',
  realign: '<path d="M2 7h4M8 7h4"/><path d="M5 4.5 L7 7 5 9.5M9 4.5 L7 7 9 9.5"/>',
};

export function Icon(props: { name: keyof typeof PATHS | string; size?: number; color?: string }) {
  const s = props.size ?? 14;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 14 14"
      fill="none"
      stroke={props.color ?? "currentColor"}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: PATHS[props.name] ?? "" }}
    />
  );
}

// ---------------------------------------------------------------- keycap

export interface KeyProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: string;
  on?: boolean;
  accent?: boolean;
  danger?: boolean;
  small?: boolean;
  /** Shortcut hint shown as a tiny key glyph. */
  kb?: string;
}

export function Key({ icon, on, accent, danger, small, kb, className, children, ...rest }: KeyProps) {
  const cls = [
    "hw-key",
    icon && !children ? "icon" : "",
    on ? "on" : "",
    accent ? "accent" : "",
    danger ? "danger" : "",
    small ? "sm" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
      {kb && <Kb>{kb}</Kb>}
    </button>
  );
}

export function Kb(props: { children: ReactNode }) {
  return <span className="hw-kb">{props.children}</span>;
}

export function Label(props: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <span className={`hw-label ${props.className ?? ""}`} style={props.style}>
      {props.children}
    </span>
  );
}

export function Led(props: { on?: boolean; color?: "orange" | "yellow" | "green" }) {
  const cls = ["hw-led", props.on ? "on" : "", props.on && props.color ? props.color : ""]
    .filter(Boolean)
    .join(" ");
  return <span className={cls} aria-hidden />;
}

export function Lcd(props: { children: ReactNode; small?: boolean; style?: CSSProperties; title?: string }) {
  return (
    <span className={`hw-lcd${props.small ? " sm" : ""}`} style={props.style} title={props.title}>
      {props.children}
    </span>
  );
}

export function Seg<T extends string>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="hw-seg" role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? "on" : ""}
          onClick={() => props.onChange(o.value)}
        >
          <Led on={o.value === props.value} />
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip(props: { on?: boolean; k?: string; onClick?: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      className={`hw-chip${props.on ? " on" : ""}`}
      onClick={props.onClick}
      aria-pressed={props.on}
      title={props.title}
    >
      {props.children}
      {props.k && <span className="k">{props.k}</span>}
    </button>
  );
}

export function Toggle(props: { on: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <button
      type="button"
      className={`hw-toggle${props.on ? " on" : ""}`}
      role="switch"
      aria-checked={props.on}
      onClick={() => props.onChange(!props.on)}
    >
      <span className="track">
        <i />
      </span>
      {props.label}
    </button>
  );
}

/** A rotary knob: drag vertically (or use arrow keys) to change 0..1. */
export function Knob(props: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  readout: string;
  size?: number;
}) {
  const size = props.size ?? 24;
  const r = size / 2;
  const angle = -135 + props.value * 270;
  const a = ((angle - 90) * Math.PI) / 180;
  const x2 = r + Math.cos(a) * (r - 5);
  const y2 = r + Math.sin(a) * (r - 5);
  const drag = useRef<{ y: number; v: number } | null>(null);
  const onDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      drag.current = { y: e.clientY, v: props.value };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [props.value],
  );
  const onMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (!drag.current) return;
      const dv = (drag.current.y - e.clientY) / 120;
      props.onChange(Math.min(1, Math.max(0, drag.current.v + dv)));
    },
    [props],
  );
  const onUp = useCallback(() => {
    drag.current = null;
  }, []);
  return (
    <div className="hw-knob">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="slider"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Math.round(props.value * 100) / 100}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowRight") {
            props.onChange(Math.min(1, props.value + 0.05));
            e.preventDefault();
          } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
            props.onChange(Math.max(0, props.value - 0.05));
            e.preventDefault();
          }
        }}
      >
        <circle cx={r} cy={r} r={r - 1} fill="var(--hw-key)" stroke="var(--hw-line-strong)" />
        <path d={`M${r} ${r} L${x2.toFixed(1)} ${y2.toFixed(1)}`} stroke="var(--hw-ink)" strokeWidth={2} strokeLinecap="round" />
      </svg>
      <div className="readout">
        <Label>{props.label}</Label>
        <span className="value">{props.readout}</span>
      </div>
    </div>
  );
}

export function Legend(props: { items: [string, string][] }) {
  return (
    <div className="hw-legend">
      {props.items.map(([k, v]) => (
        <div key={k + v}>
          <Kb>{k}</Kb>
          {v}
        </div>
      ))}
    </div>
  );
}

export function Divider() {
  return <span className="hw-divider" />;
}

export function fmtClock(s: number, tenths = true): { main: string; frac: string } {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const frac = Math.floor((t - Math.floor(t)) * 10);
  return {
    main: `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`,
    frac: tenths ? `.${frac}` : "",
  };
}
