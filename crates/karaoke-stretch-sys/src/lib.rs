//! Hand-written FFI over the vendored Signalsmith Stretch C wrapper.
//!
//! Provenance (all vendored under `vendor/`, licenses verified from the
//! vendored files themselves — PLAN.md §6):
//! - `signalsmith-stretch/` — Signalsmith Stretch header, MIT
//!   (Geraint Luff / Signalsmith Audio Ltd.)
//! - `signalsmith-linear/` — STFT/FFT support headers, MIT (Signalsmith
//!   Audio). The Accelerate/IPP platform backends are compile-time gated
//!   behind macros we never define; only the portable C++ path is built.
//! - `wrapper.{h,cpp}` + this extern block — from
//!   colinmarc/signalsmith-stretch-rs v0.1.3, MIT, with one patch:
//!   `signalsmith_stretch_set_formant_base` upstream called
//!   `setFormantSemitones` instead of `setFormantBase`
//!   (spikes/stretch/REPORT.md §4 item 4). Patched in wrapper.cpp.
//!
//! Bindings are hand-written because the published `signalsmith-stretch`
//! crate generates them with bindgen, which requires libclang — not
//! available on the dev box, and a heavy toolchain dependency for a
//! 10-function C API (spike decision, kept for production).
//!
//! All buffers are interleaved f32; lengths in the safe API are asserted to
//! be whole frames (samples divisible by the channel count).

use std::os::raw::c_int;

#[repr(C)]
pub struct RawStretch {
    _private: [u8; 0],
}

extern "C" {
    fn signalsmith_stretch_create(
        channel_count: c_int,
        block_length: usize,
        interval: usize,
    ) -> *mut RawStretch;
    fn signalsmith_stretch_create_preset_default(
        channel_count: c_int,
        sample_rate: f32,
    ) -> *mut RawStretch;
    fn signalsmith_stretch_create_preset_cheaper(
        channel_count: c_int,
        sample_rate: f32,
    ) -> *mut RawStretch;
    fn signalsmith_stretch_destroy(handle: *mut RawStretch);
    fn signalsmith_stretch_reset(handle: *mut RawStretch);
    fn signalsmith_stretch_input_latency(handle: *mut RawStretch) -> usize;
    fn signalsmith_stretch_output_latency(handle: *mut RawStretch) -> usize;
    fn signalsmith_stretch_set_transpose_factor_semitones(
        handle: *mut RawStretch,
        semitones: f32,
        tonality_limit: f32,
    );
    fn signalsmith_stretch_set_formant_base(handle: *mut RawStretch, frequency: f32);
    fn signalsmith_stretch_seek(
        handle: *mut RawStretch,
        input: *const f32,
        input_length: usize,
        playback_rate: f64,
    );
    fn signalsmith_stretch_process(
        handle: *mut RawStretch,
        input: *const f32,
        input_length: usize,
        output: *mut f32,
        output_length: usize,
    );
    fn signalsmith_stretch_flush(handle: *mut RawStretch, output: *mut f32, output_length: usize);
}

/// Safe single-owner handle to one stretcher instance.
pub struct Stretch {
    inner: *mut RawStretch,
    channels: usize,
}

// Safety: the underlying C++ object has no thread affinity; we move the
// handle between threads (built on the control thread, owned by the audio
// callback) but never share it — `Stretch` is Send, deliberately not Sync.
unsafe impl Send for Stretch {}

impl Stretch {
    /// Custom configuration: `block_length` / `interval` in frames (e.g. the
    /// spike's low-latency 40 ms / 10 ms config at the device rate).
    pub fn new(channels: u32, block_length: usize, interval: usize) -> Self {
        assert!(channels > 0 && block_length > 0 && interval > 0);
        let inner =
            unsafe { signalsmith_stretch_create(channels as c_int, block_length, interval) };
        assert!(!inner.is_null(), "signalsmith_stretch_create failed");
        Self {
            inner,
            channels: channels as usize,
        }
    }

    /// Signalsmith's default preset: 120 ms block / 30 ms interval.
    pub fn preset_default(channels: u32, sample_rate: u32) -> Self {
        assert!(channels > 0 && sample_rate > 0);
        let inner = unsafe {
            signalsmith_stretch_create_preset_default(channels as c_int, sample_rate as f32)
        };
        assert!(!inner.is_null(), "signalsmith_stretch_create failed");
        Self {
            inner,
            channels: channels as usize,
        }
    }

    /// Signalsmith's cheaper preset: 100 ms block / 40 ms interval.
    pub fn preset_cheaper(channels: u32, sample_rate: u32) -> Self {
        assert!(channels > 0 && sample_rate > 0);
        let inner = unsafe {
            signalsmith_stretch_create_preset_cheaper(channels as c_int, sample_rate as f32)
        };
        assert!(!inner.is_null(), "signalsmith_stretch_create failed");
        Self {
            inner,
            channels: channels as usize,
        }
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Clear all internal state (analysis history, output buffer).
    pub fn reset(&mut self) {
        unsafe { signalsmith_stretch_reset(self.inner) }
    }

    /// Analysis lookahead in **input** frames.
    pub fn input_latency(&self) -> usize {
        unsafe { signalsmith_stretch_input_latency(self.inner) }
    }

    /// Synthesis buffering in **output** frames.
    pub fn output_latency(&self) -> usize {
        unsafe { signalsmith_stretch_output_latency(self.inner) }
    }

    /// `tonality_limit` is a normalized frequency (hz / sample_rate); 0 = none.
    pub fn set_transpose_semitones(&mut self, semitones: f32, tonality_limit: f32) {
        unsafe {
            signalsmith_stretch_set_transpose_factor_semitones(
                self.inner,
                semitones,
                tonality_limit,
            )
        }
    }

    /// Formant-analysis base frequency in Hz (0 = auto-detect). Unused by the
    /// player today; bound so the vendored patch (see module docs) is linked
    /// and exercised rather than silently dead.
    pub fn set_formant_base(&mut self, frequency: f32) {
        unsafe { signalsmith_stretch_set_formant_base(self.inner, frequency) }
    }

    /// Pre-roll: feed `input` (interleaved) into analysis history without
    /// producing output. Measured semantics (tests/ffi_smoke.rs
    /// `preroll_fills_warmup_with_history_and_lag_is_li_plus_lo`): pre-roll
    /// does **not** shorten the pipeline lag — content fed after it still
    /// surfaces `input_latency() + output_latency()·rate` later. What it buys
    /// is that the warmup region plays the primed history instead of silence:
    /// after priming with the `input_latency()` frames *starting at* the
    /// stream position, output frame `k` ≈ stream position
    /// `(k - output_latency())·rate` — a gapless start.
    pub fn seek(&mut self, input: &[f32], playback_rate: f64) {
        assert_eq!(0, input.len() % self.channels);
        unsafe {
            signalsmith_stretch_seek(
                self.inner,
                input.as_ptr(),
                input.len() / self.channels,
                playback_rate,
            )
        }
    }

    /// Interleaved in/out; lengths may differ, which produces a time-stretch
    /// (`input frames / output frames` = playback rate).
    pub fn process(&mut self, input: &[f32], output: &mut [f32]) {
        assert_eq!(0, input.len() % self.channels);
        assert_eq!(0, output.len() % self.channels);
        unsafe {
            signalsmith_stretch_process(
                self.inner,
                input.as_ptr(),
                input.len() / self.channels,
                output.as_mut_ptr(),
                output.len() / self.channels,
            );
        }
    }

    /// Read the remaining buffered output (ideally `output_latency()` frames).
    pub fn flush(&mut self, output: &mut [f32]) {
        assert_eq!(0, output.len() % self.channels);
        unsafe {
            signalsmith_stretch_flush(self.inner, output.as_mut_ptr(), output.len() / self.channels)
        }
    }
}

impl Drop for Stretch {
    fn drop(&mut self) {
        unsafe { signalsmith_stretch_destroy(self.inner) }
    }
}
