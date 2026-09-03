# Karaoke desktop app

Tauri 2 shell over `karaoke-core`. The UI is bench-centric: one surface where
the lyrics sit on the audio (`views/Bench.tsx`, three zoom levels — Text,
Lanes, Focus), with the library as a drawer and song import landing on the
same surface (`views/Home.tsx`). The chrome is the "hardware panel" language
in `src/hw.css` (light/dark, switched in Settings); the TV player keeps its
own stage themes and the legacy `styles.css`, loaded on demand. All processing is local; the app never
downloads music, never uploads audio, and ships no lyrics. The code is public
but the project is **source-available**, not open source (PLAN.md §1, §8).

## Layout

- `src/` — React 19 + TypeScript frontend (Vite). Plain CSS, no UI framework
  in the bench/home chrome (`hw.css` + `hw/ui.tsx`); the player still uses
  `ui.tsx` (Base UI skins) and `styles.css`.
- `src/views/` — `Home` (library drawer, drop/landing, up-next tray),
  `Bench` (Lanes / Text / Focus editor), `Settings`, `PlayerView` (TV),
  `ThemesView` (player stage themes).
- Pure, tested modules the views sit on: `editorState` (undo/redo + map
  invariants), `lineEdit`/`docEdit` (line surgery), `previewEditor`
  (shift scopes), `benchLayout` (lane windows, doubt, view axis),
  `highlight`, `levels`, `playerClock`/`playerView`, `jobEvents`,
  `settings`.
- `dev/mockTauri.ts` + `vite.mock.config.ts` — browser-only harness
  (`npx vite --config vite.mock.config.ts`) that runs the real UI over a
  fake Tauri layer for layout work and screenshots; never part of a build.
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
