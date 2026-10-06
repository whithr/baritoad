// "Add to a collection?" — the golden path's last step:
// once a song is ready, file it under "Haley's hits" so next party it's one
// click away. A plain pick-one list with New… beside it; the song's menu
// (Song › Add to collection) stays the way to file it under several.

import { useEffect, useState } from "react";
import { collectionAddSong, collectionCreate, type CollectionInfo } from "../api";
import { Button, Dialog, DialogButtons, Icon, ListView, usePrompt } from "../win98";

export default function CollectionPicker(props: {
  /** The song to file; null = closed. */
  song: { id: number; title: string } | null;
  collections: CollectionInfo[];
  onClose: () => void;
  /** After the song went into a collection (refresh the Library). */
  onAdded: () => void;
}) {
  const { song } = props;
  const prompt = usePrompt();
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!song) return;
    setPicked(props.collections[0]?.id ?? null);
    setError(null);
    setBusy(false);
  }, [song]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTo = async (collectionId: number) => {
    if (!song) return;
    setBusy(true);
    try {
      await collectionAddSong(collectionId, song.id);
      props.onAdded();
      props.onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const name = await prompt({ title: "New Collection", label: "Collection &name:", okLabel: "Create" });
    if (!name) return;
    try {
      const c = await collectionCreate(name);
      if (c) await addTo(c.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const none = props.collections.length === 0;
  return (
    <Dialog open={!!song} onClose={() => !busy && props.onClose()} title="Add to Collection" width={400}>
      <div className="w-dialog-body" style={{ gap: 10 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <Icon name="disc" size={32} />
          <span style={{ lineHeight: "18px" }}>
            Put <b>{song?.title}</b> in a collection, so it's one click away next time.
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <ListView<CollectionInfo>
            ariaLabel="Collections"
            style={{ height: 150, flexGrow: 1 }}
            rows={props.collections}
            rowKey={(c) => c.id}
            selected={picked}
            onSelect={(k) => setPicked(k as number)}
            onActivate={(c) => void addTo(c.id)}
            empty="No collections yet. Make one with New…"
            columns={[
              { key: "name", label: "Collection", width: "minmax(0, 1fr)", render: (c) => c.name },
              { key: "n", label: "Songs", width: "56px", align: "right", render: (c) => c.song_count },
            ]}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 5, width: 96, flexShrink: 0 }}>
            <Button onClick={() => void createAndAdd()} disabled={busy} style={{ width: "100%" }}>
              &New…
            </Button>
          </div>
        </div>
        {error && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }} role="alert">
            <Icon name="error" />
            <span style={{ userSelect: "text" }}>{error}</span>
          </div>
        )}
      </div>
      <DialogButtons>
        <Button isDefault onClick={() => picked != null && void addTo(picked)} disabled={busy || none || picked == null}>
          &Add
        </Button>
        <Button onClick={props.onClose} disabled={busy}>
          Cancel
        </Button>
      </DialogButtons>
    </Dialog>
  );
}
