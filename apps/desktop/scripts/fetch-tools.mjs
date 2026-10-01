// Download the external programs Add from URL runs (PLAN.md §5, §6) into
// src-tauri/tools/: yt-dlp (its official release executable) and Deno (the
// JavaScript runtime yt-dlp needs for YouTube). Each download is checked
// against the checksums its release publishes, and nothing is committed —
// src-tauri/tools/ is gitignored except its README.
//
// yt-dlp's release executables are a GPLv3+ combined work, so its tagged
// source tarball is fetched beside the binary for every build that ships it.
//
//   pnpm fetch-tools            # skip what's already there at these versions
//   pnpm fetch-tools --force    # download again

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const YTDLP_VERSION = "2026.08.19";
const DENO_VERSION = "v2.9.7";

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = join(here, "..", "src-tauri", "tools");
const force = process.argv.includes("--force");

const plat = process.platform;
const arch = process.arch;

function ytdlpAsset() {
  if (plat === "win32") return arch === "arm64" ? "yt-dlp_arm64.exe" : "yt-dlp.exe";
  if (plat === "darwin") return "yt-dlp_macos";
  if (plat === "linux") return arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  throw new Error(`no yt-dlp build for ${plat}/${arch}`);
}

function denoAsset() {
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  if (plat === "win32") return `deno-${cpu}-pc-windows-msvc.zip`;
  if (plat === "darwin") return `deno-${cpu}-apple-darwin.zip`;
  if (plat === "linux") return `deno-${cpu}-unknown-linux-gnu.zip`;
  throw new Error(`no Deno build for ${plat}/${arch}`);
}

const exe = (name) => (plat === "win32" ? `${name}.exe` : name);

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": "karaoke-fetch-tools" } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** `<hex>  <name>` lines (sha256sum format, optional `*` binary marker). */
function sumFor(sums, name) {
  for (const line of sums.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  throw new Error(`no checksum listed for ${name}`);
}

/** A one-asset checksum file: `sha256sum` output, or (Deno's Windows
 *  builds) PowerShell `Get-FileHash` output — either way, its only hash. */
function onlySum(text, name) {
  const hashes = text.match(/\b[0-9a-fA-F]{64}\b/g) ?? [];
  if (hashes.length !== 1) throw new Error(`expected one checksum for ${name}, found ${hashes.length}`);
  return hashes[0].toLowerCase();
}

function verify(buf, expected, name) {
  const got = sha256(buf);
  if (got !== expected) throw new Error(`${name}: sha256 ${got} does not match the published ${expected}`);
  return got;
}

function readVersions() {
  try {
    return JSON.parse(readFileSync(join(toolsDir, "VERSIONS.json"), "utf8"));
  } catch {
    return {};
  }
}

async function fetchYtDlp(versions) {
  const target = join(toolsDir, exe("yt-dlp"));
  if (!force && versions["yt-dlp"]?.version === YTDLP_VERSION && existsSync(target)) {
    console.log(`yt-dlp ${YTDLP_VERSION}: already here`);
    return versions["yt-dlp"];
  }
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}`;
  const asset = ytdlpAsset();
  console.log(`yt-dlp ${YTDLP_VERSION}: downloading ${asset} + source`);
  const sums = (await download(`${base}/SHA2-256SUMS`)).toString("utf8");
  const bin = await download(`${base}/${asset}`);
  const binSha = verify(bin, sumFor(sums, asset), asset);
  const src = await download(`${base}/yt-dlp.tar.gz`);
  const srcSha = verify(src, sumFor(sums, "yt-dlp.tar.gz"), "yt-dlp.tar.gz");
  writeFileSync(target, bin);
  if (plat !== "win32") chmodSync(target, 0o755);
  mkdirSync(join(toolsDir, "source"), { recursive: true });
  writeFileSync(join(toolsDir, "source", `yt-dlp-${YTDLP_VERSION}.tar.gz`), src);
  return { version: YTDLP_VERSION, asset, sha256: binSha, source: `source/yt-dlp-${YTDLP_VERSION}.tar.gz`, source_sha256: srcSha };
}

async function fetchDeno(versions) {
  const target = join(toolsDir, exe("deno"));
  if (!force && versions.deno?.version === DENO_VERSION && existsSync(target)) {
    console.log(`Deno ${DENO_VERSION}: already here`);
    return versions.deno;
  }
  const base = `https://github.com/denoland/deno/releases/download/${DENO_VERSION}`;
  const asset = denoAsset();
  console.log(`Deno ${DENO_VERSION}: downloading ${asset}`);
  const sums = (await download(`${base}/${asset}.sha256sum`)).toString("utf8");
  const zip = await download(`${base}/${asset}`);
  const zipSha = verify(zip, onlySum(sums, asset), asset);
  const license = await download(`https://raw.githubusercontent.com/denoland/deno/${DENO_VERSION}/LICENSE.md`);

  const staging = join(toolsDir, ".deno-extract");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const zipPath = join(staging, asset);
  writeFileSync(zipPath, zip);
  // bsdtar reads zip on Windows 10+ and macOS; GNU tar on Linux doesn't.
  // On Windows name System32's bsdtar outright: a Git Bash PATH puts GNU tar
  // first, which takes "C:" for a remote host.
  if (plat === "linux") execFileSync("unzip", ["-o", "-q", zipPath, "-d", staging]);
  else if (plat === "win32") execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zipPath, "-C", staging]);
  else execFileSync("tar", ["-xf", zipPath, "-C", staging]);
  rmSync(target, { force: true });
  renameSync(join(staging, exe("deno")), target);
  rmSync(staging, { recursive: true, force: true });
  if (plat !== "win32") chmodSync(target, 0o755);
  writeFileSync(join(toolsDir, "DENO-LICENSE.md"), license);
  return { version: DENO_VERSION, asset, sha256: zipSha, license: "DENO-LICENSE.md" };
}

// Recorded after each tool, so a failed second download doesn't refetch the
// first.
const saveVersions = (v) => writeFileSync(join(toolsDir, "VERSIONS.json"), JSON.stringify(v, null, 2) + "\n");

mkdirSync(toolsDir, { recursive: true });
const versions = readVersions();
versions["yt-dlp"] = await fetchYtDlp(versions);
saveVersions(versions);
versions.deno = await fetchDeno(versions);
saveVersions(versions);
console.log(`tools ready in ${toolsDir}`);
