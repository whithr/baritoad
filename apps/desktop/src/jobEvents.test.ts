// Progress event reducer tests — the seam between karaoke-core's four-stage
// event stream and the two-stage honest display (PLAN.md §4).

import { describe, expect, it } from "vitest";
import type { JobEvent, JobSnapshot, PipelineEvent } from "./api";
import {
  displayStage,
  emptyJobsState,
  progressHeadline,
  reduceJobEvent,
  seedFromSnapshots,
  type JobsState,
} from "./jobEvents";

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: 1,
  audio: "C:\\music\\song.mp3",
  title: "song",
  out_dir: "C:\\music\\song-karaoke",
  status: "queued",
  cancel_requested: false,
  queued_unix: 1_700_000_000,
  lookup_lyrics: false,
  ...over,
});

const lifecycle = (over: Partial<JobSnapshot> = {}): JobEvent => ({
  kind: "lifecycle",
  job: job(over),
});

const pipe = (event: PipelineEvent, job_id = 1): JobEvent => ({
  kind: "pipeline",
  job_id,
  event,
});

function feed(events: JobEvent[], from: JobsState = emptyJobsState): JobsState {
  return events.reduce(reduceJobEvent, from);
}

describe("displayStage mapping", () => {
  it("maps separate to stage 1 and everything else to stage 2", () => {
    expect(displayStage("separate")).toBe("separating");
    expect(displayStage("clean_lyrics")).toBe("aligning");
    expect(displayStage("align")).toBe("aligning");
    expect(displayStage("export")).toBe("aligning");
  });
});

describe("reduceJobEvent", () => {
  it("registers a job on its first lifecycle event", () => {
    const s = feed([lifecycle()]);
    expect(s.order).toEqual([1]);
    expect(s.jobs[1].job.status).toBe("queued");
    expect(s.jobs[1].stage).toBe("separating");
  });

  it("never demotes a job on an out-of-order lifecycle event", () => {
    // Queued and Running are emitted from different threads; a stale Queued
    // arriving after Running used to pin the card on STBY for the whole run.
    const s = feed([lifecycle({ status: "running" }), lifecycle({ status: "queued" })]);
    expect(s.jobs[1].job.status).toBe("running");
    // terminal states never regress either
    const t = feed([lifecycle({ status: "completed" })], s);
    const t2 = feed([lifecycle({ status: "running" })], t);
    expect(t2.jobs[1].job.status).toBe("completed");
  });

  it("applies lifecycle events in their natural order unchanged", () => {
    const s = feed([lifecycle({ status: "queued" }), lifecycle({ status: "running" })]);
    expect(s.jobs[1].job.status).toBe("running");
  });

  it("ignores pipeline events for unknown jobs", () => {
    const s = feed([pipe({ type: "stage_started", stage: "separate" }, 99)]);
    expect(s).toBe(emptyJobsState);
  });

  it("tracks separation fraction and message", () => {
    const s = feed([
      lifecycle({ status: "running" }),
      pipe({ type: "stage_started", stage: "separate" }),
      pipe({
        type: "stage_progress",
        stage: "separate",
        fraction: 0.5,
        message: "separating: 8/16 segments (directml)",
      }),
    ]);
    const p = s.jobs[1];
    expect(p.stage).toBe("separating");
    expect(p.fraction).toBe(0.5);
    expect(p.message).toContain("8/16");
    expect(progressHeadline(p)).toBe("Separating vocals — 50%");
  });

  it("moves the display to aligning when separate completes, and stays there through clean_lyrics/align/export", () => {
    const s = feed([
      lifecycle({ status: "running" }),
      pipe({ type: "stage_started", stage: "separate" }),
      pipe({ type: "stage_completed", stage: "separate", seconds: 42.5 }),
      pipe({ type: "stage_started", stage: "clean_lyrics" }),
      pipe({ type: "stage_completed", stage: "clean_lyrics", seconds: 0.01 }),
      pipe({ type: "stage_started", stage: "align" }),
      pipe({
        type: "stage_progress",
        stage: "align",
        message: "whisper pass 1/4",
      }),
    ]);
    const p = s.jobs[1];
    expect(p.stage).toBe("aligning");
    expect(p.stageSeconds.separate).toBe(42.5);
    expect(progressHeadline(p)).toBe("Aligning lyrics");
  });

  it("tracks alignment fraction and shows its percent in the headline", () => {
    const s = feed([
      lifecycle({ status: "running" }),
      pipe({ type: "stage_completed", stage: "separate", seconds: 18.4 }),
      pipe({ type: "stage_started", stage: "align" }),
      pipe({
        type: "stage_progress",
        stage: "align",
        fraction: 0.55,
        message: "whisper: chunk 8/8",
      }),
    ]);
    const p = s.jobs[1];
    expect(p.stage).toBe("aligning");
    expect(p.fraction).toBe(0.55);
    expect(progressHeadline(p)).toBe("Aligning lyrics — 55%");
  });

  it("align stage_started resets the bar; clean_lyrics/export ticks never clobber it", () => {
    const s = feed([
      lifecycle({ status: "running" }),
      pipe({ type: "stage_progress", stage: "separate", fraction: 1 }),
      pipe({ type: "stage_completed", stage: "separate", seconds: 18.4 }),
      pipe({ type: "stage_started", stage: "align" }),
    ]);
    expect(s.jobs[1].fraction).toBeNull();
    const s2 = feed([
      lifecycle({ status: "running" }),
      pipe({ type: "stage_progress", stage: "align", fraction: 0.9 }),
      pipe({ type: "stage_started", stage: "export" }),
      pipe({ type: "stage_progress", stage: "export", message: "writing lrc" }),
    ]);
    expect(s2.jobs[1].fraction).toBe(0.9);
  });

  it("jumps to aligning when separation is skipped via resume", () => {
    const s = feed([
      lifecycle({ status: "running" }),
      pipe({ type: "stage_skipped", stage: "separate", reason: "up to date (stems reused)" }),
      pipe({ type: "stage_started", stage: "align" }),
    ]);
    expect(s.jobs[1].stage).toBe("aligning");
  });

  it("captures the lyric-cleanup one-liner from the clean_lyrics stage", () => {
    const s = feed([
      lifecycle({ status: "running" }),
      pipe({
        type: "stage_progress",
        stage: "clean_lyrics",
        message: "lyric cleanup: removed 4 section headers, expanded one x2 chorus",
      }),
    ]);
    expect(s.jobs[1].cleanupSummary).toBe(
      "removed 4 section headers, expanded one x2 chorus",
    );
  });

  it("records failure from stage_failed and the failed lifecycle", () => {
    const s = feed([
      lifecycle({ status: "running" }),
      pipe({ type: "stage_failed", stage: "align", message: "vocal stem not found" }),
      lifecycle({ status: "failed", error: "vocal stem not found" }),
    ]);
    const p = s.jobs[1];
    expect(p.failure).toBe("vocal stem not found");
    expect(p.job.status).toBe("failed");
    expect(progressHeadline(p)).toBe("Failed");
  });

  it("keeps pipeline progress when a lifecycle refresh arrives", () => {
    const s = feed([
      lifecycle({ status: "running" }),
      pipe({ type: "stage_progress", stage: "separate", fraction: 0.25 }),
      lifecycle({ status: "running", cancel_requested: true }),
    ]);
    const p = s.jobs[1];
    expect(p.fraction).toBe(0.25);
    expect(p.job.cancel_requested).toBe(true);
    expect(progressHeadline(p)).toBe("Cancelling…");
  });

  it("orders multiple jobs by first appearance", () => {
    const s = feed([
      lifecycle({ id: 1 }),
      lifecycle({ id: 2, title: "other" }),
      lifecycle({ id: 1, status: "running" }),
    ]);
    expect(s.order).toEqual([1, 2]);
    expect(s.jobs[1].job.status).toBe("running");
  });

  it("seeds from queue snapshots on reload", () => {
    const s = seedFromSnapshots([job({ id: 3, status: "running" }), job({ id: 4 })]);
    expect(s.order).toEqual([3, 4]);
    expect(progressHeadline(s.jobs[4])).toBe("Queued");
  });
});

describe("prep steps (Add from URL, LRCLIB lookup)", () => {
  const prep = (step: "fetch" | "lyrics", fraction?: number, message?: string): JobEvent => ({
    kind: "prep",
    job_id: 1,
    step,
    fraction,
    message,
  });
  const linkJob = { source_url: "https://example.org/song", lookup_lyrics: true, audio: "C:\\dl\\A - Song [x]" };

  it("a link job starts on downloading and shows the download's percent", () => {
    const s = feed([lifecycle({ ...linkJob, status: "running" }), prep("fetch", 0.4, "Downloading")]);
    expect(s.jobs[1].stage).toBe("downloading");
    expect(progressHeadline(s.jobs[1])).toBe("Downloading — 40%");
  });

  it("each step starts its own bar, and separation takes over after", () => {
    const s = feed([
      lifecycle({ ...linkJob, status: "running" }),
      prep("fetch", 1, "Downloading"),
      prep("lyrics", undefined, "Looking the lyrics up on LRCLIB"),
    ]);
    expect(s.jobs[1].stage).toBe("lyrics");
    expect(s.jobs[1].fraction).toBeNull();
    expect(progressHeadline(s.jobs[1])).toBe("Finding lyrics");
    const t = feed([pipe({ type: "stage_started", stage: "separate" })], s);
    expect(t.jobs[1].stage).toBe("separating");
  });

  it("keeps the step's last message when a tick has none", () => {
    const s = feed([lifecycle({ ...linkJob, status: "running" }), prep("lyrics", undefined, "Lyrics from LRCLIB"), prep("lyrics", 1)]);
    expect(s.jobs[1].message).toBe("Lyrics from LRCLIB");
    expect(s.jobs[1].fraction).toBe(1);
  });

  it("a file job that looks lyrics up starts there; a plain one on separating", () => {
    expect(feed([lifecycle({ lookup_lyrics: true })]).jobs[1].stage).toBe("lyrics");
    expect(feed([lifecycle()]).jobs[1].stage).toBe("separating");
  });
});
