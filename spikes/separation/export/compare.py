"""SNR of Rust-ONNX stems vs reference Python demucs stems.

SNR = 10*log10(sum(ref^2) / sum((ref-test)^2)) per stem. >= ~35-40 dB means the
difference is far below audibility (the reference itself is the signal).

Usage: python compare.py <ref_root> <test_root>
Both roots contain <song>/<stem>.wav.
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ref_root, test_root = Path(sys.argv[1]), Path(sys.argv[2])
stems = ["drums", "bass", "other", "vocals"]
rows = []
for song_dir in sorted(p for p in ref_root.iterdir() if p.is_dir()):
    test_dir = test_root / song_dir.name
    if not test_dir.is_dir():
        continue
    snrs = []
    for stem in stems:
        ref, sr = sf.read(song_dir / f"{stem}.wav", dtype="float32")
        test, sr2 = sf.read(test_dir / f"{stem}.wav", dtype="float32")
        assert sr == sr2
        n = min(len(ref), len(test))
        ref, test = ref[:n].astype(np.float64), test[:n].astype(np.float64)
        num = (ref ** 2).sum()
        den = ((ref - test) ** 2).sum()
        snr = 10 * np.log10(num / max(den, 1e-30))
        snrs.append(snr)
    rows.append((song_dir.name, snrs))
    print(f"{song_dir.name:24s} " + "  ".join(
        f"{s}={v:6.1f}dB" for s, v in zip(stems, snrs)))

if rows:
    all_snrs = np.array([r[1] for r in rows])
    print(f"{'MIN':24s} " + "  ".join(
        f"{s}={v:6.1f}dB" for s, v in zip(stems, all_snrs.min(axis=0))))
    print(f"overall min SNR: {all_snrs.min():.1f} dB")
