"""Export whisper-small to ONNX from OpenAI's own weights, pinned revision
(MODEL_LICENSES.md TODO: provenance must not route through a re-uploader).

Layout and opset match what karaoke-core's whisper.rs loads (the old
onnx-community files): onnx/encoder_model.onnx, onnx/decoder_model_merged.onnx
(opset 14, optimum's merged decoder with use_cache_branch), tokenizer.json,
config.json. Export-time only; nothing here ships.

usage: python export_whisper.py <out_dir>
"""
import hashlib
import os
import shutil
import sys

from huggingface_hub import snapshot_download

REPO = "openai/whisper-small"
REVISION = "973afd24965f72e36ca33b3055d56a652f456b4d"  # HF main, 2024-02-29

out = os.path.abspath(sys.argv[1])
src = snapshot_download(
    REPO,
    revision=REVISION,
    allow_patterns=["*.json", "*.safetensors", "*.txt", "merges.txt", "vocab.json"],
)
print("snapshot:", src)
for f in sorted(os.listdir(src)):
    p = os.path.join(src, f)
    if os.path.isfile(p):
        h = hashlib.sha256(open(p, "rb").read()).hexdigest()
        print(f"  {f} {os.path.getsize(p)} {h}")

from optimum.exporters.onnx import main_export  # noqa: E402

tmp = out + "-raw"
shutil.rmtree(tmp, ignore_errors=True)
main_export(src, output=tmp, task="automatic-speech-recognition-with-past", opset=14)

os.makedirs(os.path.join(out, "onnx"), exist_ok=True)
for name in ["encoder_model.onnx", "decoder_model_merged.onnx"]:
    shutil.copy2(os.path.join(tmp, name), os.path.join(out, "onnx", name))
for name in ["tokenizer.json", "config.json"]:
    shutil.copy2(os.path.join(tmp, name), os.path.join(out, name))
for rel in ["onnx/encoder_model.onnx", "onnx/decoder_model_merged.onnx", "tokenizer.json", "config.json"]:
    p = os.path.join(out, rel)
    h = hashlib.sha256(open(p, "rb").read()).hexdigest()
    print(f"export {rel} {os.path.getsize(p)} {h}")
