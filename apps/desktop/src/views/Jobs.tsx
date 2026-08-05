// Job progress view — live stage progress from `karaoke://job` events,
// rendered as the two honest display stages (PLAN.md §4):
// Separating vocals → Aligning lyrics.

import { cancelJob } from "../api";
import {
  DISPLAY_LABELS,
  progressHeadline,
  type JobProgress,
  type JobsState,
} from "../jobEvents";
import type { Route } from "../App";

export default function Jobs({ jobs, go }: { jobs: JobsState; go: (r: Route) => void }) {
  const list = [...jobs.order].reverse().map((id) => jobs.jobs[id]).filter(Boolean);
  return (
    <div className="page">
      <h1>Jobs</h1>
      {list.length === 0 && (
        <p className="muted">
          Nothing in the queue. Add one from <b>New Song</b> — you can keep queueing while a
          song processes.
        </p>
      )}
      {list.map((p) => (
        <JobCard key={p.job.id} p={p} go={go} />
      ))}
    </div>
  );
}

function JobCard({ p, go }: { p: JobProgress; go: (r: Route) => void }) {
  const { job } = p;
  const running = job.status === "running";
  const cancellable = job.status === "queued" || (running && !job.cancel_requested);
  return (
    <div className={`job-card status-${job.status}`}>
      <div className="job-head">
        <div>
          <div className="job-title">{job.title}</div>
          {job.artist && <div className="job-artist">{job.artist}</div>}
        </div>
        <div className="job-headline">{progressHeadline(p)}</div>
      </div>

      {(running || job.status === "queued") && (
        <div className="stage-track">
          <StagePill
            label={DISPLAY_LABELS.separating}
            state={
              running && p.stage === "separating"
                ? "active"
                : running
                  ? "done"
                  : "pending"
            }
            fraction={p.stage === "separating" ? p.fraction : 1}
          />
          <span className="stage-arrow">→</span>
          <StagePill
            label={DISPLAY_LABELS.aligning}
            state={running && p.stage === "aligning" ? "active" : "pending"}
            fraction={null}
          />
        </div>
      )}

      {running && p.message && <div className="job-message">{p.message}</div>}
      {p.cleanupSummary && (
        <div className="job-message">lyric cleanup: {p.cleanupSummary}</div>
      )}
      {job.status === "failed" && (
        <div className="error-banner">{job.error ?? p.failure ?? "unknown failure"}</div>
      )}

      <div className="job-actions">
        {cancellable && (
          <button onClick={() => cancelJob(job.id)}>
            {job.status === "queued" ? "Remove" : "Cancel"}
          </button>
        )}
        {job.status === "completed" && job.map_path && (
          <button
            className="primary"
            onClick={() => go({ view: "song", mapPath: job.map_path!, title: job.title })}
          >
            Open song
          </button>
        )}
      </div>
    </div>
  );
}

function StagePill(props: {
  label: string;
  state: "pending" | "active" | "done";
  fraction: number | null;
}) {
  return (
    <div className={`stage-pill ${props.state}`}>
      <span>{props.label}</span>
      {props.state === "active" && props.fraction != null && (
        <div className="stage-bar">
          <div className="stage-bar-fill" style={{ width: `${props.fraction * 100}%` }} />
        </div>
      )}
    </div>
  );
}
