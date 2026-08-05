# Karaoke desktop app (Phase 2)

Tauri 2 shell over `karaoke-core` — the wizard, job progress, and library
views for the generate pipeline. All processing is local; the app never
downloads music, never uploads audio, and ships no lyrics. The code is public
but the project is **source-available**, not open source (PLAN.md §1, §8).

## Layout

- `src/` — React 18 + TypeScript frontend (Vite). Plain CSS, no UI framework.
- `src-tauri/` — the Rust shell crate (`karaoke-desktop`, a workspace member).
  It links `karaoke-core` directly — the pipeline runs in-process on a worker
  thread, not via the CLI.

## Dev setup (Windows)

Prereqs:

- Rust toolchain (the workspace builds with stable; MSVC target)
- Node.js ≥ 20 and npm
- WebView2 runtime (preinstalled on Windows 10/11)
- Model weights in `%LOCALAPPDATA%\karaoke\models` (htdemucs.onnx,
  whisper-small/, wav2vec2/) — see MODEL_LICENSES.md for provenance; weights
  are never in the repo

Then:

```
cd apps/desktop
npm install
npm run tauri dev
```

`npm run tauri dev` starts Vite on port 1420 and opens the app window with
hot reload. The first Rust build is slow (ort + tauri); later ones are
incremental.

Other commands:

- `npm test` — vitest (progress-event reducer, wizard preview helpers)
- `npm run build` — typecheck (tsc) + production frontend bundle
- `npm run tauri build -- --debug` — debug executable at
  `target/debug/karaoke-desktop.exe` (bundle/installer targets are disabled in
  `tauri.conf.json` for now)
- `cargo test -p karaoke-desktop` — Rust-side unit tests

## Execution-provider policy

The app always requests `EpChoice::Auto`: DirectML for separation (gated by
the golden-segment parity check, falling closed to CPU) and CPU for the
wav2vec2 alignment pass (DirectML there can trip the Windows TDR watchdog —
see `karaoke_core::alignment::w2v`). An advanced setting may expose this
later; there is deliberately no settings UI in this milestone.

## Command / event surface

Commands (all async): `generate_song`, `cancel_job`, `list_jobs`,
`read_timing_map`, `clean_lyrics_preview`, `export_song` — see
`src-tauri/src/commands.rs` for payloads and `src/api.ts` for the TypeScript
mirror.

Events: everything arrives on the single `karaoke://job` channel as either a
job lifecycle snapshot or a karaoke-core `PipelineEvent` tagged with its job
id (`src-tauri/src/queue.rs`).
