//! Silence analysis of the vocal stem: chunk planning for whisper
//! transcription, and the long silent stretches the CTC trellis may only
//! place between words ([`silent_stretches`]).
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

/// A frame is "silent" for the trellis when it is this many dB or more below
/// the song's loud vocal level ([`voice_level_db`]) — further down than
/// [`VOICED_BELOW_PEAK_DB`], so quiet singing is never in doubt; what is left
/// is separation bleed, hiss, and digital silence.
const SILENT_BELOW_VOICE_DB: f64 = 40.0;
/// Only runs of silent frames at least this long count: a breath or a gap
/// between words is the trellis's to judge.
const MIN_SILENT_STRETCH_S: f64 = 1.0;
/// Each stretch gives up this much at an edge that touches sound, so a soft
/// onset or a fading note next to the silence stays alignable.
pub(crate) const SILENT_EDGE_GUARD_S: f64 = 0.2;

/// Long stretches where the vocal stem is effectively silent relative to the
/// song's own voice level, as `(start_s, end_s)` — the CTC trellis lets one
/// fall only between words ([`super::ctc::Silence`]).
/// wav2vec2 normalizes each chunk to unit variance, so a near-silent intro
/// reaches the model as full-scale noise it can read letters into (a 1925
/// 78-rpm transfer: hiss 80 dB below the voice drew the first word ~20 s
/// early). Relative to the song, like [`is_silent`].
pub fn silent_stretches(audio: &[f32], sr: usize, level_db: f64) -> Vec<(f64, f64)> {
    let db = frame_db(audio, sr);
    let min_frames = (MIN_SILENT_STRETCH_S / RMS_FRAME_S).round() as usize;
    let end_s = audio.len() as f64 / sr as f64;
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < db.len() {
        if db[i] > level_db - SILENT_BELOW_VOICE_DB {
            i += 1;
            continue;
        }
        let a = i;
        while i < db.len() && db[i] <= level_db - SILENT_BELOW_VOICE_DB {
            i += 1;
        }
        if i - a < min_frames {
            continue;
        }
        // A run that reaches the start or end of the song has no sound to
        // guard on that side (frame_db drops a trailing partial frame).
        let s = if a == 0 {
            0.0
        } else {
            a as f64 * RMS_FRAME_S + SILENT_EDGE_GUARD_S
        };
        let e = if i == db.len() {
            end_s
        } else {
            i as f64 * RMS_FRAME_S - SILENT_EDGE_GUARD_S
        };
        if e > s {
            out.push((s, e));
        }
    }
    out
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
    fn silent_stretches_are_long_quiet_runs_relative_to_the_song() {
        // quiet master (-40 dBFS singing): 10 s of hiss 60 dB under it, 5 s
        // singing, a 0.5 s gap (a breath — not a stretch), 5 s singing, a 3 s
        // break of bleed 45 dB under, 5 s singing, then 2 s of digital silence
        let mut audio = tone(10.0, 0.00001);
        audio.extend(tone(5.0, 0.01));
        audio.extend(tone(0.5, 0.00001));
        audio.extend(tone(5.0, 0.01));
        audio.extend(tone(3.0, 0.01 * 10f32.powf(-45.0 / 20.0)));
        audio.extend(tone(5.0, 0.01));
        audio.extend(vec![0.0; 2 * SR]);
        let level = voice_level_db(&audio, SR);
        let s = silent_stretches(&audio, SR, level);
        assert_eq!(s.len(), 3, "{s:?}");
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        // the intro has no sound before it to guard; its end gives up the guard
        assert!(
            close(s[0].0, 0.0) && close(s[0].1, 10.0 - SILENT_EDGE_GUARD_S),
            "{s:?}"
        );
        // the break is guarded on both sides
        assert!(close(s[1].0, 20.5 + SILENT_EDGE_GUARD_S), "{s:?}");
        assert!(close(s[1].1, 23.5 - SILENT_EDGE_GUARD_S), "{s:?}");
        // the trailing silence runs to the end of the audio
        assert!(
            close(s[2].0, 28.5 + SILENT_EDGE_GUARD_S) && close(s[2].1, 30.5),
            "{s:?}"
        );
    }

    #[test]
    fn quiet_singing_is_never_a_silent_stretch() {
        // a soft verse 30 dB under the chorus is singing, not silence
        let mut audio = tone(10.0, 0.3 * 10f32.powf(-30.0 / 20.0));
        audio.extend(tone(10.0, 0.3));
        let level = voice_level_db(&audio, SR);
        assert!(silent_stretches(&audio, SR, level).is_empty());
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
