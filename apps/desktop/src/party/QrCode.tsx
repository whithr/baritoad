// The party's join QR code: party.rs draws the dark modules as one SVG path;
// here it gets its quiet zone (4 modules of white) and a whole number of
// screen pixels per module, so it stays crisp for a phone camera.

export default function QrCode(props: { qr: { size: number; path: string }; px: number; label?: string }) {
  const n = props.qr.size + 8;
  const scale = Math.max(1, Math.floor(props.px / n));
  return (
    <svg
      viewBox={`-4 -4 ${n} ${n}`}
      width={n * scale}
      height={n * scale}
      shapeRendering="crispEdges"
      role="img"
      aria-label={props.label ?? "QR code to join the party"}
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect x={-4} y={-4} width={n} height={n} fill="#fff" />
      <path d={props.qr.path} fill="#000" />
    </svg>
  );
}
