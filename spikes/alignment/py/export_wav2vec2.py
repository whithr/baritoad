"""Export facebook/wav2vec2-base-960h (Apache-2.0) to ONNX for the alignment spike.
Build-time tooling only — no Python at app runtime (PLAN.md §5).
"""
import json, os, sys
import torch
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

OUT = os.path.join(os.path.dirname(__file__), "..", "weights", "wav2vec2")
os.makedirs(OUT, exist_ok=True)

model = Wav2Vec2ForCTC.from_pretrained("facebook/wav2vec2-base-960h")
model.eval()
proc = Wav2Vec2Processor.from_pretrained("facebook/wav2vec2-base-960h")

# vocab + preprocessor config for the Rust side
with open(os.path.join(OUT, "vocab.json"), "w") as f:
    json.dump(proc.tokenizer.get_vocab(), f)
fe = proc.feature_extractor
with open(os.path.join(OUT, "preprocessor_config.json"), "w") as f:
    json.dump({"do_normalize": fe.do_normalize, "sampling_rate": fe.sampling_rate}, f)
print("do_normalize =", fe.do_normalize)

dummy = torch.randn(1, 16000 * 5)

class Wrapper(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m
    def forward(self, input_values):
        return self.m(input_values).logits

torch.onnx.export(
    Wrapper(model),
    (dummy,),
    os.path.join(OUT, "wav2vec2-base-960h.onnx"),
    input_names=["input_values"],
    output_names=["logits"],
    dynamic_axes={"input_values": {0: "batch", 1: "samples"},
                  "logits": {0: "batch", 1: "frames"}},
    opset_version=14,
    dynamo=False,
)
print("exported to", os.path.join(OUT, "wav2vec2-base-960h.onnx"))

# quick parity check: torch vs onnxruntime on the dummy input
import numpy as np, onnxruntime as ort_rt
sess = ort_rt.InferenceSession(os.path.join(OUT, "wav2vec2-base-960h.onnx"),
                               providers=["CPUExecutionProvider"])
with torch.no_grad():
    ref = model(dummy).logits.numpy()
got = sess.run(None, {"input_values": dummy.numpy()})[0]
err = np.abs(ref - got).max()
print("torch-vs-onnx max abs err:", err)
assert err < 1e-3, "export mismatch"
print("PARITY-OK")
