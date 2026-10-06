// The installer: `pnpm package` from apps/desktop. On Windows the NSIS
// installer; on macOS the .app and a .dmg holding it (Apple Silicon).
//
// Stages what the installer carries beside the app into src-tauri/runtime/
// (gitignored) — LICENSE.txt, the generated THIRD-PARTY-NOTICES.txt and, on
// Windows, DirectML.dll from ort's download — checks the Add from URL tools
// are fetched, then runs `tauri build` with the platform's bundle config
// (src-tauri/tauri.bundle.json, or tauri.bundle.macos.json) merged over
// tauri.conf.json, so everyday `tauri dev` / `cargo build` never need any of
// it. Extra arguments go to `tauri build` (e.g. `-- --debug`).
//
// macOS signing: ad-hoc by default (tauri.bundle.macos.json). Set
// APPLE_SIGNING_IDENTITY (a Developer ID Application certificate in the
// keychain) to sign with it instead, plus Tauri's APPLE_* notarization
// variables to notarize.
import { createHash } from "node:crypto";
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

const win = process.platform === "win32";
const mac = process.platform === "darwin";
if (!win && !mac) {
  console.error("Installers are Windows and macOS only; Linux builds (by hand, .github/workflows/platforms.yml) without bundling.");
  process.exit(1);
}
const exe = (name) => (win ? `${name}.exe` : name);

step("Add from URL tools");
const tools = join(tauriDir, "tools");
const versionsPath = join(tools, "VERSIONS.json");
if (!existsSync(versionsPath)) {
  console.error("src-tauri/tools is empty — run `pnpm fetch-tools` first.");
  process.exit(1);
}
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
for (const f of [exe("yt-dlp"), exe("deno"), versions.deno.license, versions["yt-dlp"].source]) {
  if (!existsSync(join(tools, f))) {
    console.error(`missing src-tauri/tools/${f} — run \`pnpm fetch-tools\`.`);
    process.exit(1);
  }
}
console.log(`yt-dlp ${versions["yt-dlp"].version}, Deno ${versions.deno.version}`);

const { target_directory } = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", join(repo, "Cargo.toml")], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const profile = debug ? "debug" : "release";
mkdirSync(runtime, { recursive: true });
copyFileSync(join(repo, "LICENSE"), join(runtime, "LICENSE.txt"));

if (win) {
  step("DirectML.dll (from ort's download)");
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
  copyFileSync(dll, join(runtime, "DirectML.dll"));
  console.log(`${dll} (${statSync(dll).size.toLocaleString()} bytes)`);
}

step("third-party notices");
execFileSync(process.execPath, [join(here, "notices.mjs"), join(runtime, "THIRD-PARTY-NOTICES.txt")], { stdio: "inherit" });

step("tauri build");
const bundleConfig = win ? "src-tauri/tauri.bundle.json" : "src-tauri/tauri.bundle.macos.json";
execSync(["pnpm", "tauri", "build", "--config", bundleConfig, ...extra].join(" "), { cwd: app, stdio: "inherit" });

// The installer, with the sha-256 the release notes carry.
const [kind, ext] = win ? ["nsis", ".exe"] : ["dmg", ".dmg"];
const out = join(target_directory, profile, "bundle", kind);
const built = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(ext)) : [];
for (const f of built) {
  const p = join(out, f);
  const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
  console.log(`\ninstaller: ${p} (${statSync(p).size.toLocaleString()} bytes)\nsha-256: ${sha}`);
}
