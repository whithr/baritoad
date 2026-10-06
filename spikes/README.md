# Phase 0 de-risk spikes

Four feasibility questions. Nothing else gets built until these
pass or their fallbacks are chosen. Each spike lives in its own directory, is
run by a `spike-runner` agent (or a human), and must end with a `REPORT.md`
containing: verdict (pass / fail / blocked / partial), measured numbers vs the
target, hardware used, exact repro steps, risks discovered, and — on fail — a
recommendation among the named fallbacks.

Test audio: use songs you own, placed locally; audio files are gitignored and
must never be committed. Note in the report which songs were used (title/artist
text only).

## 1. `separation/` — htdemucs via ONNX in Rust

**Question:** can htdemucs be exported to ONNX and run from Rust via ONNX
Runtime with acceptable quality and speed? (The STFT ops are the
known-fiddly part.)

**Pass criteria**
- Exported model produces output with no audible degradation vs reference
  Python demucs on 3–5 real songs (spot-check by ear + report SDR if cheap).
- 3.5-min song: ≤ 60 s on GPU-class hardware (M2/CoreML here), ≤ 8 min CPU.
- Runs on CoreML and CPU EPs locally; CUDA/DirectML status documented for
  later testing on Windows/Linux hardware.

**Fallbacks if failed:** demucs.cpp via FFI; last resort a sidecar process.

## 2. `alignment/` — wav2vec2 CTC forced alignment via ONNX in Rust

**Question:** can karaoke-grade word timings be produced with whisper-small
(rough pass, edit-distance anchored to pasted lyrics) + wav2vec2-base CTC
forced alignment (refinement over the vocal stem), with the CTC trellis
reimplemented in Rust — no Python? (This has no off-the-shelf
answer and is as load-bearing as the separation spike.)

**Pass criteria**
- 5–10 English songs vs hand-timed references: median word-onset error low
  enough that highlighting *feels* right in playback (target ≤ ~100 ms median;
  report the distribution, not just the median).
- Alignment stage: ≤ 30 s GPU-class / ≤ 90 s CPU per song.
- English-only; do not spend time on multilingual.

**Fallbacks if failed:** whisper.cpp token-level timestamps + DTW, with the fix
editor carrying more weight.

## 3. `stretch/` — Signalsmith Stretch quality on real music

**Question:** is Signalsmith Stretch good enough for key (±6 semitones) and
tempo (~0.8–1.2×) changes on full mixes and separated instrumentals?

**Pass criteria**
- No objectionable artifacts on a varied test set (pop, rock, ballad, dense
  mix) at ±3 semitones; degradation at ±6 documented honestly.
- Apply latency < 100 ms and gapless when changing settings mid-playback in a
  cpal-based prototype.

**Fallbacks if failed:** none cheap — Rubber Band is excluded (GPL/paid,
docs/DEPENDENCIES.md). A fail here means licensing Rubber Band commercially or descoping
key/tempo change; escalate, don't decide in the spike.

## 4. `lyric-render/` — 60 fps lyric rendering in a Tauri webview

**Question:** can the scrolling word-highlight player view hold 60 fps in a
Tauri webview — **specifically on WebKitGTK/Linux**, the weakest webview?
(macOS/Windows passing alone does not pass this spike.)

**Pass criteria**
- Scrolling lyrics + per-word highlight + progress bar at sustained 60 fps
  (no dropped-frame stutter visible) in a representative scene.
- Measured on WebKitGTK. If no Linux machine is available, macOS/Windows
  results plus a concrete Linux test plan = verdict "partial", not "pass".

**Fallbacks if failed:** native wgpu player window for the player view only,
webview retained for everything else.
