// Add from URL: paste links — a song, a video, a whole playlist — check what
// they point at, review the list, then queue them. Each song downloads to this
// computer with yt-dlp, finds its lyrics on LRCLIB when asked, and imports
// like any other song (PLAN.md §3 Add from URL, §5). Nothing downloads until
// the person clicks Add.
//
// The review list looks each song's lyrics up as soon as it shows (when
// online lookup is on), so a song LRCLIB doesn't have is visible before
// anything runs — and can get pasted lyrics right there instead of being
// transcribed.

import { useEffect, useMemo, useRef, useState } from "react";
import { checkLinks, findLyrics, queueLinks, type FoundLink, type ImportQueued, type LinksChecked } from "../api";
import { useSettings } from "../App";
import { fmtDuration } from "../libraryState";
import {
  defaultCheckedLinks,
  linkItems,
  lyricsCell,
  lyricsSummary,
  parseLinks,
  siteLabel,
  type LinkLyrics,
} from "../linkState";
import { Button, Checkbox, Dialog, DialogButtons, FieldLabel, Glyph, Icon, ListView, TextArea, TextField, type MenuEntry } from "../win98";

/** LRCLIB lookups the review list runs at once. */
const LOOKUPS_AT_ONCE = 4;

export default function LinkDialog(props: {
  /** Open with this text in the box (links pasted onto the Library). */
  initialText: string | null;
  onClose: () => void;
  onQueued: (result: ImportQueued) => void;
}) {
  const open = props.initialText !== null;
  const { settings, update } = useSettings();
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<LinksChecked | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [collection, setCollection] = useState("");
  const [hq, setHq] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Per link: lookup result, or lyrics pasted for it. */
  const [lyrics, setLyrics] = useState<Record<string, LinkLyrics>>({});
  const lyricsRef = useRef(lyrics);
  lyricsRef.current = lyrics;
  /** Bumped when a link's pasted lyrics are cleared, to look it up again. */
  const [lookupTick, setLookupTick] = useState(0);
  /** Lookups started for an older list are dropped when they land. */
  const generation = useRef(0);
  const [pasteFor, setPasteFor] = useState<FoundLink | null>(null);
  const [pasteText, setPasteText] = useState("");

  useEffect(() => {
    if (props.initialText === null) return;
    setText(props.initialText);
    setChecking(false);
    setResult(null);
    setCollection("");
    setHq(false);
    setBusy(false);
    setError(null);
    setLyrics({});
    generation.current++;
  }, [props.initialText]);

  const urls = useMemo(() => parseLinks(text), [text]);
  const links = result?.links ?? [];
  const count = links.filter((l) => checked.has(l.url)).length;
  const lookupOn = settings.lookupLyrics;

  // Look up every listed song's lyrics that hasn't been looked up yet, a few
  // at a time (only title, artist and length go to LRCLIB).
  useEffect(() => {
    if (!result || !lookupOn) return;
    const pending = result.links.filter((l) => !lyricsRef.current[l.url]);
    if (pending.length === 0) return;
    const gen = generation.current;
    setLyrics((cur) => {
      const next = { ...cur };
      for (const l of pending) if (!next[l.url]) next[l.url] = { kind: "checking" };
      return next;
    });
    let i = 0;
    const worker = async () => {
      while (i < pending.length) {
        const l = pending[i++];
        let state: LinkLyrics;
        try {
          const r = await findLyrics({ title: l.title, artist: l.artist ?? undefined, duration_s: l.duration_s ?? undefined });
          state = r
            ? { kind: "found", track: r.track_name, artist: r.artist_name, lines: r.text.split(/\r?\n/).filter((s) => s.trim()).length }
            : { kind: "missing" };
        } catch (e) {
          state = { kind: "failed", message: String(e) };
        }
        if (generation.current !== gen) return;
        setLyrics((cur) => (cur[l.url]?.kind === "pasted" ? cur : { ...cur, [l.url]: state }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, pending.length) }, worker));
  }, [result, lookupOn, lookupTick]);

  const check = async () => {
    if (urls.length === 0 || checking) return;
    setChecking(true);
    setError(null);
    try {
      const r = await checkLinks(urls);
      generation.current++;
      setLyrics({});
      setResult(r);
      setChecked(defaultCheckedLinks(r.links));
      setSelected(r.links[0]?.url ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  const add = async () => {
    if (count === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await queueLinks(linkItems(links, checked, lyrics), {
        collection: collection.trim() || undefined,
        lookup_lyrics: lookupOn,
        hq_separation: hq,
        cpu_only: settings.importOn === "cpu",
      });
      props.onQueued(r);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const toggle = (url: string | null) => {
    if (!url) return;
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };
  const setAll = (pick: (l: FoundLink) => boolean) => setChecked(new Set(links.filter(pick).map((l) => l.url)));

  const selectedLink = links.find((l) => l.url === selected) ?? null;
  const openPaste = (l: FoundLink | null) => {
    if (!l) return;
    const cur = lyrics[l.url];
    setPasteText(cur?.kind === "pasted" ? cur.text : "");
    setPasteFor(l);
  };
  const savePaste = () => {
    if (!pasteFor) return;
    const url = pasteFor.url;
    if (pasteText.trim()) {
      setLyrics((cur) => ({ ...cur, [url]: { kind: "pasted", text: pasteText } }));
    } else {
      // Emptied: back to the lookup (or transcription).
      setLyrics((cur) => {
        const next = { ...cur };
        delete next[url];
        return next;
      });
      setLookupTick((t) => t + 1);
    }
    setPasteFor(null);
  };
  const clearPaste = (l: FoundLink | null) => {
    if (!l) return;
    setLyrics((cur) => {
      const next = { ...cur };
      delete next[l.url];
      return next;
    });
    setLookupTick((t) => t + 1);
  };

  const menu: MenuEntry[] = [
    { label: checked.has(selected ?? "") ? "&Uncheck" : "&Check", accel: "Space", run: () => toggle(selected), disabled: !selected },
    { label: "&Paste lyrics…", run: () => openPaste(selectedLink), disabled: !selectedLink },
    {
      label: lookupOn ? "&Look the lyrics up instead" : "&Transcribe instead",
      run: () => clearPaste(selectedLink),
      disabled: lyrics[selected ?? ""]?.kind !== "pasted",
    },
    "-",
    { label: "Check &all", run: () => setAll(() => true) },
    { label: "Check only &new songs", run: () => setAll((l) => !l.in_library) },
    { label: "Unchec&k all", run: () => setAll(() => false) },
  ];

  const reviewing = result !== null;
  const close = () => !busy && !checking && props.onClose();

  return (
    <>
      <Dialog open={open} onClose={close} title="Add from URL" width={reviewing ? 900 : 560}>
        <div className="w-dialog-body" style={{ gap: 8 }}>
          {!reviewing ? (
            <>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start", lineHeight: "18px" }}>
                <Icon name="globe" size={32} />
                <span>
                  Paste links to songs — a music video, a song page, or a playlist's own link for all its songs (a video
                  you opened from a playlist adds just that video). Karascape downloads each one to this computer, then
                  separates the vocals and lines up the lyrics like any song you add.
                </span>
              </div>
              <FieldLabel htmlFor="link-text" text="&Links — one per line:" />
              <TextArea
                id="link-text"
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
                autoFocus
                spellCheck={false}
                disabled={checking}
              />
              <div style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 18 }}>
                {checking ? (
                  <>
                    <Icon name="working" />
                    Checking {urls.length === 1 ? "the link" : `${urls.length} links`}… this takes a few seconds each.
                  </>
                ) : urls.length > 0 ? (
                  urls.length === 1 ? "1 link" : `${urls.length} links`
                ) : (
                  <span className="w-muted">No links yet.</span>
                )}
              </div>
            </>
          ) : (
            <>
              <div style={{ lineHeight: "18px" }}>
                {links.length === 0 ? (
                  "None of the links had songs Karascape could get."
                ) : (
                  <>
                    Found <b>{links.length === 1 ? "1 song" : `${links.length} songs`}</b>. Uncheck any you don't want, and
                    paste lyrics for any that LRCLIB doesn't have.
                  </>
                )}
              </div>
              <ListView<FoundLink>
                ariaLabel="Songs to add"
                rows={links}
                rowKey={(l) => l.url}
                selected={selected}
                onSelect={(k) => setSelected(k as string)}
                onActivate={(l) => toggle(l.url)}
                contextMenu={menu}
                style={{ height: 260 }}
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
                    render: (l) => (
                      <span
                        className="w-checkbox"
                        role="checkbox"
                        aria-checked={checked.has(l.url)}
                        aria-label={`Add ${l.title}`}
                        onClick={() => toggle(l.url)}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        {checked.has(l.url) && <Glyph name="check" />}
                      </span>
                    ),
                  },
                  {
                    key: "title",
                    label: "Song",
                    width: "minmax(150px, 1.3fr)",
                    render: (l) => <span style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={l.url}>{l.title}</span>,
                  },
                  {
                    key: "artist",
                    label: "Artist",
                    width: "minmax(90px, 0.9fr)",
                    render: (l) => l.artist ?? <span className="w-muted">Unknown artist</span>,
                  },
                  { key: "length", label: "Length", width: "60px", render: (l) => fmtDuration(l.duration_s) ?? "" },
                  {
                    key: "lyrics",
                    label: "Lyrics",
                    width: "minmax(170px, 1.1fr)",
                    render: (l) => {
                      const c = lyricsCell(lyrics[l.url], lookupOn);
                      return (
                        <span style={{ display: "flex", gap: 5, alignItems: "center", minWidth: 0 }} title={c.tip}>
                          <Icon name={c.icon} />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
                        </span>
                      );
                    },
                  },
                  { key: "site", label: "From", width: "minmax(80px, 0.5fr)", render: (l) => siteLabel(l.site) },
                  {
                    key: "status",
                    label: "Status",
                    width: "76px",
                    render: (l) => (l.in_library ? <span className="w-muted">In library</span> : "New"),
                  },
                ]}
                empty="No songs."
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ flexGrow: 1, lineHeight: "18px" }}>{lyricsSummary(links, checked, lyrics, lookupOn)}</span>
                <Button onClick={() => openPaste(selectedLink)} disabled={!selectedLink}>
                  {"&Paste lyrics…"}
                </Button>
              </div>
              {result.failures.length > 0 && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: "16px" }}>
                  <Icon name="warn" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span>{result.failures.length === 1 ? "1 link didn't work:" : `${result.failures.length} links didn't work:`}</span>
                    {result.failures.slice(0, 4).map((f) => (
                      <span key={f.url} className="w-muted" style={{ userSelect: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${f.url}\n${f.message}`}>
                        {f.url} — {f.message}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
                <FieldLabel htmlFor="link-collection" text="Put them in a &collection:" />
                <TextField
                  id="link-collection"
                  value={collection}
                  onChange={(e) => setCollection(e.target.value)}
                  placeholder="(optional)"
                  style={{ width: 240 }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <Checkbox
                  checked={lookupOn}
                  onChange={(v) => update({ lookupLyrics: v })}
                  label="Find &lyrics online (LRCLIB) — sends only the title, artist and length"
                />
                <Checkbox checked={hq} onChange={setHq} label="&High-quality separation (cleaner, about 3× slower)" />
              </div>
            </>
          )}
          {error && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }} role="alert">
              <Icon name="error" />
              <span style={{ userSelect: "text" }}>{error}</span>
            </div>
          )}
        </div>
        <DialogButtons>
          {!reviewing ? (
            <Button isDefault onClick={() => void check()} disabled={urls.length === 0 || checking}>
              {"&Next >"}
            </Button>
          ) : (
            <>
              <Button onClick={() => setResult(null)} disabled={busy}>
                {"< &Back"}
              </Button>
              <Button isDefault onClick={() => void add()} disabled={count === 0 || busy}>
                {count === 1 ? "&Add 1 song" : `&Add ${count} songs`}
              </Button>
            </>
          )}
          <Button onClick={close} disabled={busy || checking}>
            Cancel
          </Button>
        </DialogButtons>
      </Dialog>

      <Dialog open={!!pasteFor} onClose={() => setPasteFor(null)} title={`Lyrics - ${pasteFor?.title ?? ""}`} width={500}>
        <div className="w-dialog-body" style={{ gap: 8 }}>
          <FieldLabel htmlFor="link-lyrics" text="&Lyrics — one line per sung line, a blank line between verses:" />
          <TextArea id="link-lyrics" lyric rows={12} value={pasteText} onChange={(e) => setPasteText(e.target.value)} autoFocus />
          <div className="w-muted" style={{ lineHeight: "16px" }}>
            {lookupOn
              ? "Leave empty to look them up on LRCLIB again, or transcribe if it doesn't have them."
              : "Leave empty to transcribe them from the vocals."}
          </div>
        </div>
        <DialogButtons>
          <Button isDefault onClick={savePaste}>
            OK
          </Button>
          <Button onClick={() => setPasteFor(null)}>Cancel</Button>
        </DialogButtons>
      </Dialog>
    </>
  );
}
