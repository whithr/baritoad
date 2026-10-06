# Phase 0 go/no-go — de-risk spike synthesis

Date: 2026-08-05. Judged against the roadmap gate ("nothing else until
they pass or their fallbacks are chosen") and the top risks, per the criteria
in spikes/README.md. Full evidence: each spike's REPORT.md.

## Verdict table

| Spike | Verdict | Headline numbers (hardware: i7-9700K / RTX 2080 SUPER / 32 GB / Win10 unless noted) |
|---|---|---|
| separation (htdemucs → ONNX → Rust/ort) | **partial** | Quality vs Python demucs: min **91.8 dB SNR** DirectML, **67.5 dB** CPU (5 songs × 4 stems — below the 16-bit dither floor, audible difference physically impossible). Speed, 3.55-min song: **19.3–22.0 s** DirectML (target ≤ 60 s), **102.2 s** CPU (target ≤ 480 s). CoreML: **untested, no macOS hardware** — sole reason for partial. |
| alignment (whisper-small + Rust CTC trellis) | **partial** | Rust trellis **frame-exact vs torchaudio on all 5 songs (5,080/5,080 spans)**; onset error vs machine-exact TTS ground truth **55 ms median / 90 ms max, 100% ≤ 100 ms**; CPU alignment 40–75 s per 3.5-min-class song (target ≤ 90 s). **Missing: word-onset error vs hand-timed references on real songs — no references exist yet.** GPU-class ≤ 30 s target missed on this 2018 GPU (best hybrid ≈ 35–47 s; CUDA EP untested). |
| stretch (Signalsmith key/tempo) | **partial** | Apply latency **passes measured**: 80–92 ms end-to-end preset_default, **35–50 ms** with 40 ms/10 ms config (target < 100 ms); **gapless across all 16 live mid-playback changes**; RTF 0.019–0.030 (33–50× realtime). **Missing: the ~30-min human listening pass** over 65 rendered level-matched A/B files (artifact-quality criterion). |
| lyric-render (60 fps in Tauri webview) | **partial** | Windows/WebView2 at 3440×1387: DOM path **119.8 fps avg, p99 8.5 ms, 0/3,594 frames over the 60 fps budget**; canvas 9/3,564 (0.25%) over, none > 34 ms. **Missing: WebKitGTK/Linux measurement — no Linux machine**; spike contract explicitly caps this at partial. |

## Overall call: **GO** (conditional — no fallbacks invoked)

Four partials, zero fails — but the partials are not equivalent, and it matters:

- **Hardware-gap partials** (separation/CoreML, lyric-render/WebKitGTK): every
  criterion measurable on available hardware passed **with wide margin**. The
  missing piece is a machine, not a result. Both spikes ship the exact
  binary + harness + pass bar for the missing platform; running it is
  mechanical.
- **Human-ear partials** (stretch listening pass, alignment hand-timed
  references): the instrumentation is complete and everything scripted; what's
  missing is human judgment that an agent-run spike cannot supply. These are
  cheap (≈30 min and ≈1–2 days respectively) but they are the only two places
  a **quality miss could still be hiding**, so they gate Phase 0 closeout —
  see below.

The bluntest reading: **alignment is the weakest partial.** Its core criterion
("feels right vs hand-timed references, ≤ ~100 ms median") is unmeasured on
real songs, and the spike found measured evidence of the failure mode — on
full mixes, whisper-small under-transcribed an instrumental-heavy ballad (161
words in 6.4 min; 12% of words stretched > 2 s as the trellis absorbed unsung
audio). Two mitigations keep this from blocking: (1) the spike ran **without**
the two production inputs — vocal stems (now proven available from the
separation spike) and pasted-lyrics edit-distance anchoring — both of which
attack exactly this failure; (2) hard material is already budgeted for
via the first-class fix editor. The aligner mechanism itself is
proven exact; the open question is transcript quality, which the production
pipeline shape directly addresses.

**Stretch is the highest-stakes cheap item.** If the listening pass fails
there is no cheap fallback (Rubber Band is excluded, docs/DEPENDENCIES.md; the named path
is "license commercially or descope key/tempo — escalate"). Spend the 30
minutes before anything else.

## Fallback status

**None invoked.** Every spike's measured evidence points at the primary path:

| Named fallback | Status | Cost if its trigger later fires |
|---|---|---|
| demucs.cpp FFI / sidecar | Not needed — ONNX+ort passed everything measurable | n/a; trigger would be a CoreML-specific failure, in which case CPU EP on Apple Silicon is the in-place fallback first |
| whisper.cpp timestamps + DTW | Parked — nothing measured motivates it | Lower timing quality, fix editor carries more weight; only take it if hand-timed grading fails *with* stems + lyric anchoring |
| Rubber Band / descope key-tempo | Not indicated — latency/gapless passed | Real money or a v1 feature cut; decision escalates per spikes/README.md, not made here |
| Native wgpu player window | Explicitly do **not** start — trigger (WebKitGTK failure) has not been measured | ~weeks of renderer work; keep DOM+canvas dual path until Linux numbers decide |

## Phase 0 closeout — required before calling the gate cleared

In priority order (1–2 are human, 3–4 are hardware):

1. **Stretch listening pass** (~30 min, any listener): A/B the 65 renders in
   `spikes/stretch/out/` per the protocol in its REPORT §2B; also decides
   preset_default vs the 40 ms/10 ms config. Only spike whose failure has no
   cheap fallback.
2. **Hand-time 5–10 diverse English songs and grade alignment** (the actual
   spike-2 criterion): run the existing `alignment-spike` binary, grade the
   onset-error distribution + playback feel. Re-run over **vocal stems** with
   **pasted-lyrics anchoring** — the production configuration — not just full
   mixes. Apply the measured constant −55 ms bias correction first; it roughly
   halves the median for free.
3. **CoreML on an M2**: identical artifacts (same ort crate ships
   aarch64-apple-darwin+coreml binaries, same ONNX + compare.py). Graph is
   fully static — CoreML's best case. Until then the macOS story is unproven.
4. **WebKitGTK on real Linux** (live-USB Ubuntu 24.04 on this desktop is the
   zero-hardware option; **not WSLg**): run matrix {dom, canvas} ×
   {compositing on/off} × {X11, Wayland}; pass bar p99 ≤ 16.7 ms fullscreen,
   no frame > 34 ms.

Items 1–2 gate Phase 0 done. Items 3–4 may run alongside early Phase 1 CLI
work — their fallbacks are named, untriggered, and don't reshape the pipeline.

### Closeout status — owner decisions, 2026-08-05

1. **Stretch listening pass: closed, informal pass.** Owner listened to the
   rendered A/B set and judged all renders acceptable — artifacts audible at
   the extremes but not objectionable ("they all sound good, just with their
   distortions"). This satisfies criterion B's intent (no objectionable
   artifacts at ±3; degradation at ±6 acknowledged). The structured per-render
   protocol in REPORT §2B was not followed; the preset_default vs 40 ms/10 ms
   config choice remains open for Phase 1.
2. **Hand-timed alignment grading: deferred by owner decision.** Accepted
   risk; to be verified in-app once a GUI exists (the fix editor / playback
   view will make grading "feels right" direct). The whisper.cpp+DTW fallback
   remains parked, not cancelled, until that verification happens.
3. **CoreML rerun: deferred**, no timeline; macOS support unproven until run.
4. **WebKitGTK rerun: deferred**, no timeline; Linux support unproven until
   run, and the DOM+canvas dual path stays in place.

With 1 closed and 2 explicitly deferred, the Phase 0 gate is **cleared** and
Phase 1 may start. The deferred items carry known, bounded risk documented
above.

## Phase 1 hardening list (consolidated from the four reports)

**Product-correctness (highest priority — these are shipped features, not dev tests):**
- **Per-EP golden-segment SNR parity check at model install / first EP use.**
  DirectML graph fusion silently produced garbage (stem RMS ~15,000 vs ~0.14,
  no error) until `ep.dml.disable_graph_fusion=1`; a driver/EP update could
  ship inaudible-to-us garbage without this.
- **MMCSS "Pro Audio" registration** for audio callback threads on Windows
  (measured 14× reduction in worst-case callback stall: 43.5 → 3.0 ms); find
  macOS/Linux equivalents. cpal's error callback reported zero errors during
  the stalls — do not trust it as an underrun detector.
- **~−9 dB headroom pre-stretch + soft limiter post-stretch** (output peaks up
  to 2.08× input peak on loudness-maximized mixes).
- **Budget per-frame lyric-render work for ~8 ms, not 16 ms** — WebView2
  vsyncs rAF at panel rate; 120/144 Hz panels halve the frame budget.

**Pipeline quality:**
- Constant −55 ms alignment offset correction, tuned against hand-timed refs.
- Silence-aware whisper chunking (fixed 30 s chunks can split words).
- Align over vocal stems + pasted-lyrics edit-distance anchoring as the
  golden path; QA must test that full path, not the spike's harder-but-
  unrepresentative full-mix path.
- Casual ear spot-check of separation stems during dogfooding (SNR says an
  audible difference is impossible, but the by-ear criterion is still owed).

**Performance:**
- CUDA EP bring-up (needs cuDNN 9) for the ≤ 30 s GPU-class alignment target;
  DirectML is only a partial GPU story there (13× on wav2vec2, 4× *slower* on
  the whisper decoder). Not blocking — CPU meets its budget.
- Session reuse / IO-binding for ort (a naive KV copy-per-step loop doubled
  whisper time); streamed overlap-add + Symphonia decode in separation.
- Keep both DOM and canvas lyric renderers behind a switch until WebKitGTK
  numbers pick the winner (DOM beat canvas on Windows, inverting the
  "WebGL/canvas" assumption).

**Toolchain / provenance / licensing:**
- Pin the ONNX export toolchain (TorchScript exporter deprecated in torch
  2.13); mirror the exported ONNX with hashes.
- MODEL_LICENSES.md: htdemucs weights now come from HF `adefossez/HTDemucs`
  (MIT) — record repo + checkpoint hash; export whisper ONNX from original
  OpenAI weights (spike consumed the onnx-community re-export).
- Licensing matrix (docs/DEPENDENCIES.md) updates in the adopting change: add ort, ndarray, hound;
  correct wav2vec2-base-960h to **Apache-2.0** (matrix says MIT; both
  commercial-safe). No GPL/AGPL anywhere in any spike; symphonia is MPL-2.0
  unmodified.
- Signalsmith bindings: vendor the MIT C wrapper with hand-written FFI or fix
  libclang in CI for the crate; patch its `set_formant_base` →
  `setFormantSemitones` bug either way.
- Contributor docs: torch cannot pip-install into deep Windows paths (260-char
  limit) — mandate short venv paths (bit two spikes independently).

## One-line summary

Every load-bearing technical bet the plan makes — htdemucs in Rust via ONNX,
Python-free CTC alignment, Signalsmith latency, webview rendering — survived
contact with measurement, most with multiples of margin; what remains is two
cheap human passes and two platform reruns, none of which has a triggered
fallback. Proceed to Phase 1.
