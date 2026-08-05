"""Reference Python demucs separation (ground truth for the spike comparison).

Deterministic settings: shifts=0, split=True, overlap=0.25 — the same scheme
the Rust port implements. Saves all 4 stems as float32 WAV plus timing.

Usage: python reference_separate.py <wav_dir> <out_dir>
"""
import json
import sys
import time
from pathlib import Path

import soundfile as sf
import torch

from demucs.apply import apply_model
from demucs.pretrained import get_model

wav_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)

bag = get_model("htdemucs")
bag.eval()
timings = {}
for f in sorted(wav_dir.glob("*.wav")):
    data, sr = sf.read(f, dtype="float32", always_2d=True)
    assert sr == bag.samplerate
    wav = torch.from_numpy(data.T)  # (2, L)
    ref = wav.mean(0)
    mean, std = ref.mean().item(), ref.std().item()
    wav_n = (wav - mean) / std
    t0 = time.time()
    with torch.no_grad():
        sources = apply_model(bag, wav_n[None], shifts=0, split=True,
                              overlap=0.25, progress=False, device="cpu")[0]
    dt = time.time() - t0
    sources = sources * std + mean
    song_dir = out_dir / f.stem
    song_dir.mkdir(exist_ok=True)
    for name, src in zip(bag.sources, sources):
        sf.write(song_dir / f"{name}.wav", src.numpy().T, sr, subtype="FLOAT")
    timings[f.stem] = {"seconds_audio": data.shape[0] / sr, "separate_s": round(dt, 1)}
    print(f"{f.stem}: {data.shape[0] / sr:.1f}s audio, python demucs cpu {dt:.1f}s")

(out_dir / "timings.json").write_text(json.dumps(timings, indent=2))
