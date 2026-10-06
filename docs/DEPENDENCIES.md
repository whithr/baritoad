# Dependencies and licenses

baritoad is open source under GPL-3.0-or-later (LICENSE). This file is the
dependency and model licensing matrix: every library, executable, font and
model the app ships or downloads, its license, and whether it's OK to ship.
Weights' provenance and hashes live in [MODEL_LICENSES.md](../MODEL_LICENSES.md).

## The policy

- **Everything that ships with the app must be GPL-3.0-compatible and
  redistributable.** GPL code is fine.
- **No research-only or non-commercial weights**, with one recorded
  exception: the Demucs separation weights (htdemucs, htdemucs_ft vocals).
  Their author says they're provided for research purposes and aren't covered
  by Demucs' MIT license; the owner chose to ship them anyway on 2026-10-05
  and to say so plainly here, in MODEL_LICENSES.md, in the app's notices and
  beside the files on the mirror. Don't add another exception without the
  owner's say-so.
- **Proprietary GPU runtimes:** official builds ship DirectML.dll (and
  CUDA/cuDNN if ever added). Our own code allows that through the GPLv3 §7
  additional permission in the README. A third-party GPL library compiled
  *into* the binary carries no such permission — check before linking one.
  Separate executables (ffmpeg, yt-dlp, Deno) don't raise this.
- **ffmpeg** (LGPL/GPL) is only ever a separate executable run as a
  subprocess — never linked.
- **The party relay** (services/relay) isn't distributed with the app, so it
  sits outside this matrix, but it never uses AGPL code; its own dependencies
  are listed in services/relay/README.md.
- **Every new dependency or model updates this matrix in the same change.**
  CI runs `cargo deny` (deny.toml) on every push.

## The matrix

| Component | Role | License | OK to ship? |
|---|---|---|---|
| Tauri 2 (tauri 2.11 + tauri-build, runtime/wry/tao stack) | app shell | Apache-2.0 OR MIT (tao: Apache-2.0) | Yes (verified from crate metadata 2026-08-05; adopted for the Phase 2 desktop shell) |
| tauri-plugin-dialog 2.7 (+ npm @tauri-apps/plugin-dialog) | native file-open dialog | MIT OR Apache-2.0 | Yes (verified 2026-08-05; pulls tauri-plugin-fs + rfd, MIT) |
| souvlaki 0.8.3 | media keys + the OS "now playing" panel (Windows SMTC; later MPRIS / MPNowPlayingInfoCenter) | MIT | Yes (verified from cargo metadata 2026-10-01; adopted v1.0 milestone 2). On Windows it compiles only `windows` 0.44 + `windows-targets` 0.42 (MIT OR Apache-2.0). Built with `use_zbus` (pure Rust) instead of libdbus for the later Linux build; that Linux-only tree (zbus/zvariant 3, async-io/async-* , nix, uds_windows, cocoa/objc on macOS) is MIT, MIT OR Apache-2.0, BSD-3-Clause (instant) or BSD-2/Apache/MIT (zerocopy) |
| http-range 0.1.5 (transitive of tauri's `protocol-asset` feature) | HTTP Range parsing for asset-protocol audio streaming (review-screen playback) | MIT | Yes (verified from the downloaded crate's Cargo.toml + LICENSE 2026-08-05; adopted with Phase 2 milestone 3) |
| @tauri-apps/api 2.11 (npm) | webview↔core IPC bindings | Apache-2.0 OR MIT | Yes (verified from installed package metadata 2026-08-05) |
| react + react-dom 19.3 (npm, + scheduler 0.28 transitive; loose-envify dropped upstream) | UI framework (ships in webview bundle) | MIT | Yes (verified from installed package metadata 2026-08-05; upgraded from the React 18 pin — owner decision 2026-08-05, tests + build green; 19.3.0 / scheduler 0.28.0 as resolved by the pnpm lockfile, license re-verified 2026-09-30) |
| @base-ui/react 1.8 (npm, range ^1.7; runtime transitives @babel/runtime, @floating-ui/react-dom + dom + core + utils, reselect, use-sync-external-store, @base-ui/utils — all MIT) | unstyled accessible UI primitives (menu, context menu, dialog, alert dialog, tabs, tooltip, slider, number field, select, checkbox, radio, radio group) — behavior only, fully skinned by the baritoad 98 CSS (apps/desktop/src/win98) | MIT | Yes (verified from installed package metadata 2026-08-05; 1.8.0 installed as of 2026-09-29; date-fns peer is optional and not installed — no date components used) |
| Barlow font (woff2, latin + latin-ext, weights 400/400i/500/600/700; vendored at apps/desktop/src/assets/fonts with BARLOW-LICENSE-OFL.txt) | lyric typeface everywhere lyrics appear (player stage, Bench word chips) + smooth fallback for chrome when the pixel font is off (ships in webview bundle) | SIL OFL 1.1 | Yes (OFL permits bundling/commercial use, no reserved-name conflict — we don't modify or rename; license text vendored 2026-08-05) |
| Pixel Operator font v2018.10.04-1 (Regular + Bold .ttf, sha256 8d805274…b764a3e / c1963fa2…64614b0, Jayvee Enaguas / HarvettFox96; releases before 2018.10.04 were SIL OFL 1.1; downloaded from fontlibrary.org/en/font/pixel-operator 2026-09-29, zip sha256 e2b4e2d1…9730; vendored at apps/desktop/src/assets/fonts with PIXEL-OPERATOR-LICENSE-CC0.txt) | baritoad 98 chrome typeface (menus, dialogs, lists, status bars) — chrome only, never lyric type; ships in the webview bundle | CC0 1.0 (public-domain dedication) | Yes (CC0 waives copyright incl. commercial use/redistribution; license text vendored 2026-09-29; CC0 re-confirmed from fontlibrary.org 2026-10-05) |
| 98.css (Jordan Scales; nothing vendored — its bevel box-shadow recipes and several palette values are adapted by hand in apps/desktop/src/win98/tokens.css) | baritoad 98 chrome look | MIT | Yes (MIT; credited in the About box; its notice text joins the bundled third-party notices file) |
| DSEG7 Classic v0.46 font (woff2 regular/italic/bold-italic, keshikan; vendored at apps/desktop/src/assets/fonts with DSEG-LICENSE-OFL.txt) | segment-display numerals for LCD readouts (clock, key/tempo, wait seconds) — chrome only, never lyric type | SIL OFL 1.1 | Yes (OFL, license text vendored 2026-08-05; DSEG14 dropped 2026-09-29 with baritoad 98) |
| Dev-only toolchain: typescript 5 (Apache-2.0), vite 6 (MIT), @vitejs/plugin-react 4 (MIT), vitest 3 (MIT), @tauri-apps/cli 2 (Apache-2.0 OR MIT), @types/react[-dom] (MIT), esbuild/rollup (MIT) | frontend build + tests; **not shipped in the binary** | see row | Yes (verified from installed package metadata 2026-08-05; nothing from these lands in the app bundle) |
| ONNX Runtime 1.28 (statically linked via ort-sys) | inference | MIT; its own third-party notices (protobuf, re2, Eigen and others: BSD-3-Clause, MPL-2.0, …) | Yes — ORT's ThirdPartyNotices text for the linked version ships in THIRD-PARTY-NOTICES.txt |
| ort + ort-sys 2.0.0-rc.13 (Rust bindings for ONNX Runtime) | inference | MIT OR Apache-2.0 | Yes (verified from crate metadata 2026-08-05). The `directml` feature is on for Windows targets only (2026-10-01), so macOS and Linux build with the CPU provider |
| DirectML.dll (Microsoft DirectML redistributable, as ort's prebuilt Windows libraries download it; sha256 `9c9e6d82…`) | GPU inference on Windows | Microsoft DirectML redistributable license (proprietary, redistributable with apps) | Yes — shipped unmodified beside the exe by the installer (`pnpm package`, 2026-10-01), allowed for our GPL code by the README's GPLv3 §7 additional permission. Its license and third-party notices are vendored into THIRD-PARTY-NOTICES.txt (2026-10-05) |
| NSIS (the installer stub, via Tauri's bundler) | the Windows installer (`pnpm package`) | zlib/libpng | Yes — only the installer carries it; not linked into the app |
| tungstenite 0.30 (`native-tls` feature) | party mode's relay client: one outbound WebSocket (docs/PARTY.md) | MIT OR Apache-2.0 | Yes (verified from cargo metadata 2026-10-02). New crates it brings: rand 0.10 + rand_core 0.10 + chacha20 0.10, sha1 0.11 + digest 0.11 + block-buffer 0.12 + crypto-common 0.2 + hybrid-array 0.4 + const-oid 0.10 + cpufeatures 0.3 — all MIT OR Apache-2.0; http, httparse, bytes, data-encoding were already in the tree. TLS through native-tls, the same as ureq (Windows SChannel) |
| qrcodegen 1.8 (Project Nayuki) | party mode's join QR code, drawn as crisp SVG squares | MIT | Yes (verified from cargo metadata 2026-10-02; no dependencies) |
| ndarray 0.17 | tensor buffers | MIT OR Apache-2.0 | Yes (verified 2026-08-05) |
| htdemucs code | separation | MIT | Yes |
| htdemucs + htdemucs_ft (vocals) weights (Meta, via the demucs author's HF repos `adefossez/HTDemucs`, `adefossez/HTDemucs-ft`) | separation (htdemucs: every song; htdemucs_ft vocals: optional "high quality") | **Research-only per the author** — not covered by Demucs' MIT license ("provided only for scientific purposes", facebookresearch/demucs#327, 2022; also #267, #508); trained on MUSDB18, whose license is research-only. The HF cards' `mit` tag that this row once relied on was removed on 2026-08-31 | **Shipped as a recorded owner exception (2026-10-05)** — see the policy above. Labelled research-only in MODEL_LICENSES.md, the app's notices and the mirror. Replacing them with commercially-licensed separation weights would retire the exception |
| demucs.cpp | reference impl | MIT | Yes |
| Whisper (OpenAI) code + weights | transcription | MIT | Yes |
| whisper.cpp | inference alt | MIT | Yes |
| wav2vec2-base code (fairseq) | forced alignment | MIT | Yes |
| wav2vec2-base-960h weights (HF `facebook/wav2vec2-base-960h`, the fine-tuned CTC checkpoint we align with) | forced alignment | Apache-2.0 | Yes (HF card tag `apache-2.0`, verified 2026-08-05; matrix previously said MIT — corrected per spikes/alignment/REPORT.md) |
| Meta MMS multilingual weights | multilingual alignment | **CC-BY-NC** | **No** — non-commercial; this is why v1 is English-first. Revisit for v2+ only with commercial-safe weights |
| Signalsmith Stretch (C++ header, vendored at crates/karaoke-stretch-sys/vendor/signalsmith-stretch) | key/tempo shift | MIT | Yes (verified from the vendored LICENSE.txt 2026-08-05, © Geraint Luff / Signalsmith Audio Ltd.; adopted in the Phase 3 milestone-2 player engine) |
| signalsmith-linear (STFT/FFT headers, vendored at crates/karaoke-stretch-sys/vendor/signalsmith-linear) | Signalsmith Stretch dependency | MIT | Yes (verified from the vendored LICENSE.txt 2026-08-05, © Signalsmith Audio). Optional Accelerate/IPP platform backends are compile-gated behind macros we never define — only the portable C++ path is compiled |
| signalsmith-stretch-rs C wrapper v0.1.3 (colinmarc; wrapper.{h,cpp} vendored at crates/karaoke-stretch-sys/vendor, FFI hand-written — the crate's bindgen path needs libclang) | C ABI over the C++ header | MIT | Yes (verified from the vendored LICENSE.md 2026-08-05, © Colin Marc). Vendored **with one patch**: upstream `signalsmith_stretch_set_formant_base` called `setFormantSemitones`; fixed to `setFormantBase` (spikes/stretch/REPORT.md §4 item 4) |
| cc 1.4 (+ build-time transitives shlex, find-msvc-tools, jobserver, libc — all MIT OR Apache-2.0) | compiles the vendored wrapper at build time; **not shipped in the binary** | MIT OR Apache-2.0 | Yes (verified from cargo metadata of the resolved crates 2026-08-05; build-dependency of karaoke-stretch-sys only, follows the dev-only toolchain row precedent) |
| Symphonia 0.5.5 | audio decode | MPL-2.0 | Yes (MPL: file-level copyleft, keep unmodified or publish changes). Adopted for decode in Phase 1 (verified 2026-08-05). 2026-10-01: `aiff` (in symphonia-format-riff) and `alac` (new crate symphonia-codec-alac 0.5.5, MPL-2.0, verified from its Cargo.toml) turned on for AIFF and Apple Lossless m4a; the default `mkv` and the existing `isomp4` demux video files' audio, so video import needs no ffmpeg |
| cpal 0.15.3 | audio output (playback engine, Phase 3) | Apache-2.0 | Yes (verified from crate metadata 2026-08-05). New transitives all MIT OR Apache-2.0: dasp_sample 0.11, windows/windows-core/windows-result/windows-targets 0.54-line (WASAPI). Per-OS backends resolved but only compiled on their targets: coreaudio-rs/-sys (MIT/Apache-2.0, MIT), oboe (Apache-2.0), ndk (MIT OR Apache-2.0), alsa crate (Apache-2.0/MIT — binds the *system* libasound, LGPL, linked dynamically as every Linux audio app does; not bundled by us). MMCSS registration is direct avrt.dll FFI — no extra crate |
| hound 3.5 | WAV read/write | Apache-2.0 | Yes (verified 2026-08-05) |
| rubato 0.16 | sample-rate conversion | MIT | Yes (verified 2026-08-05) |
| flacenc 0.5 | FLAC encode (pure Rust) | Apache-2.0 | Yes (verified 2026-08-05) |
| clap 4 | CLI argument parsing | MIT OR Apache-2.0 | Yes (verified 2026-08-05) |
| rustfft 6 | FFT for whisper log-mel | MIT OR Apache-2.0 | Yes (verified from crate metadata 2026-08-05; adopted for the alignment stage) |
| serde / serde_json | JSON summaries + caches | MIT OR Apache-2.0 | Yes (verified 2026-08-05) |
| sha2 0.10 | content hashing for job manifests (resume) | MIT OR Apache-2.0 | Yes (verified from crate metadata 2026-08-05; transitive digest/block-buffer/crypto-common/cpufeatures/typenum MIT OR Apache-2.0, generic-array MIT) |
| ffmpeg | video I/O (Add from URL, if present) | LGPL-2.1 / GPL depending on build | **Not bundled.** The app uses an ffmpeg it finds on PATH, as a separate executable via subprocess (`--ffmpeg-location` for yt-dlp) — never linked. If we ever bundle one: LGPL or GPL configure (never `--enable-nonfree`), and offer the build's source |
| yt-dlp (official release executable) | Add from URL — audio + metadata fetch | Unlicense (source); the PyInstaller release executables are a **GPLv3+ combined work** (they bundle mutagen, GPLv2+, among others) | Yes — bundled as a **separate executable** run via subprocess, copied to the app's data folder on first use so it can self-update; GPLv3+ is compatible with our GPL-3.0. Ship its license text, its THIRD_PARTY_LICENSES.txt (CPython, mutagen, certifi and the rest of the PyInstaller bundle) and the matching tagged source with each build (verified from the yt-dlp README 2026-09-30) |
| Deno | JavaScript runtime yt-dlp needs for YouTube | MIT (contains V8 and other code: BSD-3-Clause and others) | Yes — bundled beside yt-dlp, run only by yt-dlp (v2.9.7 via `pnpm fetch-tools`, checked against its published sha256 2026-09-30) |
| ureq 3.3 (+ ureq-proto, http, httparse, base64, percent-encoding, utf8-zero, der, pem-rfc7468, rustls-pki-types, log, zeroize — all MIT OR Apache-2.0) | HTTP for LRCLIB lookup and cover art | MIT OR Apache-2.0 | Yes (verified from cargo metadata 2026-09-30; same crate ort-sys already used at build time) |
| native-tls 0.2 → schannel (Windows, MIT), security-framework (macOS, MIT OR Apache-2.0), openssl crate (Linux, Apache-2.0; openssl-sys MIT) | TLS through the OS: SChannel / Security.framework / the *system* OpenSSL, linked dynamically — not bundled by us | MIT OR Apache-2.0 | Yes (verified from cargo metadata 2026-09-30; OS roots via `RootCerts::PlatformVerifier`) |
| webpki-root-certs 1.0 (pulled in by ureq's `native-tls` feature) | Mozilla's CA list as data — compiled in but unused (roots come from the OS store) | CDLA-Permissive-2.0 | Yes (permissive data license; ureq 3.3 gates its native-tls transport on the feature that brings it) |
| LRCLIB (lrclib.net public API — a web service, nothing shipped) | online lyrics lookup | Service: free, no API key; server code MIT; no license published for the lyrics data | n/a — no code ships; requests identify the client via `User-Agent` (verified 2026-09-30). HTTP client: the ureq row |
| SQLite | library DB | Public domain | Yes — compiled into the binary via rusqlite's `bundled` feature (no system dependency) |
| rusqlite 0.37 | SQLite bindings (library store, Phase 2 milestone 2) | MIT | Yes (verified from crate metadata 2026-08-05) |
| libsqlite3-sys 0.35 (bundled SQLite) | SQLite FFI + vendored amalgamation | MIT (crate); SQLite itself public domain | Yes (verified from crate metadata 2026-08-05; build-time helpers cc/pkg-config/vcpkg are MIT OR Apache-2.0, not shipped) |
| lofty 0.22 | audio tag read (title/artist/album/cover) at import — local files only, no network metadata | MIT OR Apache-2.0 | Yes (verified from crate metadata 2026-08-05; lofty_attr/ogg_pager MIT OR Apache-2.0) |
| lofty/rusqlite transitives with new license families: byteorder (Unlicense OR MIT), foldhash (Zlib), adler2 (0BSD OR MIT OR Apache-2.0), simd-adler32 (MIT), data-encoding (MIT), flate2/miniz_oxide/hashbrown/hashlink/smallvec/bitflags/crc32fast (MIT OR Apache-2.0 [miniz_oxide adds Zlib]), fallible-(streaming-)iterator (MIT/Apache-2.0) | tag parsing + DB internals | see row — all permissive | Yes (verified from cargo metadata 2026-08-05; no copyleft, no research-only terms) |
| Transitives in the tauri/dirs tree with other license families: cssparser, cssparser-macros, selectors, dtoa-short (via tauri-utils → dom_query) and option-ext (via dirs-sys) — MPL-2.0; the icu4x family (18 crates: icu_*, zerovec, yoke, …) — Unicode-3.0; brotli, alloc-no-stdlib, alloc-stdlib, encoding_rs — BSD-3-Clause and/or MIT | runtime internals | see row — all permissive or file-level copyleft | Yes (`cargo deny check licenses` passes, 2026-10-05; MPL crates unmodified, sources linked in the notices) |
| CREPE(-tiny) | melody extraction (v2) | MIT | Yes (when needed) |
| Rubber Band | key/tempo (not used) | GPL-2.0-or-later / paid | License no longer blocks it (GPL-3.0 relicense), but Signalsmith Stretch is integrated and measured — don't swap without measured numbers; compiled-in GPL needs the DirectML check above |
| aubio | pitch (v2 concern) | GPL-3.0 | License no longer blocks it (GPL-3.0 relicense); judge it on merit for v2 — compiled-in GPL needs the DirectML check above |
| UVR community models (BS-RoFormer etc.) | better separation | varies; often research-only | **No by default** — per-model review; many require permission for commercial use |
| UltraStar Deluxe code | reference only | GPL | Code reuse is license-compatible where it's GPL-2.0-or-later (check each file); format interop is still all we need |
