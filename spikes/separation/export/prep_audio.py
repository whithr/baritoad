"""Decode test mp3s to 44.1 kHz stereo float32 WAV for the spike.

Usage: python prep_audio.py <src_dir_with_mp3s> <out_dir>
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
for f in sorted(src.glob("*.mp3")):
    data, sr = sf.read(f, dtype="float32", always_2d=True)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    assert sr == 44100, f"{f.name}: sr={sr}, resampling not implemented in spike"
    out = dst / (f.stem + ".wav")
    sf.write(out, data, sr, subtype="FLOAT")
    print(f"{f.name}: {sr} Hz, {data.shape[0] / sr:.1f}s -> {out.name}")
