# Model weight provenance

Every model weight we mirror is recorded here: origin, license, and the
verification that it permits commercial use and redistribution (PLAN.md §6
policy). Weights are never committed to this repo. A weight not listed here
does not ship.

Status values: **planned** (selected, license verified from the original
source, not yet mirrored) · **mirrored** (live on our mirror) · **excluded**
(evaluated and rejected — kept here so it isn't re-litigated).

| Weight | Role | Original source | License | Status | Verified |
|---|---|---|---|---|---|
| htdemucs | stem separation | facebookresearch/demucs (code); weights fetched by demucs 4.1 from Hugging Face `adefossez/HTDemucs` (repo of the demucs author — the original publisher's own weight host) | MIT (code and weights) | planned (verified, not yet mirrored) | 2026-08-05, https://huggingface.co/adefossez/HTDemucs license tag `mit`. Checkpoint used: snapshot `bf35a81b663819a8255c8fefee17f9d812b786b5`, file `955717e8.safetensors` (84,025,440 B), SHA256 `d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd`. Derived ONNX export (spikes/separation/export/export_htdemucs.py, opset 17): `htdemucs.onnx` 309,906,564 B, SHA256 `7d9870f72c293af3340b02573cd789501e6eb1cec8a53a2569061ab8c9ed8971` — mirror this file with this hash |
| whisper-small (ONNX, optimum layout) | transcription / rough timestamps (alignment stage 1) | openai/whisper (MIT, code and weights per its GitHub LICENSE; the HF card `openai/whisper-small` tags `apache-2.0`, re-verified 2026-08-05 — commercial-safe either way). **ONNX artifacts currently in use are the community re-export `onnx-community/whisper-small` @ 36050c46** (a transformers.js/optimum conversion of `openai/whisper-small`; its card declares the base model, no separate license tag) | MIT (weights) / Apache-2.0 (HF card) | planned (in use from spikes/alignment/weights/, not yet mirrored) | 2026-08-05. Files consumed by karaoke-core: `onnx/encoder_model.onnx` 352,825,870 B SHA256 `b37cd6625dc36f9178ec7539a1876b9680ea26a910097e092be39dc766320c7b`; `onnx/decoder_model_merged.onnx` 615,324,301 B SHA256 `6ed5e35feaba79ad2e89b368ddc7b4ddaa3c00b4c37a664375d3428a76fecc6a`; `onnx/decoder_model_merged_int8.onnx` 156,750,845 B SHA256 `ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9`; `tokenizer.json` SHA256 `27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566`; `config.json` SHA256 `457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18` (also present, unused at runtime: `onnx/encoder_model_int8.onnx` SHA256 `2601c9eb2d345c5916d4576d36f663a7c96589740fb2273828c48c3fc2c7db75` — ConvInteger unsupported by ort's bundled CPU build) |
| **TODO: whisper-small re-export from original OpenAI weights** | replaces the row above before mirroring | export ourselves from `openai/whisper-small` with a pinned toolchain (Phase 1 hardening list; GO-NO-GO.md) so provenance doesn't route through a re-uploader | MIT | planned | open — do not mirror the onnx-community artifacts as final; record new hashes here at export time |
| wav2vec2-base-960h (ONNX, our export) | CTC forced alignment (alignment stage 2) | fairseq wav2vec2 code MIT; checkpoint `facebook/wav2vec2-base-960h` on HF, card tag `apache-2.0` (verified 2026-08-05 — PLAN §6 row corrected from MIT accordingly). ONNX exported by us at build time: spikes/alignment/py/export_wav2vec2.py, opset 14, from an unpinned `facebook/wav2vec2-base-960h` snapshot — pin the revision at re-export | Apache-2.0 (weights) | planned (in use from spikes/alignment/weights/, not yet mirrored) | 2026-08-05, https://huggingface.co/facebook/wav2vec2-base-960h. Files consumed: `wav2vec2-base-960h.onnx` 377,872,713 B SHA256 `97d63f44af04994fc1716732e68e42c564539291d3cfa00ee00a080105d67324`; `vocab.json` SHA256 `19727f8944fe6459fc3f240ae2c198395b740f6a029bd23e06656266b83bcf64` |
| Meta MMS (all variants) | multilingual alignment | facebookresearch/fairseq (MMS) | CC-BY-NC 4.0 | **excluded** | non-commercial — this is why v1 is English-first (PLAN.md §1, §6) |

Verification rule: license is confirmed from the *original* publisher's
repo/model card for the exact checkpoint mirrored — never from a re-uploader's
claim. Record the URL and date in the Verified column when a row moves to
"mirrored".
