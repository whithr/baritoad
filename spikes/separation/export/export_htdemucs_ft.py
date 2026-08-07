"""Export the htdemucs_ft bag (four fine-tuned sub-models) to ONNX.

Same in-graph conv-STFT patching as export_htdemucs.py, applied to each of the
four sub-models of the `htdemucs_ft` bag. The bag's weights must be exactly
one-hot in source order (sub-model k owns source k) — the Rust side
(karaoke-core SepModel) hardcodes that combination, so anything else fails the
export loudly.

Outputs htdemucs_ft_{drums,bass,other,vocals}.onnx + a meta JSON into out_dir.

Usage: python export_htdemucs_ft.py <out_dir>
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


def export_one(model, name, seg_len, out_dir):
    model.eval()
    torch.manual_seed(1)
    x = torch.randn(1, model.audio_channels, seg_len) * 0.1
    with torch.no_grad():
        ref = model(x)

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
    print(f"[{name}] patched-vs-original torch: max_abs_err={err:.3e} "
          f"(ref max {scale:.3f}), rel={err / scale:.3e}")
    assert err / scale < 1e-3, f"{name}: patched model diverges from original"

    onnx_path = out_dir / f"{name}.onnx"
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
    print(f"[{name}] exported in {time.time() - t0:.1f}s -> {onnx_path} "
          f"({onnx_path.stat().st_size / 1e6:.1f} MB)")

    import onnxruntime as ort_py

    sess = ort_py.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    t0 = time.time()
    onnx_out = sess.run(None, {"mix": x.numpy()})[0]
    dt = time.time() - t0
    err = np.abs(onnx_out - ref.numpy()).max()
    num = float((ref.numpy() ** 2).sum())
    den = float(((onnx_out - ref.numpy()) ** 2).sum())
    snr = 10 * np.log10(num / max(den, 1e-30))
    print(f"[{name}] onnxruntime CPU 1 segment: {dt:.2f}s; "
          f"onnx-vs-torch max_abs_err={err:.3e}, SNR={snr:.1f} dB")
    return round(float(snr), 2)


def main():
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out_dir.mkdir(parents=True, exist_ok=True)

    bag = get_model("htdemucs_ft")
    print("bag models:", len(bag.models), "weights:", bag.weights,
          "sources:", bag.sources, "samplerate:", bag.samplerate)
    n = len(bag.models)
    assert n == 4, f"expected 4-model bag for htdemucs_ft, got {n}"
    sources = list(bag.sources)
    assert sources == ["drums", "bass", "other", "vocals"], sources

    # The Rust one-hot combination is only valid if the bag weights are
    # exactly: sub-model k contributes source k with weight 1, others 0.
    for k, w in enumerate(bag.weights):
        expected = [1.0 if i == k else 0.0 for i in range(4)]
        assert [float(v) for v in w] == expected, (
            f"bag weights not one-hot at sub-model {k}: {w} — "
            f"the Rust SepModel combination would be wrong")

    seg_lens = set()
    snrs = {}
    for k, model in enumerate(bag.models):
        seg_len = int(model.segment * model.samplerate)
        seg_lens.add(seg_len)
        assert model.cac, f"sub-model {k}: expected cac=True"
        name = f"htdemucs_ft_{sources[k]}"
        snrs[name] = export_one(model, name, seg_len, out_dir)

    assert seg_lens == {343980}, f"unexpected segment lengths: {seg_lens}"

    meta = {
        "bag": "htdemucs_ft",
        "segment_length": 343980,
        "samplerate": bag.samplerate,
        "sources": sources,
        "weights": "one-hot (verified)",
        "onnx_vs_torch_snr_db": snrs,
    }
    (out_dir / "htdemucs_ft_onnx_meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
