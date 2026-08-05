//! PlayerClock — current song position in **original-song seconds**, derived
//! from frames actually rendered by the audio device callback, never wall
//! time (PLAN.md §5 "lyric sync").
//!
//! Structure: `position = origin + timeline(frames_since_origin)`, where
//! `origin` is the song time of the last applied seek and [`StretchTimeline`]
//! translates device frames rendered since then into elapsed song seconds.
//!
//! With stretch active (milestone 2) the stretch engine decides ratio-change
//! and reset events; the audio callback publishes them ([`EventRing`]) and
//! they are appended to the timeline
//! ([`StretchTimeline::push_ratio_change`]) at the device frame where each
//! becomes audible. This translation — and nothing else — recovers song
//! time; callers (`position_seconds`) never changed from milestone 1. Timing
//! maps themselves always store original-song time; this is the only place
//! device position is translated (PLAN.md §5).
//!
//! Concurrency: the audio callback is the single writer of the frame counter
//! and the seek origin (a seqlock guards origin+counter pairs so a UI poll
//! never observes a torn seek). The callback **never locks**: timeline events
//! (ratio changes, resets) it decides on are published through a fixed-size
//! lock-free [`EventRing`] and folded into the mutex-guarded
//! [`StretchTimeline`] by whoever reads the clock next (UI poll / control
//! thread) — see [`ClockShared::publish_ratio_change`].
//!
//! Milestone-2 latency model (measured in
//! karaoke-stretch-sys/tests/ffi_smoke.rs): while stretch is active, audio
//! leaving the device lags the frames *fed* to the stretcher by
//! `input_latency + output_latency·ratio` song frames. The stretch engine
//! folds that constant into the **origin** at every clock reset
//! (engage/seek/disengage) and offsets ratio-change frames by
//! `input_latency + output_latency` device frames, so `position_seconds`
//! tracks what is audible, not what has been fed.

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
    ///
    /// An `at_frame` earlier than the last recorded change is clamped forward
    /// to it (the stretch engine offsets change frames by a constant
    /// device-frame latency; rapid successive changes can nominally land out
    /// of order by a few ms — the later setting wins from the boundary).
    pub fn push_ratio_change(&mut self, at_frame: u64, ratio: f64) {
        let at_frame = self
            .segments
            .last()
            .map(|&(f, _)| f.max(at_frame))
            .unwrap_or(at_frame);
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

/// Lock-free SPSC ring carrying timeline events from the audio callback
/// (single producer) to whoever folds them into the [`StretchTimeline`]
/// (consumers serialized by the timeline mutex).
///
/// Entry encoding: `a` bit 63 = reset flag, low bits = device frame since
/// origin; `b` = ratio `f64` bits. Capacity is generous: the callback emits
/// at most one event per user-visible change, and every clock read and every
/// control-plane setter drains the ring — overflow (events dropped, counted)
/// is not reachable in practice.
pub(crate) struct EventRing {
    slots: [(AtomicU64, AtomicU64); Self::CAP],
    head: AtomicU64,
    tail: AtomicU64,
    pub(crate) dropped: AtomicU64,
}

const RESET_FLAG: u64 = 1 << 63;

impl EventRing {
    const CAP: usize = 64;

    fn new() -> Self {
        Self {
            slots: std::array::from_fn(|_| (AtomicU64::new(0), AtomicU64::new(0))),
            head: AtomicU64::new(0),
            tail: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        }
    }

    /// Producer (audio callback only). Wait-free, no allocation.
    fn push(&self, packed: u64, ratio: f64) {
        let h = self.head.load(Ordering::Relaxed);
        if h.wrapping_sub(self.tail.load(Ordering::Acquire)) >= Self::CAP as u64 {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let (a, b) = &self.slots[(h % Self::CAP as u64) as usize];
        a.store(packed, Ordering::Relaxed);
        b.store(ratio.to_bits(), Ordering::Relaxed);
        self.head.store(h.wrapping_add(1), Ordering::Release);
    }

    /// Consumer; must hold the timeline lock (serializes consumers).
    fn drain_into(&self, timeline: &mut StretchTimeline) {
        let t = self.tail.load(Ordering::Relaxed);
        let h = self.head.load(Ordering::Acquire);
        let mut i = t;
        while i != h {
            let (a, b) = &self.slots[(i % Self::CAP as u64) as usize];
            let packed = a.load(Ordering::Relaxed);
            let ratio = f64::from_bits(b.load(Ordering::Relaxed));
            if packed & RESET_FLAG != 0 {
                timeline.reset(ratio);
            } else {
                timeline.push_ratio_change(packed, ratio);
            }
            i = i.wrapping_add(1);
        }
        self.tail.store(h, Ordering::Release);
    }
}

pub(crate) struct ClockShared {
    /// Seqlock: odd while the callback rewrites origin+frames (seek).
    seq: AtomicU64,
    /// f64 bits: song seconds at the clock origin (last applied seek).
    origin_song_secs_bits: AtomicU64,
    /// Device frames rendered since the origin (callback-advanced).
    frames_since_origin: AtomicU64,
    device_rate: AtomicU32,
    /// Frame → song-seconds translation since origin. Reader-written (events
    /// drained from `ring`); never locked by the audio callback.
    timeline: Mutex<StretchTimeline>,
    /// Callback → timeline event transport (see [`EventRing`]).
    ring: EventRing,
}

impl ClockShared {
    pub(crate) fn new() -> Self {
        Self {
            seq: AtomicU64::new(0),
            origin_song_secs_bits: AtomicU64::new(0f64.to_bits()),
            frames_since_origin: AtomicU64::new(0),
            device_rate: AtomicU32::new(0),
            timeline: Mutex::new(StretchTimeline::identity()),
            ring: EventRing::new(),
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

    /// Callback: current device frames since origin (single-writer read;
    /// anchor for timeline pushes).
    pub(crate) fn frames_value(&self) -> u64 {
        self.frames_since_origin.load(Ordering::Relaxed)
    }

    /// Callback: a seek landed — re-origin the clock at `song_seconds`.
    /// Seqlock write so a concurrent `position_seconds` retries instead of
    /// pairing the new origin with the old frame count.
    ///
    /// The ratio history is relative to the origin, so every re-origin must
    /// be paired with a [`Self::publish_timeline_reset`] (ratio active from
    /// the new origin). Ordering: `reset_origin` **first**, then the reset
    /// publish — a reader racing between the two sees the new (small) frame
    /// count against the stale timeline, an error bounded by
    /// `frames·|Δratio|` over at most one callback period; the reverse order
    /// could pair a reset timeline with the old, large frame count.
    pub(crate) fn reset_origin(&self, song_seconds: f64) {
        self.seq.fetch_add(1, Ordering::AcqRel); // -> odd
        self.origin_song_secs_bits
            .store(song_seconds.to_bits(), Ordering::Release);
        self.frames_since_origin.store(0, Ordering::Release);
        self.seq.fetch_add(1, Ordering::AcqRel); // -> even
    }

    /// Callback: the stretch ratio changed, taking effect at `at_frame`
    /// device frames since the current origin (the engine has already added
    /// its latency offset). Lock-free.
    pub(crate) fn publish_ratio_change(&self, at_frame: u64, ratio: f64) {
        self.ring.push(at_frame & !RESET_FLAG, ratio);
    }

    /// Callback: the timeline restarts at the (new) origin with `ratio`.
    /// Paired with every [`Self::reset_origin`]. Lock-free.
    pub(crate) fn publish_timeline_reset(&self, ratio: f64) {
        self.ring.push(RESET_FLAG, ratio);
    }

    /// Fold pending callback events into the timeline (any non-callback
    /// thread; cheap when the ring is empty).
    pub(crate) fn sync_timeline(&self) {
        let mut tl = self.timeline.lock().expect("clock timeline poisoned");
        self.ring.drain_into(&mut tl);
    }

    /// Control thread, on song load (no live callback): discard stale events
    /// and restore the identity mapping.
    pub(crate) fn reset_for_load(&self) {
        let mut tl = self.timeline.lock().expect("clock timeline poisoned");
        self.ring.drain_into(&mut tl);
        tl.reset(1.0);
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
    /// frames rendered (0.0 while nothing is loaded). Folds any pending
    /// callback timeline events in before translating.
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
            let elapsed = {
                let mut tl = self.shared.timeline.lock().expect("clock timeline poisoned");
                self.shared.ring.drain_into(&mut tl);
                tl.song_elapsed_seconds(frames, rate)
            };
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
    fn out_of_order_push_clamps_forward_to_last_change() {
        let mut t = StretchTimeline::identity();
        t.push_ratio_change(48_000, 0.5);
        // Nominally earlier (latency-offset artifact): clamps to 48_000 and
        // replaces the ratio there.
        t.push_ratio_change(47_000, 2.0);
        assert_eq!(t.song_elapsed_seconds(96_000, 48_000), 1.0 + 2.0);
    }

    #[test]
    fn ring_published_events_reach_position_reads() {
        let clock = PlayerClock::new();
        let s = clock.shared.clone();
        s.set_device_rate(48_000);
        // Callback side: 1 s at 1.0x, then a ratio change to 0.8 taking
        // effect at frame 48_000, then 1 more device second.
        s.advance(48_000);
        s.publish_ratio_change(48_000, 0.8);
        s.advance(48_000);
        assert!((clock.position_seconds() - 1.8).abs() < 1e-9);
        // Seek: re-origin then publish the paired reset (ratio 1.2 active).
        s.reset_origin(30.0);
        s.publish_timeline_reset(1.2);
        s.advance(24_000);
        assert!((clock.position_seconds() - 30.6).abs() < 1e-9);
        // Multiple changes queued between reads all land, in order.
        s.publish_ratio_change(24_000, 1.0);
        s.publish_ratio_change(48_000, 0.9);
        s.advance(48_000); // total 72_000 frames since origin
        // 0.5 s @1.2 + 0.5 s @1.0 + 0.5 s @0.9 = 1.55 s song since origin.
        assert!((clock.position_seconds() - 31.55).abs() < 1e-9);
    }

    #[test]
    fn ring_overflow_drops_new_events_and_counts_them() {
        let clock = PlayerClock::new();
        let s = clock.shared.clone();
        s.set_device_rate(48_000);
        for i in 0..80u64 {
            s.publish_ratio_change(i, 1.0 + i as f64 * 1e-3);
        }
        assert_eq!(s.ring.dropped.load(Ordering::Relaxed), 80 - 64);
        // Draining recovers: subsequent events flow again.
        let _ = clock.position_seconds();
        s.publish_ratio_change(100, 0.5);
        s.advance(200);
        // Last applied ratio wins for the tail; no panic, no stuck ring.
        let _ = clock.position_seconds();
        assert_eq!(s.ring.dropped.load(Ordering::Relaxed), 16);
    }

    #[test]
    fn reset_for_load_restores_identity_and_discards_events() {
        let clock = PlayerClock::new();
        let s = clock.shared.clone();
        s.set_device_rate(48_000);
        s.publish_ratio_change(0, 0.5);
        s.reset_for_load();
        s.reset_origin(0.0);
        s.advance(48_000);
        assert_eq!(clock.position_seconds(), 1.0);
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
