//! Key/tempo stretch engine (Phase 3 milestone 2): wraps the pure
//! [`MixerCore`] and, when pitch/tempo settings are non-identity, routes its
//! output through Signalsmith Stretch (PLAN.md §5 — deliberately NOT Rubber
//! Band, which is GPL/paid, PLAN.md §6).
//!
//! # Identity bypass
//! At 0 st / 1.00x the stretcher is **fully out of the path**: the render is
//! exactly `MixerCore::render` with no extra gain, no limiter, no latency —
//! bit-identical to the milestone-1 engine (asserted in tests). Engage /
//! disengage are deliberate ~10 ms-ramped mode switches, sequenced so they
//! are click-free and do not skip or replay song content.
//!
//! # Feed-ratio streaming (spikes/stretch/src/cmd_live.rs architecture)
//! Per device block of `out_frames`, the engine renders
//! `out_frames·tempo` (+ fractional carry) source frames from the mixer and
//! processes them into `out_frames` output frames; the tempo ratio is just
//! the input/output length ratio, changeable every block. Stems are already
//! resampled to the device rate at load, so no samplerate bridging is needed
//! here (rate 1.0 = identity feed).
//!
//! # Latency model (measured, karaoke-stretch-sys/tests/ffi_smoke.rs)
//! Audible output lags the frames *fed* to the stretcher by
//! `Li + Lo·r` song frames (`Li` = input latency, `Lo` = output latency,
//! `r` = tempo ratio). Pre-rolling `Li` frames via `seek()` does not shorten
//! that lag — it fills the warmup with real history instead of silence.
//! Consequences engineered in here:
//! - **Engage** primes the stretcher with the `Li` frames *ahead* of the
//!   cursor `c` (chunked across blocks — never more than ~2 analysis blocks
//!   of work per audio callback), then jumps the mixer to `c + Li` and holds
//!   the output muted for `Lo` output frames. Audible result: content
//!   continues seamlessly from `c` — nothing skipped, nothing replayed.
//! - **Clock**: resets fold the audible lag into the *origin*
//!   (`origin = fed_reference − (Li + Lo·r)/rate`), and tempo-change events
//!   are offset by `Li + Lo` device frames before entering the
//!   [`StretchTimeline`](super::clock::StretchTimeline). The `r`-dependence
//!   of the device-frame offset (±0.2·Li ≈ 12 ms at the tempo limits) is
//!   below the stretcher's own ~70 ms transition smear (spike t90) and is
//!   deliberately ignored there; origins use the exact `Li + Lo·r`.
//! - **Disengage** cuts the stretcher after a ramp-out and seeks the mixer
//!   *back* to the audible position (`cursor − (Li + Lo·r)`), so bypass
//!   resumes exactly where the listener left off.
//!
//! # Headroom & limiting (spikes/stretch/REPORT.md §4 item 2)
//! The spike measured up to **2.08x peak overshoot** on loudness-maximized
//! mixes. While stretch is active the fed signal is attenuated by −9 dB and
//! the output passes a memoryless soft limiter (unity below −1 dBFS,
//! tanh-saturating above, asymptote < 1.0).
//!
//! **Make-up gain (Phase 3 milestone 3 product decision):** a fixed +6 dB
//! ([`STRETCH_MAKEUP_GAIN`]) is applied *post-stretch, pre-limiter*, so the
//! net level while engaged is −3 dB instead of −9 dB — a modest, predictable
//! dip instead of a jarring drop-and-jump around engage/disengage. Placement
//! matters: the stretcher still sees the full −9 dB headroom (its overshoot
//! math is untouched), and the limiter still bounds the output below
//! full-scale — worst-case spike overshoot (2.08x · −9 dB · +6 dB ≈ 1.47)
//! lands in the tanh region and is soft-saturated, not clipped. The honest
//! cost: on loudness-maximized material the loudest peaks get gentle tanh
//! saturation while stretch is engaged. Alternatives rejected: no make-up
//! (−9 dB is a big audible drop; users crank the volume and then disengage
//! is a +9 dB jump), and post-limiter make-up (would re-clip).
//!
//! Song completion while active is reported when the *fed* cursor reaches the
//! end — up to ~`Li + Lo·r` (≈120 ms) before the audible tail finishes. The
//! stream stays open, so the tail drains; only the event is early.

use karaoke_stretch_sys::Stretch;

use super::mixer::{BlockOutcome, MixerCore, SmoothedGain};

/// Supported pitch range at the API (engine accepts wider; PLAN.md §3).
pub const MAX_PITCH_SEMITONES: f32 = 6.0;
/// Supported tempo-rate range at the API (PLAN.md §3 / spike coverage).
pub const TEMPO_RATE_MIN: f64 = 0.80;
pub const TEMPO_RATE_MAX: f64 = 1.20;

/// −9 dB pre-stretch headroom (covers the spike's 2.08x measured overshoot).
pub const STRETCH_HEADROOM_GAIN: f32 = 0.354_813_38;

/// +6 dB post-stretch / pre-limiter make-up while engaged (module docs
/// "Make-up gain"): net level −3 dB vs bypass, limiter still protects.
pub const STRETCH_MAKEUP_GAIN: f32 = 1.995_262_3;

/// Soft-limiter knee: unity gain below this (−1 dBFS), tanh saturation above.
pub const LIMITER_KNEE: f32 = 0.891_250_9;

/// Soft-limiter ceiling. Must sit strictly below 1.0 in f32: with a 1.0
/// asymptote, `knee + span·tanh(x)` rounds to exactly 1.0 for large inputs
/// (found by the 2.1x-overshoot test). ≈ −0.04 dBFS.
pub const LIMITER_CEIL: f32 = 0.995;

/// Engage/disengage output ramp (same feel as the master pause/seek ramp).
const TRANSITION_RAMP_SECONDS: f64 = 0.005;

/// Max pre-roll frames analyzed per audio callback while engaging (bounds the
/// per-callback cost to ~2 analysis blocks; the spike measured p99 2.7 ms for
/// one block's process() on the i7-9700K — priming stays within the same
/// order instead of doing the full 60 ms pre-roll in one callback).
const PRIME_CHUNK_FRAMES: usize = 2048;

/// Spike tonality limit: preserve harmonics above 8 kHz when pitch-shifting.
const TONALITY_LIMIT_HZ: f32 = 8000.0;

/// Stretcher quality/latency configuration (runtime-selectable; PLAN.md §5).
/// The default may flip to `LowLatency40x10` pending the listening verdict on
/// the spike's `lowlat40ms_*` renders (spikes/stretch/REPORT.md §2B) — that
/// change is one line in `Default`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StretchConfig {
    /// Signalsmith preset: 120 ms block / 30 ms interval. Spike end-to-end
    /// apply latency 80–92 ms. Default until Haley's listening verdict on
    /// the spike's `lowlat40ms_*` renders; flipping the default is moving
    /// the `#[default]` attribute.
    #[default]
    PresetDefault,
    /// Spike custom config: 40 ms block / 10 ms interval. Spike end-to-end
    /// apply latency 35–50 ms; quality verdict pending ears.
    LowLatency40x10,
}

impl StretchConfig {
    pub(crate) fn to_u8(self) -> u8 {
        match self {
            StretchConfig::PresetDefault => 0,
            StretchConfig::LowLatency40x10 => 1,
        }
    }

    pub(crate) fn from_u8(v: u8) -> Self {
        match v {
            1 => StretchConfig::LowLatency40x10,
            _ => StretchConfig::PresetDefault,
        }
    }

    fn index(self) -> usize {
        self.to_u8() as usize
    }
}

/// Settings snapshot the callback reads from the control-plane atomics each
/// block.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StretchSettings {
    /// Pitch shift in semitones (0 = none). Clamped to ±6 at the Player API.
    pub pitch_semitones: f32,
    /// Tempo ratio: song seconds consumed per device second (1.0 = none,
    /// 0.8 = slower, 1.2 = faster). Clamped to [0.80, 1.20] at the API.
    pub tempo_rate: f64,
    pub config: StretchConfig,
}

impl StretchSettings {
    pub fn identity(&self) -> bool {
        self.pitch_semitones == 0.0 && self.tempo_rate == 1.0
    }
}

/// Memoryless soft limiter: unity below [`LIMITER_KNEE`], tanh saturation
/// toward [`LIMITER_CEIL`] above — output strictly inside (−1, 1) for any
/// finite input. C1-continuous at the knee (tanh'(0) = 1), so it adds no
/// discontinuity of its own.
#[inline]
pub fn soft_limit(x: f32) -> f32 {
    let a = x.abs();
    if a <= LIMITER_KNEE {
        x
    } else {
        let span = LIMITER_CEIL - LIMITER_KNEE;
        let y = LIMITER_KNEE + span * ((a - LIMITER_KNEE) / span).tanh();
        if x < 0.0 {
            -y
        } else {
            y
        }
    }
}

/// Clock instruction produced by the engine for one rendered block; the audio
/// callback forwards it to [`ClockShared`](super::clock) (the engine itself
/// never touches atomics or locks — it stays as testable as `MixerCore`).
#[derive(Debug, Default, PartialEq)]
pub struct EngineOutcome {
    /// Device frames the clock advances before an (optional) origin reset.
    pub advance_before: u64,
    /// Re-origin the clock: `(origin_song_seconds, active_ratio)`. The origin
    /// already folds in the audible latency (module docs).
    pub reset: Option<(f64, f64)>,
    /// Device frames the clock advances after the reset.
    pub advance_after: u64,
    /// The tempo ratio changed at this block's start; push into the timeline
    /// at `now + latency_dev_frames`.
    pub tempo_change: Option<f64>,
    /// `Li + Lo` in device frames while the stretcher is in the path, else 0.
    pub latency_dev_frames: u64,
    /// Fed cursor reached the song end this block (may lead the audible end
    /// by the latency — module docs).
    pub completed: bool,
    /// Stretcher currently in the signal path (diagnostics).
    pub engaged: bool,
}

struct EngineStretcher {
    st: Stretch,
    input_latency: usize,
    output_latency: usize,
}

impl EngineStretcher {
    fn build(config: StretchConfig, device_rate: u32) -> Self {
        let st = match config {
            StretchConfig::PresetDefault => Stretch::preset_default(2, device_rate),
            StretchConfig::LowLatency40x10 => Stretch::new(
                2,
                (0.040 * device_rate as f64) as usize,
                (0.010 * device_rate as f64) as usize,
            ),
        };
        let input_latency = st.input_latency();
        let output_latency = st.output_latency();
        Self {
            st,
            input_latency,
            output_latency,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Stretcher out of the path (identity settings, steady state).
    Bypass,
    /// Output muted; feeding pre-roll chunks into analysis history.
    EngagePrime,
    /// Pre-roll complete; waiting for the internal mixer jump to `c + Li`.
    EngageSeekWait,
    /// Stretcher in the path. `hold` counts down the `Lo`-frame warmup mute.
    Active { hold: usize },
    /// Output muted; waiting for the internal mixer jump back to the audible
    /// position before returning to bypass.
    DisengageWait,
}

/// The render-side engine. Single owner: the audio callback. Pure like
/// `MixerCore` — no atomics, no locks, no allocation on the steady path
/// (scratch buffers grow to a high-water mark and stay).
pub struct StretchEngine {
    core: MixerCore,
    device_rate: u32,
    /// Both configs pre-built on the control thread (constructor) so a config
    /// switch never allocates in the audio callback.
    stretchers: [EngineStretcher; 2],
    mode: Mode,
    /// Post-limiter transition gain. Settled at 1.0 in steady bypass — and
    /// then it is *not applied at all*, keeping bypass bit-identical.
    out_gain: SmoothedGain,
    applied_pitch: f32,
    applied_tempo: f64,
    active_config: StretchConfig,
    prime_cursor: usize,
    prime_fed: usize,
    internal_seek: Option<usize>,
    /// Fractional source-frame carry for the feed ratio.
    feed_acc: f64,
    /// Fractional device-frame carry for clock advances (consumed / rate).
    dev_frac: f64,
    in_scratch: Vec<f32>,
    st_out: Vec<f32>,
    prime_buf: Vec<f32>,
}

impl StretchEngine {
    pub fn new(core: MixerCore, device_rate: u32, config: StretchConfig) -> Self {
        Self {
            core,
            device_rate,
            stretchers: [
                EngineStretcher::build(StretchConfig::PresetDefault, device_rate),
                EngineStretcher::build(StretchConfig::LowLatency40x10, device_rate),
            ],
            mode: Mode::Bypass,
            out_gain: SmoothedGain::new(1.0),
            applied_pitch: 0.0,
            applied_tempo: 1.0,
            active_config: config,
            prime_cursor: 0,
            prime_fed: 0,
            internal_seek: None,
            feed_acc: 0.0,
            dev_frac: 0.0,
            in_scratch: Vec::new(),
            st_out: Vec::new(),
            prime_buf: Vec::new(),
        }
    }

    /// Forwarded controller intents (same seams as milestone 1).
    pub fn request_seek(&mut self, frame: usize) {
        // A user seek supersedes any internal transition seek; the post-render
        // bookkeeping detects the mismatch and restarts the transition.
        self.internal_seek = None;
        self.core.request_seek(frame);
    }

    pub fn set_guide_gain(&mut self, gain: f32) {
        self.core.set_guide_gain(gain);
    }

    fn ramp_samples(&self) -> u32 {
        (TRANSITION_RAMP_SECONDS * self.device_rate as f64).round() as u32
    }

    fn gain_is_zero(&self) -> bool {
        self.out_gain.is_settled() && self.out_gain.value() == 0.0
    }

    fn tonality_limit(&self) -> f32 {
        TONALITY_LIMIT_HZ / self.device_rate as f32
    }

    fn latencies(&self) -> (usize, usize) {
        let es = &self.stretchers[self.active_config.index()];
        (es.input_latency, es.output_latency)
    }

    /// Audible lag behind the fed cursor, in song frames (module docs).
    fn audible_lag_song_frames(&self) -> usize {
        let (li, lo) = self.latencies();
        (li as f64 + lo as f64 * self.applied_tempo).round() as usize
    }

    /// Device frames consumed-equivalent for `fed` source frames at the
    /// current tempo, with fractional carry.
    fn fed_to_device_frames(&mut self, fed: usize) -> u64 {
        let x = fed as f64 / self.applied_tempo + self.dev_frac;
        let a = x.floor();
        self.dev_frac = x - a;
        a as u64
    }

    /// Render one device block. `playing` is the transport intent; `s` is the
    /// settings snapshot from the control plane.
    pub fn render(
        &mut self,
        out: &mut [f32],
        channels: usize,
        playing: bool,
        s: &StretchSettings,
    ) -> EngineOutcome {
        let out_frames = out.len() / channels;
        let mut ev = EngineOutcome::default();

        // --- pre-render: transition decisions -------------------------------
        match self.mode {
            Mode::Bypass => {
                if !s.identity() {
                    if self.out_gain.target() != 0.0 {
                        self.out_gain.set_target(0.0, self.ramp_samples());
                    }
                    if self.gain_is_zero() {
                        self.begin_engage(s);
                    }
                } else if self.out_gain.target() != 1.0 {
                    self.out_gain.set_target(1.0, self.ramp_samples());
                }
            }
            Mode::EngagePrime => {
                // Track setting changes that raced the transition.
                self.apply_pitch_if_changed(s);
                self.applied_tempo = s.tempo_rate;
                self.prime_step();
            }
            Mode::Active { .. } | Mode::EngageSeekWait => {
                let leaving = s.identity() || s.config != self.active_config;
                if leaving && matches!(self.mode, Mode::Active { .. }) {
                    if self.out_gain.target() != 0.0 {
                        self.out_gain.set_target(0.0, self.ramp_samples());
                    }
                    if self.gain_is_zero() {
                        let a = self
                            .core
                            .cursor()
                            .saturating_sub(self.audible_lag_song_frames());
                        self.core.request_seek(a);
                        self.internal_seek = Some(a);
                        self.mode = Mode::DisengageWait;
                    }
                } else if !leaving {
                    self.apply_pitch_if_changed(s);
                    if s.tempo_rate != self.applied_tempo {
                        self.applied_tempo = s.tempo_rate;
                        ev.tempo_change = Some(s.tempo_rate);
                    }
                }
            }
            Mode::DisengageWait => {}
        }

        // --- render ---------------------------------------------------------
        let outcome = match self.mode {
            Mode::Bypass | Mode::EngagePrime => {
                // The mixer is frozen while priming: it must not consume the
                // content the pre-roll is built around.
                let effective = playing && self.mode != Mode::EngagePrime;
                self.render_bypass(out, channels, effective)
            }
            Mode::EngageSeekWait | Mode::Active { .. } | Mode::DisengageWait => {
                self.render_stretch(out, channels, playing)
            }
        };

        // --- post-render: transition completion + clock mapping -------------
        let rate = self.device_rate as f64;
        match self.mode {
            Mode::Bypass => {
                ev.advance_before = outcome.frames_before_seek as u64;
                if let Some(t) = outcome.seek_applied {
                    ev.reset = Some((t as f64 / rate, 1.0));
                }
                ev.advance_after = outcome.frames_after_seek as u64;
            }
            Mode::EngagePrime => {
                // Only a *user* seek can land here (the mixer is frozen and we
                // requested nothing): restart priming from the new position.
                ev.advance_before = outcome.frames_before_seek as u64;
                if let Some(t) = outcome.seek_applied {
                    ev.reset = Some((t as f64 / rate, 1.0));
                    self.restart_prime_at(t, s);
                }
                ev.advance_after = outcome.frames_after_seek as u64;
            }
            Mode::EngageSeekWait => {
                ev.advance_before = self.fed_to_device_frames(outcome.frames_before_seek);
                match outcome.seek_applied {
                    Some(t) if Some(t) == self.internal_seek => {
                        // Engage complete: stretcher in path, warmup mute.
                        let (_, lo) = self.latencies();
                        let origin = (self.prime_cursor as f64
                            - lo as f64 * self.applied_tempo)
                            .max(0.0)
                            / rate;
                        ev.reset = Some((origin, self.applied_tempo));
                        self.internal_seek = None;
                        self.mode = Mode::Active { hold: lo };
                    }
                    Some(t) => {
                        // User seek superseded the engage: back to bypass;
                        // the engage restarts from the new position next block.
                        ev.reset = Some((t as f64 / rate, 1.0));
                        self.internal_seek = None;
                        self.mode = Mode::Bypass;
                        self.dev_frac = 0.0;
                    }
                    None => {}
                }
                // Post-seek frames map at the ratio the timeline now carries:
                // fed ratio when we became Active, 1:1 when we fell back to
                // bypass.
                ev.advance_after = if matches!(self.mode, Mode::Bypass) {
                    outcome.frames_after_seek as u64
                } else {
                    self.fed_to_device_frames(outcome.frames_after_seek)
                };
            }
            Mode::Active { .. } => {
                ev.advance_before = self.fed_to_device_frames(outcome.frames_before_seek);
                if let Some(t) = outcome.seek_applied {
                    // User seek while active: audible target arrives one
                    // latency later; fold it into the origin.
                    let lag = self.audible_lag_song_frames() as f64;
                    let origin = ((t as f64 - lag) / rate).max(0.0);
                    ev.reset = Some((origin, self.applied_tempo));
                }
                ev.advance_after = self.fed_to_device_frames(outcome.frames_after_seek);
                // Warmup countdown → open the gain.
                if let Mode::Active { hold } = &mut self.mode {
                    if *hold > 0 {
                        *hold = hold.saturating_sub(out_frames);
                    }
                    let hold_done = *hold == 0;
                    let leaving = s.identity() || s.config != self.active_config;
                    if hold_done && !leaving && self.out_gain.target() != 1.0 {
                        self.out_gain.set_target(1.0, self.ramp_samples());
                    }
                }
            }
            Mode::DisengageWait => {
                ev.advance_before = self.fed_to_device_frames(outcome.frames_before_seek);
                if let Some(t) = outcome.seek_applied {
                    // Internal (or superseding user) seek landed: bypass from
                    // here. If settings are still non-identity the Bypass arm
                    // re-engages on the next block. Post-seek frames map 1:1 —
                    // the timeline is back at ratio 1.0 from the reset (a
                    // fed-ratio mapping here drifted the clock by
                    // frames_after·(1/r − 1), caught by the clock test).
                    ev.reset = Some((t as f64 / rate, 1.0));
                    self.internal_seek = None;
                    self.mode = Mode::Bypass;
                    self.dev_frac = 0.0;
                    ev.advance_after = outcome.frames_after_seek as u64;
                } else {
                    ev.advance_after = self.fed_to_device_frames(outcome.frames_after_seek);
                }
            }
        }

        ev.completed = outcome.completed;
        ev.engaged = matches!(
            self.mode,
            Mode::EngageSeekWait | Mode::Active { .. } | Mode::DisengageWait
        );
        if ev.engaged {
            let (li, lo) = self.latencies();
            ev.latency_dev_frames = (li + lo) as u64;
        }
        ev
    }

    fn begin_engage(&mut self, s: &StretchSettings) {
        self.active_config = s.config;
        self.applied_pitch = s.pitch_semitones;
        self.applied_tempo = s.tempo_rate;
        self.prime_cursor = self.core.cursor();
        self.prime_fed = 0;
        self.feed_acc = 0.0;
        self.dev_frac = 0.0;
        let tonality = self.tonality_limit();
        let es = &mut self.stretchers[self.active_config.index()];
        es.st.reset();
        es.st.set_transpose_semitones(s.pitch_semitones, tonality);
        self.mode = Mode::EngagePrime;
    }

    fn restart_prime_at(&mut self, cursor: usize, s: &StretchSettings) {
        self.prime_cursor = cursor;
        self.prime_fed = 0;
        let tonality = self.tonality_limit();
        let es = &mut self.stretchers[self.active_config.index()];
        es.st.reset();
        es.st.set_transpose_semitones(s.pitch_semitones, tonality);
        self.applied_pitch = s.pitch_semitones;
    }

    fn apply_pitch_if_changed(&mut self, s: &StretchSettings) {
        if s.pitch_semitones != self.applied_pitch {
            self.applied_pitch = s.pitch_semitones;
            let tonality = self.tonality_limit();
            self.stretchers[self.active_config.index()]
                .st
                .set_transpose_semitones(s.pitch_semitones, tonality);
        }
    }

    /// Feed one bounded pre-roll chunk; on completion, jump the mixer past
    /// the primed region.
    fn prime_step(&mut self) {
        let (li, _) = self.latencies();
        let chunk = PRIME_CHUNK_FRAMES.min(li - self.prime_fed);
        if chunk > 0 {
            self.prime_buf.clear();
            self.core.mix_range(
                self.prime_cursor + self.prime_fed,
                chunk,
                STRETCH_HEADROOM_GAIN,
                &mut self.prime_buf,
            );
            self.stretchers[self.active_config.index()]
                .st
                .seek(&self.prime_buf, self.applied_tempo);
            self.prime_fed += chunk;
        }
        if self.prime_fed >= li {
            let target = (self.prime_cursor + li).min(self.core.total_frames());
            self.core.request_seek(target);
            self.internal_seek = Some(target);
            self.mode = Mode::EngageSeekWait;
        }
    }

    fn render_bypass(&mut self, out: &mut [f32], channels: usize, playing: bool) -> BlockOutcome {
        self.core.set_playing(playing);
        let outcome = self.core.render(out, channels);
        // Bit-identity: the transition gain is only touched when it is not
        // settled at unity.
        if !(self.out_gain.is_settled() && self.out_gain.value() == 1.0) {
            let frames = out.len() / channels;
            for f in 0..frames {
                let g = self.out_gain.next();
                for c in 0..channels {
                    out[f * channels + c] *= g;
                }
            }
        }
        outcome
    }

    fn render_stretch(&mut self, out: &mut [f32], channels: usize, playing: bool) -> BlockOutcome {
        self.core.set_playing(playing);
        let out_frames = out.len() / channels;

        // Feed-ratio input take (fractional carry keeps long-run exactness).
        self.feed_acc += out_frames as f64 * self.applied_tempo;
        let n = self.feed_acc.floor() as usize;
        self.feed_acc -= n as f64;

        self.in_scratch.resize(n * 2, 0.0);
        let outcome = self.core.render(&mut self.in_scratch, 2);
        for v in self.in_scratch.iter_mut() {
            *v *= STRETCH_HEADROOM_GAIN;
        }

        self.st_out.resize(out_frames * 2, 0.0);
        self.stretchers[self.active_config.index()]
            .st
            .process(&self.in_scratch, &mut self.st_out);

        for f in 0..out_frames {
            let g = self.out_gain.next();
            let l = soft_limit(self.st_out[f * 2] * STRETCH_MAKEUP_GAIN) * g;
            let r = soft_limit(self.st_out[f * 2 + 1] * STRETCH_MAKEUP_GAIN) * g;
            let base = f * channels;
            match channels {
                1 => out[base] = 0.5 * (l + r),
                _ => {
                    out[base] = l;
                    out[base + 1] = r;
                    for c in 2..channels {
                        out[base + c] = 0.0;
                    }
                }
            }
        }
        outcome
    }

    #[cfg(test)]
    fn mode_name(&self) -> &'static str {
        match self.mode {
            Mode::Bypass => "bypass",
            Mode::EngagePrime => "engage-prime",
            Mode::EngageSeekWait => "engage-seek",
            Mode::Active { .. } => "active",
            Mode::DisengageWait => "disengage",
        }
    }

    #[cfg(test)]
    fn cursor(&self) -> usize {
        self.core.cursor()
    }
}

#[cfg(test)]
mod tests {
    use super::super::clock::PlayerClock;
    use super::super::mixer::{MixerCore, Sources};
    use super::*;
    use std::sync::Arc;

    const RATE: u32 = 48_000;
    const BLOCK: usize = 480; // 10 ms

    fn sine_sources(secs: f64, hz: f32, amp: f32) -> Sources {
        let frames = (secs * RATE as f64) as usize;
        let buf: Vec<f32> = (0..frames)
            .flat_map(|i| {
                let s = amp * (2.0 * std::f32::consts::PI * hz * i as f32 / RATE as f32).sin();
                [s, s]
            })
            .collect();
        Sources {
            instrumental: Arc::new(buf.clone()),
            vocals: Some(Arc::new(buf)),
            frames,
        }
    }

    fn engine(secs: f64) -> StretchEngine {
        let core = MixerCore::new(sine_sources(secs, 220.0, 0.4), RATE, 0.0);
        StretchEngine::new(core, RATE, StretchConfig::default())
    }

    const IDENTITY: StretchSettings = StretchSettings {
        pitch_semitones: 0.0,
        tempo_rate: 1.0,
        config: StretchConfig::LowLatency40x10,
    };

    fn settings(pitch: f32, tempo: f64) -> StretchSettings {
        StretchSettings {
            pitch_semitones: pitch,
            tempo_rate: tempo,
            config: StretchConfig::LowLatency40x10,
        }
    }

    fn render_block(e: &mut StretchEngine, s: &StretchSettings) -> (Vec<f32>, EngineOutcome) {
        let mut out = vec![0.0f32; BLOCK * 2];
        let ev = e.render(&mut out, 2, true, s);
        (out, ev)
    }

    fn rms(buf: &[f32]) -> f32 {
        (buf.iter().map(|&s| s * s).sum::<f32>() / buf.len().max(1) as f32).sqrt()
    }

    // --- limiter / headroom ------------------------------------------------

    #[test]
    fn limiter_is_transparent_below_knee_bit_exact() {
        for &x in &[0.0f32, 0.1, -0.5, 0.889, -0.891, LIMITER_KNEE, -LIMITER_KNEE] {
            assert_eq!(soft_limit(x).to_bits(), x.to_bits(), "changed {x}");
        }
    }

    #[test]
    fn limiter_keeps_a_2p1x_overshoot_buffer_under_full_scale() {
        // Synthesized worst case: the spike measured 2.08x peak overshoot;
        // test at 2.1x on a full-scale-ish sine.
        let buf: Vec<f32> = (0..4800)
            .map(|i| 2.1 * (2.0 * std::f32::consts::PI * 997.0 * i as f32 / RATE as f32).sin())
            .collect();
        let mut peak = 0.0f32;
        for &x in &buf {
            let y = soft_limit(x);
            assert!(y.abs() < 1.0, "sample {x} limited to {y} >= 1.0");
            assert_eq!(y.is_sign_positive(), x.is_sign_positive() || x == 0.0);
            peak = peak.max(y.abs());
        }
        // It must still pass signal above the knee, not crush it flat.
        assert!(peak > LIMITER_KNEE && peak < 1.0);
        // Monotonic through the knee.
        assert!(soft_limit(1.0) > soft_limit(0.95));
        assert!(soft_limit(2.1) > soft_limit(1.5));
    }

    #[test]
    fn headroom_gain_is_minus_nine_db() {
        assert!((20.0 * (STRETCH_HEADROOM_GAIN as f64).log10() + 9.0).abs() < 0.01);
    }

    #[test]
    fn makeup_gain_is_plus_six_db_for_a_net_minus_three() {
        assert!((20.0 * (STRETCH_MAKEUP_GAIN as f64).log10() - 6.0).abs() < 0.01);
        let net = 20.0 * ((STRETCH_HEADROOM_GAIN * STRETCH_MAKEUP_GAIN) as f64).log10();
        assert!((net + 3.0).abs() < 0.02, "net engaged gain {net:.2} dB, expected −3 dB");
    }

    #[test]
    fn worst_case_overshoot_with_makeup_stays_inside_the_limiter() {
        // Spike worst case 2.08x on a full-scale peak, through headroom then
        // make-up: 2.08 · 0.3548 · 1.995 ≈ 1.472 → tanh region, bounded < 1.0.
        let peak = 2.08f32 * STRETCH_HEADROOM_GAIN * STRETCH_MAKEUP_GAIN;
        assert!(peak > 1.0, "test premise: make-up pushes worst case past FS");
        assert!(soft_limit(peak).abs() < 1.0);
    }

    #[test]
    fn engaged_steady_level_sits_near_minus_three_db_of_bypass() {
        // Moderate-level sine (peaks well below the limiter knee after
        // headroom+makeup) so the level check isolates the gain staging.
        let mut e = engine(60.0);
        let mut bypass = vec![0.0f32; 0];
        for _ in 0..100 {
            let (out, _) = render_block(&mut e, &IDENTITY);
            bypass.extend_from_slice(&out);
        }
        let bypass_rms = rms(&bypass[bypass.len() / 2..]);

        let s = settings(0.0, 1.0).clone();
        let s = StretchSettings { pitch_semitones: 1.0, ..s }; // engage via pitch
        for _ in 0..120 {
            let _ = render_block(&mut e, &s);
        }
        let mut engaged = vec![0.0f32; 0];
        for _ in 0..200 {
            let (out, ev) = render_block(&mut e, &s);
            assert!(ev.engaged);
            engaged.extend_from_slice(&out);
        }
        let engaged_rms = rms(&engaged);
        let db = 20.0 * (engaged_rms / bypass_rms).log10();
        // Stretch processing itself moves RMS a little; the staging target is
        // −3 dB, accept ±1.5 dB around it (and far from the old −9 dB).
        assert!(
            (-4.5..=-1.5).contains(&db),
            "engaged level {db:.2} dB vs bypass, expected ≈ −3 dB"
        );
    }

    // --- identity bypass ---------------------------------------------------

    #[test]
    fn identity_bypass_is_bit_identical_to_plain_mixer() {
        let mut e = engine(10.0);
        let mut plain = MixerCore::new(sine_sources(10.0, 220.0, 0.4), RATE, 0.0);

        let mut e_out = Vec::new();
        let mut p_out = Vec::new();
        for block in 0..200 {
            // Mid-run guide change and seek, mirrored on both.
            if block == 60 {
                e.set_guide_gain(0.7);
                plain.set_guide_gain(0.7);
            }
            if block == 120 {
                e.request_seek(3 * RATE as usize);
                plain.request_seek(3 * RATE as usize);
            }
            let (a, _) = render_block(&mut e, &IDENTITY);
            let mut b = vec![0.0f32; BLOCK * 2];
            plain.set_playing(true);
            plain.render(&mut b, 2);
            e_out.extend_from_slice(&a);
            p_out.extend_from_slice(&b);
        }
        assert_eq!(e_out.len(), p_out.len());
        for (i, (a, b)) in e_out.iter().zip(p_out.iter()).enumerate() {
            assert_eq!(a.to_bits(), b.to_bits(), "diverged at sample {i}");
        }
    }

    // --- engage / disengage lifecycle --------------------------------------

    #[test]
    fn engage_is_muted_ramped_and_lands_active_with_latency_folded_origin() {
        let mut e = engine(20.0);
        // Warm up in bypass.
        for _ in 0..50 {
            let (out, ev) = render_block(&mut e, &IDENTITY);
            assert!(!ev.engaged);
            let _ = out;
        }
        let c_before = e.cursor();
        let s = settings(3.0, 1.0);

        let mut reset: Option<(f64, f64)> = None;
        let mut blocks_to_engage = 0;
        for i in 0..100 {
            let (_, ev) = render_block(&mut e, &s);
            if let Some(r) = ev.reset {
                assert!(reset.is_none(), "more than one reset during engage");
                reset = Some(r);
            }
            if ev.engaged && reset.is_some() {
                blocks_to_engage = i + 1;
                break;
            }
        }
        let (origin, ratio) = reset.expect("engage never produced a clock reset");
        assert_eq!(ratio, 1.0, "pitch-only engage keeps ratio 1.0");
        assert_eq!(e.mode_name(), "active");

        // Origin folds the output latency: origin ≈ (cursor-at-engage − Lo)/rate.
        // The engage capture happens ≤ 2 ramp-blocks after c_before.
        let lo = e.latencies().1 as f64;
        let lower = (c_before as f64 - lo) / RATE as f64 - 0.001;
        let upper = (c_before as f64 - lo) / RATE as f64 + 0.030;
        assert!(
            origin >= lower && origin <= upper,
            "engage origin {origin:.4} outside [{lower:.4}, {upper:.4}]"
        );
        println!("engage took {blocks_to_engage} blocks ({} ms)", blocks_to_engage * 10);

        // Output must come back (hold expires, ramp reopens) and be non-silent.
        let mut heard = false;
        for _ in 0..40 {
            let (out, ev) = render_block(&mut e, &s);
            assert!(ev.engaged);
            if rms(&out) > 0.02 {
                heard = true;
                break;
            }
        }
        assert!(heard, "no audio after engage hold+ramp");

        // Back to identity: disengage resumes bypass at the audible position.
        let cursor_active = e.cursor();
        let (li, lo) = e.latencies();
        let mut dis_reset = None;
        for _ in 0..40 {
            let (_, ev) = render_block(&mut e, &IDENTITY);
            if let Some(r) = ev.reset {
                dis_reset = Some(r);
            }
            if !ev.engaged && dis_reset.is_some() {
                break;
            }
        }
        let (origin2, ratio2) = dis_reset.expect("disengage never reset the clock");
        assert_eq!(ratio2, 1.0);
        assert_eq!(e.mode_name(), "bypass");
        // Bypass resumes ≈ (cursor_active − (Li + Lo·1.0)) / rate, allowing the
        // frames consumed during the ramp-out blocks.
        let expect = (cursor_active as f64 - (li + lo) as f64) / RATE as f64;
        assert!(
            (origin2 - expect).abs() < 0.06,
            "disengage origin {origin2:.4}, expected ≈ {expect:.4}"
        );

        // And identity output flows again.
        let mut heard2 = false;
        for _ in 0..20 {
            let (out, ev) = render_block(&mut e, &IDENTITY);
            assert!(!ev.engaged);
            if rms(&out) > 0.02 {
                heard2 = true;
                break;
            }
        }
        assert!(heard2, "no audio after disengage");
    }

    #[test]
    fn tempo_change_emits_one_ratio_event_with_latency_offset() {
        let mut e = engine(30.0);
        let s1 = settings(0.0, 0.9);
        for _ in 0..80 {
            let (_, ev) = render_block(&mut e, &s1);
            if ev.engaged {
                break;
            }
        }
        assert_eq!(e.mode_name(), "active");
        // Settle, then flip tempo.
        for _ in 0..20 {
            let (_, ev) = render_block(&mut e, &s1);
            assert_eq!(ev.tempo_change, None);
        }
        let s2 = settings(0.0, 1.2);
        let (li, lo) = e.latencies();
        let (_, ev) = render_block(&mut e, &s2);
        assert_eq!(ev.tempo_change, Some(1.2), "tempo change not reported");
        assert_eq!(ev.latency_dev_frames, (li + lo) as u64);
        // Only once.
        let (_, ev2) = render_block(&mut e, &s2);
        assert_eq!(ev2.tempo_change, None);
    }

    #[test]
    fn active_feed_consumes_tempo_ratio_source_frames_per_device_frame() {
        for &tempo in &[0.8f64, 1.2] {
            let mut e = engine(60.0);
            let s = settings(0.0, tempo);
            for _ in 0..80 {
                let (_, ev) = render_block(&mut e, &s);
                if ev.engaged {
                    break;
                }
            }
            // Let the hold expire and ramps settle.
            for _ in 0..30 {
                let _ = render_block(&mut e, &s);
            }
            let c0 = e.cursor();
            let mut dev: u64 = 0;
            let n_blocks = 500; // 5 device seconds
            for _ in 0..n_blocks {
                let (_, ev) = render_block(&mut e, &s);
                dev += ev.advance_before + ev.advance_after;
            }
            let consumed = e.cursor() - c0;
            let expect = (n_blocks * BLOCK) as f64 * tempo;
            assert!(
                (consumed as f64 - expect).abs() < BLOCK as f64,
                "tempo {tempo}: consumed {consumed}, expected ≈ {expect}"
            );
            // Clock advances ≈ device frames rendered while playing steadily.
            assert!(
                (dev as f64 - (n_blocks * BLOCK) as f64).abs() < BLOCK as f64,
                "tempo {tempo}: clock advanced {dev} device frames over {} rendered",
                n_blocks * BLOCK
            );
        }
    }

    // --- full clock integration (rendered-frame arithmetic vs song time) ----

    /// Drives a real PlayerClock with the engine outcomes exactly like the
    /// audio callback does, and checks the steady-state invariant
    /// `position ≈ (cursor − Li − Lo·r) / rate` through engage, two tempo
    /// changes, and a user seek.
    #[test]
    fn clock_tracks_audible_position_through_tempo_changes_and_seek() {
        let clock = PlayerClock::new();
        clock.shared.set_device_rate(RATE);
        clock.shared.reset_origin(0.0);
        let mut e = engine(120.0);

        let mut drive = |e: &mut StretchEngine, s: &StretchSettings, blocks: usize| {
            for _ in 0..blocks {
                let f_now = clock.shared.frames_value();
                let (_, ev) = render_block(e, s);
                if let Some(r) = ev.tempo_change {
                    clock
                        .shared
                        .publish_ratio_change(f_now + ev.latency_dev_frames, r);
                }
                clock.shared.advance(ev.advance_before);
                if let Some((origin, ratio)) = ev.reset {
                    clock.shared.reset_origin(origin);
                    clock.shared.publish_timeline_reset(ratio);
                }
                clock.shared.advance(ev.advance_after);
            }
        };

        let check = |e: &StretchEngine, r: f64, tag: &str| {
            let (li, lo) = e.latencies();
            let expect = (e.cursor() as f64 - li as f64 - lo as f64 * r) / RATE as f64;
            let pos = clock.position_seconds();
            assert!(
                (pos - expect).abs() < 0.030,
                "{tag}: position {pos:.4}, audible model {expect:.4}"
            );
        };

        // Identity warmup: clock == cursor exactly.
        drive(&mut e, &IDENTITY, 100);
        let pos = clock.position_seconds();
        let cur = e.cursor() as f64 / RATE as f64;
        assert!((pos - cur).abs() < 1e-9, "bypass clock {pos} != cursor {cur}");

        // Engage at 0.9x and run 10 device seconds.
        let s09 = settings(0.0, 0.9);
        drive(&mut e, &s09, 1000);
        check(&e, 0.9, "steady 0.9x");

        // Flip to 1.2x mid-song, run 10 more device seconds.
        let s12 = settings(0.0, 1.2);
        drive(&mut e, &s12, 1000);
        check(&e, 1.2, "steady 1.2x after mid-song change");

        // Back to 0.9x (multiple mid-song ratio changes accumulate segments).
        drive(&mut e, &s09, 1000);
        check(&e, 0.9, "steady 0.9x after two changes");

        // User seek while active.
        e.request_seek(60 * RATE as usize);
        drive(&mut e, &s09, 200);
        check(&e, 0.9, "steady 0.9x after user seek");
        let pos = clock.position_seconds();
        assert!(
            (pos - 60.0).abs() < 2.5,
            "position {pos:.2} not near the 60 s seek target"
        );

        // Disengage: clock and cursor reconcile exactly again.
        drive(&mut e, &IDENTITY, 100);
        assert_eq!(e.mode_name(), "bypass");
        let pos = clock.position_seconds();
        let cur = e.cursor() as f64 / RATE as f64;
        assert!(
            (pos - cur).abs() < 1e-9,
            "post-disengage clock {pos} != cursor {cur}"
        );
    }
}
