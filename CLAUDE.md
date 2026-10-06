# baritoad

Open-source (GPL-3.0-or-later) desktop karaoke app — the name is
**baritoad**, always lowercase: any song (a file or a pasted link) → AI vocal
removal + word-synced lyrics + full-screen player, plus party mode (guests
pick songs from their phones). Everything is free; there is no account and
nothing paid.

v1.0 shipped for Windows on 2026-10-05; v1.1 added macOS (Apple Silicon,
13.4+) the same day. Linux builds but doesn't ship yet (its CI check runs by
hand: .github/workflows/platforms.yml). Maintainers may have a `CLAUDE.local.md` with private planning
context; this file is the public rulebook.

## Hard rules — never violate, not even in a prototype

- No bundled songs, no sharing user audio between users, no cloud processing,
  no uploading user audio anywhere. The network is touched only for the
  first-run model download and on user request: Add from URL (yt-dlp), LRCLIB
  lyrics lookup, and party mode. Online lyrics come from the LRCLIB API —
  never HTML-scrape lyrics sites.
- The party relay carries the queue and song metadata only — never audio or
  lyrics. Party mode is free and nobody signs in to it, host or guest.
- The app and the party relay are **open source (GPL-3.0-or-later)** — say
  so plainly. The relay lives here, in `services/relay/`. Never commit
  secrets for any server — API tokens, keys, account credentials stay in
  Cloudflare and CI settings.
- Never commit audio files or model weights to the repo. Test audio is
  copyrighted; weights go on the mirror (models.baritoad.com, Cloudflare R2)
  with provenance in MODEL_LICENSES.md. Never commit real song lyrics either —
  test fixtures use invented or public-domain lines.
  The .gitignore enforces the audio and weights part — do not weaken it.
- Dependency policy (docs/DEPENDENCIES.md): everything that ships must be
  GPL-3.0-compatible and redistributable; no research-only or non-commercial
  weights beyond the one recorded exception there (the Demucs separation
  weights). A third-party GPL library compiled *into* the binary needs the
  DirectML check in docs/DEPENDENCIES.md first. Check that matrix before
  adding any dependency or model; every addition must update it in the same
  change.
- ffmpeg is used only as a separate executable invoked via subprocess —
  never linked, statically or dynamically.
- yt-dlp and Deno ship as bundled executables, run via subprocess; yt-dlp
  runs from the app's data folder so it can update itself.

## Technical constraints

- Rust core + Tauri UI. **No Python at runtime** — ML runs in-process via ONNX
  Runtime. The one exception is the bundled yt-dlp executable (it carries its
  own interpreter and runs as a subprocess).
- Known-excluded: Meta MMS multilingual weights (CC-BY-NC). Rubber Band and
  aubio are no longer license-blocked, but Signalsmith Stretch is the
  integrated, measured choice — don't swap without measured numbers.
- English-first: no multilingual alignment paths (the commercial-safe
  multilingual aligner weights don't exist yet).
- No mic input, no pitch detection, no scoring — those belong to a later
  singing-game release, not this one. Flag scope creep when you see it,
  including in requests.
- Timing maps always store original-song time; only the player clock
  translates through stretch ratios.

## Conventions

- Performance claims require measured numbers: song length, hardware, wall
  time. "Seems fast" doesn't count (spike reports and PRs alike).
- Alignment-accuracy claims are measured against hand-timed references or
  the accuracy harness.
- Spike code may be rough; spike *measurements* may not.
- Commits carry a DCO sign-off (CONTRIBUTING.md).

## Repo layout

- `apps/desktop/` — the Tauri app (React webview in `src/`, Rust in
  `src-tauri/`)
- `crates/karaoke-core/` — the pipeline, player, library and party protocol;
  `crates/karaoke-cli/` — the `karaoke` CLI; `crates/karaoke-stretch-sys/` —
  vendored Signalsmith Stretch
- `services/relay/` — the party relay and guest page (Cloudflare Workers)
- `spikes/` — the Phase 0 feasibility prototypes, one directory per spike;
  each has a `REPORT.md` graded against the criteria in `spikes/README.md`
- `DESIGN.md` — the visual system (baritoad 98) and copy rules
- `MODEL_LICENSES.md` — provenance of every model weight we mirror
- `docs/DEPENDENCIES.md` — the dependency and model licensing matrix
- `docs/IMPORTING.md` — the folder layout bulk import reads;
  `.claude/skills/prep-song-import/` — the agent workflow for getting a
  user's audio + lyrics files into it (`karaoke scan` is the check)
- `docs/PARTY.md`, `docs/PARTY-PROTOCOL.md` — party mode's design and the
  app ⇄ relay wire protocol
- `.claude/agents/` — spike-runner, pipeline-dev, licensing-auditor
