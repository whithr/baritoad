// The player's frame-time measurement (DESIGN.md Four-Hook Rule; the
// harness is player.rs `MeasurePlan` + PlayerView's recorder). Launches the
// app in measurement mode, waits for the result, closes it, prints a summary.
// It plays the song out loud for the measured window.
//
//   node scripts/measure-player.mjs --song 3 [--theme neon-stage] [--seconds 30]
//        [--fullscreen] [--exe path\to\karaoke-desktop.exe] [--out result.json]
//
// --exe defaults to the release build in the cargo target dir (`pnpm package`
// or `pnpm tauri build`). Report song length, hardware and these numbers
// with any restyle of the stage.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const song = opt("song");
if (!song) {
  console.error("usage: node scripts/measure-player.mjs --song <library id> [--theme <id>] [--seconds 30] [--fullscreen] [--exe <path>] [--out <file>]");
  process.exit(2);
}
const seconds = Number(opt("seconds", "30"));
const out = resolve(opt("out", join(tmpdir(), `baritoad-measure-${Date.now()}.json`)));
let exe = opt("exe");
if (!exe) {
  const { target_directory } = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", join(repo, "Cargo.toml")], { encoding: "utf8" }),
  );
  exe = join(target_directory, "release", process.platform === "win32" ? "karaoke-desktop.exe" : "karaoke-desktop");
}
if (!existsSync(exe)) {
  console.error(`no app at ${exe} — build it first, or pass --exe`);
  process.exit(1);
}
rmSync(out, { force: true });

const env = {
  ...process.env,
  KARAOKE_MEASURE_OUT: out,
  KARAOKE_MEASURE_SONG_ID: song,
  KARAOKE_MEASURE_SECONDS: String(seconds),
  ...(flag("fullscreen") ? { KARAOKE_MEASURE_FULLSCREEN: "1" } : {}),
  ...(opt("theme") ? { KARAOKE_MEASURE_THEME: opt("theme") } : {}),
};
console.log(`measuring song ${song}${opt("theme") ? ` under ${opt("theme")}` : ""} for ${seconds} s (${exe})`);
const app = spawn(exe, [], { env, stdio: "ignore", detached: false });

const deadline = Date.now() + (seconds + 90) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (!existsSync(out) && Date.now() < deadline && app.exitCode == null) await sleep(500);
await sleep(500);
// The app and its import worker.
if (process.platform === "win32") {
  try {
    execFileSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // already gone
  }
} else {
  app.kill();
}
if (!existsSync(out)) {
  console.error("no result — the app closed or the run timed out");
  process.exit(1);
}
const r = JSON.parse(readFileSync(out, "utf8"));
const f = r.frame_ms;
console.log(
  [
    `frames ${r.frames} over ${r.measured_s.toFixed(1)} s (${r.avg_fps.toFixed(1)} fps)`,
    `frame ms p50 ${f.p50.toFixed(2)} · p95 ${f.p95.toFixed(2)} · p99 ${f.p99.toFixed(2)} · max ${f.max.toFixed(2)}`,
    `over 16.9 ms: ${r.over_60fps_budget} · over 34 ms: ${r.over_34ms}`,
    `audio stalls in window: ${r.engine?.stalls_in_window ?? "?"} · device ${r.engine?.device ?? "?"}`,
    `viewport ${r.viewport.w}×${r.viewport.h} @${r.viewport.dpr} · theme ${r.theme?.id ?? "?"} (visualizer ${r.theme?.visualizer ?? "?"}, glow ${r.theme?.glow ?? "?"})`,
    `full result: ${out}`,
  ].join("\n"),
);
