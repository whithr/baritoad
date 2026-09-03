// Small shared pieces of the review screen (SongDetail + FixEditor) — kept
// out of both view modules so they don't import each other.

import type { ExportStatus, PlaybackSources } from "./api";
import { exportFreshness } from "./editorState";
import { DashMenu, DashMenuItem } from "./ui";

// ---------------------------------------------------------------------------
// Sticky listening preferences — what you listen to (source + vocal blend)
// follows you across songs and across the bench/editor surfaces.
// ---------------------------------------------------------------------------

export type SourceKind = "vocals" | "instrumental" | "original";

const SOURCE_KEY = "karascape.listenSource";
const VOCALS_KEY = "karascape.listenVocals";

const isSourceKind = (v: string | null): v is SourceKind =>
  v === "vocals" || v === "instrumental" || v === "original";

/** The saved source when this song has it; otherwise the surface's own
 *  preference order (first available wins). */
export function initialSourceKind(
  sources: PlaybackSources | null,
  fallback: SourceKind[],
): SourceKind {
  const saved = localStorage.getItem(SOURCE_KEY);
  if (isSourceKind(saved) && sources?.[saved]) return saved;
  return fallback.find((k) => sources?.[k]) ?? fallback[fallback.length - 1];
}

export function saveSourceKind(v: SourceKind): void {
  try {
    localStorage.setItem(SOURCE_KEY, v);
  } catch {
    // storage unavailable — the choice still holds for this session
  }
}

/** Saved vocal-blend level, clamped to the slider's 0–100 / step-5 grid. */
export function initialVocalPct(): number {
  const v = Number(localStorage.getItem(VOCALS_KEY));
  return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v / 5) * 5)) : 0;
}

export function saveVocalPct(pct: number): void {
  try {
    localStorage.setItem(VOCALS_KEY, String(pct));
  } catch {
    // storage unavailable — the level still holds for this session
  }
}

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

/**
 * The export control: one membrane key opening a dash popup with a row per
 * format. Freshness rides each row as a badge — "current" when the file on
 * disk was rendered from the map on disk, "stale" when the map moved on —
 * and the trigger carries an amber advisory lamp while any existing export
 * is stale.
 */
export function ExportMenu(props: {
  status: ExportStatus | null;
  /** Unsaved editor changes: even hash-fresh exports already diverge. */
  dirty?: boolean;
  onExport: (format: string) => void;
  disabled?: boolean;
}) {
  const freshnessOf = (f: string) =>
    props.status ? exportFreshness(props.status, f, props.dirty ?? false) : "none";
  const anyStale = EXPORT_FORMATS.some((f) => freshnessOf(f) === "stale");
  return (
    <DashMenu
      triggerClassName="export-trigger"
      triggerTitle="Write this song's timing to karaoke formats"
      trigger={
        <>
          Export
          {anyStale && (
            <span
              className="export-lamp"
              title="An exported file is older than the timing map"
            />
          )}
          <span className="dash-select-caret" aria-hidden />
        </>
      }
    >
      {EXPORT_FORMATS.map((f) => {
        const fresh = freshnessOf(f);
        return (
          <DashMenuItem key={f} onClick={() => props.onExport(f)}>
            <span className="export-item-label">{FORMAT_LABELS[f] ?? f}</span>
            {fresh === "fresh" && <span className="badge fresh">current</span>}
            {fresh === "stale" && <span className="badge stale">stale</span>}
          </DashMenuItem>
        );
      })}
    </DashMenu>
  );
}
