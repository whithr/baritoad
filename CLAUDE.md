# Karaoke App (name TBD)

Source-available desktop karaoke app: any song the user owns → AI vocal removal +
word-synced lyrics + full-screen player. **PLAN.md is authoritative** for scope,
legal, and licensing decisions — cite it by section when a decision traces to it.

Current phase: **Phase 0 — de-risk spikes** (PLAN.md §9, spikes/README.md).

## Hard rules — never violate, not even in a prototype

- No downloader of any kind (YouTube or otherwise), no bundled songs, no
  hosting/relaying of user audio, no cloud processing, no lyrics-site scraping.
  These are legal load-bearing walls (PLAN.md §7).
- Never describe the project as "open source" in code, docs, UI copy, or commit
  messages — it is **source-available** (PLAN.md §1 terminology rule).
- Never commit audio files or model weights to the repo. Test audio is
  copyrighted; weights live on the mirror with provenance in MODEL_LICENSES.md.
  The .gitignore enforces this — do not weaken it.
- Dependency policy: everything that ships in the binary must permit commercial
  use and redistribution. No GPL/AGPL code, no research-only weights. Check the
  PLAN.md §6 matrix before adding any dependency or model; every addition must
  update that matrix in the same change.
- ffmpeg (LGPL) is used only as a bundled executable invoked via subprocess —
  never linked, statically or dynamically.

## Technical constraints

- Rust core + Tauri UI. **No Python at runtime** — ML runs in-process via ONNX
  Runtime.
- Known-excluded alternatives (do not reintroduce): Rubber Band (GPL/paid — use
  Signalsmith Stretch), aubio (GPL), Meta MMS multilingual weights (CC-BY-NC).
- English-first v1: no multilingual alignment paths (PLAN.md §1, §6).
- v1 scope is frozen (PLAN.md §3). No mic input, no pitch detection, no scoring
  — those are v2. Flag scope creep when you see it, including in requests.
- Timing maps always store original-song time; only the player clock translates
  through stretch ratios (PLAN.md §5).

## Conventions

- Performance claims require measured numbers: song length, hardware, wall
  time. "Seems fast" doesn't count (spike reports and PRs alike).
- Alignment-accuracy claims are measured against hand-timed references (Phase 0)
  or the accuracy harness (Phase 1+).
- Spike code may be rough; spike *measurements* may not.

## Repo layout

- `PLAN.md` — the plan (authoritative)
- `spikes/` — Phase 0 prototypes, one directory per spike; each produces a
  `REPORT.md` graded against the criteria in `spikes/README.md`
- `MODEL_LICENSES.md` — provenance of every model weight we mirror
- `.claude/agents/` — spike-runner, pipeline-dev, licensing-auditor
- `.claude/workflows/phase0-spikes.js` — runs the four Phase 0 spikes in
  parallel and synthesizes a go/no-go report
