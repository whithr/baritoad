// THIRD-PARTY-NOTICES.txt for the installer (scripts/package.mjs): every
// Rust crate the desktop app links on Windows, every production npm package
// in the webview bundle, and the parts that aren't packages (ONNX Runtime,
// DirectML, Signalsmith Stretch, yt-dlp, Deno, fonts, models). License texts
// come from each package's own files; identical texts are printed once.
//
//   node scripts/notices.mjs [out-file]
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const repo = resolve(app, "..", "..");
const out = process.argv[2] ?? join(app, "src-tauri", "runtime", "THIRD-PARTY-NOTICES.txt");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-_.].*)?$/i;

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n").trim();
function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile() && statSync(p).size < 256 * 1024)
    .sort();
}

// ------------------------------------------------------------ Rust crates

const meta = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc", "--manifest-path", join(repo, "Cargo.toml")],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  ),
);
const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const members = new Set(meta.workspace_members);
const root = meta.packages.find((p) => p.name === "karaoke-desktop" && members.has(p.id));
const seen = new Set();
const stack = [root.id];
while (stack.length) {
  const id = stack.pop();
  if (seen.has(id)) continue;
  seen.add(id);
  for (const d of nodes.get(id)?.deps ?? []) {
    // Normal dependencies only: build scripts and dev tools don't ship.
    if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
  }
}
const crates = [...seen]
  .filter((id) => !members.has(id))
  .map((id) => pkgs.get(id))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// ------------------------------------------------------------ npm packages

const npmJson = JSON.parse(execSync("pnpm licenses list --prod --json", { cwd: app, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const npm = Object.values(npmJson)
  .flat()
  .flatMap((p) => (p.versions ?? [p.version]).map((v, i) => ({ name: p.name, version: v, license: p.license, path: (p.paths ?? [p.path])[i] ?? p.paths?.[0] })))
  .sort((a, b) => a.name.localeCompare(b.name));

// ------------------------------------------------------------ texts

const MIT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const BSD3 = (holder) => `Copyright (c) ${holder}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

// ------------------------------------------------------------ grouping

/** text → the packages that carry exactly that text */
const groups = new Map();
const unlicensedText = [];
function add(label, files, license, fallback) {
  const text = files.length > 0 ? files.map(read).join("\n\n") : fallback?.();
  if (!text) {
    unlicensedText.push(`${label} — ${license ?? "license not stated"}`);
    return;
  }
  if (!groups.has(text)) groups.set(text, []);
  groups.get(text).push(`${label} — ${license ?? "see text"}`);
}
// A crate that publishes no license file gets its license's standard text:
// MPL-2.0 and Apache-2.0 as another crate here ships them, MIT and BSD with
// the crate's own authors. For "MIT OR Apache-2.0" that's the MIT option.
const canonical = {};
for (const c of crates) {
  for (const f of licenseFiles(dirname(c.manifest_path))) {
    const t = read(f);
    if (!canonical["MPL-2.0"] && t.startsWith("Mozilla Public License Version 2.0")) canonical["MPL-2.0"] = t;
    if (!canonical["Apache-2.0"] && /^\s*Apache License\s+Version 2\.0, January 2004/.test(t)) canonical["Apache-2.0"] = t;
  }
}
const holders = (c) => (c.authors?.length ? c.authors.join(", ") : `the ${c.name} authors`);
const fallbackFor = (c) => () => {
  const l = c.license ?? "";
  if (/\bMIT\b/.test(l)) return MIT(holders(c));
  if (l === "MPL-2.0" && canonical["MPL-2.0"]) return canonical["MPL-2.0"];
  if (l === "Apache-2.0" && canonical["Apache-2.0"]) return canonical["Apache-2.0"];
  if (l === "BSD-3-Clause") return BSD3(holders(c));
  return null;
};
// MPL-2.0 asks that the source's whereabouts go with the executable.
const sourceOf = (c) => (/MPL/.test(c.license ?? "") ? `, source https://crates.io/crates/${c.name}/${c.version}` : "");
for (const c of crates)
  add(`${c.name} ${c.version} (Rust${sourceOf(c)})`, licenseFiles(dirname(c.manifest_path)), c.license, fallbackFor(c));
for (const p of npm) add(`${p.name} ${p.version} (npm)`, p.path ? licenseFiles(p.path) : [], p.license);

// ------------------------------------------------------------ the rest

const file = (...p) => read(join(repo, ...p));
// Third-party license texts for what ships beside or inside the app, vendored
// in apps/desktop/licenses/ (its README.md says where each one came from).
const vendored = (name) => {
  const path = join(app, "licenses", name);
  if (!existsSync(path)) throw new Error(`missing apps/desktop/licenses/${name} (see licenses/README.md)`);
  return read(path);
};
const versions = JSON.parse(readFileSync(join(app, "src-tauri", "tools", "VERSIONS.json"), "utf8"));
const readme = readFileSync(join(repo, "README.md"), "utf8");
const permission = readme.slice(readme.indexOf("*Additional permission")).split(/\n\s*\n/)[0].replace(/\*/g, "").trim();

const manual = [
  ["baritoad itself", `GPL-3.0-or-later — the full text is LICENSE.txt beside this file.\n\n${permission}`],
  [
    "ONNX Runtime (Microsoft), linked into the app through the ort crate's prebuilt libraries",
    `${MIT("Microsoft Corporation")}\n\nONNX Runtime 1.28.0's own third-party notices:\n\n${vendored("onnxruntime-1.28.0-ThirdPartyNotices.txt")}`,
  ],
  [
    "DirectML.dll (Microsoft DirectML redistributable), beside the app",
    "Microsoft's DirectML 1.15.4 redistributable, shipped unmodified under its license terms below. It isn't covered by the GPL; the additional permission above lets baritoad use it.\n\n" +
      vendored("DirectML-1.15.4-LICENSE.txt") +
      "\n\nDirectML's third-party notices:\n\n" +
      vendored("DirectML-1.15.4-ThirdPartyNotices.txt"),
  ],
  ["Signalsmith Stretch (key and tempo), compiled in", file("crates", "karaoke-stretch-sys", "vendor", "signalsmith-stretch", "LICENSE.txt")],
  ["Signalsmith Linear, compiled in", file("crates", "karaoke-stretch-sys", "vendor", "signalsmith-linear", "LICENSE.txt")],
  [
    `yt-dlp ${versions["yt-dlp"].version} (tools\\yt-dlp.exe), run as a separate program`,
    "yt-dlp is released into the public domain (The Unlicense). The release executable is a combined work that also contains GPLv3+ components, so it is distributed under GPLv3+; its matching source is tools\\source\\" +
      versions["yt-dlp"].source.split("/").pop() +
      ". https://github.com/yt-dlp/yt-dlp\n\nThe executable bundles Python and the packages below under their own licenses (yt-dlp's THIRD_PARTY_LICENSES.txt for this version); their sources are available from the projects named there.\n\n" +
      vendored(`yt-dlp-${versions["yt-dlp"].version}-THIRD_PARTY_LICENSES.txt`),
  ],
  [`Deno ${versions.deno.version} (tools\\deno.exe), run as a separate program`, read(join(app, "src-tauri", "tools", versions.deno.license))],
  ["98.css (bevel and palette recipes, adapted by hand)", vendored("98css-LICENSE.txt")],
  ["Barlow (lyrics typeface)", file("apps", "desktop", "src", "assets", "fonts", "BARLOW-LICENSE-OFL.txt")],
  ["DSEG (seven-segment clock face)", file("apps", "desktop", "src", "assets", "fonts", "DSEG-LICENSE-OFL.txt")],
  ["Pixel Operator (interface pixel font)", file("apps", "desktop", "src", "assets", "fonts", "PIXEL-OPERATOR-LICENSE-CC0.txt")],
  [
    "Models (downloaded separately on first run, not in this installer)",
    "wav2vec2-base-960h (Meta, Apache-2.0) and whisper-small (OpenAI, MIT), each exported to ONNX by baritoad. htdemucs and htdemucs_ft vocals (Meta, separation): the Demucs code is MIT, but its author says the weights aren't covered by that license and are provided for research purposes (github.com/facebookresearch/demucs/issues/327); baritoad ships them anyway, and says so. License files sit beside each model on the mirror; provenance: MODEL_LICENSES.md and docs/DEPENDENCIES.md in the source.",
  ],
];

// ------------------------------------------------------------ write

const rule = "=".repeat(78);
const parts = [
  "baritoad — third-party notices",
  "",
  "baritoad is free software under GPL-3.0-or-later. It contains, or ships beside",
  "it, the components below, each under its own license.",
  "",
  `${crates.length} Rust crates and ${npm.length} npm packages, generated ${new Date().toISOString().slice(0, 10)}.`,
  "",
];
for (const [title, text] of manual) parts.push(rule, title, rule, "", text, "");
for (const [text, who] of [...groups.entries()].sort((a, b) => a[1][0].localeCompare(b[1][0]))) {
  parts.push(rule, ...who, rule, "", text, "");
}
if (unlicensedText.length) {
  parts.push(rule, "Packages without a license file (license as stated in their metadata)", rule, "", ...unlicensedText, "");
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, parts.join("\n").replace(/\n/g, "\r\n"));
console.log(`${out}\n  ${crates.length} crates, ${npm.length} npm packages, ${groups.size} distinct license texts, ${unlicensedText.length} without a file`);
if (unlicensedText.length) console.log("  without a file:\n    " + unlicensedText.join("\n    "));
