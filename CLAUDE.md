# baritoad

Open-source (GPL-3.0) desktop karaoke app — the name is **baritoad**, always
lowercase (PRODUCT.md): any song (a file or a pasted link)
→ AI vocal removal + word-synced lyrics + full-screen player. **PLAN.md is
authoritative** for scope, legal, and licensing decisions — cite it by section
when a decision traces to it.

Current phase: **Phase 3 — player, collections, polish**, finishing v1.0
(PLAN.md §9 lists what's left). v1.0 isn't a public launch: party mode
(Phase 4, designed in docs/PARTY.md) comes next, then the launch.

## Hard rules — never violate, not even in a prototype

- No bundled songs, no sharing user audio between users, no cloud processing
  (PLAN.md §7). User audio leaves the machine only through the paid cloud
  library: opt-in, private to the owner's account, one copy per account,
  never shared or processed server-side (PLAN.md §3, §7). The network is
  touched only on user request: Add from URL (yt-dlp), LRCLIB lyrics lookup,
  party mode, and the cloud library. Online lyrics come from the LRCLIB API
  — never HTML-scrape lyrics sites (PLAN.md §3, §5).
- The party relay carries the queue and song metadata only — never audio or
  lyrics. Party mode is free: nobody signs in to it, host or guest — the
  only account is the paid cloud library.
- The app and the party relay are **open source (GPL-3.0-or-later)** — say
  so plainly. The relay lives here, in `services/relay/` (owner decision
  2026-10-02). The cloud library's server is ours, closed, and lives outside
  this repo: never put its code here. Never commit secrets for any server —
  API tokens, keys, account credentials stay in Cloudflare and CI settings
  (PLAN.md §1, §8).
- Never commit audio files or model weights to the repo. Test audio is
  copyrighted; weights go on the mirror (Cloudflare R2, PLAN.md §5) with
  provenance in MODEL_LICENSES.md.
  The .gitignore enforces this — do not weaken it.
- Dependency policy: everything that ships must be GPL-3.0-compatible and
  redistributable; no research-only or non-commercial weights. A third-party
  GPL library compiled *into* the binary needs the DirectML check in PLAN.md
  §6 first. Check the PLAN.md §6 matrix before adding any dependency or
  model; every addition must update that matrix in the same change.
- ffmpeg (LGPL) is used only as a bundled executable invoked via subprocess —
  never linked, statically or dynamically.
- yt-dlp and Deno ship as bundled executables, run via subprocess; yt-dlp
  runs from the app's data folder so it can update itself (PLAN.md §5, §6).

## Technical constraints

- Rust core + Tauri UI. **No Python at runtime** — ML runs in-process via ONNX
  Runtime. The one exception is the bundled yt-dlp executable (it carries its
  own interpreter and runs as a subprocess).
- Known-excluded: Meta MMS multilingual weights (CC-BY-NC). Rubber Band and
  aubio are no longer license-blocked, but Signalsmith Stretch is the
  integrated, measured choice — don't swap without measured numbers.
- English-first v1: no multilingual alignment paths (PLAN.md §1, §6).
- v1 scope is frozen (PLAN.md §3). No mic input, no pitch detection, no scoring
  — those are v2. Party mode (free) and the cloud library (paid) are the v1.x
  features (PLAN.md §9 Phase 4), not v1.0. Flag scope creep when you see it, including in requests.
- Timing maps always store original-song time; only the player clock translates
  through stretch ratios (PLAN.md §5).

## Conventions

- Performance claims require measured numbers: song length, hardware, wall
  time. "Seems fast" doesn't count (spike reports and PRs alike).
- Alignment-accuracy claims are measured against hand-timed references (Phase 0)
  or the accuracy harness (Phase 1+).
- Spike code may be rough; spike *measurements* may not.
- Pricing, subscriptions, and other monetization strategy live only in
  `BUSINESS.md` (gitignored, local). Never write them into tracked files —
  PLAN.md §8 says only that the app and party mode are free and the cloud
  library is paid.

## Repo layout

- `PLAN.md` — the plan (authoritative)
- `spikes/` — Phase 0 prototypes, one directory per spike; each produces a
  `REPORT.md` graded against the criteria in `spikes/README.md`
- `MODEL_LICENSES.md` — provenance of every model weight we mirror
- `BUSINESS.md` — local-only pricing and monetization notes (gitignored)
- `.claude/agents/` — spike-runner, pipeline-dev, licensing-auditor
- `.claude/workflows/phase0-spikes.js` — runs the four Phase 0 spikes in
  parallel and synthesizes a go/no-go report
- `docs/IMPORTING.md` — the folder layout bulk import reads;
  `.claude/skills/prep-song-import/` — the agent workflow for getting a
  user's audio + lyrics files into it (`karaoke scan` is the check)
- `docs/PARTY.md`, `docs/PARTY-PROTOCOL.md` — party mode's design and the
  app ⇄ relay wire protocol
- `services/relay/` — the party relay and guest page (Cloudflare Workers;
  open, GPL-3.0-or-later)
