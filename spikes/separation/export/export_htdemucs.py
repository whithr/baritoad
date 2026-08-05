"""Export htdemucs to ONNX with in-graph conv-based STFT/iSTFT.

Patches the instance methods _spec/_magnitude/_mask/_ispec of the pretrained
HTDemucs so the whole segment pipeline (raw 7.8 s stereo audio in -> 4 stems
out) is one static-shape ONNX graph. Verifies the patched model against the
unpatched original in torch, then verifies the exported ONNX against torch
via onnxruntime (CPU).

Usage: python export_htdemucs.py <out_dir>
"""
import json
import sys
import time
import types
from pathlib import Path

import numpy as np
import torch

from demucs.pretrained import get_model
from stft_onnx import ConvSTFT, ConvISTFT


def main():
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out_dir.mkdir(parents=True, exist_ok=True)

    bag = get_model("htdemucs")
    print("bag models:", len(bag.models), "weights:", bag.weights,
          "sources:", bag.sources, "samplerate:", bag.samplerate)
    assert len(bag.models) == 1, "expected single-model bag for htdemucs"
    model = bag.models[0]
    model.eval()
    seg_len = int(model.segment * model.samplerate)
    print("segment:", float(model.segment), "s ->", seg_len, "samples")
    assert model.cac, "expected cac=True"

    torch.manual_seed(1)
    x = torch.randn(1, model.audio_channels, seg_len) * 0.1
    with torch.no_grad():
        ref = model(x)

    # ---- patch instance methods ----
    conv_stft = ConvSTFT(seg_len)
    conv_istft = ConvISTFT(seg_len)

    def _spec(self, xx):
        return conv_stft(xx)

    def _magnitude(self, z):
        return z

    def _mask(self, z, m):
        return m

    def _ispec(self, z, length=None, scale=0):
        assert length == seg_len
        return conv_istft(z)

    model._spec = types.MethodType(_spec, model)
    model._magnitude = types.MethodType(_magnitude, model)
    model._mask = types.MethodType(_mask, model)
    model._ispec = types.MethodType(_ispec, model)

    with torch.no_grad():
        got = model(x)
    err = (got - ref).abs().max().item()
    scale = ref.abs().max().item()
    print(f"patched-vs-original torch: max_abs_err={err:.3e} (ref max {scale:.3f}), "
          f"rel={err / scale:.3e}")
    assert err / scale < 1e-3, "patched model diverges from original"

    # ---- export ----
    onnx_path = out_dir / "htdemucs.onnx"
    t0 = time.time()
    torch.onnx.export(
        model,
        (x,),
        str(onnx_path),
        input_names=["mix"],
        output_names=["stems"],
        opset_version=17,
        dynamo=False,
    )
    print(f"exported in {time.time() - t0:.1f}s -> {onnx_path} "
          f"({onnx_path.stat().st_size / 1e6:.1f} MB)")

    # ---- verify ONNX vs original torch ----
    import onnxruntime as ort_py

    sess = ort_py.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    t0 = time.time()
    onnx_out = sess.run(None, {"mix": x.numpy()})[0]
    dt = time.time() - t0
    err = np.abs(onnx_out - ref.numpy()).max()
    # SNR of onnx output vs torch reference
    num = float((ref.numpy() ** 2).sum())
    den = float(((onnx_out - ref.numpy()) ** 2).sum())
    snr = 10 * np.log10(num / max(den, 1e-30))
    print(f"onnxruntime CPU 1 segment: {dt:.2f}s; onnx-vs-torch max_abs_err={err:.3e}, "
          f"SNR={snr:.1f} dB")

    meta = {
        "segment_length": seg_len,
        "samplerate": model.samplerate,
        "sources": model.sources,
        "audio_channels": model.audio_channels,
        "onnx_vs_torch_snr_db": round(float(snr), 2),
    }
    (out_dir / "htdemucs_onnx_meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
