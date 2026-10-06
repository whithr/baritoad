# Vendored third-party license texts

`scripts/notices.mjs` copies these into THIRD-PARTY-NOTICES.txt, which the
installer ships (About › Notices…). Each file belongs to one version of what
we ship — when that version changes, replace the file in the same change.

| File | What | From |
|---|---|---|
| `onnxruntime-1.28.0-ThirdPartyNotices.txt` | ONNX Runtime's notices for the code it links in (protobuf, re2, Eigen, …) | github.com/microsoft/onnxruntime, tag `v1.28.0`, `ThirdPartyNotices.txt` (the version ort-sys 2.0.0-rc.13 downloads) |
| `DirectML-1.15.4-LICENSE.txt`, `DirectML-1.15.4-ThirdPartyNotices.txt` | the DirectML redistributable's license and notices | the NuGet package `Microsoft.AI.DirectML` 1.15.4 (`LICENSE.txt`, `ThirdPartyNotices.txt`) |
| `yt-dlp-2026.08.19-THIRD_PARTY_LICENSES.txt` | licenses of what the yt-dlp executable bundles (Python, mutagen, certifi, …) | github.com/yt-dlp/yt-dlp, tag `2026.08.19`, `THIRD_PARTY_LICENSES.txt` |
| `98css-LICENSE.txt` | 98.css (MIT), whose bevel recipes and palette values the baritoad 98 kit adapts | github.com/jdan/98.css, `LICENSE` |
