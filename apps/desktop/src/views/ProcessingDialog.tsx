// The modeless Processing dialog: what the pipeline is doing to one song,
// as a step list and a block progress bar. "Run in background" hides it;
// the Library's status bar and Processing folder keep reporting.

import type { JobProgress } from "../jobEvents";
import { progressHeadline } from "../jobEvents";
import { Button, Dialog, Glyph, Icon, ProgressBar } from "../win98";

type StepState = "done" | "active" | "todo";

export default function ProcessingDialog(props: {
  job: JobProgress | undefined;
  open: boolean;
  onHide: () => void;
  onCancelJob: (jobId: number) => void;
}) {
  const { job } = props;
  const status = job?.job.status;
  const running = status === "queued" || status === "running";
  const separating = job?.stage === "separating";
  const steps: [string, StepState][] = [
    ["Read the audio", status === "queued" ? "active" : "done"],
    ["Separate the vocals", status === "queued" ? "todo" : separating ? "active" : "done"],
    ["Line the words up with the singing", status === "queued" || separating ? "todo" : status === "completed" ? "done" : "active"],
  ];
  const fileName = job?.job.audio.split(/[\\/]/).pop() ?? "";

  return (
    <Dialog open={props.open && !!job} onClose={props.onHide} title={`Processing - ${job?.job.title ?? ""}`} width={460} modeless>
      <div className="w-dialog-body" style={{ gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", height: 48 }} aria-hidden>
          <Icon name="disc" size={32} />
          <div style={{ flexGrow: 1, position: "relative", height: 40 }}>
            <div style={{ position: "absolute", left: "8%", right: "8%", top: 26, borderTop: "2px dotted var(--w-shadow)" }} />
            <span style={{ position: "absolute", left: "30%", top: 4 }}>
              <Icon name="note" />
            </span>
            <span style={{ position: "absolute", left: "55%", top: 14 }}>
              <Icon name="note" />
            </span>
          </div>
          <Icon name="mic" size={32} />
        </div>
        <div>
          {job ? progressHeadline(job) : ""} — <b>{fileName}</b>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 4 }}>
          {steps.map(([label, st]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, height: 20, fontWeight: st === "active" ? 700 : 400, color: st === "todo" ? "var(--w-text-dis)" : undefined }}>
              <span style={{ width: 16, display: "flex", justifyContent: "center" }}>
                {st === "done" ? <Icon name="ready" /> : st === "active" ? <Glyph name="right" /> : null}
              </span>
              {label}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ProgressBar value={running ? (job?.fraction ?? null) : 1} label="Progress" style={{ flexGrow: 1 }} />
          <span style={{ width: 36, textAlign: "right" }}>
            {job?.fraction != null && running ? `${Math.round(job.fraction * 100)}%` : ""}
          </span>
        </div>
        {job?.message && <div className="w-muted" style={{ lineHeight: "18px" }}>{job.message}</div>}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="lock" />
          Running on this computer. Nothing is uploaded.
        </div>
      </div>
      <div className="w-dialog-buttons">
        <Button isDefault onClick={props.onHide}>
          Run in &background
        </Button>
        <Button onClick={() => job && props.onCancelJob(job.job.id)} disabled={!running || job?.job.cancel_requested}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
