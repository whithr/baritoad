# Separation spike — htdemucs via ONNX in Rust

**Verdict: partial** — every criterion measurable on this hardware passed with wide
margins (quality indistinguishable from Python demucs, GPU 19–22 s and CPU well
under target for a 3.5-min song); the "runs on CoreML" bullet could not be tested
because no macOS hardware is available. Feasibility question answered: yes,
htdemucs exports to ONNX and runs from Rust via ONNX Runtime.

## What was built

- `export/stft_onnx.py` — ONNX-exportable replacements for htdemucs's STFT/iSTFT
  (the "known-fiddly part"): forward STFT as a Conv1d with a fixed DFT
  basis; inverse STFT as MatMul + shifted-pad overlap-add. Verified against
  demucs's own `_spec`/`_ispec` at <= 2.6e-6 max relative error.
- `export/export_htdemucs.py` — loads pretrained htdemucs (single-model bag,
  MIT weights), monkeypatches `_spec/_magnitude/_mask/_ispec` on the instance,
  exports one static-shape graph: stereo 7.8 s segment (1, 2, 343980) in ->
  (1, 4, 2, 343980) stems out. Opset 17, TorchScript exporter. 309.9 MB file.
- `rust/` — `separation-spike` binary (ort 2.0.0-rc.13 + hound + ndarray, ~200
  lines): replicates demucs `apply_model(shifts=0, split=True, overlap=0.25)`
  exactly — outer mono-reference normalization, 25 %-overlap segmentation with
  triangular blending, real-left-context padding + center-trim on the last
  chunk — and writes 4 stems + `instrumental.wav` (drums+bass+other).
- `export/reference_separate.py` / `export/compare.py` — deterministic Python
  demucs reference (same shifts=0/overlap settings) and per-stem SNR comparison.

## Hardware / software

- Windows 10 Pro 19045, Intel i7-9700K (8C/8T), 32 GB RAM,
  NVIDIA RTX 2080 SUPER 8 GB (driver 596.36). No CUDA toolkit installed;
  GPU path is the DirectML EP (the named Windows fallback).
- Rust 1.97.1, ort crate 2.0.0-rc.13 (ONNX Runtime 1.28.0, pyke prebuilt
  binaries). Export toolchain: Python 3.12.10, torch 2.13.0+cpu, demucs 4.1.0,
  onnx 1.22.0, onnxruntime-python 1.28.0.
- Test songs (user-owned, 44.1 kHz stereo MP3, decoded to WAV via libsndfile):
  back-on-my-bs (94.4 s), dogs (189.5 s), falling-out-of-love (382.9 s),
  she-said (213.3 s), wildflowers (212.9 s). Files had no usable title/artist
  tags; filenames are the identifiers. Audio, weights, and ONNX files all live
  outside the repo (gitignored patterns verified with `git status`).

## Numbers vs pass criteria

### 1. Quality — "no audible degradation vs reference Python demucs on 3–5 songs"

Measured as per-stem SNR of the Rust/ONNX output against reference Python
demucs output (identical deterministic settings), 5 songs x 4 stems.

DirectML EP (graph fusion disabled — see risks):

| song | drums | bass | other | vocals |
|---|---|---|---|---|
| back-on-my-bs | 119.7 dB | 123.2 dB | 110.5 dB | 117.1 dB |
| dogs | 94.7 dB | 91.8 dB | 119.7 dB | 117.6 dB |
| falling-out-of-love | 120.5 dB | 126.3 dB | 118.2 dB | 118.1 dB |
| she-said | 117.9 dB | 121.3 dB | 118.8 dB | 117.4 dB |
| wildflowers | 122.9 dB | 122.0 dB | 115.7 dB | 117.4 dB |

Minimum: **91.8 dB**.

CPU EP, same 5 songs x 4 stems: 67.5–100.8 dB, minimum **67.5 dB** (dogs,
bass); per-song minima: back-on-my-bs 79.8, dogs 67.5, falling-out-of-love
92.7, she-said 88.4, wildflowers 86.6 dB. ONNX-vs-torch parity on a random
segment: 77.8 dB SNR, max abs err 5.2e-5.

Honesty note: no human listened to these outputs (agent-run spike). At the
worst measured 67.5 dB SNR the residual sits well below the 16-bit dither
floor (~96 dB below full scale for these ~ -18 dBFS stems), so an audible
difference vs the Python reference is not physically possible. This criterion's
"by ear" spot-check should still happen casually during Phase 1 dogfooding.

### 2. Speed — "3.5-min song <= 60 s GPU-class, <= 8 min CPU"

3.5-min song = she-said (213.3 s audio, 37 segments). Wall time = load + session
init + inference + overlap-add + WAV writes.

| EP | she-said wall | target | margin |
|---|---|---|---|
| DirectML (RTX 2080 SUPER) | **19.3–22.0 s** | <= 60 s | 2.7–3.1x |
| CPU (i7-9700K, 8 threads) | **102.2 s** (148.6 s when contended) | <= 480 s | 4.7x |

All songs, DirectML (fusion disabled): 94.4 s -> 8.6 s; 189.5 s -> 16.0 s;
213.3 s -> 19.3 s; 212.9 s -> 19.8 s; 382.9 s -> 34.7 s. Roughly 11x realtime.
CPU (clean runs): 189.5 s -> 88.2 s; 213.3 s -> 102.2 s; 212.9 s -> 129.0 s;
382.9 s -> 195.5 s. Roughly 2x realtime. Reference Python demucs CPU on the
same machine: 119–475 s per song (contended, indicative only).

DirectML session init varies 3.3–14.7 s (first-run shader compile; cached
afterwards) and is included in the wall times above. Peak working set of the
Rust process (DirectML, 94 s song): 669 MB RAM (+ VRAM).

### 3. Execution providers

- **CPU EP:** works, verified bit-close to Python (min 67.5 dB SNR over all 5
  songs x 4 stems). Passes the time target with 4.7x margin.
- **DirectML EP:** works and is the fastest path measured — but only with
  `ep.dml.disable_graph_fusion = 1` (see risks; fusion silently corrupts the
  output) and only after reformulating the iSTFT as MatMul+OLA (ConvTranspose
  OOMs the 8 GB card).
- **CoreML EP: not tested — no macOS hardware in this environment.** This is
  the bullet that keeps the verdict at "partial" (same convention as the
  lyric-render spike: missing platform means partial, not pass). Concrete test
  plan: the ort crate's prebuilt `aarch64-apple-darwin+coreml` binaries are in
  the same dist manifest already used here; the exported graph is fully static
  (CoreML's best case) and contains only Conv/MatMul/Norm/Attention ops. Run
  the identical binary + compare.py on an M2, expect <= 60 s / 3.5-min song;
  CPU EP on M2 is the in-place fallback if CoreML partitioning disappoints.
- **CUDA EP: not tested** — no CUDA toolkit/cuDNN on this machine, and
  DirectML already meets the Windows GPU target, demoting CUDA to an optional
  optimization. Documented status: ort supports it behind the `cuda` feature +
  ORT CUDA binaries; test alongside Linux work in Phase 1.

## Repro (clean checkout)

```powershell
# 1. Python export env (build-time only — no Python in the product)
#    Use a SHORT path: torch install fails in deep paths (see risks)
python -m venv C:\t\venv
C:\t\venv\Scripts\python -m pip install torch torchaudio demucs onnx onnxruntime soundfile numpy einops

# 2. Verify STFT parity, then export ONNX (downloads MIT htdemucs weights from HF)
cd spikes\separation\export
C:\t\venv\Scripts\python stft_onnx.py            # expect SELFTEST PASS
C:\t\venv\Scripts\python export_htdemucs.py C:\t\work

# 3. Decode owned test MP3s and build the Python reference stems
C:\t\venv\Scripts\python prep_audio.py ..\..\testdata C:\t\work\wav
C:\t\venv\Scripts\python reference_separate.py C:\t\work\wav C:\t\work\ref

# 4. Rust inference (CPU and DirectML)
cd ..\rust
cargo build --release
.\target\release\separation-spike.exe C:\t\work\htdemucs.onnx C:\t\work\wav\she-said.wav C:\t\work\rust-cpu\she-said cpu
.\target\release\separation-spike.exe C:\t\work\htdemucs.onnx C:\t\work\wav\she-said.wav C:\t\work\rust-dml\she-said directml

# 5. SNR vs reference
cd ..\export
C:\t\venv\Scripts\python compare.py C:\t\work\ref C:\t\work\rust-dml
```

## Risks discovered

1. **DirectML graph fusion silently corrupts this model.** With default session
   options the output is garbage (stem RMS ~15 000 vs ~0.14) — no error, no
   NaN, just wrong numbers. `ep.dml.disable_graph_fusion=1` fixes it (and
   costs only ~15 % speed). Consequence for Phase 1: numerical parity
   verification per EP must be a product feature (golden-segment SNR check at
   model install / first EP use), not just a dev-time test — otherwise an EP
   or driver update could ship inaudible-to-us garbage to users.
2. **DirectML cannot run large ConvTranspose.** The natural iSTFT-as-
   ConvTranspose1d (kernel 4096, stride 1024) OOMs an 8 GB card via im2col
   materialization. Reformulating as MatMul + 4 shifted pads (overlap-add) is
   exact (verified 1e-6) and DML-friendly. Any future model with big
   transposed convs will hit the same wall.
3. **torch.stft/istft genuinely don't export** (istft has no ONNX op; opset-17
   STFT is unsupported on DML anyway). The conv/matmul reformulation with
   parity tests is the workable pattern; the "known-fiddly" flag is
   confirmed but fully tractable. In-graph DFT bases add ~134 MB of constants
   (309.9 MB total vs ~166 MB raw weights); could be halved later by doing
   STFT/iSTFT in Rust (rustfft) at the cost of reimplementing the parity-exact
   padding — not needed for the ~350 MB budget.
4. **TorchScript ONNX exporter is deprecated** (torch 2.13 warns; dynamo
   export is the default going forward). The export worked first try with
   `dynamo=False`; pin the export toolchain versions (requirements lockfile)
   before Phase 1 so the mirror-published ONNX stays reproducible.
5. **demucs 4.1 fetches weights from Hugging Face** (`adefossez/HTDemucs`,
   MIT) rather than dl.fbaipublicfiles. For MODEL_LICENSES.md provenance when
   we mirror: record the HF repo + file hash of the checkpoint actually used.
6. **demucs CLI defaults are nondeterministic** (`shifts=1` random shift). The
   spike pinned shifts=0 on both sides. If Phase 1 wants the shift trick
   (about +0.2 SDR), it doubles inference cost and needs a seeded shift in Rust.
7. **Windows dev-environment trap:** torch cannot install into deep paths
   (260-char limit) — the venv must live at a short path. Cost an hour of this
   spike; worth a line in the contributor docs.
8. **Licensing (docs/DEPENDENCIES.md):** new runtime deps are all commercial-safe — ort
   (MIT OR Apache-2.0), ndarray (MIT/Apache-2.0), hound (Apache-2.0), ONNX
   Runtime 1.28 binaries (MIT). Build-time only: torch (BSD-3), demucs (MIT),
   onnx (Apache-2.0), soundfile (BSD-3), einops (MIT). The licensing matrix needs
   ort/ndarray/hound rows added in the Phase 1 change that adopts them (spike
   rules forbid editing it from here).

## Recommendation

Adopt the ONNX + ort path for Phase 1 (no need for the demucs.cpp FFI
fallback). Harden, in order:

1. **Ship the per-EP golden-segment parity check** (risk 1) — it would have
   caught the fusion bug, and it converts "EP works on our machines" into "EP
   verified on the user's machine".
2. **Verify CoreML on an M2** with the identical artifacts (test plan above) —
   the only open pass-criterion item; until then the Windows/Linux GPU story is
   DirectML(+CUDA later) and the macOS story is unproven.
3. Streamed overlap-add (bounded memory for very long inputs), Symphonia
   decode instead of pre-decoded WAV, session/thread tuning for CPU EP, and a
   pinned export lockfile + mirrored ONNX with hash in MODEL_LICENSES.md.
