//! karaoke-core — pipeline stages, inference, and format I/O for the karaoke
//! app (GPL-3.0-or-later; see PLAN.md).
//!
//! Phase 1 scope so far:
//! - separation stage (htdemucs via ONNX Runtime), ported from
//!   spikes/separation with the hardening its REPORT.md called for: Symphonia
//!   decode of the user's file directly, streamed overlap-add, and a
//!   per-execution-provider golden-segment parity check that fails closed to
//!   CPU
//! - alignment stage (whisper-small rough pass + wav2vec2 CTC trellis over
//!   the vocal stem, pasted-lyrics anchoring), ported from spikes/alignment
//!   with its hardening list applied; output is a [`timing::WordTimingMap`]
//!   in original-song time (PLAN.md §5); auto-transcribe fallback when no
//!   lyrics are pasted (PLAN.md §3)
//! - lyric cleanup stage ([`lyrics`]): strips section headers and credit
//!   lines, expands repeat markers, flags ad-libs — runs before alignment
//!   (PLAN.md §3) and produces the machine-readable change summary (§4)
//! - export stage ([`formats`]): Enhanced LRC, ASS karaoke subtitles, and
//!   UltraStar .txt from the timing map (PLAN.md §3 "Formats & interop");
//!   original-song time verbatim, no stretch translation (§5); UltraStar
//!   *import* lands beside the exporter (pitch preserved, unused in v1)
//! - pipeline orchestrator ([`pipeline`]): the four stages above as
//!   resumable jobs with a persisted manifest and progress events
//!   (PLAN.md §5 "job queue, resume")
//! - accuracy harness ([`accuracy`]): word-onset error vs hand-made
//!   UltraStar references (PLAN.md §9 Phase 1)
//! - library store ([`library`]): SQLite-backed songs / collections /
//!   up-next queue (PLAN.md §3, §5), tag-based metadata + cover art via
//!   lofty (local files only, never the network), and the completion hook
//!   that registers finished jobs idempotently by audio hash
//!
//! Phase 3 (in progress):
//! - playback audio engine ([`player`]): cpal output stream, dual-stem
//!   mixing with click-free vocal-guide blend, sample-accurate transport,
//!   and the device-frame-derived player clock with the stretch-translation
//!   seam (PLAN.md §5 "lyric sync"; stretch itself is milestone 2)
//!
//! Hard rules honored here (CLAUDE.md): no Python at runtime, ffmpeg and
//! yt-dlp only ever as subprocesses, nothing compiled in that isn't
//! GPL-3.0-compatible.

pub mod accuracy;
pub mod alignment;
pub mod audio;
pub mod compute;
pub mod error;
pub mod fetch;
pub mod formats;
pub mod import;
pub mod library;
pub mod lrclib;
pub mod lyrics;
pub mod output;
pub mod pipeline;
pub mod player;
pub mod separation;
pub mod timing;

pub use error::{Error, Result};
