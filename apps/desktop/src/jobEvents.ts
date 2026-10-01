// Progress-event reducer — pure logic, vitest-covered.
//
// The pipeline has four internal stages (separate → clean_lyrics → align →
// export), but the progress screen shows the two the user was promised
// (PLAN.md §4): "Separating vocals → Aligning lyrics". clean_lyrics/align/
// export fold into the second display stage — clean_lyrics is milliseconds
// and export is instant, so this stays honest. A link job (Add from URL)
// downloads first, and a job that looks its lyrics up on LRCLIB does that
// before separating — two more display stages ahead of the pipeline's.

import type { JobEvent, JobSnapshot, PipelineEvent, PrepStep, StageId } from "./api";

export type DisplayStage = "downloading" | "lyrics" | "separating" | "aligning";

/** Display stages in the order a job goes through them. */
export const STAGE_ORDER: DisplayStage[] = ["downloading", "lyrics", "separating", "aligning"];

export function displayStage(stage: StageId): DisplayStage {
  return stage === "separate" ? "separating" : "aligning";
}

export function prepStage(step: PrepStep): DisplayStage {
  return step === "fetch" ? "downloading" : "lyrics";
}

export const DISPLAY_LABELS: Record<DisplayStage, string> = {
  downloading: "Downloading",
  lyrics: "Finding lyrics",
  separating: "Separating vocals",
  aligning: "Aligning lyrics",
};

export interface JobProgress {
  job: JobSnapshot;
  /** Which display stage is active while running. */
  stage: DisplayStage;
  /** 0..1 within the active display stage; null when unquantified. */
  fraction: number | null;
  /** Latest human-readable progress message. */
  message: string | null;
  /** One-line lyric-cleanup summary, when the pipeline reported it. */
  cleanupSummary: string | null;
  /** Wall seconds per completed internal stage. */
  stageSeconds: Partial<Record<StageId, number>>;
  /** Set on stage_failed (mirrors job.error once the lifecycle lands). */
  failure: string | null;
}

export interface JobsState {
  /** Job ids, oldest first. */
  order: number[];
  jobs: Record<number, JobProgress>;
}

export const emptyJobsState: JobsState = { order: [], jobs: {} };

function freshProgress(job: JobSnapshot): JobProgress {
  return {
    job,
    stage: job.source_url ? "downloading" : job.lookup_lyrics ? "lyrics" : "separating",
    fraction: null,
    message: null,
    cleanupSummary: null,
    stageSeconds: {},
    failure: null,
  };
}

const CLEANUP_PREFIX = "lyric cleanup: ";

function applyPipeline(p: JobProgress, e: PipelineEvent): JobProgress {
  switch (e.type) {
    case "stage_started":
      // Reset the bar only when a quantified stage begins its display stage;
      // clean_lyrics/export starting must not blank align's progress.
      return {
        ...p,
        stage: displayStage(e.stage),
        fraction:
          e.stage === "separate" || e.stage === "align" ? null : p.fraction,
        message: null,
      };
    case "stage_progress": {
      // separate and align each quantify their own display stage;
      // clean_lyrics/export ticks (instant) never clobber align's fraction.
      const quantified = e.stage === "separate" || e.stage === "align";
      const next: JobProgress = {
        ...p,
        stage: displayStage(e.stage),
        fraction: quantified ? (e.fraction ?? p.fraction) : p.fraction,
        message: e.message ?? p.message,
      };
      if (e.stage === "clean_lyrics" && e.message?.startsWith(CLEANUP_PREFIX)) {
        next.cleanupSummary = e.message.slice(CLEANUP_PREFIX.length);
      }
      return next;
    }
    case "stage_skipped":
      // A skipped separate stage means stems were reused — jump the display
      // to the aligning stage so the bar doesn't sit on a stage that won't run.
      return {
        ...p,
        stage: displayStage(e.stage) === "separating" ? "aligning" : p.stage,
        message: `${e.stage}: skipped (${e.reason})`,
      };
    case "stage_completed": {
      const stageSeconds = { ...p.stageSeconds, [e.stage]: e.seconds };
      // After separate completes, the next work is display-stage 2.
      const stage = e.stage === "separate" ? "aligning" : p.stage;
      return { ...p, stageSeconds, stage, fraction: e.stage === "separate" ? 1 : p.fraction };
    }
    case "stage_failed":
      return { ...p, failure: e.message };
    case "note":
      return { ...p, message: e.message };
    default:
      return p;
  }
}

/** Lifecycle rank: queued < running < terminal. */
const STATUS_RANK: Record<JobSnapshot["status"], number> = {
  queued: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
};

/**
 * Merge a lifecycle snapshot over the current one, monotonically: the
 * queue's "queued" and "running" events are emitted from different threads
 * and can reach the webview out of order — a stale lower-rank status must
 * never demote a job the UI already saw further along (the visible symptom
 * was a running job stuck on STBY until it completed).
 */
function mergeLifecycle(cur: JobSnapshot, next: JobSnapshot): JobSnapshot {
  return STATUS_RANK[next.status] < STATUS_RANK[cur.status]
    ? { ...next, status: cur.status }
    : next;
}

export function reduceJobEvent(state: JobsState, e: JobEvent): JobsState {
  if (e.kind === "lifecycle") {
    const id = e.job.id;
    const existing = state.jobs[id];
    const progress: JobProgress = existing
      ? { ...existing, job: mergeLifecycle(existing.job, e.job) }
      : freshProgress(e.job);
    return {
      order: existing ? state.order : [...state.order, id],
      jobs: { ...state.jobs, [id]: progress },
    };
  }
  const existing = state.jobs[e.job_id];
  if (!existing) return state; // event for a job we never saw queued
  if (e.kind === "prep") {
    const stage = prepStage(e.step);
    return {
      ...state,
      jobs: {
        ...state.jobs,
        [e.job_id]: {
          ...existing,
          stage,
          // a new step starts its own bar
          fraction: e.fraction ?? (existing.stage === stage ? existing.fraction : null),
          message: e.message ?? existing.message,
        },
      },
    };
  }
  return {
    ...state,
    jobs: { ...state.jobs, [e.job_id]: applyPipeline(existing, e.event) },
  };
}

/** Seed the reducer state from a `list_jobs` snapshot (page reload). */
export function seedFromSnapshots(snapshots: JobSnapshot[]): JobsState {
  const state: JobsState = { order: [], jobs: {} };
  for (const s of snapshots) {
    state.order.push(s.id);
    state.jobs[s.id] = freshProgress(s);
  }
  return state;
}

/** Progress-screen headline for a job, per its lifecycle + display stage. */
export function progressHeadline(p: JobProgress): string {
  switch (p.job.status) {
    case "queued":
      return "Queued";
    case "running":
      return p.job.cancel_requested
        ? "Cancelling…"
        : DISPLAY_LABELS[p.stage] +
            (p.fraction != null ? ` — ${Math.round(p.fraction * 100)}%` : "");
    case "completed":
      return "Ready";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}
