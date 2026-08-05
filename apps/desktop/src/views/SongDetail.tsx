// Song detail stub — shows the finished timing map as a word list with times
// and confidence flags. The word-drag fix editor replaces this in milestone 3.

import { useEffect, useState } from "react";
import { exportSong, readTimingMap, type TimingMap } from "../api";

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

export default function SongDetail({ mapPath, title }: { mapPath: string; title?: string }) {
  const [map, setMap] = useState<TimingMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string[] | null>(null);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const m = await readTimingMap(mapPath);
        if (!disposed) setMap(m);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [mapPath]);

  const doExport = async (formats: string[]) => {
    setExported(null);
    setError(null);
    try {
      setExported(await exportSong({ map_path: mapPath, formats, title }));
    } catch (e) {
      setError(String(e));
    }
  };

  // Group words by lyric line for readable display.
  const lines: { line: number | null; words: TimingMap["words"] }[] = [];
  if (map) {
    for (const w of map.words) {
      const key = w.line ?? null;
      const last = lines[lines.length - 1];
      if (last && last.line === key && key !== null) last.words.push(w);
      else lines.push({ line: key, words: [w] });
    }
  }

  return (
    <div className="page">
      <h1>{title ?? "Song"}</h1>
      {error && <div className="error-banner">{error}</div>}
      {!map && !error && <p className="muted">Loading timing map…</p>}
      {map && (
        <>
          <p className="muted">
            {map.words.length} words · {fmtTime(map.duration)} ·{" "}
            {map.lyric_source === "transcribed" ? "auto-transcribed lyrics" : "pasted lyrics"}
            {map.unsung_spans.length > 0 &&
              ` · ${map.unsung_spans.length} unsung span${map.unsung_spans.length === 1 ? "" : "s"}`}
          </p>
          <div className="actions">
            <button onClick={() => doExport(["lrc"])}>Export LRC</button>
            <button onClick={() => doExport(["ass"])}>Export ASS</button>
            <button onClick={() => doExport(["ultrastar"])}>Export UltraStar</button>
          </div>
          {exported && (
            <p className="muted small">wrote {exported.join(", ")}</p>
          )}
          <p className="muted small">
            Timing fixes (word-drag on the waveform) arrive in a later milestone — this list is
            read-only for now. Times are original-song time.
          </p>
          <div className="word-lines">
            {lines.map((ln, i) => (
              <div className="word-line" key={i}>
                {ln.words.map((w, j) => (
                  <span
                    key={j}
                    className={`word${w.unsung ? " unsung" : ""}${w.ad_lib ? " adlib" : ""}`}
                    title={`${fmtTime(w.start)} – ${fmtTime(w.end)} · confidence ${(w.confidence * 100).toFixed(0)}%${w.anchored ? " · anchored" : ""}`}
                  >
                    <span className="word-text">{w.word}</span>
                    <span className="word-time">{fmtTime(w.start)}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
