// Karascape 98 icons — in-house pixel art (no Microsoft assets, DESIGN.md).
// Two families:
//   Glyph — tiny one-colour marks for caption buttons, arrows, transport and
//           menu checks; drawn in currentColor so schemes recolour them.
//   Icon  — 16-px colour pictograms, shown at 1× or 2× (size 16 | 32).

import type { ReactNode } from "react";

// ---------------------------------------------------------------- glyphs

const GLYPHS: Record<string, { w: number; h: number; body: ReactNode }> = {
  min: { w: 8, h: 7, body: <rect x="1" y="5" width="6" height="2" /> },
  max: { w: 9, h: 9, body: <path d="M0 0h9v9H0zM1 2v6h7V2z" fillRule="evenodd" /> },
  restore: {
    w: 9,
    h: 9,
    body: <path d="M2 0h7v6H7v3H0V3h2zM3 2v1h4v3h1V2zM1 5v3h5V5z" fillRule="evenodd" />,
  },
  close: {
    w: 8,
    h: 7,
    body: (
      <path d="M0 0h2v1H0zM6 0h2v1H6zM1 1h2v1H1zM5 1h2v1H5zM2 2h4v1H2zM3 3h2v1H3zM2 4h4v1H2zM1 5h2v1H1zM5 5h2v1H5zM0 6h2v1H0zM6 6h2v1H6z" />
    ),
  },
  help: { w: 6, h: 9, body: <path d="M1 0h4v1H1zM0 1h2v2H0zM4 1h2v3H4zM3 4h2v1H3zM2 5h2v2H2zM2 8h2v1H2z" /> },
  up: { w: 7, h: 4, body: <path d="M3 0h1v1H3zM2 1h3v1H2zM1 2h5v1H1zM0 3h7v1H0z" /> },
  down: { w: 7, h: 4, body: <path d="M0 0h7v1H0zM1 1h5v1H1zM2 2h3v1H2zM3 3h1v1H3z" /> },
  left: { w: 4, h: 7, body: <path d="M3 0h1v7H3zM2 1h1v5H2zM1 2h1v3H1zM0 3h1v1H0z" /> },
  right: { w: 4, h: 7, body: <path d="M0 0h1v7H0zM1 1h1v5H1zM2 2h1v3H2zM3 3h1v1H3z" /> },
  play: { w: 7, h: 9, body: <path d="M0 0h1v9H0zM1 1h1v7H1zM2 2h1v5H2zM3 3h1v3H3zM4 3h1v3H4zM5 4h1v1H5z" /> },
  pause: { w: 8, h: 9, body: <path d="M0 0h3v9H0zM5 0h3v9H5z" /> },
  stop: { w: 8, h: 8, body: <rect width="8" height="8" /> },
  prev: {
    w: 9,
    h: 9,
    body: <path d="M0 0h2v9H0zM8 0h1v9H8zM7 1h1v7H7zM6 2h1v5H6zM5 3h1v3H5zM4 3h1v3H4zM3 4h1v1H3z" />,
  },
  next: {
    w: 9,
    h: 9,
    body: <path d="M7 0h2v9H7zM0 0h1v9H0zM1 1h1v7H1zM2 2h1v5H2zM3 3h1v3H3zM4 3h1v3H4zM5 4h1v1H5z" />,
  },
  check: {
    w: 7,
    h: 7,
    body: <path d="M6 0h1v1H6zM5 1h2v1H5zM0 2h1v1H0zM4 2h3v1H4zM0 3h2v1H0zM3 3h3v1H3zM0 4h5v1H0zM1 5h3v1H1zM2 6h1v1H2z" />,
  },
  bullet: { w: 6, h: 6, body: <path d="M1 0h4v1H1zM0 1h6v4H0zM1 5h4v1H1z" /> },
  ear: {
    w: 8,
    h: 10,
    body: <path d="M2 0h4v1H2zM1 1h1v1H1zM6 1h1v1H6zM0 2h1v3H0zM7 2h1v3H7zM3 3h2v1H3zM2 4h1v1H2zM6 5h1v1H6zM5 6h1v1H5zM4 7h1v2H4zM1 9h3v1H1z" />,
  },
};

export type GlyphName = keyof typeof GLYPHS;

export function Glyph(props: { name: GlyphName; scale?: number }) {
  const g = GLYPHS[props.name];
  const k = props.scale ?? 1;
  return (
    <svg
      width={g.w * k}
      height={g.h * k}
      viewBox={`0 0 ${g.w} ${g.h}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden
    >
      {g.body}
    </svg>
  );
}

// ----------------------------------------------------------------- icons

const DISC = (
  <>
    <circle cx="8" cy="8" r="7" fill="#dfdfdf" stroke="#000" strokeWidth="0.75" />
    <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5H11a3 3 0 0 0-3-3z" fill="#80ffff" />
    <path d="M8 14.5A6.5 6.5 0 0 1 1.5 8H5a3 3 0 0 0 3 3z" fill="#ff80ff" />
    <circle cx="8" cy="8" r="2" fill="#fff" stroke="#808080" strokeWidth="0.75" />
  </>
);

const ICONS: Record<string, { crisp: boolean; body: ReactNode }> = {
  // brand: VU bars rising into a note (the bar-graph note, redrawn in pixels)
  app: {
    crisp: true,
    body: (
      <>
        <rect x="1" y="11" width="2" height="4" fill="#00c000" />
        <rect x="4" y="8" width="2" height="7" fill="#e0e000" />
        <rect x="7" y="5" width="2" height="10" fill="#ff4040" />
        <rect x="12" y="1" width="1" height="11" fill="#ff00ff" />
        <rect x="13" y="2" width="1" height="1" fill="#ff00ff" />
        <rect x="14" y="3" width="1" height="3" fill="#ff00ff" />
        <rect x="10" y="10" width="3" height="1" fill="#ff00ff" />
        <rect x="9" y="11" width="4" height="2" fill="#ff00ff" />
        <rect x="9" y="13" width="3" height="1" fill="#ff00ff" />
      </>
    ),
  },
  disc: { crisp: false, body: DISC },
  folder: {
    crisp: true,
    body: (
      <>
        <rect x="1" y="2" width="6" height="2" fill="#000" />
        <rect x="2" y="3" width="4" height="1" fill="#ffff80" />
        <rect x="0" y="4" width="16" height="11" fill="#000" />
        <rect x="1" y="5" width="14" height="9" fill="#ffff00" />
        <rect x="1" y="5" width="14" height="1" fill="#ffff80" />
        <rect x="1" y="12" width="14" height="2" fill="#c0c000" />
      </>
    ),
  },
  tv: {
    crisp: true,
    body: (
      <>
        <rect x="1" y="2" width="14" height="10" fill="#000" />
        <rect x="2" y="3" width="12" height="8" fill="#008080" />
        <rect x="3" y="4" width="4" height="1" fill="#80ffff" />
        <rect x="6" y="12" width="4" height="1" fill="#000" />
        <rect x="4" y="13" width="8" height="2" fill="#808080" />
      </>
    ),
  },
  queue: {
    crisp: true,
    body: (
      <>
        <rect x="2" y="1" width="12" height="14" fill="#000" />
        <rect x="3" y="2" width="10" height="12" fill="#fff" />
        <rect x="4" y="4" width="2" height="1" fill="#000080" />
        <rect x="7" y="4" width="5" height="1" fill="#000" />
        <rect x="4" y="7" width="2" height="1" fill="#000080" />
        <rect x="7" y="7" width="5" height="1" fill="#000" />
        <rect x="4" y="10" width="2" height="1" fill="#000080" />
        <rect x="7" y="10" width="5" height="1" fill="#000" />
      </>
    ),
  },
  timing: {
    crisp: true,
    body: (
      <>
        <rect x="1" y="1" width="14" height="14" fill="#000" />
        <rect x="2" y="2" width="12" height="12" fill="#fff" />
        <rect x="3" y="7" width="1" height="2" fill="#000080" />
        <rect x="5" y="5" width="1" height="6" fill="#000080" />
        <rect x="7" y="3" width="1" height="10" fill="#000080" />
        <rect x="9" y="6" width="1" height="4" fill="#000080" />
        <rect x="11" y="4" width="1" height="8" fill="#000080" />
        <rect x="12" y="7" width="1" height="2" fill="#000080" />
      </>
    ),
  },
  floppy: {
    crisp: true,
    body: (
      <>
        <rect x="1" y="1" width="14" height="14" fill="#000" />
        <rect x="2" y="2" width="12" height="12" fill="#000080" />
        <rect x="4" y="2" width="7" height="4" fill="#c0c0c0" />
        <rect x="8" y="3" width="2" height="2" fill="#000080" />
        <rect x="3" y="8" width="10" height="6" fill="#fff" />
        <rect x="4" y="10" width="8" height="1" fill="#808080" />
      </>
    ),
  },
  gear: {
    crisp: true,
    body: (
      <>
        <rect x="7" y="1" width="2" height="14" fill="#000" />
        <rect x="1" y="7" width="14" height="2" fill="#000" />
        <rect x="2" y="2" width="2" height="2" fill="#000" />
        <rect x="12" y="2" width="2" height="2" fill="#000" />
        <rect x="2" y="12" width="2" height="2" fill="#000" />
        <rect x="12" y="12" width="2" height="2" fill="#000" />
        <rect x="3" y="3" width="10" height="10" fill="#000" />
        <rect x="4" y="4" width="8" height="8" fill="#808080" />
        <rect x="4" y="4" width="8" height="2" fill="#dfdfdf" />
        <rect x="6" y="6" width="4" height="4" fill="#000" />
        <rect x="7" y="7" width="2" height="2" fill="#c0c0c0" />
      </>
    ),
  },
  mic: {
    crisp: true,
    body: (
      <>
        <rect x="6" y="1" width="4" height="1" fill="#000" />
        <rect x="5" y="2" width="6" height="6" fill="#000" />
        <rect x="6" y="2" width="4" height="5" fill="#c0c0c0" />
        <rect x="6" y="3" width="1" height="3" fill="#fff" />
        <rect x="6" y="8" width="4" height="1" fill="#000" />
        <rect x="3" y="6" width="1" height="3" fill="#000" />
        <rect x="12" y="6" width="1" height="3" fill="#000" />
        <rect x="4" y="9" width="8" height="1" fill="#000" />
        <rect x="7" y="10" width="2" height="3" fill="#000" />
        <rect x="4" y="13" width="8" height="2" fill="#000" />
      </>
    ),
  },
  ready: {
    crisp: true,
    body: (
      <path
        d="M12 3h2v2h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v-1H5V9H4V8H3V7h2v1h1v1h1V8h1V7h1V6h1V5h1V4h1z"
        fill="#008000"
      />
    ),
  },
  working: {
    crisp: true,
    body: (
      <>
        <rect x="3" y="1" width="10" height="2" fill="#000" />
        <rect x="3" y="13" width="10" height="2" fill="#000" />
        <rect x="4" y="3" width="8" height="3" fill="#000" />
        <rect x="5" y="3" width="6" height="3" fill="#fff" />
        <rect x="5" y="4" width="6" height="2" fill="#c0c000" />
        <rect x="5" y="6" width="6" height="1" fill="#000" />
        <rect x="6" y="6" width="4" height="1" fill="#c0c000" />
        <rect x="6" y="7" width="4" height="2" fill="#000" />
        <rect x="7" y="7" width="2" height="2" fill="#c0c000" />
        <rect x="5" y="9" width="6" height="1" fill="#000" />
        <rect x="6" y="9" width="4" height="1" fill="#fff" />
        <rect x="4" y="10" width="8" height="3" fill="#000" />
        <rect x="5" y="10" width="6" height="1" fill="#fff" />
        <rect x="5" y="11" width="6" height="2" fill="#c0c000" />
      </>
    ),
  },
  warn: {
    crisp: true,
    body: (
      <>
        <path d="M7 1h2v2h1v3h1v3h1v3h1v2h1v1H1v-1h1v-2h1V9h1V6h1V3h1z" fill="#000" />
        <path d="M7 3h2v3h1v3h1v3h1v2H4v-2h1V9h1V6h1z" fill="#ffff00" />
        <rect x="7" y="5" width="2" height="5" fill="#000" />
        <rect x="7" y="11" width="2" height="2" fill="#000" />
      </>
    ),
  },
  failed: {
    crisp: false,
    body: (
      <>
        <circle cx="8" cy="8" r="7" fill="#ff0000" stroke="#800000" strokeWidth="0.75" />
        <path d="M5 4l3 3 3-3 1 1-3 3 3 3-1 1-3-3-3 3-1-1 3-3-3-3z" fill="#fff" />
      </>
    ),
  },
  lock: {
    crisp: true,
    body: (
      <>
        <rect x="5" y="2" width="6" height="1" fill="#000" />
        <rect x="4" y="3" width="1" height="4" fill="#000" />
        <rect x="11" y="3" width="1" height="4" fill="#000" />
        <rect x="3" y="7" width="10" height="8" fill="#000" />
        <rect x="4" y="8" width="8" height="6" fill="#c0c000" />
        <rect x="4" y="8" width="8" height="1" fill="#ffff80" />
        <rect x="7" y="10" width="2" height="2" fill="#000" />
      </>
    ),
  },
  trash: {
    crisp: true,
    body: (
      <>
        <rect x="5" y="1" width="6" height="1" fill="#000" />
        <rect x="2" y="2" width="12" height="2" fill="#000" />
        <rect x="3" y="4" width="10" height="11" fill="#000" />
        <rect x="4" y="4" width="8" height="10" fill="#c0c0c0" />
        <rect x="5" y="5" width="1" height="8" fill="#808080" />
        <rect x="7" y="5" width="1" height="8" fill="#808080" />
        <rect x="9" y="5" width="1" height="8" fill="#808080" />
        <rect x="4" y="4" width="1" height="10" fill="#fff" />
      </>
    ),
  },
  note: {
    crisp: true,
    body: (
      <>
        <rect x="9" y="1" width="1" height="10" fill="#800080" />
        <rect x="10" y="2" width="2" height="1" fill="#800080" />
        <rect x="12" y="3" width="1" height="2" fill="#800080" />
        <rect x="6" y="10" width="4" height="3" fill="#800080" />
      </>
    ),
  },
  palette: {
    crisp: false,
    body: (
      <>
        <path d="M8 1.5C4 1.5 1.5 4.2 1.5 7.5s2.6 6 5.6 6c1.2 0 1.4-.9 1-1.7-.5-.9 0-1.8 1.1-1.8h1.6c2.3 0 3.7-1.5 3.7-3.4 0-2.9-2.9-5.1-6.5-5.1z" fill="#dfdfdf" stroke="#000" strokeWidth="0.75" />
        <circle cx="5" cy="6" r="1.3" fill="#ff0000" />
        <circle cx="8" cy="4.3" r="1.3" fill="#ffff00" />
        <circle cx="11" cy="6" r="1.3" fill="#0000ff" />
        <circle cx="4.8" cy="9.6" r="1.3" fill="#008000" />
      </>
    ),
  },
  info: {
    crisp: false,
    body: (
      <>
        <path d="M8 1C4 1 1 3.5 1 7c0 2.5 1.5 4.3 3.5 5.3L3.5 15l3.5-2.3c.3.1.7.1 1 .1 4 0 7-2.5 7-5.8S12 1 8 1z" fill="#fff" stroke="#000" strokeWidth="0.6" />
        <rect x="7" y="3" width="2" height="2" fill="#0000ff" />
        <rect x="7" y="6" width="2" height="5" fill="#0000ff" />
      </>
    ),
  },
  question: {
    crisp: false,
    body: (
      <>
        <path d="M8 1C4 1 1 3.5 1 7c0 2.5 1.5 4.3 3.5 5.3L3.5 15l3.5-2.3c.3.1.7.1 1 .1 4 0 7-2.5 7-5.8S12 1 8 1z" fill="#fff" stroke="#000" strokeWidth="0.6" />
        <path d="M5.5 4.5h1v-1h3v1h1V7h-1v1h-1v1.5h-1V7.5h1v-1h1V4.5h-3v1h-1z" fill="#0000ff" />
        <rect x="7.5" y="10.5" width="1" height="1" fill="#0000ff" />
      </>
    ),
  },
  error: {
    crisp: false,
    body: (
      <>
        <circle cx="8" cy="8" r="7" fill="#ff0000" stroke="#800000" strokeWidth="0.6" />
        <path d="M5 4l3 3 3-3 1 1-3 3 3 3-1 1-3-3-3 3-1-1 3-3-3-3z" fill="#fff" />
      </>
    ),
  },
};

export type IconName = keyof typeof ICONS;

/** Pixel icons are drawn on a 16-px grid; use multiples of 16 to keep them crisp. */
export function Icon(props: { name: IconName; size?: number }) {
  const i = ICONS[props.name];
  const s = props.size ?? 16;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 16 16"
      shapeRendering={i.crisp ? "crispEdges" : undefined}
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      {i.body}
    </svg>
  );
}

/** The trackbar thumb: a raised pointer (11 × 21). */
export function ThumbArt() {
  return (
    <svg width="11" height="21" viewBox="0 0 11 21" aria-hidden>
      <polygon points="0,0 11,0 11,16 5.5,21 0,16" fill="var(--w-dark)" />
      <polygon points="0,0 10,0 10,15.5 5.5,20 0,15.5" fill="var(--w-hi)" />
      <polygon points="1,1 10,1 10,15.5 5.5,20 1,15.5" fill="var(--w-shadow)" />
      <polygon points="1,1 9,1 9,15 5,19 1,15" fill="var(--w-face)" />
    </svg>
  );
}
