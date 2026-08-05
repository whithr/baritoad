// Typed surface of the Rust commands (src-tauri/src/commands.rs) and the
// `karaoke://job` event channel (src-tauri/src/queue.rs). Keep in sync by
// hand — the payloads are small and stable.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type StageId = "separate" | "clean_lyrics" | "align" | "export";

/** karaoke-core PipelineEvent — serde-tagged (`{"type": ...}`). */
export type PipelineEvent =
  | { type: "stage_started"; stage: StageId }
  | { type: "stage_progress"; stage: StageId; fraction?: number; message?: string }
  | { type: "stage_skipped"; stage: StageId; reason: string }
  | { type: "stage_completed"; stage: StageId; seconds: number }
  | { type: "stage_failed"; stage: StageId; message: string }
  | { type: "note"; message: string };

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobSnapshot {
  id: number;
  audio: string;
  title: string;
  artist?: string;
  out_dir: string;
  map_path?: string;
  status: JobStatus;
  error?: string;
  cancel_requested: boolean;
  queued_unix: number;
}

export type JobEvent =
  | { kind: "lifecycle"; job: JobSnapshot }
  | { kind: "pipeline"; job_id: number; event: PipelineEvent };

export interface RegistryJob {
  job_id: string;
  audio: string;
  out_dir: string;
  updated_unix: number;
  status?: string;
  map_path?: string;
  title: string;
  artist?: string;
}

export interface JobsList {
  active: JobSnapshot[];
  registry: RegistryJob[];
}

export interface CleanPreview {
  summary: string;
  lines_kept: number;
  words_kept: number;
  edits: string[];
  cleaned_text: string;
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
  confidence: number;
  anchored: boolean;
  unsung: boolean;
  line?: number;
  word_in_line?: number;
  ad_lib: boolean;
}

export interface TimingMap {
  version: number;
  time_base: string;
  duration: number;
  lyric_source?: "pasted" | "transcribed";
  words: WordTiming[];
  unsung_spans: { first_word: number; last_word: number; start: number; end: number }[];
}

export interface GenerateSongRequest {
  audio_path: string;
  lyrics_text?: string;
  title?: string;
  artist?: string;
  out_dir?: string;
  exports?: string[];
  force?: boolean;
}

export const generateSong = (request: GenerateSongRequest) =>
  invoke<JobSnapshot>("generate_song", { request });

export const cancelJob = (jobId: number) => invoke<JobSnapshot>("cancel_job", { jobId });

export const listJobs = () => invoke<JobsList>("list_jobs");

export const readTimingMap = (path: string) => invoke<TimingMap>("read_timing_map", { path });

export const cleanLyricsPreview = (text: string) =>
  invoke<CleanPreview>("clean_lyrics_preview", { text });

export const exportSong = (request: {
  map_path: string;
  formats: string[];
  title?: string;
  artist?: string;
  audio_name?: string;
}) => invoke<string[]>("export_song", { request });

export const onJobEvent = (handler: (e: JobEvent) => void): Promise<UnlistenFn> =>
  listen<JobEvent>("karaoke://job", (event) => handler(event.payload));
