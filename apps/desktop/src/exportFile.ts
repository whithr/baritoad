// Export with Save As (Song › Export in the Library, File › Export in the
// Bench): pick where the file goes, write it, then offer to show it.

import { save } from "@tauri-apps/plugin-dialog";
import { exportSong, revealPath } from "./api";
import type { useMessageBox } from "./win98";

export const EXPORTS: [format: string, label: string][] = [
  ["lrc", "&LRC lyrics"],
  ["ass", "&ASS subtitles"],
  ["ultrastar", "&UltraStar .txt"],
];

const EXT: Record<string, { ext: string; name: string }> = {
  lrc: { ext: "lrc", name: "LRC lyrics" },
  ass: { ext: "ass", name: "ASS subtitles" },
  ultrastar: { ext: "txt", name: "UltraStar song" },
};

/** A file name from a song title: no characters Windows refuses. */
export function exportFileName(title: string, format: string): string {
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "song";
  return `${base}.${EXT[format]?.ext ?? format}`;
}

/** The folder a path is in ("C:\\music\\a.mp3" → "C:\\music"). */
export function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}

/** Ask where, export there, and offer Show in folder. Returns the path
 *  written, or null when the person cancelled. */
export async function exportWithSaveAs(
  ask: ReturnType<typeof useMessageBox>,
  opts: { mapPath: string; format: string; title: string; artist?: string | null; nextTo: string },
): Promise<string | null> {
  const kind = EXT[opts.format];
  const sep = opts.nextTo.includes("\\") ? "\\" : "/";
  const target = await save({
    title: `Export ${kind?.name ?? opts.format}`,
    defaultPath: `${opts.nextTo}${sep}${exportFileName(opts.title, opts.format)}`,
    filters: kind ? [{ name: kind.name, extensions: [kind.ext] }] : undefined,
  });
  if (!target) return null;
  const [written] = await exportSong({
    map_path: opts.mapPath,
    formats: [opts.format],
    title: opts.title,
    artist: opts.artist ?? undefined,
    out_path: target,
  });
  const r = await ask({
    kind: "info",
    title: "Export",
    message: "Exported.",
    detail: written,
    buttons: [
      { id: "show", label: "Show in &folder" },
      { id: "ok", label: "OK", isDefault: true, cancel: true },
    ],
  });
  if (r === "show") await revealPath(written).catch(() => undefined);
  return written;
}
