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
| htdemucs | stem separation | facebookresearch/demucs | MIT | planned | pending Phase 0 spike — verify at export time against the release actually used |
| whisper-small | transcription / rough timestamps | openai/whisper | MIT | planned | pending Phase 0 spike — verify at export time |
| wav2vec2-base | CTC forced alignment | facebookresearch/fairseq | MIT | planned | pending Phase 0 spike — verify the exact checkpoint used, not just the repo license |
| Meta MMS (all variants) | multilingual alignment | facebookresearch/fairseq (MMS) | CC-BY-NC 4.0 | **excluded** | non-commercial — this is why v1 is English-first (PLAN.md §1, §6) |

Verification rule: license is confirmed from the *original* publisher's
repo/model card for the exact checkpoint mirrored — never from a re-uploader's
claim. Record the URL and date in the Verified column when a row moves to
"mirrored".
