//! Real-time mixer core: dual-stem (instrumental + vocal-guide) or
//! single-source rendering with click-free gain ramps, a seek/pause state
//! machine, and song-end detection.
//!
//! Deliberately pure — no cpal, no atomics, no clocks. The audio callback in
//! [`super`] owns one `MixerCore` and drives it with [`MixerCore::render`];
//! tests drive it with a mock sink (plain `Vec<f32>`) and inspect the rendered
//! buffers, which is how the "no clicks" claim is verified (rendered-buffer
//! inspection, not ears).
//!
//! All buffers here are interleaved stereo at the *device* sample rate
//! (sources are resampled at load). While there is no tempo stretch
//! (Phase 3 milestone 1), one rendered device frame consumes exactly one
//! source frame; the clock translation seam lives in [`super::clock`], not
//! here.

use std::sync::Arc;

/// Vocal-guide gain ramp length (seconds). Short enough to feel immediate,
/// long enough that a full 0→1 step never produces an audible click.
pub const GUIDE_RAMP_SECONDS: f64 = 0.010;

/// Master (pause/seek/stop) ramp length in seconds.
pub const MASTER_RAMP_SECONDS: f64 = 0.005;

/// Linear per-sample gain smoother. `set_target` starts a fixed-duration ramp
/// from the *current* value; `next()` advances one sample and returns the gain
/// to apply.
#[derive(Debug, Clone)]
pub struct SmoothedGain {
    current: f32,
    target: f32,
    step: f32,
}

impl SmoothedGain {
    pub fn new(value: f32) -> Self {
        Self {
            current: value,
            target: value,
            step: 0.0,
        }
    }

    /// Begin ramping toward `target` over `ramp_samples` samples.
    pub fn set_target(&mut self, target: f32, ramp_samples: u32) {
        self.target = target;
        let n = ramp_samples.max(1) as f32;
        self.step = (target - self.current) / n;
    }

    /// Jump immediately (only safe when output is already silent).
    pub fn snap(&mut self, value: f32) {
        self.current = value;
        self.target = value;
        self.step = 0.0;
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        if self.current != self.target {
            let v = self.current + self.step;
            // Clamp on overshoot so the ramp terminates exactly on target.
            if (self.step >= 0.0 && v >= self.target) || (self.step < 0.0 && v <= self.target) {
                self.current = self.target;
            } else {
                self.current = v;
            }
        }
        self.current
    }

    pub fn value(&self) -> f32 {
        self.current
    }

    pub fn target(&self) -> f32 {
        self.target
    }

    pub fn is_settled(&self) -> bool {
        self.current == self.target
    }
}

/// Loaded audio, interleaved stereo f32 at the device rate. `vocals` is
/// `None` in fallback mode (single original file, no stems).
pub struct Sources {
    pub instrumental: Arc<Vec<f32>>,
    pub vocals: Option<Arc<Vec<f32>>>,
    /// Frames (samples per channel); both buffers are exactly `2 * frames`.
    pub frames: usize,
}

/// What happened during one rendered block — the callback uses this to drive
/// the [`super::clock::PlayerClock`] and fire the completion event.
#[derive(Debug, Default, PartialEq)]
pub struct BlockOutcome {
    /// Source frames consumed before a seek was applied (or all of them when
    /// no seek happened this block). 1:1 with device frames until stretch
    /// lands (milestone 2).
    pub frames_before_seek: usize,
    /// A pending seek landed: the source frame the cursor jumped to.
    pub seek_applied: Option<usize>,
    /// Source frames consumed after the seek landed.
    pub frames_after_seek: usize,
    /// The cursor reached the end of the sources during this block
    /// (fires exactly once until the next seek).
    pub completed: bool,
}

impl BlockOutcome {
    pub fn frames_consumed(&self) -> usize {
        self.frames_before_seek + self.frames_after_seek
    }
}

/// Render-side state machine. Single owner: the audio callback.
pub struct MixerCore {
    sources: Sources,
    cursor: usize,
    guide: SmoothedGain,
    master: SmoothedGain,
    /// Transport intent: true while the controller wants audio flowing.
    playing: bool,
    pending_seek: Option<usize>,
    /// Song end already reported; cleared by seek.
    completed: bool,
    device_rate: u32,
}

impl MixerCore {
    pub fn new(sources: Sources, device_rate: u32, guide_gain: f32) -> Self {
        Self {
            sources,
            cursor: 0,
            guide: SmoothedGain::new(guide_gain.clamp(0.0, 1.0)),
            master: SmoothedGain::new(0.0),
            playing: false,
            pending_seek: None,
            completed: false,
            device_rate,
        }
    }

    fn guide_ramp_samples(&self) -> u32 {
        (GUIDE_RAMP_SECONDS * self.device_rate as f64).round() as u32
    }

    fn master_ramp_samples(&self) -> u32 {
        (MASTER_RAMP_SECONDS * self.device_rate as f64).round() as u32
    }

    /// Controller intent: start (or resume) playback.
    pub fn set_playing(&mut self, playing: bool) {
        if self.playing != playing {
            self.playing = playing;
            let target = if playing { 1.0 } else { 0.0 };
            self.master.set_target(target, self.master_ramp_samples());
        }
    }

    /// Controller intent: vocal-guide blend in [0, 1], click-free.
    pub fn set_guide_gain(&mut self, gain: f32) {
        let gain = gain.clamp(0.0, 1.0);
        if gain != self.guide.target() {
            self.guide.set_target(gain, self.guide_ramp_samples());
        }
    }

    /// Controller intent: jump to `frame` (clamped to the source length).
    /// Applied inside `render` after a click-free ramp-out.
    pub fn request_seek(&mut self, frame: usize) {
        self.pending_seek = Some(frame.min(self.sources.frames));
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// Render `out` (interleaved, `channels` per frame; stereo written to the
    /// first two channels, extra channels zeroed, mono devices get a downmix).
    /// Returns the frame accounting for the clock.
    pub fn render(&mut self, out: &mut [f32], channels: usize) -> BlockOutcome {
        debug_assert!(channels >= 1);
        let frames = out.len() / channels;
        let mut outcome = BlockOutcome::default();
        let total = self.sources.frames;
        let inst = self.sources.instrumental.clone();
        let voc = self.sources.vocals.clone();

        for f in 0..frames {
            // A pending seek waits for silence (master ramped to 0), then
            // jumps — this is what makes seeks click-free.
            if let Some(target) = self.pending_seek {
                if self.master.value() > 0.0 {
                    // Audible: ramp out first (redirecting any in-progress
                    // ramp-in), then fall through and render the ramp tail.
                    if self.master.target() != 0.0 {
                        self.master.set_target(0.0, self.master_ramp_samples());
                    }
                } else {
                    // Silent: safe to jump.
                    self.cursor = target;
                    self.completed = false;
                    self.pending_seek = None;
                    outcome.seek_applied = Some(target);
                    if self.playing {
                        self.master.set_target(1.0, self.master_ramp_samples());
                    }
                }
            }

            // Ramps advance every frame — including past the song end —
            // otherwise a pending seek's ramp-out could never finish.
            let m = self.master.next();
            let g = self.guide.next();

            let (mut l, mut r) = (0.0f32, 0.0f32);
            if m > 0.0 {
                if self.cursor < total {
                    let i = self.cursor * 2;
                    l = inst[i];
                    r = inst[i + 1];
                    if let Some(v) = &voc {
                        l += g * v[i];
                        r += g * v[i + 1];
                    }
                    l *= m;
                    r *= m;
                    self.cursor += 1;
                    if outcome.seek_applied.is_some() {
                        outcome.frames_after_seek += 1;
                    } else {
                        outcome.frames_before_seek += 1;
                    }
                    if self.cursor >= total && !self.completed {
                        self.completed = true;
                        outcome.completed = true;
                    }
                } else if !self.completed {
                    self.completed = true;
                    outcome.completed = true;
                }
            }

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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dc_sources(frames: usize, inst_level: f32, voc_level: f32) -> Sources {
        Sources {
            instrumental: Arc::new(vec![inst_level; frames * 2]),
            vocals: Some(Arc::new(vec![voc_level; frames * 2])),
            frames,
        }
    }

    /// Max |x[n] - x[n-1]| over an interleaved-stereo left channel.
    fn max_delta(buf: &[f32]) -> f32 {
        buf.chunks_exact(2)
            .map(|c| c[0])
            .collect::<Vec<_>>()
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f32::max)
    }

    const RATE: u32 = 48_000;

    fn render_secs(m: &mut MixerCore, secs: f64) -> (Vec<f32>, BlockOutcome) {
        let frames = (secs * RATE as f64) as usize;
        let mut out = vec![0.0f32; frames * 2];
        let mut total = BlockOutcome::default();
        // render in real-callback-sized blocks (480 frames = 10 ms)
        let mut off = 0;
        while off < frames {
            let n = 480.min(frames - off);
            let o = m.render(&mut out[off * 2..(off + n) * 2], 2);
            if o.seek_applied.is_some() {
                total.seek_applied = o.seek_applied;
                total.frames_before_seek += o.frames_before_seek;
                total.frames_after_seek += o.frames_after_seek;
            } else if total.seek_applied.is_some() {
                // blocks after the seek block: all post-seek consumption
                total.frames_after_seek += o.frames_consumed();
            } else {
                total.frames_before_seek += o.frames_consumed();
            }
            total.completed |= o.completed;
            off += n;
        }
        (out, total)
    }

    #[test]
    fn guide_ramp_is_click_free_and_reaches_target_in_10ms() {
        let mut m = MixerCore::new(dc_sources(RATE as usize, 0.4, 0.4), RATE, 0.0);
        m.set_playing(true);
        let _ = render_secs(&mut m, 0.05); // settle master ramp-in
        m.set_guide_gain(1.0);
        let (out, _) = render_secs(&mut m, 0.02);
        // Full 0→1 guide step on a 0.4 DC vocal over 480 samples: per-sample
        // delta ≈ 0.4/480 ≈ 0.00083. Anything near a click would be ~0.4.
        let d = max_delta(&out);
        assert!(d < 0.005, "guide ramp click: max delta {d}");
        // After 10 ms the guide must be settled at 1.0: output = 0.4 + 0.4.
        let frames_10ms = (0.010 * RATE as f64) as usize;
        let after = out[(frames_10ms + 8) * 2];
        assert!((after - 0.8).abs() < 1e-4, "guide not settled: {after}");
    }

    #[test]
    fn pause_ramps_to_silence_without_click_and_stops_consuming() {
        let mut m = MixerCore::new(dc_sources(RATE as usize, 0.5, 0.0), RATE, 0.0);
        m.set_playing(true);
        let _ = render_secs(&mut m, 0.05);
        m.set_playing(false);
        let (out, o) = render_secs(&mut m, 0.05);
        let d = max_delta(&out);
        assert!(d < 0.01, "pause ramp click: max delta {d}");
        // Tail must be silent.
        assert_eq!(out[out.len() - 2], 0.0);
        assert_eq!(out[out.len() - 1], 0.0);
        // Consumption stops once the ramp (5 ms = 240 frames) settles.
        let ramp = (MASTER_RAMP_SECONDS * RATE as f64) as usize;
        assert!(
            o.frames_consumed() <= ramp + 2,
            "consumed {} frames after pause (ramp is {ramp})",
            o.frames_consumed()
        );
        let cursor_after = m.cursor();
        let (_, o2) = render_secs(&mut m, 0.05);
        assert_eq!(o2.frames_consumed(), 0, "paused mixer still consuming");
        assert_eq!(m.cursor(), cursor_after, "cursor moved while paused");
    }

    #[test]
    fn seek_while_playing_ramps_out_jumps_ramps_in_click_free() {
        let n = RATE as usize * 2;
        // Use DC so any cursor discontinuity without a ramp would be a step.
        let mut m = MixerCore::new(dc_sources(n, 0.5, 0.0), RATE, 0.0);
        m.set_playing(true);
        let _ = render_secs(&mut m, 0.05);
        let target = RATE as usize; // 1.0 s
        m.request_seek(target);
        let (out, o) = render_secs(&mut m, 0.05);
        assert_eq!(o.seek_applied, Some(target));
        let d = max_delta(&out);
        assert!(d < 0.01, "seek click: max delta {d}");
        // Cursor accounting: target + frames consumed after the jump.
        assert_eq!(m.cursor(), target + o.frames_after_seek);
        assert!(o.frames_after_seek > 0, "did not resume after seek");
    }

    #[test]
    fn seek_while_paused_is_immediate_and_silent() {
        let n = RATE as usize;
        let mut m = MixerCore::new(dc_sources(n, 0.5, 0.0), RATE, 0.0);
        m.request_seek(1234);
        let mut out = vec![0.0f32; 960];
        let o = m.render(&mut out, 2);
        assert_eq!(o.seek_applied, Some(1234));
        assert_eq!(o.frames_consumed(), 0);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(m.cursor(), 1234);
    }

    #[test]
    fn completion_fires_exactly_once_and_resets_on_seek() {
        let n = 1000usize;
        let mut m = MixerCore::new(dc_sources(n, 0.1, 0.0), RATE, 0.0);
        m.set_playing(true);
        let mut out = vec![0.0f32; 2 * 800];
        let o1 = m.render(&mut out, 2);
        assert!(!o1.completed);
        let o2 = m.render(&mut out, 2);
        assert!(o2.completed, "end not detected");
        assert_eq!(o2.frames_consumed(), n - 800);
        let o3 = m.render(&mut out, 2);
        assert!(!o3.completed, "completion fired twice");
        assert_eq!(o3.frames_consumed(), 0);
        // Seek back re-arms completion.
        m.request_seek(0);
        let o4 = m.render(&mut out, 2);
        assert_eq!(o4.seek_applied, Some(0));
        assert!(!o4.completed);
        let mut big = vec![0.0f32; 2 * 2000];
        let o5 = m.render(&mut big, 2);
        assert!(o5.completed, "completion did not re-arm after seek");
    }

    #[test]
    fn fallback_single_source_ignores_guide_gain() {
        let n = 480usize;
        let src = Sources {
            instrumental: Arc::new(vec![0.25f32; n * 2]),
            vocals: None,
            frames: n,
        };
        let mut m = MixerCore::new(src, RATE, 1.0);
        m.set_playing(true);
        let (out, _) = render_secs(&mut m, 0.005);
        // After master ramp-in the level must be exactly the source level.
        let last = out[out.len() - 2];
        assert!((last - 0.25).abs() < 1e-5, "fallback level {last}");
    }

    #[test]
    fn mono_device_gets_downmix_and_extra_channels_get_zeros() {
        let n = 480usize;
        let src = Sources {
            instrumental: Arc::new(
                (0..n).flat_map(|_| [0.5f32, 0.1f32]).collect::<Vec<_>>(),
            ),
            vocals: None,
            frames: n,
        };
        let mut m = MixerCore::new(src, RATE, 0.0);
        m.set_playing(true);
        // settle master
        let mut warm = vec![0.0f32; 2 * 480];
        let _ = m.render(&mut warm, 2);
        m.request_seek(0);
        let mut warm2 = vec![0.0f32; 2 * 480];
        let _ = m.render(&mut warm2, 2);

        let mut mono = vec![0.0f32; 64];
        let _ = m.render(&mut mono, 1);
        let last = mono[63];
        assert!((last - 0.3).abs() < 1e-5, "mono downmix {last}");

        let mut quad = vec![0.0f32; 4 * 64];
        let _ = m.render(&mut quad, 4);
        assert!((quad[quad.len() - 4] - 0.5).abs() < 1e-5);
        assert_eq!(quad[quad.len() - 2], 0.0);
        assert_eq!(quad[quad.len() - 1], 0.0);
    }

    #[test]
    fn smoothed_gain_terminates_exactly_on_target() {
        let mut g = SmoothedGain::new(0.0);
        g.set_target(1.0, 10);
        for _ in 0..9 {
            g.next();
        }
        assert!(!g.is_settled());
        assert!((g.next() - 1.0).abs() < 1e-6);
        assert!(g.is_settled());
        // Down-ramp too.
        g.set_target(0.25, 7);
        for _ in 0..7 {
            g.next();
        }
        assert_eq!(g.value(), 0.25);
    }
}
