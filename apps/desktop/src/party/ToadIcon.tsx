// A guest's toad in the app — crisp squares at a whole-pixel scale (see
// toads.ts). `full` draws the 16×20 figure with its hat; lists use the
// 16×16 face so it fits a row.

import { useMemo } from "react";
import { toadRects, toadLabel, type Toad } from "./toads";

export default function ToadIcon(props: { toad: Toad; scale?: number; full?: boolean }) {
  const scale = Math.max(1, Math.round(props.scale ?? 1));
  const full = props.full ?? false;
  const top = full ? -4 : 0;
  const h = full ? 20 : 16;
  const rects = useMemo(() => toadRects(props.toad).filter((r) => r.y >= top && r.y < top + h), [props.toad, top, h]);
  return (
    <svg
      viewBox={`0 ${top} 16 ${h}`}
      width={16 * scale}
      height={h * scale}
      shapeRendering="crispEdges"
      role="img"
      aria-label={toadLabel(props.toad)}
      style={{ flexShrink: 0, imageRendering: "pixelated" }}
    >
      {rects.map((r) => (
        <rect key={`${r.x},${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}
