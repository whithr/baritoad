//! Playback audio engine (Phase 3 milestone 1): cpal output stream, dual-stem
//! mixing with a click-free vocal-guide blend, sample-accurate transport, and
//! a device-frame-derived [`PlayerClock`] (PLAN.md §5 "audio engine (cpal)" /
//! "lyric sync").
//!
//! Scope: library-level only — Tauri wiring is a later milestone. No tempo /
//! key stretch yet (milestone 2); the clock's stretch-ratio translation seam
//! is in [`clock::StretchTimeline`]. When stretch lands it also brings the
//! headroom + soft-limiter stage the spike calls for (REPORT.md §4 item 2);
//! without stretch, stems sum back to (at most) the original mix, so no
//! limiter is needed here yet.
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
//!
//! `Player` holds a `cpal::Stream`, which is not `Send` on all platforms —
//! host it on a dedicated audio-control thread when wiring into Tauri.

pub mod clock;
pub mod diag;
pub mod mixer;
pub mod mmcss;

use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::audio::{self, DecodedAudio, TARGET_SAMPLE_RATE};
use crate::error::{Error, Result};

pub use clock::PlayerClock;
pub use diag::{Diagnostics, MmcssStatus};

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
/// callback never locks).
struct ControlShared {
    transport: AtomicU8,
    guide_bits: AtomicU32,
    seek_frame: AtomicU64,
    seek_id: AtomicU64,
    finished: AtomicU8, // 0/1 (AtomicBool-as-u8 keeps the struct uniform)
    // diagnostics published by the callback
    callbacks: AtomicU64,
    stalls: AtomicU64,
    max_gap_ns: AtomicU64,
    stream_errors: AtomicU64,
    mmcss: AtomicU8,
}

impl ControlShared {
    fn new(guide: f32) -> Self {
        Self {
            transport: AtomicU8::new(T_STOPPED),
            guide_bits: AtomicU32::new(guide.to_bits()),
            seek_frame: AtomicU64::new(0),
            seek_id: AtomicU64::new(0),
            finished: AtomicU8::new(0),
            callbacks: AtomicU64::new(0),
            stalls: AtomicU64::new(0),
            max_gap_ns: AtomicU64::new(0),
            stream_errors: AtomicU64::new(0),
            mmcss: AtomicU8::new(M_NOT_ATTEMPTED),
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
            shared: Arc::new(ControlShared::new(0.0)),
            clock: PlayerClock::new(),
            events_tx,
            events_rx: Some(events_rx),
            duration_seconds: 0.0,
            duration_frames: 0,
        })
    }

    pub fn device_info(&self) -> &DeviceInfo {
        &self.device_info
    }

    /// Load instrumental + vocal stems (the normal karaoke mode).
    pub fn load_stems(&mut self, instrumental: &Path, vocals: &Path) -> Result<()> {
        let inst = audio::decode_to_stereo_44k(instrumental)?;
        let voc = audio::decode_to_stereo_44k(vocals)?;
        self.load_decoded(inst, Some(voc))
    }

    /// Fallback mode: play the original file as-is (stems absent — e.g. a
    /// library entry whose separation hasn't run). The vocal-guide gain has
    /// no effect in this mode.
    pub fn load_single(&mut self, path: &Path) -> Result<()> {
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
        // Tear down any current stream before touching shared state.
        self.stream = None;

        let dev_rate = self.stream_config.sample_rate.0;
        let channels = self.stream_config.channels as usize;

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

        self.duration_frames = frames as u64;
        self.duration_seconds = frames as f64 / dev_rate as f64;

        // Fresh control state; keep the existing clock handle (UI may hold
        // clones) but re-origin it for the new song.
        self.shared = Arc::new(ControlShared::new(self.vocal_guide()));
        self.clock.shared.set_device_rate(dev_rate);
        self.clock.shared.reset_origin(0.0);

        let sources = mixer::Sources {
            instrumental: Arc::new(inst),
            vocals: voc.map(Arc::new),
            frames,
        };
        let core = mixer::MixerCore::new(sources, dev_rate, self.vocal_guide());

        let stream = match self.sample_format {
            cpal::SampleFormat::F32 => self.build_stream::<f32>(core, channels)?,
            cpal::SampleFormat::I16 => self.build_stream::<i16>(core, channels)?,
            cpal::SampleFormat::U16 => self.build_stream::<u16>(core, channels)?,
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

    fn build_stream<T>(&self, mut core: mixer::MixerCore, channels: usize) -> Result<cpal::Stream>
    where
        T: cpal::SizedSample + cpal::FromSample<f32>,
    {
        let shared = self.shared.clone();
        let err_shared = self.shared.clone();
        let clock = self.clock.shared.clone();
        let events = self.events_tx.clone();
        let dev_rate = self.stream_config.sample_rate.0;
        let t0 = Instant::now();
        let mut gaps = diag::GapTracker::new();
        let mut scratch: Vec<f32> = Vec::new();
        let mut last_seek_id = 0u64;
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
                        core.request_seek(shared.seek_frame.load(Ordering::Relaxed) as usize);
                    }
                    core.set_playing(shared.transport.load(Ordering::Acquire) == T_PLAYING);
                    core.set_guide_gain(f32::from_bits(
                        shared.guide_bits.load(Ordering::Relaxed),
                    ));

                    // Render + convert to the device sample type.
                    scratch.resize(data.len(), 0.0);
                    let outcome = core.render(&mut scratch, channels);
                    for (d, &s) in data.iter_mut().zip(scratch.iter()) {
                        *d = T::from_sample(s);
                    }

                    // Clock: advance by frames actually rendered from the
                    // source, splitting around an applied seek so the origin
                    // reset is sample-accurate.
                    clock.advance(outcome.frames_before_seek as u64);
                    if let Some(frame) = outcome.seek_applied {
                        clock.reset_origin(frame as f64 / dev_rate as f64);
                    }
                    clock.advance(outcome.frames_after_seek as u64);

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

    /// Vocal-guide blend in [0, 1]; takes effect mid-playback via a ~10 ms
    /// ramp (click-free). No-op in single-source fallback mode.
    pub fn set_vocal_guide(&self, gain: f32) {
        self.shared
            .guide_bits
            .store(gain.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub fn vocal_guide(&self) -> f32 {
        f32::from_bits(self.shared.guide_bits.load(Ordering::Relaxed))
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
            mmcss: match self.shared.mmcss.load(Ordering::Acquire) {
                M_REGISTERED => MmcssStatus::Registered,
                M_FAILED => MmcssStatus::Failed,
                M_UNSUPPORTED => MmcssStatus::Unsupported,
                _ => MmcssStatus::NotAttempted,
            },
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
