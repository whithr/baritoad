// Tools › Models… — the model packs (PLAN.md §3 "Model manager"): what each
// is for, its size, whether it's here, and Download / Update with progress.
// Modeless: a download keeps going while you use the Library, and closing
// the dialog doesn't stop it. Also the first-run welcome (WelcomeDialog).

import { useCallback, useEffect, useState } from "react";
import {
  modelsCancel,
  modelsDownload,
  modelsStatus,
  onModelsEvent,
  type ModelEvent,
  type ModelPack,
  type ModelsInfo,
  type PackStatus,
} from "../api";
import { Button, Dialog, DialogButtons, GroupBox, Icon, ProgressBar } from "../win98";

export const PACK_TEXT: Record<ModelPack, { name: string; what: string }> = {
  core: { name: "Song models", what: "Take the singing out and line the words up with the music. Every song needs them." },
  transcription: { name: "Transcription", what: "Writes the words down for songs that come without lyrics." },
  high_quality: { name: "High-quality separation", what: "Cleaner vocal removal for the High-quality box, about 3× slower." },
};

export const mbOf = (bytes: number) => `${Math.round(bytes / 1_000_000).toLocaleString()} MB`;

/** Follows the packs and any running download. */
export function useModels(open: boolean) {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [progress, setProgress] = useState<Extract<ModelEvent, { kind: "progress" }>["progress"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = useCallback(() => {
    modelsStatus()
      .then((i) => setInfo(i))
      .catch((e) => setProblem(String(e)));
  }, []);
  useEffect(() => {
    if (!open) return;
    refresh();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onModelsEvent((e) => {
      if (e.kind === "progress") setProgress(e.progress);
      else if (e.kind === "failed")
        setProblem(`The download stopped: ${e.message}. Download again to pick up where it left off.`);
      else if (e.kind === "done" || e.kind === "cancelled" || e.kind === "finished") {
        if (e.kind !== "done") setProgress(null);
        refresh();
      }
      if (e.kind === "finished") setProgress(null);
    })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open, refresh]);
  const download = async (packs: ModelPack[]) => {
    setProblem(null);
    try {
      await modelsDownload(packs);
      refresh();
    } catch (e) {
      setProblem(String(e));
    }
  };
  return { info, progress, problem, download, cancel: () => void modelsCancel().catch(() => undefined) };
}

function PackRow(props: { st: PackStatus; busy: boolean; onGet: () => void }) {
  const { st } = props;
  const text = PACK_TEXT[st.pack];
  const state = st.installed ? "Downloaded." : st.usable ? "An older version is here; it still works." : "Not downloaded.";
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "4px 0" }}>
      <Icon name={st.installed ? "ready" : st.usable ? "info" : "disc"} />
      <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2, lineHeight: "16px" }}>
        <b>
          {text.name} <span style={{ fontWeight: 400 }}>— {mbOf(st.bytes_total)}</span>
        </b>
        <span>{text.what}</span>
        <span className="w-muted">{state}</span>
      </div>
      {!st.installed && (
        <Button onClick={props.onGet} disabled={props.busy} style={{ minWidth: 88 }}>
          {st.usable ? "&Update" : "&Download"}
        </Button>
      )}
    </div>
  );
}

export default function ModelsDialog(props: { open: boolean; onClose: () => void }) {
  const { info, progress, problem, download, cancel } = useModels(props.open);
  const busy = !!info?.downloading || !!progress;
  return (
    <Dialog open={props.open} onClose={props.onClose} title="Models" width={520} modeless>
      <div className="w-dialog-body" style={{ gap: 10 }}>
        <span style={{ lineHeight: "18px" }}>
          Everything happens on this computer, with these models. Each downloads once{info ? `, from ${info.mirror}` : ""}.
        </span>
        <GroupBox label="Packs">
          {info ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {info.packs.map((st, i) => (
                <div key={st.pack} style={{ borderTop: i > 0 ? "1px solid var(--w-shadow)" : undefined, paddingTop: i > 0 ? 6 : 0 }}>
                  <PackRow st={st} busy={busy} onGet={() => void download([st.pack])} />
                </div>
              ))}
            </div>
          ) : (
            <span>Looking…</span>
          )}
        </GroupBox>
        {busy && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }} aria-live="polite">
            <span>
              Downloading {progress ? PACK_TEXT[progress.pack].name.toLowerCase() : "models"}
              {progress ? ` — ${mbOf(progress.done)} of ${mbOf(progress.total)}` : "…"}
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <ProgressBar value={progress ? progress.done / Math.max(1, progress.total) : 0} style={{ flexGrow: 1 }} />
              <Button onClick={cancel}>Cancel</Button>
            </div>
            <span className="w-muted">Cancelled or cut off, it picks up from where it stopped next time.</span>
          </div>
        )}
        {problem && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: "16px" }} role="alert">
            <Icon name="error" />
            <span style={{ userSelect: "text" }}>{problem}</span>
          </div>
        )}
      </div>
      <DialogButtons>
        <Button isDefault onClick={props.onClose}>
          Close
        </Button>
      </DialogButtons>
    </Dialog>
  );
}

/** First run: what baritoad does, what goes online, and the one download. */
export function WelcomeDialog(props: { open: boolean; coreBytes: number; onDownload: () => void; onClose: () => void }) {
  return (
    <Dialog open={props.open} onClose={props.onClose} title="Welcome to baritoad" width={480}>
      <div className="w-dialog-body" style={{ gap: 10, lineHeight: "18px" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <Icon name="disc" size={32} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <b>Karaoke from the songs you already have.</b>
            <span>Add a song and the singing comes out and the words line up with the music, ready to sing on the TV.</span>
            <span>
              All of that happens on this computer. To do it, the song models need to download once — about {mbOf(props.coreBytes)}.
            </span>
            <span className="w-muted">
              Nothing goes online unless you ask: downloading models, fetching a song from a link, and looking up lyrics on
              LRCLIB if you turn that on.
            </span>
          </div>
        </div>
      </div>
      <DialogButtons>
        <Button isDefault onClick={props.onDownload}>
          &Download now
        </Button>
        <Button onClick={props.onClose}>&Later</Button>
      </DialogButtons>
    </Dialog>
  );
}
