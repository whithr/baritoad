# Karaoke desktop app

Tauri 2 shell over `karaoke-core`, styled as a late-90s desktop program
("baritoad 98", DESIGN.md): a main window that moves between the Library
(`views/Home.tsx` — places tree, sortable song list, Up next, Add Song
wizard) and the Bench (`views/Bench.tsx` — the timing editor, Text / Lanes /
Focus), and a separate Stage window for the TV player
(`views/PlayerView.tsx`, created by `src-tauri/src/stage.rs`) that can be
dragged or sent full screen to another display. All processing is local; the app never uploads audio
and ships no music or lyrics. The app is open source
(GPL-3.0-or-later).

## Layout

- `src/` — React 19 + TypeScript frontend (Vite). Plain CSS; behaviour
  (menus, dialogs, tabs, sliders…) from `@base-ui/react` primitives.
- `src/win98/` — the baritoad 98 kit: tokens (Classic + Night schemes),
  class-scoped base CSS, pixel icons, controls, menu bar / context menus
  from one command model, list + tree views, dialogs, wizard, message boxes,
  the frameless window frame; `stage.css` holds the TV stage's lyric CSS
  (the player's per-frame hooks) and `bench.css` the Bench lanes.
- `src/views/` — `Home` (Library), `AddSongWizard`, `LinkDialog` (Add from
  URL), `ImportDialog`, `ProcessingDialog`,
  `Bench`, `PlayerView` (stage), `Properties` (+ About), `PlayerThemes`,
  `AppDialogs`; `KitView` is a dev-only parts bin at `#/kit`.
- `src/stage.ts` / `src/prefsSync.ts` — opening the Stage window and keeping
  settings/themes in step between the two windows.
- Pure, tested modules the views sit on: `editorState` (undo/redo + map
  invariants), `lineEdit`/`docEdit` (line surgery), `previewEditor`
  (shift scopes), `benchLayout` (lane windows, view axis),
  `highlight`, `levels`, `playerClock`/`playerView`, `jobEvents`,
  `settings`, `importState`, `linkState`.
- `dev/mockTauri.ts` + `vite.mock.config.ts` — browser-only harness
  (`pnpm exec vite --config vite.mock.config.ts`) that runs the real UI over a
  fake Tauri layer for layout work and screenshots; never part of a build.
- `src-tauri/` — the Rust shell crate (`karaoke-desktop`, a workspace member).
  It links `karaoke-core` directly; song imports run in a child copy of the
  app (`--pipeline-worker`, below-normal priority — `src-tauri/src/worker.rs`),
  not via the CLI. `src-tauri/tools/` holds the programs Add from URL
  runs (yt-dlp, Deno) — fetched, never committed.

## Dev setup (Windows)

Prereqs:

- Rust toolchain (the workspace builds with stable; MSVC target)
- Node.js ≥ 20 and pnpm (the version pinned in `package.json`'s
  `packageManager` field; `pnpm-lock.yaml` is the only lockfile — don't
  `npm install`)
- WebView2 runtime (preinstalled on Windows 10/11)
- Model weights in `%LOCALAPPDATA%\baritoad\models` — the app downloads
  them (Tools › Models…; `KARAOKE_MODEL_MIRROR` points it at another mirror),
  or place them by hand. MODEL_LICENSES.md has their provenance; weights are
  never in the repo
- The data folder was `%LOCALAPPDATA%\karaoke` before the rename; the first
  start moves it (karaoke-core `paths`), leaving the old one as a backup
  with a MOVED.txt. The webview's profile (settings, themes) lives in
  `baritoad\webview`, not under the app identifier

Then:

```
cd apps/desktop
pnpm install
pnpm fetch-tools   # yt-dlp + Deno for Add from URL (checksum-verified)
pnpm tauri dev
```

`pnpm tauri dev` starts Vite on port 1420 and opens the app window with
hot reload. The first Rust build is slow (ort + tauri); later ones are
incremental.

Other commands:

- `pnpm test` — vitest (progress-event reducer, wizard preview helpers)
- `pnpm build` — typecheck (tsc) + production frontend bundle
- `pnpm tauri build --debug` — debug executable at
  `target/debug/karaoke-desktop.exe`, frontend embedded (no installer)
- `pnpm package` — the Windows installer (NSIS, per machine) at
  `target/release/bundle/nsis/`. It stages `src-tauri/runtime/` (DirectML.dll
  from ort's download, LICENSE.txt, THIRD-PARTY-NOTICES.txt from
  `pnpm notices`), checks the `pnpm fetch-tools` files are there, and merges
  `src-tauri/tauri.bundle.json` over `tauri.conf.json` — everyday builds never
  need any of it. `src-tauri/nsis/hooks.nsh` makes the uninstaller's "Delete
  the application data" box remove `%LOCALAPPDATA%\baritoad`. On a Mac the
  same command makes `baritoad.app` and a `.dmg` (Apple Silicon, macOS 13.4+:
  ONNX Runtime's floor) at `target/release/bundle/dmg/`, with
  `src-tauri/tauri.bundle.macos.json` instead and no DirectML. It's ad-hoc
  signed unless `APPLE_SIGNING_IDENTITY` names a Developer ID certificate.
  The data folder there is `~/Library/Application Support/baritoad`
- `pnpm icons` — the app icons, redrawn from the 16-px toad in
  `src/win98/icons.tsx` at whole-pixel multiples
- `cargo test -p karaoke-desktop` — Rust-side unit tests

CI (`.github/workflows/ci.yml`) runs the tests and a build on Windows and
macOS, the party relay's checks, and `cargo deny check` (`deny.toml`,
docs/DEPENDENCIES.md) on every push. The Linux build (`platforms.yml`) runs
only when started by hand from the Actions tab.

## Execution-provider policy

The app requests `EpChoice::Auto` unless Properties › Processing is set to
"Processor only": DirectML for separation, wav2vec2, and the whisper encoder,
each behind a parity check that falls closed to CPU; the whisper decoder stays
on the CPU. wav2vec2 runs in 10 s dispatches to stay under the Windows TDR
watchdog (see `karaoke_core::alignment::w2v`). Properties › Processing also
sets what happens while a game is using the graphics card
(`src-tauri/src/gaming.rs`).

## Command / event surface

Commands (all async) live in `src-tauri/src/` — `commands.rs` (jobs, lyrics,
export, links), `library.rs` (songs, collections, the up-next queue),
`player.rs`, `stage.rs`, `review.rs`, `tools.rs`, `theme.rs`, `gaming.rs`,
`media_keys.rs` (the OS media controls; `keep_awake.rs` holds off sleep
while songs import) —
with typed wrappers in `src/api.ts`.

Events: `karaoke://job` (job lifecycle snapshots and karaoke-core
`PipelineEvent`s tagged with their job id, `src-tauri/src/queue.rs`),
`karaoke://player` (playback status, about 10 Hz while playing),
`karaoke://library` (metadata backfill), `karaoke://models` (model downloads), `karaoke://party` (party
mode: phase, join link, QR, guests — `party.rs`; `KARAOKE_PARTY_RELAY=ws://127.0.0.1:8787` points
it at a local relay from `services/relay`), `baritoad://stage` (the Stage
window), and `baritoad://prefs` (settings shared between the two windows).
