# Karaoke desktop app

Tauri 2 shell over `karaoke-core`, styled as a late-90s desktop program
("Karascape 98", DESIGN.md): a main window that moves between the Library
(`views/Home.tsx` — places tree, sortable song list, Up next, Add Song
wizard) and the Bench (`views/Bench.tsx` — the timing editor, Text / Lanes /
Focus), and a separate Stage window for the TV player
(`views/PlayerView.tsx`, created by `src-tauri/src/stage.rs`) that can be
dragged or sent full screen to another display. All processing is local; the app never uploads audio
and ships no music or lyrics. The app is open source
(GPL-3.0-or-later, PLAN.md §1, §8).

## Layout

- `src/` — React 19 + TypeScript frontend (Vite). Plain CSS; behaviour
  (menus, dialogs, tabs, sliders…) from `@base-ui/react` primitives.
- `src/win98/` — the Karascape 98 kit: tokens (Classic + Night schemes),
  class-scoped base CSS, pixel icons, controls, menu bar / context menus
  from one command model, list + tree views, dialogs, wizard, message boxes,
  the frameless window frame; `stage.css` holds the TV stage's lyric CSS
  (the player's per-frame hooks) and `bench.css` the Bench lanes.
- `src/views/` — `Home` (Library), `AddSongWizard`, `ProcessingDialog`,
  `Bench`, `PlayerView` (stage), `Properties` (+ About), `PlayerThemes`,
  `AppDialogs`; `KitView` is a dev-only parts bin at `#/kit`.
- `src/stage.ts` / `src/prefsSync.ts` — opening the Stage window and keeping
  settings/themes in step between the two windows.
- Pure, tested modules the views sit on: `editorState` (undo/redo + map
  invariants), `lineEdit`/`docEdit` (line surgery), `previewEditor`
  (shift scopes), `benchLayout` (lane windows, view axis),
  `highlight`, `levels`, `playerClock`/`playerView`, `jobEvents`,
  `settings`.
- `dev/mockTauri.ts` + `vite.mock.config.ts` — browser-only harness
  (`pnpm exec vite --config vite.mock.config.ts`) that runs the real UI over a
  fake Tauri layer for layout work and screenshots; never part of a build.
- `src-tauri/` — the Rust shell crate (`karaoke-desktop`, a workspace member).
  It links `karaoke-core` directly — the pipeline runs in-process on a worker
  thread, not via the CLI.

## Dev setup (Windows)

Prereqs:

- Rust toolchain (the workspace builds with stable; MSVC target)
- Node.js ≥ 20 and pnpm (the version pinned in `package.json`'s
  `packageManager` field; `pnpm-lock.yaml` is the only lockfile — don't
  `npm install`)
- WebView2 runtime (preinstalled on Windows 10/11)
- Model weights in `%LOCALAPPDATA%\karaoke\models` (htdemucs.onnx,
  whisper-small/, wav2vec2/) — see MODEL_LICENSES.md for provenance; weights
  are never in the repo

Then:

```
cd apps/desktop
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` starts Vite on port 1420 and opens the app window with
hot reload. The first Rust build is slow (ort + tauri); later ones are
incremental.

Other commands:

- `pnpm test` — vitest (progress-event reducer, wizard preview helpers)
- `pnpm build` — typecheck (tsc) + production frontend bundle
- `pnpm tauri build --debug` — debug executable at
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
