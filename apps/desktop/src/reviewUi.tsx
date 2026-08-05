// Small shared pieces of the review screen (SongDetail + FixEditor) — kept
// out of both view modules so they don't import each other.

import type { ExportFreshness } from "./editorState";

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

export const EXPORT_FORMATS = ["lrc", "ass", "ultrastar"] as const;

const FORMAT_LABELS: Record<string, string> = {
  lrc: "LRC",
  ass: "ASS",
  ultrastar: "UltraStar",
};

/** Export button with a freshness badge: "current" when the file on disk was
 *  rendered from the map on disk, "stale" when the map moved on. */
export function ExportButton(props: {
  format: string;
  freshness: ExportFreshness;
  onClick: () => void;
  disabled?: boolean;
}) {
  const { format, freshness } = props;
  return (
    <button onClick={props.onClick} className="export-btn" disabled={props.disabled}>
      Export {FORMAT_LABELS[format] ?? format}
      {freshness === "fresh" && <span className="badge fresh">current</span>}
      {freshness === "stale" && (
        <span
          className="badge stale"
          title="The timing map changed after this export — re-export to update it"
        >
          stale
        </span>
      )}
    </button>
  );
}
