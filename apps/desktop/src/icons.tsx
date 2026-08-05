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

export function IconGear(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="5.5" y="5.5" width="5" height="5" />
      <path d="M8 1.5 V3.5 M8 12.5 V14.5 M1.5 8 H3.5 M12.5 8 H14.5 M3.4 3.4 L4.8 4.8 M11.2 11.2 L12.6 12.6 M12.6 3.4 L11.2 4.8 M4.8 11.2 L3.4 12.6" />
    </Base>
  );
}

export function IconNote(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M6 12.5 V3.5 L13 2 V11" />
      <rect x="2.8" y="10.7" width="3.2" height="3" fill="currentColor" stroke="none" />
      <rect x="9.8" y="9.2" width="3.2" height="3" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function IconQueue(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M2.5 3.5 H10" />
      <path d="M2.5 8 H10" />
      <path d="M2.5 12.5 H7" />
      <path d="M10.5 8.5 L14.5 11 L10.5 13.5 Z" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function IconLibrary(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="2" y="2.5" width="3.2" height="11" />
      <rect x="7" y="2.5" width="3.2" height="11" />
      <path d="M11.6 3.2 L14.4 13.2" />
    </Base>
  );
}

export function IconJobs(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="2.5" y="9" width="2.4" height="4.5" fill="currentColor" stroke="none" />
      <rect x="6.8" y="5.5" width="2.4" height="8" fill="currentColor" stroke="none" />
      <rect x="11.1" y="2.5" width="2.4" height="11" fill="currentColor" stroke="none" />
    </Base>
  );
}
