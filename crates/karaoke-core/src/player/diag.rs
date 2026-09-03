//! Callback-health diagnostics: underrun/stall detection by measuring gaps
//! between callback invocations ourselves.
//!
//! Spike finding (spikes/stretch/REPORT.md §4 item 1): cpal's error callback
//! reported **zero** errors during 43 ms scheduler stalls — it cannot be
//! trusted as an underrun detector. So we timestamp every callback and flag a
//! stall whenever the gap since the previous callback exceeds twice the
//! expected device period (with a small floor so tiny buffers don't
//! false-positive on scheduler jitter).

/// A gap counts as a stall when it exceeds `2 * expected_period` and the
/// excess is at least this many nanoseconds (guards against jitter on very
/// small buffer sizes).
pub const STALL_MIN_EXCESS_NS: u64 = 1_000_000; // 1 ms

/// Pure gap accounting — fed with monotonic timestamps by the audio callback,
/// unit-tested with synthetic sequences.
#[derive(Debug, Default)]
pub struct GapTracker {
    last_ns: Option<u64>,
    last_period_ns: u64,
    pub callbacks: u64,
    pub stalls: u64,
    pub max_gap_ns: u64,
}

impl GapTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a callback that started at `now_ns` (monotonic) and will render
    /// `frames` frames at `rate` Hz. The gap is judged against the *previous*
    /// callback's expected period (the frames it was covering).
    pub fn record(&mut self, now_ns: u64, frames: u64, rate: u32) {
        self.callbacks += 1;
        if let Some(last) = self.last_ns {
            let gap = now_ns.saturating_sub(last);
            self.max_gap_ns = self.max_gap_ns.max(gap);
            let expected = self.last_period_ns;
            if expected > 0 && gap > 2 * expected && gap - 2 * expected >= STALL_MIN_EXCESS_NS {
                self.stalls += 1;
            }
        }
        self.last_ns = Some(now_ns);
        self.last_period_ns = if rate > 0 {
            frames.saturating_mul(1_000_000_000) / rate as u64
        } else {
            0
        };
    }
}

/// MMCSS registration outcome for the callback thread (see [`super::mmcss`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MmcssStatus {
    /// Not attempted yet (no callback has run).
    NotAttempted,
    /// `AvSetMmThreadCharacteristicsW("Pro Audio")` succeeded.
    Registered,
    /// The call failed; playback continues without scheduling protection.
    Failed,
    /// Non-Windows platform: registration is a documented stub.
    Unsupported,
}

/// Snapshot of playback-engine health for logs / a debug overlay.
#[derive(Debug, Clone)]
pub struct Diagnostics {
    /// Total device callbacks observed since load.
    pub callbacks: u64,
    /// Callback gaps that exceeded twice the expected device period
    /// (our own underrun/stall signal — NOT cpal's error callback).
    pub stalls: u64,
    /// Largest observed gap between consecutive callbacks, milliseconds.
    pub max_gap_ms: f64,
    /// Errors cpal's error callback did report (kept for completeness; a
    /// zero here means nothing — see module docs).
    pub stream_errors: u64,
    /// Frames rendered as silence because the play cursor sat above a
    /// streaming load's fill watermark (e.g. seeking past what has decoded
    /// so far). Distinct from `stalls`: the callback kept its cadence.
    pub starved_frames: u64,
    pub mmcss: MmcssStatus,
    /// Stretcher currently in the signal path (false = identity bypass).
    pub stretch_engaged: bool,
    /// Count of stretch-setting changes the callback has picked up.
    pub stretch_applied: u64,
    /// Request → callback pickup for the most recent setting change,
    /// milliseconds (scheduling latency only — the stretcher pipeline adds
    /// its own t90, measured in the spike).
    pub stretch_apply_ms: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    #[test]
    fn steady_cadence_counts_no_stalls() {
        let mut g = GapTracker::new();
        // 480 frames @ 48 kHz = 10 ms period.
        for i in 0..100u64 {
            g.record(i * 10 * MS, 480, 48_000);
        }
        assert_eq!(g.callbacks, 100);
        assert_eq!(g.stalls, 0);
        assert_eq!(g.max_gap_ns, 10 * MS);
    }

    #[test]
    fn spike_style_43ms_stall_is_counted_once() {
        let mut g = GapTracker::new();
        let mut t = 0u64;
        for _ in 0..10 {
            g.record(t, 480, 48_000);
            t += 10 * MS;
        }
        // One 43.5 ms preemption (the spike's measured worst case).
        t += 33_500_000; // gap becomes 43.5 ms
        g.record(t, 480, 48_000);
        for _ in 0..10 {
            t += 10 * MS;
            g.record(t, 480, 48_000);
        }
        assert_eq!(g.stalls, 1);
        assert_eq!(g.max_gap_ns, 43_500_000);
    }

    #[test]
    fn jitter_below_twice_period_is_not_a_stall() {
        let mut g = GapTracker::new();
        g.record(0, 480, 48_000);
        g.record(19 * MS, 480, 48_000); // 19 ms < 2*10 ms
        assert_eq!(g.stalls, 0);
        // 12.1 ms (spike's with-MMCSS max) is also not a stall.
        g.record(19 * MS + 12_100_000, 480, 48_000);
        assert_eq!(g.stalls, 0);
    }

    #[test]
    fn tiny_buffers_need_the_absolute_excess_floor() {
        let mut g = GapTracker::new();
        // 32 frames @ 48 kHz ≈ 0.667 ms period; a 1.5 ms gap is >2x expected
        // but the excess (~0.17 ms) is below the 1 ms floor — jitter, not stall.
        g.record(0, 32, 48_000);
        g.record(1_500_000, 32, 48_000);
        assert_eq!(g.stalls, 0);
        // A 4 ms gap (excess > 1 ms) is a stall.
        g.record(1_500_000 + 4_000_000, 32, 48_000);
        assert_eq!(g.stalls, 1);
    }

    #[test]
    fn variable_frames_per_callback_use_previous_period() {
        let mut g = GapTracker::new();
        g.record(0, 4800, 48_000); // 100 ms period next
        g.record(150 * MS, 480, 48_000); // 150 ms gap < 2*100 ms → fine
        assert_eq!(g.stalls, 0);
        g.record(150 * MS + 25 * MS, 480, 48_000); // 25 ms > 2*10 ms → stall
        assert_eq!(g.stalls, 1);
    }
}
