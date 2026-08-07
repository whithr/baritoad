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
  /** Library row id once the completed job registered. */
  library_song_id?: number;
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

// ---------------------------------------------------------------------------
// library (src-tauri/src/library.rs — SQLite store in karaoke-core)
// ---------------------------------------------------------------------------

export interface Song {
  id: number;
  title: string;
  artist?: string | null;
  album?: string | null;
  audio_path: string;
  audio_hash: string;
  job_dir: string;
  timing_map_path?: string | null;
  vocals_path?: string | null;
  instrumental_path?: string | null;
  duration_s?: number | null;
  cover_path?: string | null;
  lyric_source?: string | null;
  language_tag: string;
  date_added: number;
  last_played?: number | null;
  play_count: number;
  /** Unix seconds of "Looks good" / a timing-fix save; null = needs review. */
  reviewed_at?: number | null;
}

export type SongSort = "recently_added" | "recently_played" | "title" | "collection_order";

export interface SongQuery {
  search?: string;
  sort?: SongSort;
  collection?: number;
}

export interface CollectionInfo {
  id: number;
  name: string;
  created: number;
  song_count: number;
}

export interface QueueEntry {
  id: number;
  position: number;
  added_from_collection?: number | null;
  song: Song;
}

export interface ProbeResult {
  title: string;
  artist?: string;
  album?: string;
  duration_s?: number;
  cover_data_url?: string;
  from_tags: boolean;
}

export const probeAudio = (path: string) => invoke<ProbeResult>("probe_audio", { path });

export const librarySongs = (query?: SongQuery) =>
  invoke<Song[]>("library_songs", { query });

export const libraryDeleteSong = (songId: number) =>
  invoke<boolean>("library_delete_song", { songId });

export const libraryCollections = () => invoke<CollectionInfo[]>("library_collections");

export const collectionCreate = (name: string) =>
  invoke<CollectionInfo>("collection_create", { name });

export const collectionRename = (collectionId: number, name: string) =>
  invoke<void>("collection_rename", { collectionId, name });

export const collectionDelete = (collectionId: number) =>
  invoke<boolean>("collection_delete", { collectionId });

export const collectionAddSong = (collectionId: number, songId: number) =>
  invoke<void>("collection_add_song", { collectionId, songId });

export const collectionRemoveSong = (collectionId: number, songId: number) =>
  invoke<boolean>("collection_remove_song", { collectionId, songId });

export const songCollections = (songId: number) =>
  invoke<number[]>("song_collections", { songId });

export const queueList = () => invoke<QueueEntry[]>("queue_list");

export const queueAdd = (songId: number, fromCollection?: number) =>
  invoke<QueueEntry>("queue_add", { songId, fromCollection: fromCollection ?? null });

export const queueRemove = (entryId: number) => invoke<boolean>("queue_remove", { entryId });

export const queueMoveEntry = (entryId: number, toIndex: number) =>
  invoke<void>("queue_move", { entryId, toIndex });

export const queueClear = () => invoke<void>("queue_clear");

export const readCover = (path: string) => invoke<string>("read_cover", { path });

// ---------------------------------------------------------------------------
// review screen (src-tauri/src/review.rs — preview, fix editor, exports)
// ---------------------------------------------------------------------------

/** Absolute paths, already allowed in the asset scope — feed each through
 *  convertFileSrc() before handing to an <audio> element. */
export interface PlaybackSources {
  instrumental?: string;
  vocals?: string;
  original?: string;
}

export const playbackSources = (args: { songId?: number; mapPath?: string }) =>
  invoke<PlaybackSources>("playback_sources", {
    songId: args.songId ?? null,
    mapPath: args.mapPath ?? null,
  });

export interface RealignedWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export const realignSelection = (request: {
  vocals_path: string;
  window_start: number;
  window_end: number;
  words: string[];
}) => invoke<RealignedWord[]>("realign_selection", { request });

/** Atomic save with .bak; resolves to the saved map's content hash
 *  (stale-export tracking). */
export const saveTimingMap = (path: string, map: TimingMap) =>
  invoke<string>("save_timing_map", { path, map });

export const songSetReviewed = (songId: number, reviewed: boolean) =>
  invoke<void>("song_set_reviewed", { songId, reviewed });

export const librarySong = (songId: number) =>
  invoke<Song | null>("library_song", { songId });

export interface ExportStatusEntry {
  path: string;
  map_sha256: string;
  written_unix: number;
  exists: boolean;
}

export interface ExportStatus {
  current_map_sha256: string;
  exports: Partial<Record<string, ExportStatusEntry>>;
}

export const exportStatus = (mapPath: string) =>
  invoke<ExportStatus>("export_status", { mapPath });

export interface VocalLevels {
  version: number;
  bins_per_second: number;
  source_len: number;
  source_mtime_unix: number;
  /** Peak per bin, normalized to the stem's own loudest bin, 0–255. */
  peaks: number[];
}

/** Peak envelope of the vocal stem (computed once, cached in a sidecar
 *  beside it) — the fix editor's level display. */
export const vocalLevels = (vocalsPath: string) =>
  invoke<VocalLevels>("vocal_levels", { vocalsPath });

// ---------------------------------------------------------------------------
// performance player (src-tauri/src/player.rs — the cpal engine's UI surface;
// the review player above stays webview <audio> and is untouched)
// ---------------------------------------------------------------------------

export type PlayerTransportState = "stopped" | "playing" | "paused" | "finished" | "unloaded";

export type StretchConfigName = "default" | "low_latency";

/** Host-side engine snapshot. `position` is ORIGINAL-SONG seconds (PLAN.md
 *  §5): the engine clock already translated through any stretch ratio — the
 *  UI compares it against timing-map times directly, never converts. */
export interface PlayerStatus {
  state: PlayerTransportState;
  position: number;
  duration: number;
  guide: number;
  pitch: number;
  tempo: number;
  stretch_config: StretchConfigName;
  song_id?: number | null;
  /** Only the original mix loaded (stems missing) — the guide is inert. */
  single_source: boolean;
  device?: string | null;
  callbacks: number;
  stalls: number;
  max_gap_ms: number;
  stretch_engaged: boolean;
  mmcss: string;
}

export type PlayerPushEvent =
  | { kind: "status"; status: PlayerStatus }
  | { kind: "completed"; position: number };

export const playerLoad = (args: {
  songId?: number;
  mapPath?: string;
  autoplay?: boolean;
}) =>
  invoke<PlayerStatus>("player_load", {
    songId: args.songId ?? null,
    mapPath: args.mapPath ?? null,
    autoplay: args.autoplay ?? null,
  });

export const playerPlay = () => invoke<void>("player_play");
export const playerPause = () => invoke<void>("player_pause");
export const playerStop = () => invoke<void>("player_stop");
export const playerSeek = (position: number) => invoke<void>("player_seek", { position });
export const playerSetGuide = (gain: number) => invoke<void>("player_set_guide", { gain });
export const playerSetPitch = (semitones: number) =>
  invoke<void>("player_set_pitch", { semitones });
export const playerSetTempo = (rate: number) => invoke<void>("player_set_tempo", { rate });
export const playerSetStretchConfig = (config: StretchConfigName) =>
  invoke<void>("player_set_stretch_config", { config });
export const playerStatus = () => invoke<PlayerStatus>("player_status");
export const playerUnload = () => invoke<void>("player_unload");

export const onPlayerEvent = (handler: (e: PlayerPushEvent) => void): Promise<UnlistenFn> =>
  listen<PlayerPushEvent>("karaoke://player", (event) => handler(event.payload));

// Dev measurement harness (inert unless the app was launched with
// KARAOKE_MEASURE_* env vars — src-tauri/src/player.rs).
export interface MeasurePlan {
  song_id?: number | null;
  map_path?: string | null;
  seconds: number;
  out_path: string;
  pitch?: number | null;
  tempo?: number | null;
  fullscreen?: boolean;
}

export const measurePlan = () => invoke<MeasurePlan | null>("measure_plan");
export const measureWrite = (json: string) => invoke<void>("measure_write", { json });
