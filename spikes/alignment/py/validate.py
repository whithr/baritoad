"""Cross-validate the Rust reimplementations against reference implementations.

1. CTC trellis: torchaudio.functional.forced_align on the exact emissions the
   Rust binary dumped -> token spans must match frame-for-frame.
2. Whisper log-mel: transformers WhisperFeatureExtractor on the same audio
   chunk -> max abs error vs the Rust mel dump.

Usage: validate.py <song-stem> [audio-path]
"""
import json, struct, sys, os
import numpy as np
import torch
import torchaudio.functional as F

OUT = os.path.join(os.path.dirname(__file__), "..", "out")
stem = sys.argv[1]

# ---- 1. trellis vs torchaudio ----
with open(os.path.join(OUT, f"{stem}.emissions.bin"), "rb") as f:
    T, C = struct.unpack("<QQ", f.read(16))
    em = np.frombuffer(f.read(), dtype="<f4").reshape(T, C)
targets = json.load(open(os.path.join(OUT, f"{stem}.targets.json")))
rust_spans = json.load(open(os.path.join(OUT, f"{stem}.spans.json")))

log_probs = torch.from_numpy(em.copy()).unsqueeze(0)  # [1, T, C]
tgt = torch.tensor([targets], dtype=torch.int32)
labels, scores = F.forced_align(log_probs, tgt, blank=0)
labels = labels[0].tolist()

# collapse reference frame labels to token spans (mirror of Rust logic)
ref_spans = []
t = 0
tok_idx = 0
prev = None
# torchaudio returns per-frame aligned label ids incl. blanks (0). Build spans of
# consecutive frames assigned to each successive target token occurrence.
# Use token_index tracking: walk frames; a new span starts when label != blank and
# (previous frame was blank or a different token occurrence boundary).
# torchaudio also provides merge_tokens, but do it manually to control semantics.
i = 0
ti = 0  # index into targets
while i < len(labels):
    if labels[i] == 0:
        i += 1
        continue
    lab = labels[i]
    start = i
    while i < len(labels) and labels[i] == lab:
        i += 1
    # repeated identical tokens (e.g. "LL") appear as separate spans separated by
    # a mandatory blank, so each maximal run = one target occurrence.
    ref_spans.append({"token_index": ti, "token_id": lab, "start_frame": start, "end_frame": i})
    ti += 1

print(f"[{stem}] frames={T} vocab={C} targets={len(targets)}")
print(f"rust spans: {len(rust_spans)}  ref spans: {len(ref_spans)}")
mismatch = 0
if len(rust_spans) != len(ref_spans):
    print("SPAN COUNT MISMATCH")
    mismatch = 1
else:
    onset_diff = []
    for r, g in zip(rust_spans, ref_spans):
        if (r["start_frame"], r["end_frame"], r["token_id"]) != (
            g["start_frame"], g["end_frame"], g["token_id"]):
            mismatch += 1
            if mismatch <= 5:
                print("  diff:", r, "vs", g)
        onset_diff.append(abs(r["start_frame"] - g["start_frame"]))
    od = np.array(onset_diff)
    print(f"exact-span mismatches: {mismatch}/{len(ref_spans)}")
    print(f"onset diff frames: max={od.max()} mean={od.mean():.4f}")
print("TRELLIS-MATCH" if mismatch == 0 else "TRELLIS-MISMATCH")

# ---- 2. mel vs WhisperFeatureExtractor ----
mel_path = os.path.join(OUT, f"{stem}.mel0.bin")
audio16k_path = os.path.join(OUT, f"{stem}.audio16k.bin")
if os.path.exists(mel_path) and os.path.exists(audio16k_path):
    from transformers import WhisperFeatureExtractor
    rust_mel = np.fromfile(mel_path, dtype="<f4").reshape(80, 3000)
    audio = np.fromfile(audio16k_path, dtype="<f4")  # the exact input Rust used
    chunk = np.zeros(480000, dtype=np.float32)
    n = min(len(audio), 480000)
    chunk[:n] = audio[:n]
    fe = WhisperFeatureExtractor.from_pretrained(
        os.path.join(os.path.dirname(__file__), "..", "weights", "whisper-small"))
    ref_mel = fe(chunk, sampling_rate=16000, padding=False)["input_features"][0]
    err = np.abs(rust_mel - ref_mel).max()
    print(f"mel max abs err vs WhisperFeatureExtractor: {err:.5f}")
    print("MEL-OK" if err < 0.02 else "MEL-DIVERGES")
