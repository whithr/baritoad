// Icon system — one grammar for the whole dash: 16×16 grid, 1.75 stroke,
// square caps and miter joins (angular instrument pictograms, not rounded
// consumer glyphs). Fill is reserved for the two solid transport marks.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconPlay(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4.5 2.5 L13 8 L4.5 13.5 Z" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function IconPause(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="3.5" y="2.5" width="3" height="11" fill="currentColor" stroke="none" />
      <rect x="9.5" y="2.5" width="3" height="11" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function IconBack(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M10.5 2.5 L5 8 L10.5 13.5" />
    </Base>
  );
}

export function IconExpand(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M9.5 2.5 h4 v4" />
      <path d="M6.5 13.5 h-4 v-4" />
      <path d="M13.5 2.5 L9.75 6.25" />
      <path d="M2.5 13.5 L6.25 9.75" />
    </Base>
  );
}

export function IconCompress(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M13.5 6.5 h-4 v-4" />
      <path d="M2.5 9.5 h4 v4" />
      <path d="M9.5 6.5 L13.25 2.75" />
      <path d="M6.5 9.5 L2.75 13.25" />
    </Base>
  );
}

export function IconDots(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="1.5" y="7" width="2.4" height="2.4" fill="currentColor" stroke="none" />
      <rect x="6.8" y="7" width="2.4" height="2.4" fill="currentColor" stroke="none" />
      <rect x="12.1" y="7" width="2.4" height="2.4" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function IconX(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" />
    </Base>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M2.5 8.5 L6.5 12.5 L13.5 4" />
    </Base>
  );
}

export function IconPencil(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M3 13 L3.6 10.2 L11 2.8 L13.2 5 L5.8 12.4 Z" />
    </Base>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M8 2.5 V13.5 M2.5 8 H13.5" />
    </Base>
  );
}

export function IconGrip(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="4" y="2.5" width="2.2" height="2.2" fill="currentColor" stroke="none" />
      <rect x="9.8" y="2.5" width="2.2" height="2.2" fill="currentColor" stroke="none" />
      <rect x="4" y="6.9" width="2.2" height="2.2" fill="currentColor" stroke="none" />
      <rect x="9.8" y="6.9" width="2.2" height="2.2" fill="currentColor" stroke="none" />
      <rect x="4" y="11.3" width="2.2" height="2.2" fill="currentColor" stroke="none" />
      <rect x="9.8" y="11.3" width="2.2" height="2.2" fill="currentColor" stroke="none" />
    </Base>
  );
}

// Machined adjuster screw: chamfered-octagon head + diagonal slot.
export function IconGear(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M5.7 2.5 H10.3 L13.5 5.7 V10.3 L10.3 13.5 H5.7 L2.5 10.3 V5.7 Z" />
      <path d="M5.9 10.1 L10.1 5.9" />
    </Base>
  );
}

// The brand mark: an eighth note whose body is ascending VU bars — the
// tallest bar is the stem, carrying an angular flag. Reads as a note at a
// glance, as a segmented meter up close (the app's own instrument grammar).
export function IconBrandNote(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="2" y="11.6" width="2.6" height="2.4" fill="currentColor" stroke="none" />
      <rect x="2" y="8.4" width="2.6" height="2.4" fill="currentColor" stroke="none" />
      <rect x="6" y="11.6" width="2.6" height="2.4" fill="currentColor" stroke="none" />
      <rect x="6" y="8.4" width="2.6" height="2.4" fill="currentColor" stroke="none" />
      <rect x="6" y="5.2" width="2.6" height="2.4" fill="currentColor" stroke="none" />
      <rect x="10" y="2" width="2.6" height="12" fill="currentColor" stroke="none" />
      <path d="M12.6 2 L15.4 4.8 V8.2 L12.6 5.4 Z" fill="currentColor" stroke="none" />
    </Base>
  );
}

// 32-grid variant for large renders (library empty state at 56px) — the
// 16-grid mark's 0.8px segment gaps blur when upscaled.
export function IconBrandNoteLarge({ size = 32, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      aria-hidden
      focusable="false"
      {...rest}
    >
      <rect x="4" y="25" width="5" height="3" />
      <rect x="4" y="20.5" width="5" height="3" />
      <rect x="4" y="16" width="5" height="3" />
      <rect x="12" y="25" width="5" height="3" />
      <rect x="12" y="20.5" width="5" height="3" />
      <rect x="12" y="16" width="5" height="3" />
      <rect x="12" y="11.5" width="5" height="3" />
      <rect x="20" y="4" width="5" height="24" />
      <path d="M25 4 L31 10 V16 L25 10 Z" />
    </svg>
  );
}

// New Song: a cartridge (song-card chamfer notch) taking a plus — its own
// icon, so the brand mark stays unique to the brand.
export function IconCartridgeNew(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M2 5 H9 L12.5 8.5 V13.5 H2 Z" />
      <path d="M4.5 11 H8" />
      <path d="M12.75 2.25 V6.25 M10.75 4.25 H14.75" />
    </Base>
  );
}

// Run order: lamped rows, the solid play wedge sitting on who's next.
export function IconQueue(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="2" y="2.6" width="2.2" height="2.2" fill="currentColor" stroke="none" />
      <path d="M6.2 3.7 H10.2" />
      <path d="M11.2 2.1 L14.4 3.7 L11.2 5.3 Z" fill="currentColor" stroke="none" />
      <rect x="2" y="6.9" width="2.2" height="2.2" fill="currentColor" stroke="none" />
      <path d="M6.2 8 H14.4" />
      <rect x="2" y="11.2" width="2.2" height="2.2" fill="currentColor" stroke="none" />
      <path d="M6.2 12.3 H14.4" />
    </Base>
  );
}

// Cartridge rack: one seated, one half-ejected, both chamfer-notched.
export function IconLibrary(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M2.5 6.5 H5.2 L6.5 7.8 V13.5 H2.5 Z" />
      <path d="M9.5 2.5 H12.2 L13.5 3.8 V13.5 H9.5 Z" />
      <path d="M1.5 13.5 H14.5" />
    </Base>
  );
}

// In-progress meters (horizontal — the vertical bars now belong to the
// brand mark).
export function IconJobs(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="2" y="3" width="11.5" height="2.6" fill="currentColor" stroke="none" />
      <rect x="2" y="6.7" width="7.5" height="2.6" fill="currentColor" stroke="none" />
      <rect x="2" y="10.4" width="4" height="2.6" fill="currentColor" stroke="none" />
    </Base>
  );
}
