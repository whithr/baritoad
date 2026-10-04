// Typed surface of the Rust commands (src-tauri/src/commands.rs) and the
// `karaoke://job` event channel (src-tauri/src/queue.rs). Keep in sync by
// hand — the payloads are small and stable.

import type { Toad } from "./party/toads";
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
  /** The link the audio comes from (Add from URL). Until the download
   *  finishes, `audio` is the planned path without an extension. */
  source_url?: string;
  /** Looks its lyrics up on LRCLIB before the pipeline runs. */
  lookup_lyrics: boolean;
}

/** A step before the pipeline: download from a link, look lyrics up, or
 *  (gaming mode's pause) wait for a game to let go of the graphics card. */
export type PrepStep = "fetch" | "lyrics" | "wait";

export type JobEvent =
  | { kind: "lifecycle"; job: JobSnapshot }
  | { kind: "pipeline"; job_id: number; event: PipelineEvent }
  | { kind: "prep"; job_id: number; step: PrepStep; fraction?: number; message?: string };

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
  /** Problems the cleanup doesn't fix (LRC timestamps, chords, HTML…). */
  warnings: string[];
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
  lyric_source?: "pasted" | "transcribed" | "imported";
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
  /** High-quality separation: higher overlap + shift-averaging (~3x slower,
   *  cleaner stems). */
  hq_separation?: boolean;
  /** Run the import on the CPU only (leaves the graphics card free; slower). */
  cpu_only?: boolean;
}

export const generateSong = (request: GenerateSongRequest) =>
  invoke<JobSnapshot>("generate_song", { request });

// ---------------------------------------------------------------------------
// bulk import (karaoke-core import.rs — folder scan; commands.rs)
// ---------------------------------------------------------------------------

/** The lyrics a scanned song brings. UltraStar files keep their own timings. */
export type ImportLyrics =
  | { kind: "none" }
  | { kind: "text"; path: string }
  | { kind: "lrc"; path: string }
  | { kind: "ultrastar"; path: string }
  | { kind: "unreadable"; path: string; reason: string };

export interface ImportCandidate {
  audio_path: string;
  title: string;
  artist?: string | null;
  lyrics: ImportLyrics;
  /** Named after the song's folder. */
  collection?: string | null;
  in_library: boolean;
  /** From an UltraStar header, when the song has one. */
  year?: number | null;
  genre?: string | null;
  language?: string | null;
  /** What's worth fixing in its lyrics file by hand (LRC times, chords…). */
  lyrics_warnings: string[];
}

export interface ImportScan {
  items: ImportCandidate[];
  /** .txt / .lrc files no song claimed. */
  unmatched_lyrics: string[];
  /** Songs whose audio can't be decoded (WMA, Opus…), left out of items. */
  unreadable_audio: { path: string; reason: string }[];
}

export interface ImportSongItem {
  audio_path: string;
  title?: string;
  artist?: string;
  lyrics: ImportLyrics;
  collection?: string;
  year?: number;
  genre?: string;
  language?: string;
}

export interface ImportQueued {
  jobs: JobSnapshot[];
  failures: { audio_path: string; message: string }[];
}

/** Find the songs in dropped/picked folders and files, paired with lyrics. */
export const scanImport = (paths: string[]) => invoke<ImportScan>("scan_import", { paths });

/** Queue a reviewed import, one job per song. `lookup_lyrics`: songs that
 *  brought no lyrics look them up on LRCLIB first. */
export const importSongs = (
  items: ImportSongItem[],
  opts: { hq_separation: boolean; cpu_only: boolean; lookup_lyrics?: boolean },
) =>
  invoke<ImportQueued>("import_songs", {
    items,
    hqSeparation: opts.hq_separation,
    cpuOnly: opts.cpu_only,
    lookupLyrics: opts.lookup_lyrics ?? false,
  });

// ---------------------------------------------------------------------------
// add from URL (commands.rs — yt-dlp via karaoke-core fetch.rs) and LRCLIB
// lyrics lookup (karaoke-core lrclib.rs)
// ---------------------------------------------------------------------------

/** One song a checked link points at. */
export interface FoundLink {
  url: string;
  id: string;
  title: string;
  artist?: string | null;
  duration_s?: number | null;
  /** yt-dlp's name for the site ("Youtube", "ArchiveOrg"). */
  site: string;
  thumbnail?: string | null;
  /** Who posted it ("Artist - Topic" is YouTube's auto-generated album
   *  audio), when the site says. */
  channel?: string | null;
  /** Fetched before — the library has it. */
  in_library: boolean;
}

export interface LinksChecked {
  links: FoundLink[];
  failures: { url: string; message: string }[];
}

/** What pasted links point at (a playlist lists its songs). Takes a few
 *  seconds per link. */
export const checkLinks = (urls: string[]) => invoke<LinksChecked>("check_links", { urls });

export interface LinkItem {
  url: string;
  id: string;
  title: string;
  artist?: string;
  duration_s?: number;
  thumbnail?: string;
  /** Lyrics pasted in the review list (the job skips the online lookup). */
  lyrics_text?: string;
}

/** Queue reviewed links: each downloads, finds its lyrics, then imports. */
export const queueLinks = (
  items: LinkItem[],
  opts: { collection?: string; lookup_lyrics: boolean; hq_separation: boolean; cpu_only: boolean; playback_speed: boolean },
) =>
  invoke<ImportQueued>("queue_links", {
    items,
    collection: opts.collection ?? null,
    lookupLyrics: opts.lookup_lyrics,
    hqSeparation: opts.hq_separation,
    cpuOnly: opts.cpu_only,
    playbackSpeed: opts.playback_speed,
  });

/** YouTube Music's search for these words, in the person's browser (the
 *  review list's Find Album Version; the app doesn't fetch anything). */
export const searchAlbumVersion = (query: string) => invoke<void>("search_album_version", { query });

export interface FoundLyrics {
  text: string;
  track_name: string;
  artist_name: string;
  duration_s?: number | null;
  synced: boolean;
}

/** Look a song's lyrics up on LRCLIB; null when it has none that fit. */
export const findLyrics = (q: { title: string; artist?: string; duration_s?: number }) =>
  invoke<FoundLyrics | null>("find_lyrics", {
    title: q.title,
    artist: q.artist ?? null,
    durationS: q.duration_s ?? null,
  });

// ---------------------------------------------------------------------------
// gaming mode (src-tauri/src/gaming.rs)
// ---------------------------------------------------------------------------

export type GamePolicy = "cpu" | "pause" | "gpu";

export interface GameStatus {
  gaming: boolean;
  /** The app in front ("RuneLite") while one is detected. */
  app?: string;
  gpu_percent?: number;
  /** False where detection isn't available. */
  supported: boolean;
}

export const setGamePolicy = (policy: GamePolicy) => invoke<void>("set_game_policy", { policy });
export const gameStatus = () => invoke<GameStatus>("game_status");

/** Run a failed or cancelled job again (a link whose download failed). */
export const retryJob = (jobId: number) => invoke<JobSnapshot>("retry_job", { jobId });

/** The lyrics the job in `outDir` last ran with; null when it transcribed
 *  (or never got as far as saving them). */
export const jobLyrics = (outDir: string) => invoke<string | null>("job_lyrics", { outDir });

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
  /** Save As: write the one format here (its extension must match). */
  out_path?: string;
}) => invoke<string[]>("export_song", { request });

/** Open the file's folder with the file selected. */
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
/** The installed THIRD-PARTY-NOTICES.txt, in the system text viewer. */
export const openNotices = () => invoke<void>("open_notices");

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
  /** Release year (tags, UltraStar header, or Song › Properties). */
  year?: number | null;
  genre?: string | null;
  /** Words per minute while singing, measured from our own timings. */
  pace_wpm?: number | null;
}

/** What Song › Properties edits. */
export interface SongDetails {
  title: string;
  artist?: string | null;
  year?: number | null;
  genre?: string | null;
  /** Omit to keep the current language. */
  language_tag?: string | null;
}

export const songUpdateDetails = (songId: number, details: SongDetails) =>
  invoke<Song>("song_update_details", { songId, details });

/** Library rows changed behind the webview's back (the startup backfill of
 *  year / genre / pace). */
export const onLibraryChanged = (handler: () => void): Promise<UnlistenFn> =>
  listen("karaoke://library", () => handler());

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
  /** Who's singing it (party mode); null for the host's own picks. */
  singer?: string | null;
  toad?: Toad | null;
  /** The party guest who picked it (per-party id). */
  guest?: string | null;
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

/** Up next plus the entry on the Stage. An entry stays listed while it's
 *  sung and leaves when its song finishes or is skipped (library.rs). */
export interface QueueState {
  entries: QueueEntry[];
  playing: number | null;
}

export const queueList = () => invoke<QueueEntry[]>("queue_list");

export const queueState = () => invoke<QueueState>("queue_state");

export const queueAdd = (songId: number, fromCollection?: number) =>
  invoke<QueueEntry>("queue_add", { songId, fromCollection: fromCollection ?? null });

/** Several songs in this order; ones without timings are skipped. Returns
 *  how many were queued. */
export const queueAddMany = (songIds: number[], fromCollection?: number) =>
  invoke<number>("queue_add_many", { songIds, fromCollection: fromCollection ?? null });

export const queueRemove = (entryId: number) => invoke<boolean>("queue_remove", { entryId });

export const queueMoveEntry = (entryId: number, toIndex: number) =>
  invoke<void>("queue_move", { entryId, toIndex });

export const queueClear = () => invoke<void>("queue_clear");

/** About to sing this entry (an entry playing before it leaves the list). */
export const queuePlay = (entryId: number) => invoke<QueueEntry>("queue_play", { entryId });

/** Left the player mid-song: the unfinished entry stays first in line. */
export const queueStop = () => invoke<void>("queue_stop");

/** This song reached its end; if it was the queued entry being sung, it
 *  leaves the list. Returns the queue as it is now. */
export const queueFinish = (songId: number) => invoke<QueueState>("queue_finish", { songId });

// ---------------------------------------------------------------------------
// model packs (src-tauri/src/models.rs, karaoke-core models)
// ---------------------------------------------------------------------------

export type ModelPack = "core" | "transcription" | "high_quality";

export interface PackStatus {
  pack: ModelPack;
  /** Every file at its current version. */
  installed: boolean;
  /** Every file there, maybe an older version — enough to run. */
  usable: boolean;
  outdated: string[];
  missing: string[];
  bytes_total: number;
  bytes_present: number;
}

/** One model (a pack holds one or two), as the download dialogs list them. */
export interface ModelStatus {
  /** "htdemucs" · "wav2vec2" · "whisper-small" · "htdemucs_ft_vocals" */
  model: string;
  pack: ModelPack;
  installed: boolean;
  usable: boolean;
  bytes_total: number;
  bytes_present: number;
}

export interface ModelsInfo {
  packs: PackStatus[];
  /** The same files by model, in download order. */
  models: ModelStatus[];
  /** Where downloads come from. */
  mirror: string;
  downloading: boolean;
}

export type ModelEvent =
  | {
      kind: "progress";
      progress: { pack: ModelPack; file: string; done: number; total: number; model: string; model_done: number; model_total: number };
    }
  | { kind: "done"; pack: ModelPack }
  | { kind: "failed"; pack: ModelPack; message: string }
  | { kind: "cancelled"; pack: ModelPack }
  | { kind: "finished" };

export const modelsStatus = () => invoke<ModelsInfo>("models_status");
export const modelsDownload = (packs: ModelPack[]) => invoke<void>("models_download", { packs });
export const modelsCancel = () => invoke<void>("models_cancel");
export const onModelsEvent = (handler: (e: ModelEvent) => void): Promise<UnlistenFn> =>
  listen<ModelEvent>("karaoke://models", (event) => handler(event.payload));

// ---------------------------------------------------------------------------
// party mode (src-tauri/src/party.rs, docs/PARTY.md)
// ---------------------------------------------------------------------------

export type PartyPhase = "off" | "connecting" | "open" | "reconnecting" | "ended";

export interface PartyGuest {
  id: string;
  name: string;
  toad: Toad;
}

export interface PartyStatus {
  phase: PartyPhase;
  join_url?: string | null;
  /** The join QR: a size×size grid; `path` draws the dark modules. */
  qr?: { size: number; path: string } | null;
  guests: PartyGuest[];
  message?: string | null;
  /** The relay's address, said plainly in the Party dialog. */
  relay: string;
}

export const partyStatus = () => invoke<PartyStatus>("party_status");
export const partyStart = () => invoke<PartyStatus>("party_start");
export const partyStop = () => invoke<void>("party_stop");
export const partyNewCode = () => invoke<void>("party_new_code");
export const partyKick = (guest: string) => invoke<void>("party_kick", { guest });
export const onPartyEvent = (handler: (s: PartyStatus) => void): Promise<UnlistenFn> =>
  listen<PartyStatus>("karaoke://party", (event) => handler(event.payload));

/** A hardware media key (Windows SMTC), sent to the Stage (media_keys.rs). */
export type MediaKey = "play" | "pause" | "toggle" | "next" | "previous" | "stop";

export const onMediaKey = (handler: (k: MediaKey) => void): Promise<UnlistenFn> =>
  listen<MediaKey>("baritoad://media", (event) => handler(event.payload));

/** Tell the OS "now playing" panel what the Stage is playing. */
export const mediaNowPlaying = (now: {
  title?: string | null;
  artist?: string | null;
  duration_s?: number | null;
  state: "playing" | "paused" | "stopped";
  position_s?: number | null;
}) => invoke<void>("media_now_playing", { now });

/** Every queue change, from either window (karaoke://queue). */
export const onQueueChanged = (handler: (q: QueueState) => void): Promise<UnlistenFn> =>
  listen<QueueState>("karaoke://queue", (event) => handler(event.payload));

export const readCover = (path: string) => invoke<string>("read_cover", { path });

/** Copy a picked picture into the covers folder; returns its stored path
 *  (preview it with readCover). Nothing changes until songSetCover. */
export const coverImportImage = (srcPath: string) => invoke<string>("cover_import_image", { srcPath });

/** Use a stored cover for this song (null clears it). Survives re-imports. */
export const songSetCover = (songId: number, coverPath: string | null) =>
  invoke<Song>("song_set_cover", { songId, coverPath });

// ---------------------------------------------------------------------------
// player themes (src-tauri/src/theme.rs — background images only; themes
// themselves are webview data, see themes.ts)
// ---------------------------------------------------------------------------

/** Copy a user-picked image into the app's themes dir; returns the stored
 *  path a ThemeSpec background records. */
export const themeImportImage = (srcPath: string) =>
  invoke<string>("theme_import_image", { srcPath });

/** Read an imported theme background as a data URL (CSP allows data: only). */
export const readThemeImage = (path: string) =>
  invoke<string>("read_theme_image", { path });

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
  /** Original-song seconds already decoded and playable (streaming load
   *  progress; == duration once the background fill completes). */
  loaded_seconds: number;
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
  /** A Player Theme id to measure under. */
  theme?: string | null;
}

export const measurePlan = () => invoke<MeasurePlan | null>("measure_plan");
export const measureWrite = (json: string) => invoke<void>("measure_write", { json });
