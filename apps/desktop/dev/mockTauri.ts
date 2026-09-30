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
];

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const r = (v: unknown) => v as T;
  switch (cmd) {
    case "list_jobs":
      return r({ active: [{ id: 41, audio: "C:/music/dogs.mp3", title: "Dogs", out_dir: "j3", status: "running", cancel_requested: false, queued_unix: 0 }], registry: [] });
    case "library_songs":
      return r(SONGS);
    case "library_collections":
      return r([{ id: 1, name: "Cassie's hits", created: 0, song_count: 3 }, { id: 2, name: "Christmas party", created: 0, song_count: 12 }]);
    case "library_song":
      return r(SONGS.find((s) => s.id === args?.songId) ?? null);
    case "read_timing_map":
      return r(MAP);
    case "playback_sources":
      return r({ instrumental: "inst.wav", vocals: "vocals.wav", original: "orig.mp3" });
    case "vocal_levels":
      return r(levels());
    case "queue_list":
      return r([{ id: 1, position: 0, song: SONGS[1] }, { id: 2, position: 1, song: SONGS[3] }, { id: 3, position: 2, song: SONGS[4] }]);
    case "probe_audio":
      return r({ title: "New Song", artist: "Someone", duration_s: 200, from_tags: true });
    case "clean_lyrics_preview":
      return r({ summary: "", lines_kept: 4, words_kept: 20, edits: [], cleaned_text: "" });
    case "save_timing_map":
      return r("hash");
    case "measure_plan":
      return r(null);
    default:
      return r(undefined);
  }
}

export function convertFileSrc(_path: string): string {
  if (!wavUrl) wavUrl = silentWav(DURATION);
  return wavUrl;
}

export async function listen(_event: string, _handler: (e: unknown) => void) {
  return () => undefined;
}
export type UnlistenFn = () => void;

export function getCurrentWebview() {
  return { onDragDropEvent: async () => () => undefined };
}
// Browser stand-in for the frameless window: the caption buttons and the
// title bar's state tracking need these to exist (they no-op here).
export function getCurrentWindow() {
  return {
    label: "main",
    setFullscreen: async () => undefined,
    isFullscreen: async () => false,
    isMaximized: async () => false,
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => undefined,
    setTitle: async (t: string) => {
      document.title = t;
    },
    startDragging: async () => undefined,
    onResized: async () => () => undefined,
    onFocusChanged: async () => () => undefined,
    onCloseRequested: async () => () => undefined,
  };
}
export async function open() {
  return null;
}
