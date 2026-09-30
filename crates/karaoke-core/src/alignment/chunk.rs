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

/// A frame is "singing" when it is within this many dB of the song's loud
/// vocal level ([`voice_level_db`]).
const VOICED_BELOW_PEAK_DB: f64 = 30.0;
/// A chunk with fewer singing frames than this is skipped by whisper.
const MIN_VOICED_FRACTION: f64 = 0.03;

fn frame_db(audio: &[f32], sr: usize) -> Vec<f64> {
    let frame = (RMS_FRAME_S * sr as f64) as usize;
    audio
        .chunks_exact(frame.max(1))
        .map(|f| {
            let ms = f.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / f.len() as f64;
            10.0 * (ms + 1e-12).log10()
        })
        .collect()
}

/// The vocal stem's loud level: the 95th percentile of 100 ms frame RMS (dB).
/// Relative to the song, so a quiet master isn't mistaken for silence.
pub fn voice_level_db(audio: &[f32], sr: usize) -> f64 {
    let mut db = frame_db(audio, sr);
    if db.is_empty() {
        return -120.0;
    }
    db.sort_by(|a, b| a.partial_cmp(b).unwrap());
    db[((db.len() - 1) as f64 * 0.95) as usize]
}

/// True when almost nothing in `chunk` is sung (an intro, an instrumental
/// break): whisper gains nothing there and tends to invent words on
/// near-silence ("Thank you."), which would become bogus lyrics.
pub fn is_silent(audio: &[f32], chunk: &Chunk, sr: usize, level_db: f64) -> bool {
    let db = frame_db(&audio[chunk.start..chunk.start + chunk.len], sr);
    if db.is_empty() {
        return true;
    }
    let voiced = db.iter().filter(|&&d| d > level_db - VOICED_BELOW_PEAK_DB).count();
    (voiced as f64) < MIN_VOICED_FRACTION * db.len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: usize = 16_000;

    fn tone(secs: f64, amp: f32) -> Vec<f32> {
        (0..(secs * SR as f64) as usize)
            .map(|i| amp * (i as f32 * 2.0 * std::f32::consts::PI * 220.0 / SR as f32).sin())
            .collect()
    }

    #[test]
    fn silence_is_relative_to_the_song() {
        // a quiet master: singing at -40 dBFS, a break of bleed at -80 dBFS
        let mut audio = tone(20.0, 0.01);
        audio.extend(tone(20.0, 0.0001));
        audio.extend(tone(20.0, 0.01));
        let level = voice_level_db(&audio, SR);
        let chunk = |s: usize| Chunk { start: s * 20 * SR, len: 20 * SR };
        assert!(!is_silent(&audio, &chunk(0), SR, level));
        assert!(is_silent(&audio, &chunk(1), SR, level));
        assert!(!is_silent(&audio, &chunk(2), SR, level));
    }

    #[test]
    fn a_short_phrase_keeps_its_chunk() {
        // 2 s of singing in a 25 s chunk (8%) is enough to transcribe
        let mut audio = tone(23.0, 0.0001);
        audio.extend(tone(2.0, 0.1));
        let level = voice_level_db(&tone(10.0, 0.1), SR);
        assert!(!is_silent(&audio, &Chunk { start: 0, len: 25 * SR }, SR, level));
    }

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
