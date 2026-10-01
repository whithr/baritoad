// Import Songs: the review step of a bulk import. The folder scan (File ›
// Import Folder…, or a folder / several files dropped on the Library) has
// already paired each song with its lyrics; this list shows what will happen
// to every song before anything runs — which lyrics it brings, the
// collection its folder names, whether the library has it already — and
// queues the checked ones in one go.

import { useEffect, useMemo, useState } from "react";
import { importSongs, type ImportCandidate, type ImportQueued, type ImportScan } from "../api";
import { useSettings } from "../App";
import {
  commonFolder,
  defaultChecked,
  hasLyrics,
  importItems,
  importSummary,
  lyricsLabel,
  summaryText,
} from "../importState";
import { Button, Checkbox, Dialog, DialogButtons, Glyph, Icon, ListView, type MenuEntry } from "../win98";

export default function ImportDialog(props: {
  scan: ImportScan | null;
  onClose: () => void;
  onQueued: (result: ImportQueued) => void;
}) {
  const { scan } = props;
  const items = useMemo(() => scan?.items ?? [], [scan]);
  const { settings, update } = useSettings();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [useCollections, setUseCollections] = useState(true);
  const [hq, setHq] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // fresh review per scan
  useEffect(() => {
    setChecked(defaultChecked(items));
    setSelected(items[0]?.audio_path ?? null);
    setUseCollections(true);
    setHq(false);
    setBusy(false);
    setError(null);
  }, [items]);

  const summary = importSummary(items, checked, useCollections);
  const anyCollections = items.some((i) => i.collection);
  const folder = commonFolder(items);

  const toggle = (path: string | null) => {
    if (!path) return;
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const setAll = (pick: (i: ImportCandidate) => boolean) => setChecked(new Set(items.filter(pick).map((i) => i.audio_path)));

  const doImport = async () => {
    if (summary.count === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importSongs(importItems(items, checked, useCollections), {
        hq_separation: hq,
        cpu_only: settings.importOn === "cpu",
        lookup_lyrics: settings.lookupLyrics,
      });
      props.onQueued(result);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const menu: MenuEntry[] = [
    { label: checked.has(selected ?? "") ? "&Uncheck" : "&Check", accel: "Space", run: () => toggle(selected), disabled: !selected },
    "-",
    { label: "Check &all", run: () => setAll(() => true) },
    { label: "Check only &new songs", run: () => setAll((i) => !i.in_library) },
    { label: "Check songs with &lyrics", run: () => setAll((i) => !i.in_library && hasLyrics(i.lyrics)) },
    { label: "Unchec&k all", run: () => setAll(() => false) },
  ];

  return (
    <Dialog open={!!scan} onClose={() => !busy && props.onClose()} title="Import Songs" width={820}>
      <div className="w-dialog-body" style={{ gap: 8 }}>
        <div style={{ lineHeight: "18px" }}>
          Found <b>{items.length === 1 ? "1 song" : `${items.length} songs`}</b>
          {folder ? (
            <>
              {" "}
              in <b style={{ userSelect: "text" }}>{folder}</b>
            </>
          ) : null}
          . Uncheck any you don't want.
        </div>
        <ListView<ImportCandidate>
          ariaLabel="Songs to import"
          rows={items}
          rowKey={(i) => i.audio_path}
          selected={selected}
          onSelect={(k) => setSelected(k as string)}
          onActivate={(i) => toggle(i.audio_path)}
          contextMenu={menu}
          style={{ height: 320 }}
          onKey={(e) => {
            if (e.key === " ") {
              e.preventDefault();
              toggle(selected);
              return true;
            }
            return false;
          }}
          columns={[
            {
              key: "check",
              label: "",
              width: "28px",
              render: (i) => (
                <span
                  className="w-checkbox"
                  role="checkbox"
                  aria-checked={checked.has(i.audio_path)}
                  aria-label={`Import ${i.title}`}
                  onClick={() => toggle(i.audio_path)}
                  // the row's double-click also toggles — one toggle per click here
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  {checked.has(i.audio_path) && <Glyph name="check" />}
                </span>
              ),
            },
            {
              key: "title",
              label: "Song",
              width: "minmax(140px, 1.3fr)",
              render: (i) => <span style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={i.audio_path}>{i.title}</span>,
            },
            {
              key: "artist",
              label: "Artist",
              width: "minmax(90px, 0.9fr)",
              render: (i) => i.artist ?? <span className="w-muted">Unknown artist</span>,
            },
            {
              key: "lyrics",
              label: "Lyrics",
              width: "minmax(190px, 1.2fr)",
              render: (i) => (
                <span
                  style={{ display: "flex", gap: 5, alignItems: "center", minWidth: 0 }}
                  title={i.lyrics.kind === "unreadable" ? i.lyrics.reason : "path" in i.lyrics ? i.lyrics.path : undefined}
                >
                  <Icon name={hasLyrics(i.lyrics) ? "ready" : "warn"} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{lyricsLabel(i.lyrics)}</span>
                </span>
              ),
            },
            {
              key: "collection",
              label: "Collection",
              width: "minmax(90px, 0.7fr)",
              render: (i) =>
                i.collection && useCollections ? i.collection : <span className="w-muted">—</span>,
            },
            {
              key: "status",
              label: "Status",
              width: "84px",
              render: (i) => (i.in_library ? <span className="w-muted">In library</span> : "New"),
            },
          ]}
          empty="No songs found."
        />
        <div style={{ lineHeight: "18px" }}>{summaryText(summary, settings.lookupLyrics)}</div>
        {scan && scan.unmatched_lyrics.length > 0 && (
          <div className="w-muted" style={{ lineHeight: "16px" }} title={scan.unmatched_lyrics.join("\n")}>
            {scan.unmatched_lyrics.length === 1 ? "1 lyrics file" : `${scan.unmatched_lyrics.length} lyrics files`} didn't
            match a song — name each one like its audio file (Song.mp3 + Song.txt).
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
          {anyCollections && (
            <Checkbox checked={useCollections} onChange={setUseCollections} label="Put songs in &collections named after their folders" />
          )}
          {summary.transcribe > 0 && (
            <Checkbox
              checked={settings.lookupLyrics}
              onChange={(v) => update({ lookupLyrics: v })}
              label="Find missing &lyrics online (LRCLIB) — sends only the title, artist and length"
            />
          )}
          <Checkbox checked={hq} onChange={setHq} label="&High-quality separation (cleaner, about 3× slower)" />
        </div>
        {error && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }} role="alert">
            <Icon name="error" />
            <span style={{ userSelect: "text" }}>{error}</span>
          </div>
        )}
      </div>
      <DialogButtons>
        <Button isDefault onClick={() => void doImport()} disabled={summary.count === 0 || busy}>
          {summary.count === 1 ? "&Import 1 song" : `&Import ${summary.count} songs`}
        </Button>
        <Button onClick={props.onClose} disabled={busy}>
          Cancel
        </Button>
      </DialogButtons>
    </Dialog>
  );
}
