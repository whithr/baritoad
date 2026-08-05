//! Silence-aware chunk planning for whisper transcription.
//!
//! The spike used fixed 30 s windows, which can split a word at a boundary
//! (spikes/alignment/REPORT.md risk 6). Production cuts each chunk at the
//! quietest moment inside the last third of the window instead, so boundaries
//! land in breaths/instrumental gaps whenever one exists.

/// Whisper's window: chunks are at most this long (padded up to it for the
/// model input).
pub const MAX_CHUNK_S: f64 = 30.0;
/// A cut is searched for in `[MIN_CHUNK_S, MAX_CHUNK_S]` — no chunk is shorter
/// than this (keeps chunk count, and therefore whisper cost, bounded).
pub const MIN_CHUNK_S: f64 = 20.0;
/// RMS analysis frame for the quiet-point search.
const RMS_FRAME_S: f64 = 0.1;

/// A planned chunk in samples at the given rate; `start + len <= audio.len()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chunk {
    pub start: usize,
    pub len: usize,
}

impl Chunk {
    pub fn start_s(&self, sr: usize) -> f64 {
        self.start as f64 / sr as f64
    }
    pub fn end_s(&self, sr: usize) -> f64 {
        (self.start + self.len) as f64 / sr as f64
    }
}

/// Plan chunk boundaries over mono audio: greedy left-to-right, each boundary
/// placed at the minimum-RMS frame inside the search window. Chunks tile the
/// input exactly (no overlap, no gaps).
pub fn plan_chunks(audio: &[f32], sr: usize) -> Vec<Chunk> {
    let max = (MAX_CHUNK_S * sr as f64) as usize;
    let min = (MIN_CHUNK_S * sr as f64) as usize;
    let frame = (RMS_FRAME_S * sr as f64) as usize;
    let mut chunks = Vec::new();
    let mut cur = 0usize;
    while audio.len() - cur > max {
        // search [cur+min, cur+max] for the quietest RMS frame; cut at its center
        let lo = cur + min;
        let hi = cur + max;
        let mut best_pos = hi;
        let mut best_rms = f64::INFINITY;
        let mut p = lo;
        while p + frame <= hi {
            let seg = &audio[p..p + frame];
            let rms = seg.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / frame as f64;
            if rms < best_rms {
                best_rms = rms;
                best_pos = p + frame / 2;
            }
            p += frame;
        }
        chunks.push(Chunk {
            start: cur,
            len: best_pos - cur,
        });
        cur = best_pos;
    }
    if audio.len() > cur {
        chunks.push(Chunk {
            start: cur,
            len: audio.len() - cur,
        });
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: usize = 16_000;

    #[test]
    fn short_audio_is_one_chunk() {
        let audio = vec![0.5f32; 10 * SR];
        let c = plan_chunks(&audio, SR);
        assert_eq!(c, vec![Chunk { start: 0, len: 10 * SR }]);
    }

    #[test]
    fn chunks_tile_exactly_and_respect_bounds() {
        let audio = vec![0.3f32; 95 * SR]; // constant loudness, no silence
        let chunks = plan_chunks(&audio, SR);
        let mut pos = 0usize;
        for c in &chunks {
            assert_eq!(c.start, pos, "gap or overlap at {pos}");
            let s = c.len as f64 / SR as f64;
            assert!(s <= MAX_CHUNK_S + 1e-9);
            pos += c.len;
        }
        assert_eq!(pos, audio.len());
        // all but the final chunk must be at least MIN_CHUNK_S
        for c in &chunks[..chunks.len() - 1] {
            assert!(c.len as f64 / SR as f64 >= MIN_CHUNK_S - RMS_FRAME_S);
        }
    }

    #[test]
    fn boundary_lands_in_silence_gap() {
        // 40 s of tone with a 1 s silent gap at t = 25 s
        let mut audio: Vec<f32> = (0..40 * SR)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / SR as f32).sin())
            .collect();
        for v in &mut audio[25 * SR..26 * SR] {
            *v = 0.0;
        }
        let chunks = plan_chunks(&audio, SR);
        assert_eq!(chunks.len(), 2);
        let boundary_s = chunks[0].len as f64 / SR as f64;
        assert!(
            (25.0..=26.0).contains(&boundary_s),
            "boundary at {boundary_s}s, expected inside the 25–26 s gap"
        );
    }

    #[test]
    fn no_silence_falls_back_to_max_window() {
        let audio: Vec<f32> = (0..50 * SR)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / SR as f32).sin())
            .collect();
        let chunks = plan_chunks(&audio, SR);
        // first boundary must sit in the search window even with no silence
        let boundary_s = chunks[0].len as f64 / SR as f64;
        assert!((MIN_CHUNK_S..=MAX_CHUNK_S).contains(&boundary_s));
    }
}
