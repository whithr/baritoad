//! karaoke-core — pipeline stages, inference, and format I/O for the karaoke
//! app (source-available; see PLAN.md).
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
//!   original-song time verbatim, no stretch translation (§5)
//!
//! Hard rules honored here (CLAUDE.md): no Python at runtime, ffmpeg only ever
//! as a subprocess (not used by these stages at all), no GPL/AGPL dependencies.

pub mod alignment;
pub mod audio;
pub mod error;
pub mod formats;
pub mod lyrics;
pub mod output;
pub mod separation;
pub mod timing;

pub use error::{Error, Result};
