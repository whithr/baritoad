//! Progressive (streaming-fill) source buffers: the player's fast load path.
//!
//! Problem (measured with `examples/loadprobe.rs`, dev profile, 48 kHz
//! device): fully decoding + resampling both stems of a 6.4-min song before
//! building the output stream cost ~17.5 s of silence. The fix: for sources
//! whose frame count is known from the header (our pipeline stems are always
//! 44.1 kHz WAV), the full interleaved device-rate buffer is preallocated up
//! front — its exact length comes from the same duration-preserving
//! output-length math as the offline resample path, so `device frame /
//! device rate` remains original-song time exactly (PLAN.md §5) — and a
//! background thread fills it progressively (chunked symphonia decode →
//! incremental rubato resample → write). Playback starts once a small primed
//! window is ready; the rest streams in ~40x faster than realtime.
//!
//! # Concurrency design
//! Exactly one writer (the fill thread) and any number of readers (the audio
//! callback, the control thread's progress queries) per [`StemBuffer`]:
//!
//! - Samples live in a `Box<[AtomicU32]>` holding f32 bits; the writer stores
//!   them with `Relaxed`, readers load them with `Relaxed`.
//! - `ready` — the watermark, in frames — is stored with `Release` *after*
//!   every sample below it has been written, and loaded with `Acquire` by
//!   readers.
//!
//! The Release store / Acquire load pair on `ready` makes all sample stores
//! sequenced before the store visible to any reader that observed the new
//! watermark. Readers never read indices at/above the watermark they loaded
//! (the mixer renders silence there instead), so `Relaxed` element access is
//! sufficient — and because every access is atomic there is no data race in
//! the memory model even for in-flight regions. On x86-64, relaxed atomic
//! loads/stores compile to plain `mov`s, so the audio callback pays nothing
//! over a `&[f32]`.
//!
//! The fill thread checks a shared cancel flag between chunks: a superseded
//! load stops within one decode/resample chunk, and because each thread only
//! ever holds an `Arc` to the buffer it was spawned with, a lingering thread
//! can never write into a buffer a newer load owns. [`FillWorkers`] joins on
//! drop, making unload/reload race-free.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::audio::{StreamingSource, TARGET_SAMPLE_RATE};
use crate::error::{Error, Result};

/// Fill-thread status (control-plane only — the audio callback never reads
/// it; it relies solely on the watermark).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillState {
    /// Still writing (or writer never finished — e.g. cancelled).
    Filling,
    /// All frames written (including any silence padding).
    Done,
    /// The writer hit an unrecoverable error; the watermark stays where it
    /// was and the region above it renders as silence.
    Failed,
}

const S_FILLING: u8 = 0;
const S_DONE: u8 = 1;
const S_FAILED: u8 = 2;

/// One stem's interleaved-stereo device-rate buffer with a monotonic
/// published-frames watermark. See the module docs for the ordering rules.
pub struct StemBuffer {
    /// Interleaved stereo f32 bits, `2 * frames` elements.
    data: Box<[AtomicU32]>,
    /// Frames readable (watermark). Release on store, Acquire on load.
    ready: AtomicUsize,
    state: AtomicU8,
    /// Writer-thread error report (never touched by the audio callback).
    error: Mutex<Option<String>>,
}

/// Reinterpret a zero-initialized `u32` buffer as atomics.
///
/// SAFETY: `AtomicU32` is guaranteed by std to have the same size, alignment,
/// and bit validity as `u32`, and we hold the only owner of the allocation,
/// so re-typing the `Box` is sound.
fn atomics_from_bits(bits: Box<[u32]>) -> Box<[AtomicU32]> {
    unsafe { Box::from_raw(Box::into_raw(bits) as *mut [AtomicU32]) }
}

impl StemBuffer {
    /// All-silence buffer with watermark 0 (streaming fill target).
    pub fn new_silent(frames: usize) -> Self {
        // `vec![0u32; n]` uses a zeroed allocation (no per-element init cost).
        let bits = vec![0u32; frames * 2].into_boxed_slice();
        Self {
            data: atomics_from_bits(bits),
            ready: AtomicUsize::new(0),
            state: AtomicU8::new(S_FILLING),
            error: Mutex::new(None),
        }
    }

    /// Fully-loaded buffer from an interleaved-stereo vector (offline load
    /// path and tests); the watermark starts at the full length.
    pub fn preloaded(interleaved: Vec<f32>) -> Self {
        let frames = interleaved.len() / 2;
        let boxed: Box<[f32]> = interleaved.into_boxed_slice();
        // SAFETY: f32 and u32 have identical size/alignment and every bit
        // pattern is a valid u32; sole owner, so re-typing the Box is sound.
        let bits: Box<[u32]> = unsafe { Box::from_raw(Box::into_raw(boxed) as *mut [u32]) };
        Self {
            data: atomics_from_bits(bits),
            ready: AtomicUsize::new(frames),
            state: AtomicU8::new(S_DONE),
            error: Mutex::new(None),
        }
    }

    /// Total frames (samples per channel) the buffer holds.
    pub fn total_frames(&self) -> usize {
        self.data.len() / 2
    }

    /// Frames currently safe to read (Acquire — pairs with the writer's
    /// Release publish).
    #[inline]
    pub fn ready_frames(&self) -> usize {
        self.ready.load(Ordering::Acquire)
    }

    /// Read one interleaved sample (`idx` in samples, not frames). Only valid
    /// below `2 * ready_frames()` as loaded by this reader.
    #[inline]
    pub fn sample(&self, idx: usize) -> f32 {
        f32::from_bits(self.data[idx].load(Ordering::Relaxed))
    }

    /// Writer side: store `l`/`r` (planar, equal length) at `start_frame` and
    /// publish the new watermark. Panics on overflow of the buffer (writer
    /// bug — the fill worker clips to the buffer length).
    pub fn write_planar(&self, start_frame: usize, l: &[f32], r: &[f32]) {
        let n = l.len().min(r.len());
        assert!(start_frame + n <= self.total_frames(), "write past buffer end");
        for i in 0..n {
            let base = (start_frame + i) * 2;
            self.data[base].store(l[i].to_bits(), Ordering::Relaxed);
            self.data[base + 1].store(r[i].to_bits(), Ordering::Relaxed);
        }
        self.ready.store(start_frame + n, Ordering::Release);
    }

    /// Writer side: mark the fill complete. Publishes the watermark at the
    /// *total* length — any unwritten tail (silence padding for a shorter
    /// stem, or a decode that came up short) is the zeroed allocation.
    pub fn finish(&self) {
        self.ready.store(self.total_frames(), Ordering::Release);
        self.state.store(S_DONE, Ordering::Release);
    }

    /// Writer side: record an unrecoverable failure. The watermark stays put.
    pub fn fail(&self, msg: String) {
        if let Ok(mut e) = self.error.lock() {
            *e = Some(msg);
        }
        self.state.store(S_FAILED, Ordering::Release);
    }

    pub fn state(&self) -> FillState {
        match self.state.load(Ordering::Acquire) {
            S_DONE => FillState::Done,
            S_FAILED => FillState::Failed,
            _ => FillState::Filling,
        }
    }

    pub fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }
}

/// Output length of the duration-preserving resample: identical rounding to
/// `audio::resample_stereo`'s `expected` (PLAN.md §5 — device frames must map
/// to original-song time exactly, streamed or not).
pub fn expected_device_frames(src_frames: u64, src_rate: u32, dev_rate: u32) -> usize {
    if src_rate == dev_rate {
        src_frames as usize
    } else {
        ((src_frames as u128 * dev_rate as u128 + (src_rate as u128) / 2) / src_rate as u128)
            as usize
    }
}

/// Compact the pending planar queues once the consumed prefix grows past this
/// (bounds fill-thread memory to ~a second of audio instead of the song).
const PENDING_COMPACT_FRAMES: usize = 1 << 18;

/// Decode + resample one stem into `buf` chunk by chunk, publishing the
/// watermark as regions complete. `expected` is this stem's own device-frame
/// count (≤ `buf.total_frames()`, which is the shared padded total).
///
/// Returns after marking the buffer `Done` (normal completion — including
/// short decodes, whose missing tail stays silent, matching the offline
/// path's zero-pad) or `Failed`. A cancel leaves the state `Filling`.
pub fn fill_stem(
    src: &mut StreamingSource,
    buf: &StemBuffer,
    dev_rate: u32,
    expected: usize,
    cancel: &AtomicBool,
) {
    match fill_stem_inner(src, buf, dev_rate, expected, cancel) {
        Ok(true) => buf.finish(),
        Ok(false) => {} // cancelled: stop promptly, publish nothing more
        Err(e) => buf.fail(e.to_string()),
    }
}

/// Ok(true) = ran to completion, Ok(false) = cancelled.
fn fill_stem_inner(
    src: &mut StreamingSource,
    buf: &StemBuffer,
    dev_rate: u32,
    expected: usize,
    cancel: &AtomicBool,
) -> Result<bool> {
    let expected = expected.min(buf.total_frames());

    // Device rate == pipeline rate: plain chunked copy.
    if dev_rate == TARGET_SAMPLE_RATE {
        let mut l: Vec<f32> = Vec::new();
        let mut r: Vec<f32> = Vec::new();
        let mut written = 0usize;
        while written < expected {
            if cancel.load(Ordering::Acquire) {
                return Ok(false);
            }
            l.clear();
            r.clear();
            if !src.next_packet_into(&mut l, &mut r)? {
                break; // short decode: tail stays silent (offline parity)
            }
            written = write_clipped(buf, written, expected, &l, &r);
        }
        return Ok(true);
    }

    // Incremental windowed-sinc resample, configured *identically* to
    // `audio::resample_stereo` (same params, same 1024 chunk, same
    // process/process_partial sequencing) so the streamed output is
    // bit-identical to the offline path. rubato 0.16 SincFixedIn output is
    // already time-aligned in this concatenated usage — do NOT skip
    // `output_delay()` (impulse-tested; see audio.rs).
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
        WindowFunction,
    };
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let chunk = 1024usize;
    let ratio = dev_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let mut rs = SincFixedIn::<f32>::new(ratio, 1.1, params, chunk, 2)
        .map_err(|e| Error::Decode(format!("resampler init: {e}")))?;
    let map_err = |e: rubato::ResampleError| Error::Decode(format!("resample: {e}"));

    let mut pend_l: Vec<f32> = Vec::new();
    let mut pend_r: Vec<f32> = Vec::new();
    let mut pos = 0usize; // consumed prefix of the pending queues
    let mut eof = false;
    let mut written = 0usize;

    loop {
        if cancel.load(Ordering::Acquire) {
            return Ok(false);
        }
        if pos >= PENDING_COMPACT_FRAMES {
            pend_l.drain(..pos);
            pend_r.drain(..pos);
            pos = 0;
        }
        let need = rs.input_frames_next();
        while !eof && pend_l.len() - pos < need {
            if !src.next_packet_into(&mut pend_l, &mut pend_r)? {
                eof = true;
            }
        }
        let avail = pend_l.len() - pos;
        let res = if avail >= need {
            let bufs = [&pend_l[pos..pos + need], &pend_r[pos..pos + need]];
            let out = rs.process(&bufs, None).map_err(map_err)?;
            pos += need;
            out
        } else if avail > 0 {
            // Source exhausted mid-chunk: flush the partial final chunk (the
            // offline path's process_partial arm).
            let bufs = [&pend_l[pos..], &pend_r[pos..]];
            let out = rs.process_partial(Some(&bufs), None).map_err(map_err)?;
            pos = pend_l.len();
            out
        } else {
            break; // eof and nothing pending: drain phase
        };
        written = write_clipped(buf, written, expected, &res[0], &res[1]);
        if written >= expected {
            return Ok(true);
        }
    }

    // Drain internal resampler state until the expected length is covered
    // (same tail handling as the offline path — the total output length lands
    // exactly on the expected frame count, never short by a partial chunk).
    while written < expected {
        if cancel.load(Ordering::Acquire) {
            return Ok(false);
        }
        let none: Option<&[&[f32]]> = None;
        let res = rs.process_partial(none, None).map_err(map_err)?;
        if res[0].is_empty() {
            break; // resampler dry: remaining tail stays silent (zero-pad)
        }
        written = write_clipped(buf, written, expected, &res[0], &res[1]);
    }
    Ok(true)
}

fn write_clipped(
    buf: &StemBuffer,
    written: usize,
    expected: usize,
    l: &[f32],
    r: &[f32],
) -> usize {
    let n = l.len().min(r.len()).min(expected - written);
    if n > 0 {
        buf.write_planar(written, &l[..n], &r[..n]);
    }
    written + n
}

/// Handle for a load's background fill threads. Dropping (or [`stop`ping]
/// (Self::stop)) cancels and joins — a chunk-granular wait, so unload/reload
/// is race-free and prompt.
pub struct FillWorkers {
    cancel: Arc<AtomicBool>,
    handles: Vec<std::thread::JoinHandle<()>>,
}

impl FillWorkers {
    /// Spawn one fill thread per stem. Each job is
    /// `(source, target buffer, this stem's expected device frames)`.
    pub fn spawn(
        jobs: Vec<(StreamingSource, Arc<StemBuffer>, usize)>,
        dev_rate: u32,
    ) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        let handles = jobs
            .into_iter()
            .map(|(mut src, buf, expected)| {
                let cancel = cancel.clone();
                std::thread::Builder::new()
                    .name("stem-fill".into())
                    .spawn(move || fill_stem(&mut src, &buf, dev_rate, expected, &cancel))
                    .expect("spawn stem-fill thread")
            })
            .collect();
        Self { cancel, handles }
    }

    /// Cancel and join. Idempotent.
    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
    }
}

impl Drop for FillWorkers {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio;
    use std::path::Path;

    fn write_wav(path: &Path, rate: u32, l: &[f32], r: &[f32]) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..l.len() {
            w.write_sample((l[i].clamp(-1.0, 1.0) * 32767.0).round() as i16)
                .unwrap();
            w.write_sample((r[i].clamp(-1.0, 1.0) * 32767.0).round() as i16)
                .unwrap();
        }
        w.finalize().unwrap();
    }

    fn sine(rate: u32, hz: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin())
            .collect()
    }

    fn temp_wav(name: &str, n_frames: usize) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("karaoke-core-test-prog");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let l = sine(44_100, 440.0, n_frames, 0.5);
        let r = sine(44_100, 220.0, n_frames, 0.25);
        write_wav(&path, 44_100, &l, &r);
        path
    }

    #[test]
    fn expected_length_matches_offline_rounding() {
        // Same formula as resample_stereo's `expected`.
        assert_eq!(expected_device_frames(44_100, 44_100, 44_100), 44_100);
        assert_eq!(expected_device_frames(44_100, 44_100, 48_000), 48_000);
        // Odd length: round-half-up of n*48000/44100.
        let n = 44_137u64;
        let want = ((n as u128 * 48_000 + 22_050) / 44_100) as usize;
        assert_eq!(expected_device_frames(n, 44_100, 48_000), want);
    }

    #[test]
    fn watermark_publishes_written_regions_across_threads() {
        let frames = 48_000usize;
        let buf = Arc::new(StemBuffer::new_silent(frames));
        let writer_buf = buf.clone();
        let writer = std::thread::spawn(move || {
            let chunk = 1_000usize;
            let mut start = 0usize;
            while start < frames {
                let n = chunk.min(frames - start);
                let l: Vec<f32> = (start..start + n).map(|i| i as f32).collect();
                let r: Vec<f32> = (start..start + n).map(|i| -(i as f32)).collect();
                writer_buf.write_planar(start, &l, &r);
                start += n;
            }
            writer_buf.finish();
        });

        // Reader: every observation of the watermark must expose fully
        // written data below it (spot-check the boundary region — the newest
        // writes are the ones a broken ordering would expose stale).
        loop {
            let ready = buf.ready_frames();
            if ready > 0 {
                for f in ready.saturating_sub(8)..ready {
                    assert_eq!(buf.sample(f * 2), f as f32, "left below watermark");
                    assert_eq!(buf.sample(f * 2 + 1), -(f as f32), "right below watermark");
                }
            }
            if ready >= frames {
                break;
            }
            std::thread::yield_now();
        }
        writer.join().unwrap();
        assert_eq!(buf.state(), FillState::Done);
        assert_eq!(buf.ready_frames(), frames);
    }

    /// The streamed fill must be bit-identical to the offline
    /// decode → resample_stereo path, including the flushed tail, and land
    /// exactly on the expected frame count (odd length on purpose).
    #[test]
    fn streamed_fill_is_bit_identical_to_offline_resample_with_exact_tail() {
        let n = 44_100 + 37; // ~1 s, deliberately not a chunk multiple
        let path = temp_wav("parity.wav", n);
        let dev_rate = 48_000u32;

        // Offline reference: full decode + resample (the current load path).
        let dec = audio::decode_to_stereo_44k(&path).unwrap();
        let (ol, or) = audio::resample_stereo(
            &dec.samples[..dec.len],
            &dec.samples[dec.len..2 * dec.len],
            44_100,
            dev_rate,
        )
        .unwrap();
        let expected = expected_device_frames(n as u64, 44_100, dev_rate);
        assert_eq!(ol.len(), expected);

        // Streamed fill.
        let mut src = audio::open_streaming_44k(&path).unwrap().expect("eligible");
        assert_eq!(src.frames, n as u64);
        let buf = StemBuffer::new_silent(expected);
        let cancel = AtomicBool::new(false);
        fill_stem(&mut src, &buf, dev_rate, expected, &cancel);

        assert_eq!(buf.state(), FillState::Done);
        assert_eq!(buf.ready_frames(), expected, "tail must land exactly");
        for f in 0..expected {
            assert_eq!(
                buf.sample(f * 2).to_bits(),
                ol[f].to_bits(),
                "left diverged at frame {f}"
            );
            assert_eq!(
                buf.sample(f * 2 + 1).to_bits(),
                or[f].to_bits(),
                "right diverged at frame {f}"
            );
        }
    }

    /// A shorter stem in a shared (padded) timeline: finish() publishes the
    /// full buffer and the pad region is silence — never truncation.
    #[test]
    fn shorter_stem_is_silence_padded_to_the_shared_total() {
        let n = 22_050; // 0.5 s
        let path = temp_wav("short.wav", n);
        let dev_rate = 48_000u32;
        let expected = expected_device_frames(n as u64, 44_100, dev_rate);
        let total = expected + 12_345; // the other stem is longer

        let mut src = audio::open_streaming_44k(&path).unwrap().unwrap();
        let buf = StemBuffer::new_silent(total);
        let cancel = AtomicBool::new(false);
        fill_stem(&mut src, &buf, dev_rate, expected, &cancel);

        assert_eq!(buf.state(), FillState::Done);
        assert_eq!(buf.ready_frames(), total, "pad region must be published");
        for f in expected..total {
            assert_eq!(buf.sample(f * 2), 0.0);
            assert_eq!(buf.sample(f * 2 + 1), 0.0);
        }
        // And the audio region is not all silence.
        assert!((0..expected).any(|f| buf.sample(f * 2) != 0.0));
    }

    /// Cancel stops the fill promptly and leaves the buffer un-finalized —
    /// a superseded load never sees a lying "done" watermark.
    #[test]
    fn cancel_stops_fill_mid_stream() {
        // Pre-set cancel: deterministic "stop before any work" check.
        let n = 44_100;
        let path = temp_wav("cancel.wav", n);
        let mut src = audio::open_streaming_44k(&path).unwrap().unwrap();
        let expected = expected_device_frames(n as u64, 44_100, 48_000);
        let buf = StemBuffer::new_silent(expected);
        let cancel = AtomicBool::new(true);
        fill_stem(&mut src, &buf, 48_000, expected, &cancel);
        assert_eq!(buf.ready_frames(), 0);
        assert_eq!(buf.state(), FillState::Filling, "cancel must not mark done");

        // Mid-fill cancel through the FillWorkers handle (30 s source so the
        // fill is guaranteed to still be running when stop() lands).
        let big = 44_100 * 30;
        let path = temp_wav("cancel-big.wav", big);
        let src = audio::open_streaming_44k(&path).unwrap().unwrap();
        let expected = expected_device_frames(big as u64, 44_100, 48_000);
        let buf = Arc::new(StemBuffer::new_silent(expected));
        let mut workers = FillWorkers::spawn(vec![(src, buf.clone(), expected)], 48_000);
        std::thread::sleep(std::time::Duration::from_millis(5));
        let t0 = std::time::Instant::now();
        workers.stop(); // cancel + join
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(2),
            "stop() did not return promptly"
        );
        // Either it finished legitimately (fast machine) or it was cut off
        // mid-fill; a cut-off fill must not claim completion.
        if buf.state() != FillState::Done {
            assert!(buf.ready_frames() < expected);
        }
    }
}
