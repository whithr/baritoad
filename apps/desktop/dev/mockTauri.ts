// Browser-only stand-in for the Tauri API surface, so the webview UI can be
// exercised (and screenshotted) without the Rust shell. Wired in by
// vite.mock.config.ts via aliases; never bundled by the real build.

type Word = {
  word: string;
  start: number;
  end: number;
  confidence: number;
  anchored: boolean;
  unsung: boolean;
  line?: number;
  word_in_line?: number;
  ad_lib: boolean;
};

const LYRICS = [
  "Well the tide",
  "came in this morning",
  "and the boats all drifted out",
  "oh oh, oh, oh",
  "",
  "We rowed all night",
  "We rowed all night to reach the shore",
  "The tide came and was turning",
  "and the boats all drifted out",
  "oh oh, oh, oh",
  "",
  "but every time we sail",
  "the lanterns drift into the dark",
  "and we wait by the pier",
  "for the sound of the bell",
  "oh oh, oh, oh",
];

const DURATION = 221;

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function buildWords(): Word[] {
  const rnd = seeded(7);
  const words: Word[] = [];
  let t = 12;
  let line = 0;
  for (const text of LYRICS) {
    if (text === "") {
      t += 8;
      continue;
    }
    const toks = text.split(" ");
    toks.forEach((w, k) => {
      const dur = 0.18 + w.length * 0.05 + rnd() * 0.15;
      words.push({
        word: w,
        start: Number(t.toFixed(3)),
        end: Number((t + dur).toFixed(3)),
        confidence: rnd() < 0.12 ? 0.2 + rnd() * 0.25 : 0.7 + rnd() * 0.3,
        anchored: false,
        unsung: false,
        line,
        word_in_line: k,
        ad_lib: false,
      });
      t += dur + 0.12 + rnd() * 0.2;
    });
    t += 1.4 + rnd() * 0.8;
    line++;
  }
  return words;
}

const WORDS = buildWords();
const MAP = { version: 1, time_base: "original", duration: DURATION, lyric_source: "pasted", words: WORDS, unsung_spans: [] };

function levels() {
  const bps = 100;
  const n = Math.round(DURATION * bps);
  const peaks = new Array(n).fill(0);
  const rnd = seeded(3);
  for (const w of WORDS) {
    const b0 = Math.floor(w.start * bps);
    const b1 = Math.ceil(w.end * bps);
    for (let b = b0; b < b1; b++) {
      const ph = (b - b0) / Math.max(1, b1 - b0);
      peaks[b] = Math.round(255 * (0.45 + 0.5 * Math.sin(ph * Math.PI)) * (0.7 + rnd() * 0.3));
    }
  }
  for (let b = 0; b < n; b++) if (peaks[b] === 0) peaks[b] = Math.round(rnd() * 18);
  return { version: 1, bins_per_second: bps, source_len: 0, source_mtime_unix: 0, peaks };
}

function silentWav(seconds: number): string {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, "data"); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
let wavUrl: string | null = null;

const SONGS = [
  { id: 1, title: "Turning Tide", artist: "The Mock Harbor", audio_path: "C:/music/turning-tide.mp3", audio_hash: "a", job_dir: "j1", timing_map_path: "C:/jobs/turning-tide/map.json", vocals_path: "C:/jobs/turning-tide/vocals.wav", instrumental_path: "C:/jobs/turning-tide/inst.wav", duration_s: DURATION, language_tag: "en", date_added: 1, play_count: 0, reviewed_at: 1 },
  { id: 2, title: "Wildflowers", artist: "Tom Petty", audio_path: "C:/music/wildflowers.mp3", audio_hash: "b", job_dir: "j2", timing_map_path: "C:/jobs/wildflowers/map.json", duration_s: 190, language_tag: "en", date_added: 2, play_count: 3, reviewed_at: null },
  { id: 3, title: "Dogs", artist: "Pink Floyd", audio_path: "C:/music/dogs.mp3", audio_hash: "c", job_dir: "j3", timing_map_path: null, duration_s: 1020, language_tag: "en", date_added: 3, play_count: 0, reviewed_at: null },
  { id: 4, title: "Falling Out of Love", artist: null, audio_path: "C:/music/fool.mp3", audio_hash: "d", job_dir: "j4", timing_map_path: "C:/jobs/fool/map.json", duration_s: 233, language_tag: "en", date_added: 4, play_count: 1, reviewed_at: 5 },
  { id: 5, title: "Back On My BS", artist: "Pip", audio_path: "C:/music/bs.mp3", audio_hash: "e", job_dir: "j5", timing_map_path: "C:/jobs/bs/map.json", duration_s: 201, language_tag: "en", date_added: 5, play_count: 0, reviewed_at: 9 },
  { id: 6, title: "Harvest Moon", artist: "Neil Young", audio_path: "C:/music/moon.mp3", audio_hash: "f", job_dir: "j6", timing_map_path: null, duration_s: 303, language_tag: "en", date_added: 6, play_count: 0, reviewed_at: null },
  { id: 7, title: "99 Luftballons", artist: "Nena", audio_path: "C:/music/nena.mp3", audio_hash: "g", job_dir: "j7", timing_map_path: "C:/jobs/nena/map.json", duration_s: 232, language_tag: "de", date_added: 7, play_count: 2, reviewed_at: 9 },
  { id: 8, title: "Africa", artist: "Toto", audio_path: "C:/music/africa.mp3", audio_hash: "h", job_dir: "j8", timing_map_path: "C:/jobs/africa/map.json", duration_s: 295, language_tag: "en", date_added: 8, play_count: 6, reviewed_at: 9 },
  { id: 9, title: "Lose Yourself", artist: "Eminem", audio_path: "C:/music/lose.mp3", audio_hash: "i", job_dir: "j9", timing_map_path: "C:/jobs/lose/map.json", duration_s: 326, language_tag: "en", date_added: 9, play_count: 0, reviewed_at: 9 },
  { id: 10, title: "Waterloo", artist: "ABBA", audio_path: "C:/music/waterloo.mp3", audio_hash: "k", job_dir: "j10", timing_map_path: "C:/jobs/waterloo/map.json", duration_s: 168, language_tag: "en", date_added: 10, play_count: 1, reviewed_at: 9 },
];
// Categories (Browse / Group by / search): year, genre, pace — and two songs
// added "this week" so Recently added isn't empty.
const CATEGORY: Record<number, { year?: number; genre?: string; pace_wpm?: number; recent?: boolean }> = {
  1: { year: 2017, genre: "Indie Rock", pace_wpm: 132, recent: true },
  2: { year: 1994, genre: "Rock", pace_wpm: 98 },
  4: { year: 2019, genre: "Pop", pace_wpm: 118 },
  5: { year: 2020, genre: "Pop", pace_wpm: 176, recent: true },
  7: { year: 1983, genre: "Pop", pace_wpm: 141 },
  8: { year: 1982, genre: "Rock", pace_wpm: 104 },
  9: { year: 2002, genre: "Hip Hop", pace_wpm: 262 },
  10: { year: 1974, genre: "Pop", pace_wpm: 150 },
};
for (const s of SONGS as Record<string, unknown>[]) {
  const c = CATEGORY[s.id as number];
  if (!c) continue;
  Object.assign(s, { year: c.year, genre: c.genre, pace_wpm: c.pace_wpm });
  if (c.recent) s.date_added = Math.floor(Date.now() / 1000) - 2 * 86400;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const r = (v: unknown) => v as T;
  switch (cmd) {
    case "list_jobs":
      return r({
        active: [
          { id: 40, audio: "C:/music/fool.mp3", title: "Falling Out of Love", out_dir: "j4", status: "failed", error: "align: the vocals track is silent", cancel_requested: false, queued_unix: 0 },
          { id: 41, audio: "C:/music/dogs.mp3", title: "Dogs", out_dir: "j3", status: "running", cancel_requested: false, queued_unix: 0 },
        ],
        registry: [],
      });
    case "job_lyrics":
      // The failed job ran with pasted lyrics; the rest transcribed.
      return r(args?.outDir === "j4" ? LYRICS.join("\n") : null);
    case "library_songs": {
      // ?empty shows a first-run library. Collection 1 is Cassie's hits
      // (one of them still without timings); 2 is everything else.
      if (new URLSearchParams(location.search).has("empty")) return r([]);
      const coll = (args?.query as { collection?: number } | undefined)?.collection;
      const cassie = [1, 5, 6, 9];
      if (coll === 1) return r(SONGS.filter((s) => cassie.includes(s.id)));
      if (coll === 2) return r(SONGS.filter((s) => !cassie.includes(s.id)));
      return r(SONGS);
    }
    case "song_update_details": {
      const song = SONGS.find((s) => s.id === args?.songId) as Record<string, unknown> | undefined;
      const d = args?.details as { title: string; artist?: string | null; year?: number | null; genre?: string | null; language_tag?: string | null };
      if (!song) throw new Error("no such song");
      Object.assign(song, { title: d.title, artist: d.artist ?? null, year: d.year ?? null, genre: d.genre ?? null });
      if (d.language_tag) song.language_tag = d.language_tag;
      return r(song);
    }
    case "library_collections":
      return r([{ id: 1, name: "Cassie's hits", created: 0, song_count: 4 }, { id: 2, name: "Christmas party", created: 0, song_count: 6 }]);
    case "library_song":
      return r(SONGS.find((s) => s.id === args?.songId) ?? null);
    case "read_timing_map":
      return r(MAP);
    case "playback_sources":
      return r({ instrumental: "inst.wav", vocals: "vocals.wav", original: "orig.mp3" });
    case "vocal_levels":
      return r(levels());
    case "queue_list":
      return r(mockQueue().entries);
    case "queue_state":
      return r(mockQueue());
    case "queue_add": {
      const song = SONGS.find((s) => s.id === args?.songId);
      if (!song) throw new Error("no such song");
      const q = mockQueue();
      const e = { id: nextEntryId(q), position: q.entries.length, added_from_collection: (args?.fromCollection as number | null) ?? null, song };
      q.entries.push(e);
      saveQueue(q);
      return r(e);
    }
    case "queue_add_many": {
      const q = mockQueue();
      let n = 0;
      for (const id of (args?.songIds as number[]) ?? []) {
        const song = SONGS.find((s) => s.id === id && s.timing_map_path);
        if (!song) continue;
        q.entries.push({ id: nextEntryId(q), position: q.entries.length, added_from_collection: (args?.fromCollection as number | null) ?? null, song });
        n++;
      }
      saveQueue(q);
      return r(n);
    }
    case "queue_remove": {
      const q = mockQueue();
      const before = q.entries.length;
      q.entries = q.entries.filter((e) => e.id !== args?.entryId);
      saveQueue(q);
      return r(q.entries.length < before);
    }
    case "queue_move": {
      const q = mockQueue();
      const from = q.entries.findIndex((e) => e.id === args?.entryId);
      if (from < 0) throw new Error(`no queue entry ${String(args?.entryId)}`);
      const [e] = q.entries.splice(from, 1);
      q.entries.splice(Math.min(Number(args?.toIndex ?? 0), q.entries.length), 0, e);
      saveQueue(q);
      return r(undefined);
    }
    case "queue_clear":
      saveQueue({ entries: [], playing: null });
      return r(undefined);
    case "queue_play": {
      const q = mockQueue();
      const e = q.entries.find((x) => x.id === args?.entryId);
      if (!e) throw new Error("that song isn't in Up next anymore");
      if (q.playing != null && q.playing !== e.id) q.entries = q.entries.filter((x) => x.id !== q.playing);
      q.playing = e.id;
      saveQueue(q);
      return r(e);
    }
    case "queue_finish": {
      const q = mockQueue();
      const cur = q.entries.find((x) => x.id === q.playing);
      if (cur && cur.song.id === args?.songId) {
        q.entries = q.entries.filter((x) => x.id !== cur.id);
        q.playing = null;
      }
      saveQueue(q);
      return r(mockQueue());
    }
    case "export_song": {
      const req = args?.request as { out_path?: string; formats: string[] };
      return r(req.out_path ? [req.out_path] : req.formats.map((f) => `C:\\jobs\\song.${f}`));
    }
    case "reveal_path":
      return r(undefined);
    case "cover_import_image":
      return r("C:\\covers\\0123456789abcdef.png");
    case "song_set_cover": {
      const song = SONGS.find((s) => s.id === args?.songId) as Record<string, unknown> | undefined;
      if (!song) throw new Error("that song isn't in the library anymore");
      song.cover_path = (args?.coverPath as string | null) ?? null;
      return r(song);
    }
    case "queue_stop": {
      const q = mockQueue();
      if (q.playing != null) saveQueue({ ...q, playing: null });
      return r(undefined);
    }
    case "probe_audio":
      return r({ title: "New Song", artist: "Someone", duration_s: 200, from_tags: true });
    case "clean_lyrics_preview":
      return r({ summary: "", lines_kept: 4, words_kept: 20, edits: [], cleaned_text: "" });
    case "save_timing_map":
      return r("hash");
    case "measure_plan":
      return r(null);
    case "generate_song":
      return r(fakeJob(args?.request as { audio_path: string; title?: string; artist?: string }));
    case "scan_import":
      return r(importScan((args?.paths as string[]) ?? []));
    case "import_songs": {
      const items = (args?.items as { audio_path: string; title?: string; artist?: string }[]) ?? [];
      // Imports run one after another, faster than a wizard song.
      return r({ jobs: items.map((i) => fakeJob(i, 0.4)), failures: [] });
    }
    case "cancel_job":
      cancelled.add(args?.jobId as number);
      return r(true);
    case "check_links": {
      // Every link is one song; a link with "fail" in it doesn't work.
      const urls = (args?.urls as string[]) ?? [];
      return new Promise((res) =>
        setTimeout(
          () =>
            res({
              links: urls
                .filter((u) => !/fail/i.test(u))
                .map((u, i) => ({ url: u, id: `v${i}`, title: `Linked Song ${i + 1}`, artist: "Some Band", duration_s: 180 + i * 7, site: "Youtube", in_library: false })),
              failures: urls.filter((u) => /fail/i.test(u)).map((u) => ({ url: u, message: "Video unavailable" })),
            }),
          900,
        ),
      );
    }
    case "queue_links": {
      const items = (args?.items as { url: string; title: string; artist?: string }[]) ?? [];
      return r({ jobs: items.map((i) => fakeJob({ audio_path: `C:/downloads/${i.title}`, title: i.title, artist: i.artist }, 0.4)), failures: [] });
    }
    case "find_lyrics":
      return r({ text: LYRICS.join("\n"), track_name: String(args?.title ?? "Song"), artist_name: String(args?.artist ?? "Someone"), duration_s: 200, synced: true });
    case "game_status":
      return r({ gaming: true, app: "RuneLite", gpu_percent: 18.7, supported: true });
    case "set_game_policy":
      return r(undefined);
    case "retry_job":
      return r(fakeJob({ audio_path: "C:/music/retry.mp3", title: "Retried song" }));
    case "stage_open":
      stageOpen(args?.route as { song_id?: number | null; map_path?: string | null; measure?: boolean });
      return r(undefined);
    case "stage_current":
      return r(null);
    case "stage_focus":
    case "stage_show_on":
      return r(undefined);
    case "player_load": {
      // Loading anything but the entry being sung unmarks it (player.rs).
      const q = mockQueue();
      const cur = q.entries.find((x) => x.id === q.playing);
      if (cur && cur.song.id !== args?.songId) saveQueue({ ...q, playing: null });
      // ?finished loads the song already over (the end-of-song box and the
      // between-songs screen).
      return r({ state: new URLSearchParams(location.search).has("finished") ? "finished" : "playing", position: 0, duration: DURATION, loaded_seconds: DURATION, guide: 0.4, pitch: 0, tempo: 1, stretch_config: "default", song_id: args?.songId ?? null, single_source: false, device: "Mock output", callbacks: 0, stalls: 0, max_gap_ms: 0, stretch_engaged: false, mmcss: "n/a" });
    }
    default:
      return r(undefined);
  }
}

// Up next stand-in. Kept in localStorage so the Library tab and the stage
// tab share one queue, and announced on the event bus like library.rs does.
type MockEntry = { id: number; position: number; added_from_collection?: number | null; song: (typeof SONGS)[number] };
type MockQueue = { entries: MockEntry[]; playing: number | null };
const QUEUE_KEY = "baritoad-mock-queue";
function mockQueue(): MockQueue {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (raw) {
      const q = JSON.parse(raw) as MockQueue;
      return { playing: q.playing, entries: q.entries.map((e, i) => ({ ...e, position: i })) };
    }
  } catch {
    // fall through to the starter queue
  }
  return { entries: [{ id: 1, position: 0, song: SONGS[1] }, { id: 2, position: 1, song: SONGS[3] }, { id: 3, position: 2, song: SONGS[4] }], playing: null };
}
function saveQueue(q: MockQueue) {
  const tidy = { playing: q.entries.some((e) => e.id === q.playing) ? q.playing : null, entries: q.entries.map((e, i) => ({ ...e, position: i })) };
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(tidy));
  } catch {
    // private mode: this tab only
  }
  void emit("karaoke://queue", tidy);
}
const nextEntryId = (q: MockQueue) => Math.max(0, ...q.entries.map((e) => e.id)) + 1;

export function convertFileSrc(_path: string): string {
  if (!wavUrl) wavUrl = silentWav(DURATION);
  return wavUrl;
}

// Events: an in-page bus (fake jobs report progress on it) bridged across
// tabs with a BroadcastChannel, so the stage "window" (a popup tab named
// baritoad-player) and the main tab hear each other like two webviews.
const handlers = new Map<string, Set<(e: { payload: unknown }) => void>>();
const LABEL = typeof window !== "undefined" && window.name === "baritoad-player" ? "player" : "main";
const bus = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("baritoad-mock") : null;
function deliver(event: string, payload: unknown) {
  handlers.get(event)?.forEach((h) => h({ payload }));
}
bus?.addEventListener("message", (m: MessageEvent<{ event: string; payload: unknown; to?: string }>) => {
  if (!m.data.to || m.data.to === LABEL) deliver(m.data.event, m.data.payload);
});
export async function emit(event: string, payload: unknown) {
  deliver(event, payload);
  bus?.postMessage({ event, payload });
}
async function emitTo(to: string, event: string, payload: unknown) {
  if (to === LABEL) deliver(event, payload);
  else bus?.postMessage({ event, payload, to });
}
export async function listen(event: string, handler: (e: { payload: unknown }) => void) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(handler);
  return () => void handlers.get(event)?.delete(handler);
}

// Stage window stand-in: a named popup tab; reusing the name re-targets it.
function stageOpen(route: { song_id?: number | null; map_path?: string | null; measure?: boolean }) {
  const q = new URLSearchParams();
  if (route.song_id != null) q.set("id", String(route.song_id));
  if (route.map_path) q.set("map", route.map_path);
  if (route.measure) q.set("measure", "1");
  const url = `${location.pathname}${location.search}#/play?${q.toString()}`;
  const w = window.open(url, "baritoad-player", "popup,width=1280,height=720");
  if (!w) throw new Error("popup blocked");
  void emitTo("main", "baritoad://stage", { kind: "opened", route });
}
if (LABEL === "player" && typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void emitTo("main", "baritoad://stage", { kind: "closed" }));
}

// A fake pipeline run: ~8 s separating, ~4 s aligning, then done — or, when
// the title mentions "fail", a failure right after separating (drives the
// failure message box).
let nextJob = 100;
const cancelled = new Set<number>();
// Bulk import stand-in: a folder with every lyrics kind, a sub-folder
// collection, a song the library already has, and one that fails (its title
// mentions "fail").
function importScan(paths: string[]) {
  const root = paths.length === 1 && !/\.[a-z0-9]{2,4}$/i.test(paths[0]) ? paths[0] : "D:\\Karaoke\\Party";
  const at = (rel: string) => `${root}\\${rel}`;
  const song = (rel: string, title: string, artist: string | null, lyrics: Record<string, unknown>, collection: string | null) => ({
    audio_path: at(rel),
    title,
    artist,
    lyrics,
    collection,
    in_library: false,
    lyrics_warnings: [] as string[],
  });
  return {
    items: [
      song("ABBA - Waterloo.flac", "Waterloo", "ABBA", { kind: "text", path: at("ABBA - Waterloo.txt") }, null),
      song("Nirvana - Lithium.mp3", "Lithium", "Nirvana", { kind: "none" }, null),
      song("Queen - Bohemian Rhapsody\\Queen - Bohemian Rhapsody.mp3", "Bohemian Rhapsody", "Queen", { kind: "ultrastar", path: at("Queen - Bohemian Rhapsody\\Queen - Bohemian Rhapsody.txt") }, null),
      { ...song("Robyn - Dancing On My Own.mp3", "Dancing On My Own", "Robyn", { kind: "lrc", path: at("Robyn - Dancing On My Own.lrc") }, null), lyrics_warnings: ["3 lines look like chord charts (Am  G  C) — delete them; chords would be timed as sung words"] },
      song("The Failures - Fail Safe.mp3", "Fail Safe", "The Failures", { kind: "none" }, null),
      song("Two Voices - Together.mp3", "Together", "Two Voices", { kind: "unreadable", path: at("Two Voices - Together.txt"), reason: "ultrastar line 5: duet file (P1/P2 voices) — duet import is not supported in v1" }, null),
      song("Christmas\\Mariah Carey - All I Want For Christmas Is You.mp3", "All I Want For Christmas Is You", "Mariah Carey", { kind: "text", path: at("Christmas\\Mariah Carey - All I Want For Christmas Is You.txt") }, "Christmas"),
      song("Christmas\\Wham! - Last Christmas.mp3", "Last Christmas", "Wham!", { kind: "none" }, "Christmas"),
      { ...song("Turning Tide.mp3", "Turning Tide", "The Mock Harbor", { kind: "text", path: at("Turning Tide.txt") }, null), in_library: true },
    ],
    unmatched_lyrics: [at("notes.txt"), at("Christmas\\setlist.txt")],
    unreadable_audio: [{ path: at("Old Recording.wma"), reason: "unsupported codec: core (codec):unsupported codec" }],
  };
}

// The real queue runs one job at a time; so does the stand-in.
let busyUntil = 0;

function fakeJob(req: { audio_path: string; title?: string; artist?: string; out_dir?: string }, speed = 1) {
  const id = nextJob++;
  const fails = /fail/i.test(req.title ?? "");
  const snap = {
    id,
    audio: req.audio_path,
    title: req.title ?? "New Song",
    artist: req.artist,
    out_dir: req.out_dir ?? "C:/jobs/new",
    status: "queued",
    cancel_requested: false,
    queued_unix: 0,
    lookup_lyrics: false,
  };
  const life = (over: Record<string, unknown>) => emit("karaoke://job", { kind: "lifecycle", job: { ...snap, ...over } });
  const pipe = (event: Record<string, unknown>) => emit("karaoke://job", { kind: "pipeline", job_id: id, event });
  setTimeout(() => life({ status: "queued" }), 0);
  const wait = Math.max(0, busyUntil - Date.now());
  const steps: [number, () => void][] = [
    [wait + 300, () => life({ status: "running" })],
    [400, () => pipe({ type: "stage_started", stage: "separate" })],
  ];
  for (let i = 1; i <= 8; i++) {
    steps.push([1000, () => pipe({ type: "stage_progress", stage: "separate", fraction: i / 8, message: `segment ${i} of 8` })]);
  }
  steps.push([200, () => pipe({ type: "stage_completed", stage: "separate", seconds: 8 })]);
  steps.push([200, () => pipe({ type: "stage_started", stage: "align" })]);
  if (fails) {
    steps.push([500, () => pipe({ type: "stage_failed", stage: "align", message: "align: no words found in the vocals" })]);
    steps.push([100, () => life({ status: "failed", error: "align: no words found in the vocals" })]);
  } else {
    for (let i = 1; i <= 4; i++) steps.push([1000, () => pipe({ type: "stage_progress", stage: "align", fraction: i / 4 })]);
    steps.push([300, () => life({ status: "completed", map_path: "C:/jobs/turning-tide/map.json", library_song_id: 1 })]);
  }
  let t = 0;
  for (const [k, [dt, fn]] of steps.entries()) {
    t += k === 0 ? dt : dt * speed; // the queue wait isn't sped up
    setTimeout(() => {
      if (!cancelled.has(id)) fn();
    }, t);
  }
  busyUntil = Date.now() + t;
  const watch = window.setInterval(() => {
    if (cancelled.has(id)) {
      window.clearInterval(watch);
      life({ status: "cancelled" });
    }
  }, 250);
  window.setTimeout(() => window.clearInterval(watch), t + 500);
  return snap;
}
export type UnlistenFn = () => void;

export function getCurrentWebview() {
  return { onDragDropEvent: async () => () => undefined };
}
// Browser stand-in for the frameless window: the caption buttons and the
// title bar's state tracking need these to exist (they no-op here).
export function getCurrentWindow() {
  return {
    label: LABEL,
    setFullscreen: async (on: boolean) => {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen().catch(() => undefined);
      if (!on && document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    },
    isFullscreen: async () => !!document.fullscreenElement,
    isMaximized: async () => false,
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => {
      if (LABEL === "player") window.close();
    },
    setTitle: async (t: string) => {
      document.title = t;
    },
    startDragging: async () => undefined,
    onResized: async () => () => undefined,
    onFocusChanged: async () => () => undefined,
    onCloseRequested: async () => () => undefined,
  };
}
export async function availableMonitors() {
  return [];
}
export type Monitor = { name: string | null; position: { x: number; y: number }; size: { width: number; height: number } };
export async function open(opts?: { filters?: { extensions: string[] }[]; directory?: boolean }) {
  // Folder pickers get a stand-in folder (Import Folder…); audio pickers a
  // stand-in file so the Add Song wizard can be driven.
  if (opts?.directory) return "D:\\Karaoke\\Party";
  if (opts?.filters?.some((f) => f.extensions.includes("png"))) return "C:\\Pictures\\cover.png";
  return opts?.filters?.some((f) => f.extensions.includes("mp3")) ? "C:\\Music\\Night Drive.flac" : null;
}
// Save As: says yes to the suggested name.
export async function save(opts?: { defaultPath?: string }) {
  return opts?.defaultPath ?? null;
}
