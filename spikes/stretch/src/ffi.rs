//! Hand-written FFI bindings to vendor/wrapper.h.
//!
//! The C wrapper (vendor/wrapper.{h,cpp}) is from colinmarc/signalsmith-stretch-rs
//! v0.1.3 (MIT); bindings are written by hand here because bindgen requires
//! libclang, which is not installed on this machine. The safe wrapper below is
//! adapted from that crate's src/lib.rs (MIT).

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
    fn signalsmith_stretch_process(
        handle: *mut RawStretch,
        input: *const f32,
        input_length: usize,
        output: *mut f32,
        output_length: usize,
    );
    fn signalsmith_stretch_flush(handle: *mut RawStretch, output: *mut f32, output_length: usize);
}

pub struct Stretch {
    inner: *mut RawStretch,
    channels: usize,
}

// The underlying object is only touched from one thread at a time in this spike.
unsafe impl Send for Stretch {}

#[allow(dead_code)]
impl Stretch {
    pub fn new(channels: u32, block_length: usize, interval: usize) -> Self {
        let inner = unsafe { signalsmith_stretch_create(channels as c_int, block_length, interval) };
        Self { inner, channels: channels as usize }
    }

    pub fn preset_default(channels: u32, sample_rate: u32) -> Self {
        let inner = unsafe {
            signalsmith_stretch_create_preset_default(channels as c_int, sample_rate as f32)
        };
        Self { inner, channels: channels as usize }
    }

    pub fn preset_cheaper(channels: u32, sample_rate: u32) -> Self {
        let inner = unsafe {
            signalsmith_stretch_create_preset_cheaper(channels as c_int, sample_rate as f32)
        };
        Self { inner, channels: channels as usize }
    }

    pub fn reset(&mut self) {
        unsafe { signalsmith_stretch_reset(self.inner) }
    }

    pub fn input_latency(&self) -> usize {
        unsafe { signalsmith_stretch_input_latency(self.inner) }
    }

    pub fn output_latency(&self) -> usize {
        unsafe { signalsmith_stretch_output_latency(self.inner) }
    }

    /// `tonality_limit` is a normalized frequency (hz / sample_rate); 0 = none.
    pub fn set_transpose_semitones(&mut self, semitones: f32, tonality_limit: f32) {
        unsafe {
            signalsmith_stretch_set_transpose_factor_semitones(self.inner, semitones, tonality_limit)
        }
    }

    /// Interleaved in/out; lengths are in samples (frames * channels) and may
    /// differ, which produces a time-stretch.
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
