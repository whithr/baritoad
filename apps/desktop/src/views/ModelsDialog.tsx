// The models (PLAN.md §3 "Model manager"), in two places:
// - ModelsGate, the first run: baritoad can't do anything without its
//   models, so the app waits behind it until all four are here — each
//   named, with what it does, downloading one at a time.
// - ModelsDialog, Tools › Models…: the same list later, to update an older
//   version or fetch one again. Modeless; closing it doesn't stop a download.

import { useCallback, useEffect, useState } from "react";
import {
  modelsCancel,
  modelsDownload,
  modelsStatus,
  onModelsEvent,
  type ModelEvent,
  type ModelPack,
  type ModelsInfo,
  type ModelStatus,
} from "../api";
import { Button, Dialog, DialogButtons, GroupBox, Icon, ProgressBar } from "../win98";

/** What each model is and does here. */
export const MODEL_TEXT: Record<string, { name: string; maker: string; what: string }> = {
  htdemucs: { name: "Demucs v4", maker: "Meta", what: "Separates the singing from the music." },
  wav2vec2: { name: "wav2vec 2.0", maker: "Meta", what: "Lines up each word with the singing." },
  "whisper-small": { name: "Whisper small", maker: "OpenAI", what: "Writes down the words when a song has no lyrics." },
  htdemucs_ft_vocals: { name: "Demucs v4, fine-tuned", maker: "Meta", what: "Cleaner vocal removal, for High-quality separation." },
};
const textOf = (id: string) => MODEL_TEXT[id] ?? { name: id, maker: "", what: "" };

export const mbOf = (bytes: number) => `${Math.round(bytes / 1_000_000).toLocaleString()} MB`;
const gbOf = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;
const packsOf = (models: ModelStatus[]): ModelPack[] => [...new Set(models.map((m) => m.pack))];

type Progress = Extract<ModelEvent, { kind: "progress" }>["progress"];

/** The models on disk, and the download if one is running. */
function useModels(active: boolean) {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  /** Models this download finished (the status refreshes once per pack). */
  const [finished, setFinished] = useState<Set<string>>(() => new Set());
  /** The packs asked for, while they download. */
  const [queue, setQueue] = useState<ModelPack[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = useCallback(() => {
    modelsStatus()
      .then(setInfo)
      .catch((e) => setProblem(String(e)));
  }, []);
  useEffect(() => {
    if (!active) return;
    refresh();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onModelsEvent((e) => {
      if (e.kind === "progress") {
        setProgress(e.progress);
        if (e.progress.model_done >= e.progress.model_total) setFinished((f) => new Set(f).add(e.progress.model));
      } else if (e.kind === "failed") {
        setProblem(`The download stopped: ${e.message}. Download again to pick up where it left off.`);
      } else if (e.kind === "done") {
        refresh();
      } else {
        setProgress(null);
        setQueue([]);
        refresh();
      }
    })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active, refresh]);
  const download = async (packs: ModelPack[]) => {
    if (packs.length === 0) return;
    setProblem(null);
    setFinished(new Set());
    setQueue(packs);
    try {
      await modelsDownload(packs);
    } catch (e) {
      setQueue([]);
      setProblem(String(e));
    }
    refresh();
  };
  const running = !!info?.downloading || queue.length > 0;
  return { info, progress, finished, queue, running, problem, download, cancel: () => void modelsCancel().catch(() => undefined) };
}

type RowState = "done" | "current" | "waiting" | "older" | "stopped" | "missing";

function ModelList(props: { m: ReturnType<typeof useModels> }) {
  const { info, progress, finished, queue, running } = props.m;
  if (!info) return <span>Looking…</span>;
  const stateOf = (s: ModelStatus): RowState => {
    if (s.installed || finished.has(s.model)) return "done";
    if (running && progress?.model === s.model) return "current";
    if (running && queue.includes(s.pack)) return "waiting";
    if (s.usable) return "older";
    return s.bytes_present > 0 ? "stopped" : "missing";
  };
  return (
    <GroupBox label="Models">
      <div style={{ display: "flex", flexDirection: "column" }}>
        {info.models.map((s, i) => {
          const t = textOf(s.model);
          const state = stateOf(s);
          const note: Record<RowState, string> = {
            done: "Downloaded",
            current: "",
            waiting: "Waiting",
            older: "Older version, still works",
            stopped: `Stopped at ${mbOf(s.bytes_present)}`,
            missing: "Not downloaded",
          };
          return (
            <div
              key={s.model}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                padding: "6px 0",
                borderTop: i > 0 ? "1px solid var(--w-shadow)" : undefined,
              }}
            >
              <Icon name={state === "done" ? "ready" : state === "current" ? "working" : state === "older" ? "info" : "disc"} />
              <div style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2, lineHeight: "16px" }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <b style={{ flexGrow: 1 }}>
                    {t.name}
                    {t.maker && <span style={{ fontWeight: 400 }}> · {t.maker}</span>}
                  </b>
                  <span>{mbOf(s.bytes_total)}</span>
                </div>
                <span>{t.what}</span>
                {state === "current" && progress ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
                    <ProgressBar small value={progress.model_done / Math.max(1, progress.model_total)} style={{ flexGrow: 1 }} />
                    <span className="w-muted" style={{ whiteSpace: "nowrap" }}>
                      {mbOf(progress.model_done)} of {mbOf(progress.model_total)}
                    </span>
                  </div>
                ) : (
                  <span className="w-muted">{note[state]}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </GroupBox>
  );
}

function Problem(props: { text: string | null }) {
  if (!props.text) return null;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: "16px" }} role="alert">
      <Icon name="error" />
      <span style={{ userSelect: "text" }}>{props.text}</span>
    </div>
  );
}

/** First run: the app waits here until every model is downloaded. */
export function ModelsGate() {
  const m = useModels(true);
  /** Stays up after a download here, until Start. */
  const [started, setStarted] = useState(false);
  const missing = m.info?.models.filter((s) => !s.usable) ?? [];
  const open = !!m.info && (missing.length > 0 || started);
  const allHere = !!m.info && m.info.models.every((s) => s.usable || m.finished.has(s.model));
  const size = missing.reduce((n, s) => n + s.bytes_total, 0);
  return (
    <Dialog open={open} onClose={() => undefined} closable={false} title="Download the models" width={500}>
      <div className="w-dialog-body" style={{ gap: 10 }}>
        <span style={{ lineHeight: "18px" }}>
          <b>baritoad needs these models to work.</b> They run on this computer and download once
          {size > 0 ? `, ${gbOf(size)} in all` : ""}.
        </span>
        <ModelList m={m} />
        <Problem text={m.problem} />
      </div>
      <DialogButtons>
        {m.running ? (
          <Button onClick={m.cancel}>Cancel</Button>
        ) : allHere ? (
          <Button isDefault onClick={() => setStarted(false)}>
            &Start
          </Button>
        ) : (
          <Button
            isDefault
            onClick={() => {
              setStarted(true);
              void m.download(packsOf(missing));
            }}
          >
            &Download
          </Button>
        )}
      </DialogButtons>
    </Dialog>
  );
}

/** Tools › Models…: the same list, to update or download again. */
export default function ModelsDialog(props: { open: boolean; onClose: () => void }) {
  const m = useModels(props.open);
  const pending = m.info?.models.filter((s) => !s.installed && !m.finished.has(s.model)) ?? [];
  const host = (() => {
    try {
      return m.info ? new URL(m.info.mirror).host : "";
    } catch {
      return m.info?.mirror ?? "";
    }
  })();
  return (
    <Dialog open={props.open} onClose={props.onClose} title="Models" width={500} modeless>
      <div className="w-dialog-body" style={{ gap: 10 }}>
        <span style={{ lineHeight: "18px" }}>
          baritoad runs these models on this computer{host ? `. They download from ${host}.` : "."}
        </span>
        <ModelList m={m} />
        <Problem text={m.problem} />
      </div>
      <DialogButtons>
        {m.running ? (
          <Button onClick={m.cancel}>Cancel download</Button>
        ) : (
          pending.length > 0 && (
            <Button onClick={() => void m.download(packsOf(pending))}>
              {pending.some((s) => !s.usable) ? "&Download" : "&Update"}
            </Button>
          )
        )}
        <Button isDefault onClick={props.onClose}>
          Close
        </Button>
      </DialogButtons>
    </Dialog>
  );
}
