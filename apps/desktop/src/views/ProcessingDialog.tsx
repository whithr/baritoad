// The modeless Processing dialog: what the pipeline is doing to one song,
// as a step list and a block progress bar. "Run in background" hides it;
// the Library's status bar keeps reporting. During a bulk import it follows
// the batch — the song in progress on top, the songs still waiting below.

import type { JobProgress } from "../jobEvents";
import { progressHeadline } from "../jobEvents";
import { Button, Dialog, Glyph, Icon, ListView, ProgressBar } from "../win98";

type StepState = "done" | "active" | "todo";

export default function ProcessingDialog(props: {
  job: JobProgress | undefined;
  /** Other songs queued behind this one (bulk import). */
  waiting?: JobProgress[];
  open: boolean;
  onHide: () => void;
  onCancelJob: (jobId: number) => void;
  onCancelAll?: () => void;
}) {
  const { job } = props;
  const waiting = props.waiting ?? [];
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
        {waiting.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div>{waiting.length === 1 ? "1 more song waiting:" : `${waiting.length} more songs waiting:`}</div>
            <ListView<JobProgress>
              ariaLabel="Songs waiting"
              rows={waiting}
              rowKey={(p) => p.job.id}
              selected={null}
              onSelect={() => undefined}
              style={{ height: 96 }}
              columns={[
                { key: "title", label: "Song", width: "minmax(0, 1.4fr)", render: (p) => p.job.title },
                { key: "artist", label: "Artist", width: "minmax(0, 1fr)", render: (p) => p.job.artist ?? "" },
              ]}
            />
          </div>
        )}
      </div>
      <div className="w-dialog-buttons">
        <Button isDefault onClick={props.onHide}>
          Run in &background
        </Button>
        <Button onClick={() => job && props.onCancelJob(job.job.id)} disabled={!running || job?.job.cancel_requested}>
          {waiting.length > 0 ? "S&kip this song" : "Cancel"}
        </Button>
        {waiting.length > 0 && props.onCancelAll && <Button onClick={props.onCancelAll}>Cancel &all</Button>}
      </div>
    </Dialog>
  );
}
