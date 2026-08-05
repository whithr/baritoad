//! PlayerClock — current song position in **original-song seconds**, derived
//! from frames actually rendered by the audio device callback, never wall
//! time (PLAN.md §5 "lyric sync").
//!
//! Structure: `position = origin + timeline(frames_since_origin)`, where
//! `origin` is the song time of the last applied seek and [`StretchTimeline`]
//! translates device frames rendered since then into elapsed song seconds.
//!
//! **Milestone-2 seam:** today the timeline holds a single ratio-1.0 segment,
//! so device frames map 1:1 to song time. When tempo stretch lands, the
//! controller appends ratio changes ([`StretchTimeline::push_ratio_change`])
//! at the device frame where each takes effect, and this translation — and
//! nothing else — recovers song time. Callers (`position_seconds`) never
//! change. Timing maps themselves always store original-song time; this is
//! the only place device position is translated.
//!
//! Concurrency: the audio callback is the single writer of the frame counter
//! and the seek origin (a seqlock guards origin+counter pairs so a UI poll
//! never observes a torn seek). The timeline is written by the control thread
//! only (milestone 2) and read under a mutex at poll rate (~60 Hz) — never
//! locked by the audio callback.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Piecewise-constant stretch-ratio history over device frames since the
/// clock origin. Ratio = song seconds advanced per device second rendered
/// (1.0 = no stretch; 0.8 = song slowed to 80% speed... i.e. playing slower:
/// one device second advances 0.8 song seconds).
#[derive(Debug, Clone)]
pub struct StretchTimeline {
    /// (start_frame, ratio); ordered, first entry always starts at 0.
    segments: Vec<(u64, f64)>,
}

impl StretchTimeline {
    /// Identity timeline: 1 device frame = 1 song frame (milestone 1).
    pub fn identity() -> Self {
        Self {
            segments: vec![(0, 1.0)],
        }
    }

    /// Reset to a single segment (used when a seek re-origins the clock).
    pub fn reset(&mut self, ratio: f64) {
        self.segments.clear();
        self.segments.push((0, ratio));
    }

    /// Record a ratio change taking effect at `at_frame` (device frames since
    /// origin). Milestone 2 calls this when a tempo change is applied.
    pub fn push_ratio_change(&mut self, at_frame: u64, ratio: f64) {
        debug_assert!(
            self.segments.last().map(|&(f, _)| f <= at_frame).unwrap_or(true),
            "ratio changes must be appended in frame order"
        );
        match self.segments.last_mut() {
            Some(last) if last.0 == at_frame => last.1 = ratio,
            _ => self.segments.push((at_frame, ratio)),
        }
    }

    /// Song seconds elapsed after rendering `frames` device frames since the
    /// origin, integrating through the ratio history.
    pub fn song_elapsed_seconds(&self, frames: u64, device_rate: u32) -> f64 {
        if device_rate == 0 {
            return 0.0;
        }
        let mut total = 0.0f64;
        for (i, &(start, ratio)) in self.segments.iter().enumerate() {
            if start >= frames {
                break;
            }
            let end = self
                .segments
                .get(i + 1)
                .map(|&(f, _)| f.min(frames))
                .unwrap_or(frames);
            total += (end - start) as f64 * ratio;
        }
        total / device_rate as f64
    }
}

/// Convert an original-song time to the nearest device frame (identity
/// mapping — valid while there is no stretch; the duration-preserving
/// resample keeps song time == device frames / device rate).
pub fn song_seconds_to_frame(seconds: f64, device_rate: u32) -> u64 {
    (seconds.max(0.0) * device_rate as f64).round() as u64
}

pub(crate) struct ClockShared {
    /// Seqlock: odd while the callback rewrites origin+frames (seek).
    seq: AtomicU64,
    /// f64 bits: song seconds at the clock origin (last applied seek).
    origin_song_secs_bits: AtomicU64,
    /// Device frames rendered since the origin (callback-advanced).
    frames_since_origin: AtomicU64,
    device_rate: AtomicU32,
    /// Frame → song-seconds translation since origin. Control-thread-written,
    /// UI-read; never touched by the audio callback.
    timeline: Mutex<StretchTimeline>,
}

impl ClockShared {
    pub(crate) fn new() -> Self {
        Self {
            seq: AtomicU64::new(0),
            origin_song_secs_bits: AtomicU64::new(0f64.to_bits()),
            frames_since_origin: AtomicU64::new(0),
            device_rate: AtomicU32::new(0),
            timeline: Mutex::new(StretchTimeline::identity()),
        }
    }

    pub(crate) fn set_device_rate(&self, rate: u32) {
        self.device_rate.store(rate, Ordering::Release);
    }

    /// Callback: `frames` more device frames were rendered from the source.
    pub(crate) fn advance(&self, frames: u64) {
        if frames > 0 {
            self.frames_since_origin.fetch_add(frames, Ordering::AcqRel);
        }
    }

    /// Callback: a seek landed — re-origin the clock at `song_seconds`.
    /// Seqlock write so a concurrent `position_seconds` retries instead of
    /// pairing the new origin with the old frame count.
    ///
    /// Milestone-2 note: the ratio history is relative to the origin, so the
    /// controller must [`StretchTimeline::reset`] the timeline (to the ratio
    /// active at the seek) when the seek it issued is reported applied. In
    /// milestone 1 the timeline is permanently identity — nothing to reset.
    pub(crate) fn reset_origin(&self, song_seconds: f64) {
        self.seq.fetch_add(1, Ordering::AcqRel); // -> odd
        self.origin_song_secs_bits
            .store(song_seconds.to_bits(), Ordering::Release);
        self.frames_since_origin.store(0, Ordering::Release);
        self.seq.fetch_add(1, Ordering::AcqRel); // -> even
    }
}

/// Cloneable read handle for the UI (poll at rAF rate). See module docs.
#[derive(Clone)]
pub struct PlayerClock {
    pub(crate) shared: Arc<ClockShared>,
}

impl PlayerClock {
    pub(crate) fn new() -> Self {
        Self {
            shared: Arc::new(ClockShared::new()),
        }
    }

    /// Current position in original-song seconds, derived purely from device
    /// frames rendered (0.0 while nothing is loaded).
    pub fn position_seconds(&self) -> f64 {
        loop {
            let s1 = self.shared.seq.load(Ordering::Acquire);
            if s1 & 1 == 1 {
                std::hint::spin_loop();
                continue;
            }
            let origin = f64::from_bits(self.shared.origin_song_secs_bits.load(Ordering::Acquire));
            let frames = self.shared.frames_since_origin.load(Ordering::Acquire);
            let rate = self.shared.device_rate.load(Ordering::Acquire);
            let elapsed = self
                .shared
                .timeline
                .lock()
                .expect("clock timeline poisoned")
                .song_elapsed_seconds(frames, rate);
            if self.shared.seq.load(Ordering::Acquire) == s1 {
                return origin + elapsed;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_timeline_maps_frames_to_seconds_1_to_1() {
        let t = StretchTimeline::identity();
        assert_eq!(t.song_elapsed_seconds(48_000, 48_000), 1.0);
        assert_eq!(t.song_elapsed_seconds(0, 48_000), 0.0);
        assert_eq!(t.song_elapsed_seconds(24_000, 48_000), 0.5);
        // Unloaded clock: rate 0 must not divide by zero.
        assert_eq!(t.song_elapsed_seconds(999, 0), 0.0);
    }

    #[test]
    fn ratio_history_integrates_piecewise() {
        // 1.0x for 1 s, then 0.5x (half speed) for 1 s, then 2.0x for 0.5 s.
        let mut t = StretchTimeline::identity();
        t.push_ratio_change(48_000, 0.5);
        t.push_ratio_change(96_000, 2.0);
        // Mid-first-segment.
        assert_eq!(t.song_elapsed_seconds(24_000, 48_000), 0.5);
        // Exactly at the first change.
        assert_eq!(t.song_elapsed_seconds(48_000, 48_000), 1.0);
        // Mid-second: 1.0 + 0.5 s device * 0.5 = 1.25 song-s.
        assert_eq!(t.song_elapsed_seconds(72_000, 48_000), 1.25);
        // Past the third: 1.0 + 1.0*0.5 + 0.5*2.0 = 2.5 song-s.
        assert_eq!(t.song_elapsed_seconds(120_000, 48_000), 2.5);
    }

    #[test]
    fn ratio_change_at_same_frame_replaces_not_appends() {
        let mut t = StretchTimeline::identity();
        t.push_ratio_change(0, 0.8);
        assert_eq!(t.song_elapsed_seconds(48_000, 48_000), 0.8);
    }

    #[test]
    fn reset_collapses_history() {
        let mut t = StretchTimeline::identity();
        t.push_ratio_change(1000, 0.5);
        t.reset(1.0);
        assert_eq!(t.song_elapsed_seconds(48_000, 48_000), 1.0);
    }

    #[test]
    fn seek_arithmetic_rounds_to_nearest_frame_and_clamps_negative() {
        assert_eq!(song_seconds_to_frame(0.0, 48_000), 0);
        assert_eq!(song_seconds_to_frame(1.0, 48_000), 48_000);
        // 0.5 / 48000 s past a frame boundary rounds down; just over half up.
        assert_eq!(song_seconds_to_frame(1.0 + 0.4 / 48_000.0, 48_000), 48_000);
        assert_eq!(song_seconds_to_frame(1.0 + 0.6 / 48_000.0, 48_000), 48_001);
        assert_eq!(song_seconds_to_frame(-3.0, 48_000), 0);
        // 44.1 kHz too.
        assert_eq!(song_seconds_to_frame(2.5, 44_100), 110_250);
    }

    #[test]
    fn clock_position_is_origin_plus_translated_frames() {
        let clock = PlayerClock::new();
        clock.shared.set_device_rate(48_000);
        clock.shared.advance(24_000);
        assert_eq!(clock.position_seconds(), 0.5);
        // Seek to 10 s: origin resets, frames restart.
        clock.shared.reset_origin(10.0);
        assert_eq!(clock.position_seconds(), 10.0);
        clock.shared.advance(48_000);
        assert_eq!(clock.position_seconds(), 11.0);
    }

    #[test]
    fn clock_uses_timeline_translation_not_raw_frames() {
        let clock = PlayerClock::new();
        clock.shared.set_device_rate(48_000);
        clock
            .shared
            .timeline
            .lock()
            .unwrap()
            .push_ratio_change(0, 0.5);
        clock.shared.advance(48_000);
        // One device second at half speed = 0.5 song seconds.
        assert_eq!(clock.position_seconds(), 0.5);
    }
}
