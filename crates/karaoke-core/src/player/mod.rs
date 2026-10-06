//! Playback audio engine (Phase 3 milestone 1): cpal output stream, dual-stem
//! mixing with a click-free vocal-guide blend, sample-accurate transport, and
//! a device-frame-derived [`PlayerClock`].
//!
//! Scope: library-level only — Tauri wiring is a later milestone. Milestone 2
//! adds key/tempo stretch ([`stretch::StretchEngine`], Signalsmith via
//! karaoke-stretch-sys): pitch ±6 st and tempo 0.80–1.20x, independently
//! adjustable mid-playback, with −9 dB headroom + a soft limiter while
//! active (REPORT.md §4 item 2). At identity settings the stretcher is fully
//! out of the path and rendering is bit-identical to milestone 1; the clock
//! translates device frames through [`clock::StretchTimeline`] with the
//! stretcher's input+output latency folded into the origin (stretch.rs
//! module docs).
//!
//! Threading model:
//! - The **audio callback** (cpal-owned thread, MMCSS-registered on Windows,
//!   see [`mmcss`]) owns the [`mixer::MixerCore`] and is the only writer of
//!   the clock's frame counter. It never locks, blocks, or allocates on the
//!   steady path.
//! - The **controller** ([`Player`]) publishes intent through atomics
//!   (transport state, guide gain, pending seek) that the callback picks up
//!   at block boundaries — the same pattern the stretch spike proved live
//!   (spikes/stretch/src/cmd_live.rs).
//! - The **UI** polls [`PlayerClock::position_seconds`] (cheap, lock-light)
//!   at rAF rate and drains [`PlayerEvent`]s from the channel returned by
//!   [`Player::take_events`].
//! - **Stem-fill threads** (streaming loads, [`progressive`]): one writer per
//!   stem decodes + resamples into a preallocated buffer behind a
//!   Release/Acquire watermark the callback reads once per block; frames
//!   above the watermark render as silence (never a lock or a stall).
//!   Cancelled + joined on unload/reload.
//!
//! `Player` holds a `cpal::Stream`, which is not `Send` on all platforms —
//! host it on a dedicated audio-control thread when wiring into Tauri.

pub mod clock;
pub mod diag;
pub mod mixer;
pub mod mmcss;
pub mod progressive;
pub mod stretch;

use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::audio::{self, DecodedAudio, TARGET_SAMPLE_RATE};
use crate::error::{Error, Result};

pub use clock::PlayerClock;
pub use diag::{Diagnostics, MmcssStatus};
pub use stretch::{StretchConfig, MAX_PITCH_SEMITONES, TEMPO_RATE_MAX, TEMPO_RATE_MIN};

/// Primed window a streaming load waits for before returning: enough decoded
/// audio that playback starting immediately never runs into the fill
/// watermark (the fill outruns realtime by well over an order of magnitude,
/// so once this window exists it only ever grows ahead of the cursor).
const PRIME_SECONDS: f64 = 2.0;

/// Hard cap on the prime wait — a pathologically slow fill degrades to
/// starting with silence rather than hanging the load forever.
const PRIME_TIMEOUT: Duration = Duration::from_secs(30);

/// Transport state as observed by the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportState {
    /// Nothing playing; position at 0 (initial, or after [`Player::stop`]).
    Stopped,
    Playing,
    Paused,
    /// The song played to its end (auto-advance hooks onto this + the
    /// [`PlayerEvent::Completed`] event; queue logic is a later milestone).
    Finished,
}

/// Events emitted from the engine (drain via [`Player::take_events`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerEvent {
    /// Song played to the end.
    Completed,
}

/// Negotiated output-device description (for logs / diagnostics UI).
#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    /// cpal sample format the stream runs in (`f32`, `i16`, `u16`).
    pub sample_format: String,
    /// Device buffer-size description as reported by cpal.
    pub buffer: String,
}

// transport atomic encoding
const T_STOPPED: u8 = 0;
const T_PLAYING: u8 = 1;
const T_PAUSED: u8 = 2;

// mmcss atomic encoding (mirrors MmcssStatus)
const M_NOT_ATTEMPTED: u8 = 0;
const M_REGISTERED: u8 = 1;
const M_FAILED: u8 = 2;
const M_UNSUPPORTED: u8 = 3;

/// Control-plane state shared with the audio callback (atomics only — the
/// callback never locks). The stretch settings ride the same pattern the
/// spike proved live (spikes/stretch/src/cmd_live.rs): value atomics plus a
/// change counter the callback compares each block.
struct ControlShared {
    transport: AtomicU8,
    guide_bits: AtomicU32,
    seek_frame: AtomicU64,
    seek_id: AtomicU64,
    finished: AtomicU8, // 0/1 (AtomicBool-as-u8 keeps the struct uniform)
    // stretch control plane (milestone 2)
    pitch_bits: AtomicU32,          // f32 semitones
    tempo_bits: AtomicU64,          // f64 ratio
    stretch_config: AtomicU8,       // StretchConfig::to_u8
    stretch_change_id: AtomicU64,   // bumped by any stretch setter
    stretch_request_ns: AtomicU64,  // epoch-relative nanos of the last change
    // diagnostics published by the callback
    callbacks: AtomicU64,
    stalls: AtomicU64,
    max_gap_ns: AtomicU64,
    stream_errors: AtomicU64,
    starved: AtomicU64, // frames rendered as silence above the fill watermark
    mmcss: AtomicU8,
    stretch_engaged: AtomicU8,      // stretcher currently in the signal path
    stretch_applied: AtomicU64,     // count of setting pickups by the callback
    stretch_apply_ns: AtomicU64,    // request → callback pickup, last change
}

impl ControlShared {
    fn new(guide: f32, pitch: f32, tempo: f64, config: u8) -> Self {
        Self {
            transport: AtomicU8::new(T_STOPPED),
            guide_bits: AtomicU32::new(guide.to_bits()),
            seek_frame: AtomicU64::new(0),
            seek_id: AtomicU64::new(0),
            finished: AtomicU8::new(0),
            pitch_bits: AtomicU32::new(pitch.to_bits()),
            tempo_bits: AtomicU64::new(tempo.to_bits()),
            stretch_config: AtomicU8::new(config),
            stretch_change_id: AtomicU64::new(0),
            stretch_request_ns: AtomicU64::new(0),
            callbacks: AtomicU64::new(0),
            stalls: AtomicU64::new(0),
            max_gap_ns: AtomicU64::new(0),
            stream_errors: AtomicU64::new(0),
            starved: AtomicU64::new(0),
            mmcss: AtomicU8::new(M_NOT_ATTEMPTED),
            stretch_engaged: AtomicU8::new(0),
            stretch_applied: AtomicU64::new(0),
            stretch_apply_ns: AtomicU64::new(0),
        }
    }
}

/// The playback engine. One instance per output device; load songs into it.
pub struct Player {
    device: cpal::Device,
    stream_config: cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    device_info: DeviceInfo,
    stream: Option<cpal::Stream>,
    shared: Arc<ControlShared>,
    clock: PlayerClock,
    events_tx: Sender<PlayerEvent>,
    events_rx: Option<Receiver<PlayerEvent>>,
    /// Loaded song duration in original-song seconds (0.0 when unloaded).
    duration_seconds: f64,
    duration_frames: u64,
    /// Background fill threads of a streaming load (None when fully loaded
    /// up front). Dropped (cancel + join) on unload/reload — see
    /// [`progressive::FillWorkers`].
    fill: Option<progressive::FillWorkers>,
    /// The loaded stems' buffers (same `Arc`s the mixer reads) for progress
    /// queries; empty when nothing is loaded.
    stem_buffers: Vec<Arc<progressive::StemBuffer>>,
    /// Shared time base for control-thread requests vs callback pickups
    /// (stretch apply-latency diagnostics).
    epoch: Instant,
}

impl Player {
    /// Open the default output device and negotiate a stream config
    /// (prefers the device default — the WASAPI shared-mode mix format —
    /// falling back to a supported f32/i16/u16 config near 48 kHz).
    pub fn new() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| Error::Device("no default audio output device".into()))?;
        let (stream_config, sample_format) = negotiate_config(&device)?;
        let device_info = DeviceInfo {
            name: device.name().unwrap_or_else(|_| "<unknown>".into()),
            sample_rate: stream_config.sample_rate.0,
            channels: stream_config.channels,
            sample_format: format!("{sample_format:?}").to_lowercase(),
            buffer: format!("{:?}", stream_config.buffer_size),
        };
        let (events_tx, events_rx) = channel();
        Ok(Self {
            device,
            stream_config,
            sample_format,
            device_info,
            stream: None,
            shared: Arc::new(ControlShared::new(0.0, 0.0, 1.0, 0)),
            clock: PlayerClock::new(),
            events_tx,
            events_rx: Some(events_rx),
            duration_seconds: 0.0,
            duration_frames: 0,
            fill: None,
            stem_buffers: Vec::new(),
            epoch: Instant::now(),
        })
    }

    pub fn device_info(&self) -> &DeviceInfo {
        &self.device_info
    }

    /// Load instrumental + vocal stems (the normal karaoke mode).
    ///
    /// When both files are eligible for streaming (header-known frame count
    /// at 44.1 kHz — always true for our pipeline's WAV stems), this returns
    /// as soon as a small primed window is decoded (~well under a second)
    /// and the rest fills on background threads; otherwise it falls back to
    /// the full decode+resample load.
    pub fn load_stems(&mut self, instrumental: &Path, vocals: &Path) -> Result<()> {
        if let (Some(i), Some(v)) = (
            audio::open_streaming_44k(instrumental)?,
            audio::open_streaming_44k(vocals)?,
        ) {
            return self.load_streaming(vec![i, v]);
        }
        let inst = audio::decode_to_stereo_44k(instrumental)?;
        let voc = audio::decode_to_stereo_44k(vocals)?;
        self.load_decoded(inst, Some(voc))
    }

    /// Fallback mode: play the original file as-is (stems absent — e.g. a
    /// library entry whose separation hasn't run). The vocal-guide gain has
    /// no effect in this mode. Streams when the file is eligible (see
    /// [`Self::load_stems`]); a VBR MP3 without a header frame count takes
    /// the full-load path.
    pub fn load_single(&mut self, path: &Path) -> Result<()> {
        if let Some(src) = audio::open_streaming_44k(path)? {
            return self.load_streaming(vec![src]);
        }
        let audio = audio::decode_to_stereo_44k(path)?;
        self.load_decoded(audio, None)
    }

    /// Load already-decoded audio (tests, tools, and callers that decoded
    /// elsewhere). Sources are resampled from the pipeline rate (44.1 kHz)
    /// to the negotiated device rate with the duration-preserving resampler,
    /// so `device frame / device rate` remains original-song time exactly.
    pub fn load_decoded(
        &mut self,
        instrumental: DecodedAudio,
        vocals: Option<DecodedAudio>,
    ) -> Result<()> {
        self.teardown_current();

        let dev_rate = self.stream_config.sample_rate.0;

        let inst = interleave_at_device_rate(&instrumental, dev_rate)?;
        let voc = match &vocals {
            Some(v) => Some(interleave_at_device_rate(v, dev_rate)?),
            None => None,
        };
        // Stems from the pipeline share a timeline; pad any length difference
        // (decoder edge effects) with silence rather than truncating audio.
        let frames = inst
            .len()
            .max(voc.as_ref().map(|v| v.len()).unwrap_or(0))
            / 2;
        let mut inst = inst;
        inst.resize(frames * 2, 0.0);
        let voc = voc.map(|mut v| {
            v.resize(frames * 2, 0.0);
            v
        });

        self.install_sources(mixer::Sources::preloaded(inst, voc))
    }

    /// Streaming load: preallocate the full device-rate buffers (exact
    /// lengths from the headers — same duration-preserving math as the
    /// offline path), start background fill threads, build the
    /// stream immediately, then block only until a small primed window is
    /// decoded on every stem.
    fn load_streaming(&mut self, srcs: Vec<audio::StreamingSource>) -> Result<()> {
        self.teardown_current();

        let dev_rate = self.stream_config.sample_rate.0;
        let expected: Vec<usize> = srcs
            .iter()
            .map(|s| {
                progressive::expected_device_frames(s.frames, audio::TARGET_SAMPLE_RATE, dev_rate)
            })
            .collect();
        // Shared timeline: silence-pad the shorter stem to the longer, never
        // truncate (same policy as the offline path).
        let total = expected.iter().copied().max().unwrap_or(0);
        if total == 0 {
            return Err(Error::Decode("no audio frames in stream".into()));
        }
        let bufs: Vec<Arc<progressive::StemBuffer>> = expected
            .iter()
            .map(|_| Arc::new(progressive::StemBuffer::new_silent(total)))
            .collect();

        let sources = mixer::Sources {
            instrumental: bufs[0].clone(),
            vocals: bufs.get(1).cloned(),
            frames: total,
        };

        let jobs: Vec<_> = srcs
            .into_iter()
            .zip(bufs.iter().cloned())
            .zip(expected.iter().copied())
            .map(|((src, buf), exp)| (src, buf, exp))
            .collect();
        self.fill = Some(progressive::FillWorkers::spawn(jobs, dev_rate));

        self.install_sources(sources)?;

        // Prime: enough audio that playback starting now never catches the
        // watermark (fill runs far faster than realtime). ~tens of ms of
        // decode+resample work, so the load still returns almost instantly.
        let prime = ((PRIME_SECONDS * dev_rate as f64) as usize).min(total);
        let t0 = Instant::now();
        loop {
            let min_ready = self
                .stem_buffers
                .iter()
                .map(|b| b.ready_frames())
                .min()
                .unwrap_or(0);
            if min_ready >= prime {
                break;
            }
            if let Some(e) = self.fill_error() {
                // Early failure (before anything meaningful decoded): fail
                // the load like the offline path would have.
                self.teardown_current();
                self.duration_frames = 0;
                self.duration_seconds = 0.0;
                return Err(Error::Decode(format!("streaming load failed: {e}")));
            }
            if t0.elapsed() > PRIME_TIMEOUT {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }

    /// Stop the current stream and any background fill (cancel + join) —
    /// after this, no thread can touch the previous load's buffers.
    fn teardown_current(&mut self) {
        self.stream = None;
        if let Some(mut f) = self.fill.take() {
            f.stop();
        }
        self.stem_buffers.clear();
    }

    /// Common tail of every load: reset control/clock state, build the
    /// engine over `sources`, and start the output stream.
    fn install_sources(&mut self, sources: mixer::Sources) -> Result<()> {
        let dev_rate = self.stream_config.sample_rate.0;
        let channels = self.stream_config.channels as usize;
        let frames = sources.frames;

        self.duration_frames = frames as u64;
        self.duration_seconds = frames as f64 / dev_rate as f64;
        self.stem_buffers = {
            let mut v = vec![sources.instrumental.clone()];
            if let Some(voc) = &sources.vocals {
                v.push(voc.clone());
            }
            v
        };

        // Fresh control state; keep the existing clock handle (UI may hold
        // clones) but re-origin it for the new song. Stretch settings persist
        // across loads like the vocal guide (the engine re-engages from
        // bypass on the first blocks when they are non-identity).
        self.shared = Arc::new(ControlShared::new(
            self.vocal_guide(),
            self.pitch_semitones(),
            self.tempo_rate(),
            self.stretch_config().to_u8(),
        ));
        self.clock.shared.set_device_rate(dev_rate);
        self.clock.shared.reset_for_load();
        self.clock.shared.reset_origin(0.0);

        let core = mixer::MixerCore::new(sources, dev_rate, self.vocal_guide());
        // Engine construction pre-builds both stretcher configs here on the
        // control thread; the audio callback never allocates one.
        let engine = stretch::StretchEngine::new(core, dev_rate, self.stretch_config());

        let stream = match self.sample_format {
            cpal::SampleFormat::F32 => self.build_stream::<f32>(engine, channels)?,
            cpal::SampleFormat::I16 => self.build_stream::<i16>(engine, channels)?,
            cpal::SampleFormat::U16 => self.build_stream::<u16>(engine, channels)?,
            f => {
                return Err(Error::Device(format!(
                    "negotiated sample format {f:?} unsupported"
                )))
            }
        };
        stream
            .play()
            .map_err(|e| Error::Device(format!("stream start: {e}")))?;
        self.stream = Some(stream);
        Ok(())
    }

    fn build_stream<T>(
        &self,
        mut engine: stretch::StretchEngine,
        channels: usize,
    ) -> Result<cpal::Stream>
    where
        T: cpal::SizedSample + cpal::FromSample<f32>,
    {
        let shared = self.shared.clone();
        let err_shared = self.shared.clone();
        let clock = self.clock.shared.clone();
        let events = self.events_tx.clone();
        let dev_rate = self.stream_config.sample_rate.0;
        let t0 = self.epoch;
        let mut gaps = diag::GapTracker::new();
        let mut scratch: Vec<f32> = Vec::new();
        let mut last_seek_id = 0u64;
        let mut last_stretch_id = 0u64;
        let mut mmcss_attempted = false;

        let stream = self
            .device
            .build_output_stream(
                &self.stream_config,
                move |data: &mut [T], _info: &cpal::OutputCallbackInfo| {
                    let now_ns = t0.elapsed().as_nanos() as u64;
                    if !mmcss_attempted {
                        mmcss_attempted = true;
                        let status = if mmcss::SUPPORTED {
                            if mmcss::register_pro_audio_current_thread() {
                                M_REGISTERED
                            } else {
                                M_FAILED
                            }
                        } else {
                            M_UNSUPPORTED
                        };
                        shared.mmcss.store(status, Ordering::Release);
                    }
                    let frames = data.len() / channels;

                    // Own underrun signal — cpal's error callback stayed
                    // silent through 43 ms stalls in the spike.
                    gaps.record(now_ns, frames as u64, dev_rate);
                    shared.callbacks.store(gaps.callbacks, Ordering::Relaxed);
                    shared.stalls.store(gaps.stalls, Ordering::Relaxed);
                    shared.max_gap_ns.store(gaps.max_gap_ns, Ordering::Relaxed);

                    // Pick up controller intent.
                    let sid = shared.seek_id.load(Ordering::Acquire);
                    if sid != last_seek_id {
                        last_seek_id = sid;
                        engine.request_seek(shared.seek_frame.load(Ordering::Relaxed) as usize);
                    }
                    engine.set_guide_gain(f32::from_bits(
                        shared.guide_bits.load(Ordering::Relaxed),
                    ));
                    let playing = shared.transport.load(Ordering::Acquire) == T_PLAYING;

                    // Stretch settings snapshot + apply-latency diagnostics.
                    let settings = stretch::StretchSettings {
                        pitch_semitones: f32::from_bits(
                            shared.pitch_bits.load(Ordering::Relaxed),
                        ),
                        tempo_rate: f64::from_bits(shared.tempo_bits.load(Ordering::Relaxed)),
                        config: stretch::StretchConfig::from_u8(
                            shared.stretch_config.load(Ordering::Relaxed),
                        ),
                    };
                    let cid = shared.stretch_change_id.load(Ordering::Acquire);
                    if cid != last_stretch_id {
                        last_stretch_id = cid;
                        let req = shared.stretch_request_ns.load(Ordering::Relaxed);
                        shared
                            .stretch_apply_ns
                            .store(now_ns.saturating_sub(req), Ordering::Relaxed);
                        shared.stretch_applied.fetch_add(1, Ordering::Release);
                    }

                    // Device frames since origin *before* this block — the
                    // anchor for a tempo-change timeline push.
                    let f_now = clock.frames_value();

                    // Render + convert to the device sample type.
                    scratch.resize(data.len(), 0.0);
                    let outcome = engine.render(&mut scratch, channels, playing, &settings);
                    for (d, &s) in data.iter_mut().zip(scratch.iter()) {
                        *d = T::from_sample(s);
                    }

                    // Clock: the engine already mapped source-frame accounting
                    // to device frames and folded stretcher latency into any
                    // reset origin (stretch.rs module docs). Order per
                    // clock.rs: reset_origin first, then its paired timeline
                    // reset.
                    if let Some(ratio) = outcome.tempo_change {
                        clock.publish_ratio_change(
                            f_now + outcome.latency_dev_frames,
                            ratio,
                        );
                    }
                    clock.advance(outcome.advance_before);
                    if let Some((origin_secs, ratio)) = outcome.reset {
                        clock.reset_origin(origin_secs);
                        clock.publish_timeline_reset(ratio);
                    }
                    clock.advance(outcome.advance_after);

                    shared
                        .stretch_engaged
                        .store(outcome.engaged as u8, Ordering::Relaxed);
                    if outcome.starved > 0 {
                        shared.starved.fetch_add(outcome.starved, Ordering::Relaxed);
                    }

                    if outcome.completed {
                        shared.finished.store(1, Ordering::Release);
                        let _ = events.send(PlayerEvent::Completed);
                    }
                },
                move |e| {
                    // Kept for completeness only — NOT an underrun detector
                    // (spike finding); see GapTracker.
                    let _ = e;
                    err_shared.stream_errors.fetch_add(1, Ordering::Relaxed);
                },
                None,
            )
            .map_err(|e| Error::Device(format!("build output stream: {e}")))?;
        Ok(stream)
    }

    /// Start / resume playback. If the song already finished, restarts from
    /// the top.
    pub fn play(&self) {
        if self.shared.finished.swap(0, Ordering::AcqRel) == 1 {
            self.seek(0.0);
        }
        self.shared.transport.store(T_PLAYING, Ordering::Release);
    }

    pub fn pause(&self) {
        self.shared.transport.store(T_PAUSED, Ordering::Release);
    }

    /// Stop: pause + rewind to 0.
    pub fn stop(&self) {
        self.shared.transport.store(T_STOPPED, Ordering::Release);
        self.seek(0.0);
    }

    /// Sample-accurate seek to `song_seconds` (original-song time, clamped to
    /// the song). Applied by the audio callback after a ~5 ms click-free
    /// ramp; the clock re-origins at the exact landed frame.
    pub fn seek(&self, song_seconds: f64) {
        let frame = clock::song_seconds_to_frame(
            song_seconds.min(self.duration_seconds),
            self.stream_config.sample_rate.0,
        )
        .min(self.duration_frames);
        self.shared.finished.store(0, Ordering::Release);
        self.shared.seek_frame.store(frame, Ordering::Relaxed);
        self.shared.seek_id.fetch_add(1, Ordering::Release);
    }

    /// Vocal-guide blend in [[`mixer::GUIDE_MIN`], 1]; negative =
    /// over-subtraction, a deeper cut into leftover vocal residue (see
    /// [`mixer::GUIDE_MIN`]). Takes effect mid-playback via a ~10 ms ramp
    /// (click-free). No-op in single-source fallback mode.
    pub fn set_vocal_guide(&self, gain: f32) {
        self.shared
            .guide_bits
            .store(gain.clamp(mixer::GUIDE_MIN, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub fn vocal_guide(&self) -> f32 {
        f32::from_bits(self.shared.guide_bits.load(Ordering::Relaxed))
    }

    /// Mark a stretch-setting change for the callback and stamp the request
    /// time (apply-latency diagnostics). Also folds any pending clock events
    /// so the timeline ring stays shallow.
    fn touch_stretch_change(&self) {
        self.shared
            .stretch_request_ns
            .store(self.epoch.elapsed().as_nanos() as u64, Ordering::Relaxed);
        self.shared.stretch_change_id.fetch_add(1, Ordering::Release);
        self.clock.shared.sync_timeline();
    }

    /// Pitch shift in semitones, clamped to ±[`MAX_PITCH_SEMITONES`].
    /// Applies mid-playback; at 0 st and 1.00x tempo the
    /// stretcher leaves the signal path entirely (stretch.rs).
    pub fn set_pitch_semitones(&self, semitones: f32) {
        let v = semitones.clamp(-MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES);
        if v.to_bits() != self.shared.pitch_bits.load(Ordering::Relaxed) {
            self.shared.pitch_bits.store(v.to_bits(), Ordering::Relaxed);
            self.touch_stretch_change();
        }
    }

    pub fn pitch_semitones(&self) -> f32 {
        f32::from_bits(self.shared.pitch_bits.load(Ordering::Relaxed))
    }

    /// Tempo ratio (1.0 = original speed), clamped to
    /// [[`TEMPO_RATE_MIN`], [`TEMPO_RATE_MAX`]]. Independent of
    /// pitch; applies mid-playback. Timing maps are untouched — only the
    /// player clock translates through the ratio history.
    pub fn set_tempo_rate(&self, rate: f64) {
        let v = rate.clamp(TEMPO_RATE_MIN, TEMPO_RATE_MAX);
        if v.to_bits() != self.shared.tempo_bits.load(Ordering::Relaxed) {
            self.shared.tempo_bits.store(v.to_bits(), Ordering::Relaxed);
            self.touch_stretch_change();
        }
    }

    pub fn tempo_rate(&self) -> f64 {
        f64::from_bits(self.shared.tempo_bits.load(Ordering::Relaxed))
    }

    /// Stretcher latency/quality configuration. Takes effect mid-playback
    /// (the engine transitions through a short ramped re-engage).
    pub fn set_stretch_config(&self, config: StretchConfig) {
        if config.to_u8() != self.shared.stretch_config.load(Ordering::Relaxed) {
            self.shared
                .stretch_config
                .store(config.to_u8(), Ordering::Relaxed);
            self.touch_stretch_change();
        }
    }

    pub fn stretch_config(&self) -> StretchConfig {
        StretchConfig::from_u8(self.shared.stretch_config.load(Ordering::Relaxed))
    }

    pub fn state(&self) -> TransportState {
        if self.shared.finished.load(Ordering::Acquire) == 1 {
            return TransportState::Finished;
        }
        match self.shared.transport.load(Ordering::Acquire) {
            T_PLAYING => TransportState::Playing,
            T_PAUSED => TransportState::Paused,
            _ => TransportState::Stopped,
        }
    }

    /// Song duration in original-song seconds (0.0 when nothing is loaded).
    pub fn duration_seconds(&self) -> f64 {
        self.duration_seconds
    }

    /// Original-song seconds already decoded and playable on *every* stem
    /// (device frames below the fill watermark ÷ device rate — original-song
    /// time exactly). Equals [`Self::duration_seconds`] once a
    /// load is complete (immediately for non-streaming loads); 0.0 when
    /// nothing is loaded.
    pub fn loaded_seconds(&self) -> f64 {
        if self.stem_buffers.is_empty() {
            return 0.0;
        }
        let min_ready = self
            .stem_buffers
            .iter()
            .map(|b| b.ready_frames())
            .min()
            .unwrap_or(0);
        (min_ready as f64 / self.stream_config.sample_rate.0 as f64).min(self.duration_seconds)
    }

    /// Error from a streaming load's background fill, if one failed after
    /// the load returned (the region above the watermark stays silent).
    pub fn fill_error(&self) -> Option<String> {
        self.stem_buffers.iter().find_map(|b| b.error())
    }

    /// Cloneable clock handle for the UI to poll at rAF rate.
    pub fn clock(&self) -> PlayerClock {
        self.clock.clone()
    }

    /// Take the event receiver (once); drain it from the UI/control side.
    pub fn take_events(&mut self) -> Option<Receiver<PlayerEvent>> {
        self.events_rx.take()
    }

    pub fn diagnostics(&self) -> Diagnostics {
        Diagnostics {
            callbacks: self.shared.callbacks.load(Ordering::Relaxed),
            stalls: self.shared.stalls.load(Ordering::Relaxed),
            max_gap_ms: self.shared.max_gap_ns.load(Ordering::Relaxed) as f64 / 1e6,
            stream_errors: self.shared.stream_errors.load(Ordering::Relaxed),
            starved_frames: self.shared.starved.load(Ordering::Relaxed),
            mmcss: match self.shared.mmcss.load(Ordering::Acquire) {
                M_REGISTERED => MmcssStatus::Registered,
                M_FAILED => MmcssStatus::Failed,
                M_UNSUPPORTED => MmcssStatus::Unsupported,
                _ => MmcssStatus::NotAttempted,
            },
            stretch_engaged: self.shared.stretch_engaged.load(Ordering::Relaxed) != 0,
            stretch_applied: self.shared.stretch_applied.load(Ordering::Acquire),
            stretch_apply_ms: self.shared.stretch_apply_ns.load(Ordering::Relaxed) as f64 / 1e6,
        }
    }
}

/// Planar 44.1 kHz [`DecodedAudio`] → interleaved stereo at the device rate.
fn interleave_at_device_rate(audio: &DecodedAudio, device_rate: u32) -> Result<Vec<f32>> {
    let n = audio.len;
    let (l, r) = (&audio.samples[..n], &audio.samples[n..2 * n]);
    let (l, r) = audio::resample_stereo(l, r, TARGET_SAMPLE_RATE, device_rate)?;
    let mut out = Vec::with_capacity(l.len() * 2);
    for i in 0..l.len() {
        out.push(l[i]);
        out.push(r[i]);
    }
    Ok(out)
}

/// Pick a stream config: the device default when its format is one we render
/// (this is the WASAPI shared-mode mix format on Windows — usually f32 —
/// so no format conversion or resampling happens in the OS mixer); otherwise
/// the best supported config, preferring f32, stereo, and 48 kHz.
fn negotiate_config(device: &cpal::Device) -> Result<(cpal::StreamConfig, cpal::SampleFormat)> {
    use cpal::SampleFormat::{F32, I16, U16};

    if let Ok(def) = device.default_output_config() {
        if matches!(def.sample_format(), F32 | I16 | U16) {
            return Ok((def.config(), def.sample_format()));
        }
    }

    let ranges = device
        .supported_output_configs()
        .map_err(|e| Error::Device(format!("querying output configs: {e}")))?;
    let mut best: Option<(cpal::SupportedStreamConfig, u32)> = None;
    for range in ranges {
        let fmt_score = match range.sample_format() {
            F32 => 3u32,
            I16 => 2,
            U16 => 1,
            _ => continue,
        };
        let ch_score = if range.channels() >= 2 { 1u32 } else { 0 };
        let rate = 48_000
            .clamp(range.min_sample_rate().0, range.max_sample_rate().0);
        let cfg = range.with_sample_rate(cpal::SampleRate(rate));
        let score = fmt_score * 10 + ch_score;
        if best.as_ref().map(|&(_, s)| score > s).unwrap_or(true) {
            best = Some((cfg, score));
        }
    }
    let (cfg, _) = best.ok_or_else(|| {
        Error::Device("no supported output config (need f32/i16/u16)".into())
    })?;
    let fmt = cfg.sample_format();
    Ok((cfg.config(), fmt))
}
