// Add from URL: paste links — a song, a video, a whole playlist — check what
// they point at, review the list, then queue them. Each song downloads to this
// computer with yt-dlp, finds its lyrics on LRCLIB when asked, and imports
// like any other song (PLAN.md §3 Add from URL, §5). Nothing downloads until
// the person clicks Add.

import { useEffect, useMemo, useState } from "react";
import { checkLinks, queueLinks, type FoundLink, type ImportQueued, type LinksChecked } from "../api";
import { useSettings } from "../App";
import { fmtDuration } from "../libraryState";
import { defaultCheckedLinks, linkItems, parseLinks, siteLabel } from "../linkState";
import { Button, Checkbox, Dialog, DialogButtons, FieldLabel, Glyph, Icon, ListView, TextArea, TextField, type MenuEntry } from "../win98";

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

  useEffect(() => {
    if (props.initialText === null) return;
    setText(props.initialText);
    setChecking(false);
    setResult(null);
    setCollection("");
    setHq(false);
    setBusy(false);
    setError(null);
  }, [props.initialText]);

  const urls = useMemo(() => parseLinks(text), [text]);
  const links = result?.links ?? [];
  const count = links.filter((l) => checked.has(l.url)).length;

  const check = async () => {
    if (urls.length === 0 || checking) return;
    setChecking(true);
    setError(null);
    try {
      const r = await checkLinks(urls);
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
      const r = await queueLinks(linkItems(links, checked), {
        collection: collection.trim() || undefined,
        lookup_lyrics: settings.lookupLyrics,
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
  const menu: MenuEntry[] = [
    { label: checked.has(selected ?? "") ? "&Uncheck" : "&Check", accel: "Space", run: () => toggle(selected), disabled: !selected },
    "-",
    { label: "Check &all", run: () => setAll(() => true) },
    { label: "Check only &new songs", run: () => setAll((l) => !l.in_library) },
    { label: "Unchec&k all", run: () => setAll(() => false) },
  ];

  const reviewing = result !== null;
  const close = () => !busy && !checking && props.onClose();

  return (
    <Dialog open={open} onClose={close} title="Add from URL" width={reviewing ? 820 : 560}>
      <div className="w-dialog-body" style={{ gap: 8 }}>
        {!reviewing ? (
          <>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", lineHeight: "18px" }}>
              <Icon name="globe" size={32} />
              <span>
                Paste links to songs — a music video, a song page, or a whole playlist. Karascape downloads each one to
                this computer, then separates the vocals and lines up the lyrics like any song you add.
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
                  Found <b>{links.length === 1 ? "1 song" : `${links.length} songs`}</b>. Uncheck any you don't want.
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
                  width: "minmax(160px, 1.4fr)",
                  render: (l) => <span style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={l.url}>{l.title}</span>,
                },
                {
                  key: "artist",
                  label: "Artist",
                  width: "minmax(100px, 1fr)",
                  render: (l) => l.artist ?? <span className="w-muted">Unknown artist</span>,
                },
                { key: "length", label: "Length", width: "64px", render: (l) => fmtDuration(l.duration_s) ?? "" },
                { key: "site", label: "From", width: "minmax(90px, 0.6fr)", render: (l) => siteLabel(l.site) },
                {
                  key: "status",
                  label: "Status",
                  width: "84px",
                  render: (l) => (l.in_library ? <span className="w-muted">In library</span> : "New"),
                },
              ]}
              empty="No songs."
            />
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
                checked={settings.lookupLyrics}
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
  );
}
