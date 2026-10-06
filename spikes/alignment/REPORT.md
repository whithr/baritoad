# Spike report: `alignment/` — wav2vec2 CTC forced alignment via ONNX in Rust

**Verdict: partial** — mechanism proven end-to-end with no Python at runtime; speed within CPU budget; trellis reimplementation exact vs reference; absolute timing verified to 55 ms median on machine-generated ground truth. The one criterion this environment could not measure is word-onset error vs **hand-timed references on real songs** (no hand-timed references exist yet and grading "feels right in playback" requires a human listener). Nothing observed suggests it would fail; the remaining risk is concentrated in whisper transcript quality on full mixes, not in the aligner.

## What was built

A single Rust binary (`alignment-spike`, ~1,100 lines, no Python at runtime) implementing the two-stage design:

1. mp3/wav decode (symphonia) → mono → 16 kHz (rubato sinc resample)
2. **Stage 1**: whisper-small via ONNX Runtime (`ort` crate) — Rust log-mel
   (slaney filterbank, matches `WhisperFeatureExtractor` to 1e-5), encoder +
   merged KV-cache decoder, greedy English decode, suppress-token handling
3. **Stage 2**: wav2vec2-base-960h emissions via ONNX (30 s chunks, 4 s overlap,
   trimmed stitching, log-softmax) → **CTC Viterbi forced-alignment trellis
   reimplemented in Rust** (torchaudio-style, 2N+1 states, backpointer
   backtrack) → per-word start/end times + confidence → JSON

Python (torch/torchaudio/transformers) was used only as build-time tooling:
ONNX export of wav2vec2 and cross-validation of the Rust implementations.

## Numbers

Hardware: Intel i7-9700K (8C/8T, 2018), 32 GB RAM, NVIDIA RTX 2080 SUPER 8 GB
(DirectML EP), Windows 10 Pro 19045. **Caveat: the machine carried ambient
load (a game + browser, ~50% CPU at times) during measurement; the whisper
stage showed up to 2x run-to-run variance. Numbers below are single
representative runs; treat them as upper bounds on an idle machine.**

Test input: five user-supplied mp3s (44.1 kHz stereo), titles as supplied:
back-on-my-bs (1:35), dogs (3:10), falling-out-of-love (6:23), she-said
(3:34), wildflowers (3:33). Full mixes — no vocal stems were available (the
separation spike ran in parallel), which is *harder* than the production
input.

### Correctness of the Rust reimplementation (the load-bearing question)

| Check | Result |
|---|---|
| CTC trellis vs `torchaudio.functional.forced_align` on identical emissions | **frame-exact on all 5 songs — 5,080/5,080 token spans identical** (back-on-my-bs 1120, dogs 697, falling-out-of-love 804, she-said 1569, wildflowers 890) |
| Rust log-mel vs `WhisperFeatureExtractor` (same 16 kHz input) | max abs err 0.00001 on all 5 songs |
| wav2vec2 ONNX export vs PyTorch | max abs err 5e-5 |

### Absolute timing accuracy vs machine-exact ground truth

Windows SAPI TTS renders 60 words of clean speech (16 kHz) and reports each
word's exact audio onset (`SpeakProgress.AudioPosition`). This catches
systematic time-mapping bugs (resample offsets, frame indexing) that the
trellis comparison cannot, since that comparison shares emissions.

- **59/60 words matched; onset error: median 55 ms, p90 81 ms, max 90 ms;
  100% within 100 ms** (signed error +55 ms median — a consistent "late"
  bias from the CTC emission peak sitting mid-phoneme; a constant offset
  correction would roughly halve the median)
- Clean speech, not sung vocals — this validates the *pipeline's clock*, not
  karaoke-feel on music.

### Speed vs target (alignment stage = whisper + w2v emissions + trellis)

Target: ≤ 30 s GPU-class / ≤ 90 s CPU per 3.5-min song.

CPU fp32 (all 8 threads):

| song | audio | whisper | w2v | trellis | total | rtf | normalized to 3.5 min |
|---|---|---|---|---|---|---|---|
| back-on-my-bs | 95 s | 29.2 | 12.1 | 0.04 | 41.4 s | 0.44 | 92 s |
| dogs | 190 s | 20.7 | 19.4 | 0.03 | 40.1 s | 0.21 | 44 s |
| falling-out-of-love | 383 s | 44.2 | 53.0 | 0.08 | 97.2 s | 0.25 | 53 s |
| she-said | 214 s | 46.1 | 28.3 | 0.18 | 74.5 s | 0.35 | 73 s |
| wildflowers | 213 s | 27.8 | 31.4 | 0.06 | 59.3 s | 0.28 | 58 s |

- All four 3–3.6-min songs finished in 40–75 s ≤ 90 s CPU target. Normalized
  rtf range 0.21–0.44 (median 0.28); worst case (dense rap) sits at the limit.
- **int8 decoder** (dynamic-quantized): she-said 74.5 → **58.3 s** (–22%),
  word-sequence similarity 0.893 vs fp32, onset agreement median 0.0 s.
- **DirectML (RTX 2080 SUPER)**: wav2vec2 emissions **28.3 → 2.1 s (13x)**.
  Whisper is *not* DML-viable: merged KV-cache decoder 4x slower than CPU
  (dynamic shapes), encoder also slower than 8-core CPU. Best hybrid measured
  (whisper int8 CPU + w2v DML): she-said ≈ 35 s, wildflowers 47.3 s under
  ambient load — **misses the ≤ 30 s GPU-class target on this 2018 GPU**, with
  clear paths open (CUDA EP untested here — needs cuDNN 9 installed; encoder
  IO-binding; batched decode). Trellis cost is negligible (< 0.2 s).
- Model load (excluded from stage times, once per app run): whisper ~4.5 s,
  w2v ~1.5 s.

### Alignment plausibility on songs (no hand-timed refs — heuristics only)

Word timings strictly monotonic on all songs. Median word duration
0.14–0.60 s. Stretched words (> 2 s, usually the aligner absorbing audio the
transcript missed): back-on-my-bs 1/231, she-said 3/334, wildflowers 7/200,
dogs 12/146, falling-out-of-love 20/161 (12% — whisper badly
under-transcribed this one: 161 words in 6.4 min).

## Repro (clean checkout)

```
# 1. Rust toolchain (1.97) + Python 3.12 venv for export/validation tooling
python -m venv %TEMP%\kvenv   # short path: torch install hits Windows long-path limits otherwise
%TEMP%\kvenv\Scripts\pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
%TEMP%\kvenv\Scripts\pip install transformers onnx onnxruntime soundfile numpy

# 2. Models (gitignored under spikes/alignment/weights/)
#    whisper-small ONNX: huggingface.co/onnx-community/whisper-small @ 36050c46
#    -> weights/whisper-small/{config,generation_config,tokenizer,preprocessor_config}.json
#    -> weights/whisper-small/onnx/{encoder_model,decoder_model_merged,decoder_model_merged_int8}.onnx
%TEMP%\kvenv\Scripts\python py\export_wav2vec2.py   # exports facebook/wav2vec2-base-960h -> weights/wav2vec2/

# 3. Build + run (from spikes/alignment/)
cargo build --release
target\release\alignment-spike ..\testdata\<song>.mp3 --weights weights --outdir out --dump-debug
#   flags: --int8 (quantized whisper decoder), --dml (wav2vec2 on DirectML)

# 4. Validation
%TEMP%\kvenv\Scripts\python py\validate.py <song-stem>   # trellis vs torchaudio + mel parity
powershell -File py\make_tts_reference.ps1               # SAPI ground truth (16 kHz!)
target\release\alignment-spike out\tts-reference.wav --weights weights --outdir out
%TEMP%\kvenv\Scripts\python py\compare_tts.py            # onset-error distribution
%TEMP%\kvenv\Scripts\python py\summarize.py              # per-song table
```

## Licensing (docs/DEPENDENCIES.md — all clear)

- whisper-small: OpenAI weights, MIT per the licensing matrix (HF card tags Apache-2.0;
  both commercial-safe). ONNX export consumed from onnx-community (a
  transformers.js/optimum export of `openai/whisper-small`); **Phase 1 should
  export from the original OpenAI weights ourselves for clean provenance** and
  record it in MODEL_LICENSES.md.
- wav2vec2: `facebook/wav2vec2-base-960h`, **Apache-2.0** (HF). The licensing matrix lists
  "wav2vec2-base (fairseq) MIT" — the fine-tuned 960h CTC checkpoint actually
  carries Apache-2.0; commercial-safe either way, but the matrix row should
  be updated in Phase 1 (not touched by this spike per spike rules).
- Rust deps: ort MIT/Apache-2.0, symphonia MPL-2.0 (unmodified), rubato MIT,
  rustfft MIT/Apache-2.0, serde/serde_json/anyhow MIT/Apache-2.0. No
  GPL/AGPL anywhere. torch/torchaudio/transformers are build-time tooling
  only and ship nothing.
- Meta MMS multilingual was not touched (CC-BY-NC, excluded; English-only).

## Risks discovered

1. **Transcript quality is the accuracy bottleneck, not the aligner.** On full
   mixes whisper-small under-transcribes/hallucinates in instrumental-heavy
   songs (161 words in 6.4 min on one ballad; 12% of its words stretched
   > 2 s as the trellis absorbed unsung audio). The golden path (pasted
   lyrics + edit-distance anchoring + vocal stems) attacks exactly this — but
   it means alignment quality *measured without stems and without pasted
   lyrics* understates production quality, and QA must test the full path.
2. **DirectML is a partial GPU story**: 13x for wav2vec2, but whisper's merged
   KV-cache decoder is 4x *slower* than CPU on DML and the encoder also loses
   to 8 threads. The ≤ 30 s GPU-class target likely needs CUDA EP (cuDNN 9
   install — not present here) or a static-shape decoder export. Not blocking:
   the CPU path already meets its budget.
3. **ort 2.0-rc.10 sharp edges**: zero-length KV tensors must be created via
   the allocator API (raw-data creation rejects dim 0); presents must be moved
   and fed by view — a naive copy-per-step decode loop doubled whisper time
   (99.7 s → 46.1 s after fixing). int8 *encoder* ONNX uses ConvInteger,
   unimplemented in ort's bundled CPU build (int8 decoder works fine).
4. **Constant +55 ms late bias** in word onsets (vs SAPI ground truth). A
   fixed offset subtraction is a near-free accuracy win to tune against
   hand-timed references in Phase 1.
5. **Windows long-path**: torch cannot pip-install into deep venv paths;
   dev-setup docs should mandate short venv paths or LongPathsEnabled.
6. whisper's fixed 30 s chunking can split words at boundaries; production
   should cut chunks at detected silence and/or overlap-merge.

## Recommendation

Proceed toward Phase 1 with this design — the no-Python bet holds. In order:

1. **Close the accuracy criterion first** (cheap, human-in-the-loop): hand-time
   5–10 diverse English songs (per spikes/README.md), run this binary, grade
   the onset-error distribution and playback feel. Everything is scripted;
   only the references are missing.
2. Re-run over **vocal stems** from the separation spike + **pasted-lyrics
   anchoring** (edit-distance vs whisper text) — the two production inputs
   this spike had to do without; both should materially improve hard cases.
3. Harden for Phase 1: constant-offset correction (risk 4), silence-aware
   chunking (risk 6), IO-binding/session reuse, CUDA EP bring-up for the GPU
   target, export whisper ONNX from original weights + MODEL_LICENSES.md
   entries, update the licensing matrix row for wav2vec2-base-960h (Apache-2.0).
4. Keep the named fallback (whisper.cpp timestamps + DTW) parked — nothing
   measured here motivates taking it.
