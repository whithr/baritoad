// The Windows installer (NSIS): `pnpm package` from apps/desktop.
//
// Stages what the installer carries beside the app into src-tauri/runtime/
// (gitignored) — DirectML.dll from ort's download, LICENSE.txt and the
// generated THIRD-PARTY-NOTICES.txt — checks the Add from URL tools are
// fetched, then runs `tauri build` with src-tauri/tauri.bundle.json merged
// over tauri.conf.json, so everyday `tauri dev` / `cargo build` never need
// any of it. Extra arguments go to `tauri build` (e.g. `-- --debug`).
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const repo = resolve(app, "..", "..");
const tauriDir = join(app, "src-tauri");
const runtime = join(tauriDir, "runtime");
const extra = process.argv.slice(2).filter((a) => a !== "--");
const debug = extra.includes("--debug");
const step = (s) => console.log(`\n== ${s}`);

if (process.platform !== "win32") {
  console.error("The installer is Windows-only for v1.0 (PLAN.md §3); macOS and Linux build in CI without bundling.");
  process.exit(1);
}

step("Add from URL tools");
const tools = join(tauriDir, "tools");
const versionsPath = join(tools, "VERSIONS.json");
if (!existsSync(versionsPath)) {
  console.error("src-tauri/tools is empty — run `pnpm fetch-tools` first.");
  process.exit(1);
}
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
for (const f of ["yt-dlp.exe", "deno.exe", versions.deno.license, versions["yt-dlp"].source]) {
  if (!existsSync(join(tools, f))) {
    console.error(`missing src-tauri/tools/${f} — run \`pnpm fetch-tools\`.`);
    process.exit(1);
  }
}
console.log(`yt-dlp ${versions["yt-dlp"].version}, Deno ${versions.deno.version}`);

step("DirectML.dll (from ort's download)");
const { target_directory } = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", join(repo, "Cargo.toml")], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const profile = debug ? "debug" : "release";
// Building karaoke-core runs ort-sys, which copies DirectML.dll into the
// profile's folder; the desktop build after it reuses this work.
execFileSync("cargo", ["build", "-p", "karaoke-core", ...(debug ? [] : ["--release"]), "--manifest-path", join(repo, "Cargo.toml")], {
  stdio: "inherit",
});
const dll = join(target_directory, profile, "DirectML.dll");
if (!existsSync(dll)) {
  console.error(`no DirectML.dll in ${dirname(dll)} after building karaoke-core`);
  process.exit(1);
}
mkdirSync(runtime, { recursive: true });
copyFileSync(dll, join(runtime, "DirectML.dll"));
copyFileSync(join(repo, "LICENSE"), join(runtime, "LICENSE.txt"));
console.log(`${dll} (${statSync(dll).size.toLocaleString()} bytes)`);

step("third-party notices");
execFileSync(process.execPath, [join(here, "notices.mjs"), join(runtime, "THIRD-PARTY-NOTICES.txt")], { stdio: "inherit" });

step("tauri build");
execSync(["pnpm", "tauri", "build", "--config", "src-tauri/tauri.bundle.json", ...extra].join(" "), { cwd: app, stdio: "inherit" });

const nsis = join(target_directory, profile, "bundle", "nsis");
const built = existsSync(nsis) ? readdirSync(nsis).filter((f) => f.endsWith(".exe")) : [];
for (const f of built) console.log(`\ninstaller: ${join(nsis, f)} (${statSync(join(nsis, f)).size.toLocaleString()} bytes)`);
