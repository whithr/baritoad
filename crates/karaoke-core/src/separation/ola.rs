//! Streamed overlap-add segmentation — the spike's whole-song accumulation
//! rebuilt with bounded memory (REPORT.md hardening item 3).
//!
//! Replicates demucs `apply_model(shifts=0, split=True, overlap=0.25)` exactly,
//! like the spike did: outer mono-reference mean/std normalization, 7.8 s
//! segments with 25% overlap and triangular blending, real-left-context
//! padding + center-trim on short chunks. The arithmetic per sample is
//! identical to the spike's (same contribution order, same divide-then-
//! denormalize), so output parity with the spike path is exact.
//!
//! Memory: the decoded mix stays in memory (2 × len f32), but stem
//! accumulation is a sliding window of one segment (8 × SEGMENT f32 ≈ 11 MB)
//! flushed to the sink as samples finalize — vs the spike's 8 × len
//! (≈ 540 MB for a 6.4-min song).

use ndarray::Array3;

use crate::error::Result;
use crate::output::StemSink;
use crate::separation::model::SegmentInfer;
use crate::separation::{NUM_SOURCES, SEGMENT};

/// Segment hop: `int((1 - 0.25) * SEGMENT)`; SEGMENT is divisible by 4.
pub const STRIDE: usize = SEGMENT / 4 * 3;

/// Triangular blending weights, transition_power = 1.0 (demucs default).
pub fn blend_weights() -> Vec<f32> {
    let mut weight = vec![0f32; SEGMENT];
    let half = SEGMENT / 2;
    for i in 0..half {
        weight[i] = (i + 1) as f32;
    }
    for i in 0..(SEGMENT - half) {
        weight[half + i] = (SEGMENT - half - i) as f32;
    }
    let wmax = weight[half - 1].max(weight[half]);
    for w in weight.iter_mut() {
        *w /= wmax;
    }
    weight
}

pub fn segment_count(len: usize) -> usize {
    if len == 0 {
        0
    } else {
        len.div_ceil(STRIDE)
    }
}

/// Mono-reference normalization constants (demucs.api outer normalization).
pub fn norm_stats(mix: &[f32], len: usize) -> (f32, f32) {
    let (l, r) = mix.split_at(len);
    let mean = (0..len).map(|i| (l[i] + r[i]) as f64 / 2.0).sum::<f64>() / len as f64;
    let var = (0..len)
        .map(|i| {
            let m = (l[i] + r[i]) as f64 / 2.0 - mean;
            m * m
        })
        .sum::<f64>()
        / (len as f64 - 1.0); // torch.std uses Bessel correction
    (mean as f32, var.sqrt() as f32)
}

pub struct SeparateStats {
    pub segments: usize,
    pub infer_seconds: f64,
}

/// Run the full streamed separation over planar stereo `mix` (`2 * len`
/// samples), pushing finalized blocks into `sink` and reporting per-segment
/// progress via `on_segment(done, total)`.
pub fn separate_streamed(
    mix: &[f32],
    len: usize,
    model: &mut dyn SegmentInfer,
    sink: &mut dyn StemSink,
    on_segment: &mut dyn FnMut(usize, usize),
) -> Result<SeparateStats> {
    assert!(len > 0 && mix.len() >= 2 * len, "planar stereo mix required");
    let (mean, std) = norm_stats(mix, len);
    let inv_std = 1.0 / std;
    let (mix_l, mix_r) = mix.split_at(len);
    let weight = blend_weights();
    let total = segment_count(len);

    // Sliding accumulation window: acc[stem*2+ch][0..SEGMENT] with acc[·][0]
    // at absolute position `offset` (the flush frontier).
    let mut acc: Vec<Vec<f32>> = (0..NUM_SOURCES * 2).map(|_| vec![0f32; SEGMENT]).collect();
    let mut sum_weight = vec![0f32; SEGMENT];
    let mut flush: Vec<Vec<f32>> = (0..NUM_SOURCES * 2).map(|_| vec![0f32; STRIDE]).collect();

    let mut input = Array3::<f32>::zeros((1, 2, SEGMENT));
    let mut infer_seconds = 0.0f64;
    let mut done = 0usize;
    let mut offset = 0usize;
    while offset < len {
        let chunk_len = SEGMENT.min(len - offset);
        // TensorChunk::padded — pull real context on the left, zeros where the
        // song ends; delta//2 shift, then center_trim afterwards.
        let delta = SEGMENT - chunk_len;
        let start = offset as i64 - (delta / 2) as i64;
        let end = start + SEGMENT as i64;
        let c_start = start.max(0) as usize;
        let c_end = end.min(len as i64) as usize;
        let pad_left = (c_start as i64 - start) as usize;
        let trim = delta / 2;

        input.fill(0.0);
        for (ch, src) in [mix_l, mix_r].into_iter().enumerate() {
            for i in c_start..c_end {
                input[[0, ch, pad_left + (i - c_start)]] = (src[i] - mean) * inv_std;
            }
        }

        let t0 = std::time::Instant::now();
        let stems = model.infer(&input)?;
        infer_seconds += t0.elapsed().as_secs_f64();

        for s in 0..NUM_SOURCES {
            for ch in 0..2 {
                let a = &mut acc[s * 2 + ch];
                for i in 0..chunk_len {
                    a[i] += weight[i] * stems[[0, s, ch, trim + i]];
                }
            }
        }
        for i in 0..chunk_len {
            sum_weight[i] += weight[i];
        }

        // Samples in [offset, offset + STRIDE) get no further contributions
        // (the next segment starts at offset + STRIDE) — finalize and flush.
        let next = offset + STRIDE;
        let flush_n = if next < len { STRIDE } else { chunk_len };
        for sc in 0..NUM_SOURCES * 2 {
            let a = &acc[sc];
            let f = &mut flush[sc];
            if f.len() < flush_n {
                f.resize(flush_n, 0.0);
            }
            for i in 0..flush_n {
                f[i] = a[i] / sum_weight[i] * std + mean;
            }
        }
        sink.write(&flush, flush_n)?;

        // Slide the window left by flush_n.
        for a in acc.iter_mut() {
            a.copy_within(flush_n.., 0);
            let tail = SEGMENT - flush_n;
            a[tail..].fill(0.0);
        }
        sum_weight.copy_within(flush_n.., 0);
        let tail = SEGMENT - flush_n;
        sum_weight[tail..].fill(0.0);

        done += 1;
        on_segment(done, total);
        offset = next;
    }

    Ok(SeparateStats {
        segments: done,
        infer_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndarray::Array4;

    /// Deterministic mock: stem s = input scaled by (s+1)/4, with a small
    /// index-dependent nonlinearity so blending/trim bugs can't cancel out.
    struct MockModel;
    impl SegmentInfer for MockModel {
        fn infer(&mut self, input: &Array3<f32>) -> Result<Array4<f32>> {
            let mut out = Array4::<f32>::zeros((1, NUM_SOURCES, 2, SEGMENT));
            for s in 0..NUM_SOURCES {
                let k = (s as f32 + 1.0) / 4.0;
                for ch in 0..2 {
                    for i in 0..SEGMENT {
                        let x = input[[0, ch, i]];
                        out[[0, s, ch, i]] = k * x + 0.001 * x * x;
                    }
                }
            }
            Ok(out)
        }
    }

    /// The spike's whole-song-in-memory algorithm, verbatim, as the reference.
    fn separate_naive(mix: &[f32], len: usize) -> Vec<Vec<f32>> {
        let (mean, std) = norm_stats(mix, len);
        let mut nmix = mix[..2 * len].to_vec();
        for v in nmix.iter_mut() {
            *v = (*v - mean) / std;
        }
        let weight = blend_weights();
        let mut out: Vec<Vec<f32>> = (0..NUM_SOURCES * 2).map(|_| vec![0f32; len]).collect();
        let mut sum_weight = vec![0f32; len];
        let mut model = MockModel;
        let mut offset = 0usize;
        while offset < len {
            let chunk_len = SEGMENT.min(len - offset);
            let delta = SEGMENT - chunk_len;
            let start = offset as i64 - (delta / 2) as i64;
            let end = start + SEGMENT as i64;
            let c_start = start.max(0) as usize;
            let c_end = end.min(len as i64) as usize;
            let pad_left = (c_start as i64 - start) as usize;
            let trim = delta / 2;

            let mut input = Array3::<f32>::zeros((1, 2, SEGMENT));
            for ch in 0..2 {
                for i in c_start..c_end {
                    input[[0, ch, pad_left + (i - c_start)]] = nmix[ch * len + i];
                }
            }
            let stems = model.infer(&input).unwrap();
            for s in 0..NUM_SOURCES {
                for ch in 0..2 {
                    for i in 0..chunk_len {
                        out[s * 2 + ch][offset + i] += weight[i] * stems[[0, s, ch, trim + i]];
                    }
                }
            }
            for i in 0..chunk_len {
                sum_weight[offset + i] += weight[i];
            }
            offset += STRIDE;
        }
        for sc in 0..NUM_SOURCES * 2 {
            for i in 0..len {
                out[sc][i] = out[sc][i] / sum_weight[i] * std + mean;
            }
        }
        out
    }

    struct VecSink {
        data: Vec<Vec<f32>>,
    }
    impl StemSink for VecSink {
        fn write(&mut self, block: &[Vec<f32>], n: usize) -> Result<()> {
            for sc in 0..NUM_SOURCES * 2 {
                self.data[sc].extend_from_slice(&block[sc][..n]);
            }
            Ok(())
        }
        fn finalize(&mut self) -> Result<Vec<crate::output::OutputFile>> {
            Ok(vec![])
        }
    }

    fn test_mix(len: usize) -> Vec<f32> {
        let mut state = 0xDEADBEEFu64;
        let mut rng = move || {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            (state.wrapping_mul(0x2545F4914F6CDD1D) >> 40) as f32 / (1u64 << 24) as f32 - 0.5
        };
        (0..2 * len)
            .map(|i| {
                0.2 * ((i % len) as f32 * 0.001).sin() + 0.05 * rng() + 0.01 // +DC so mean != 0
            })
            .collect()
    }

    fn check_len(len: usize) {
        let mix = test_mix(len);
        let expected = separate_naive(&mix, len);
        let mut sink = VecSink {
            data: (0..NUM_SOURCES * 2).map(|_| Vec::new()).collect(),
        };
        let mut model = MockModel;
        let mut last = (0, 0);
        let stats =
            separate_streamed(&mix, len, &mut model, &mut sink, &mut |d, t| last = (d, t))
                .unwrap();
        assert_eq!(stats.segments, segment_count(len));
        assert_eq!(last, (stats.segments, stats.segments));
        for sc in 0..NUM_SOURCES * 2 {
            assert_eq!(sink.data[sc].len(), len, "len mismatch stem-ch {sc}");
            for i in 0..len {
                let (a, b) = (expected[sc][i], sink.data[sc][i]);
                assert!(
                    (a - b).abs() <= 1e-6 * a.abs().max(1.0),
                    "stem-ch {sc} sample {i}: naive={a} streamed={b} (len={len})"
                );
            }
        }
    }

    #[test]
    fn streamed_matches_naive_short() {
        check_len(100_000); // < one segment
    }

    #[test]
    fn streamed_matches_naive_exact_segment() {
        check_len(SEGMENT);
    }

    #[test]
    fn streamed_matches_naive_multi_segment() {
        check_len(SEGMENT + STRIDE / 3); // partial last chunk
        check_len(3 * STRIDE); // boundary-aligned
        check_len(900_000);
    }

    #[test]
    fn stride_and_weights_match_demucs_constants() {
        assert_eq!(SEGMENT, 343_980);
        assert_eq!(STRIDE, 257_985); // int(0.75 * 343980)
        let w = blend_weights();
        assert_eq!(w.len(), SEGMENT);
        assert_eq!(w[SEGMENT / 2 - 1], 1.0); // peak normalized
        assert!(w[0] > 0.0 && w[0] < 1e-4);
        assert!(w[SEGMENT - 1] > 0.0 && w[SEGMENT - 1] < 1e-4);
        // symmetric-ish triangle: rising then falling
        assert!(w[100] < w[1000] && w[SEGMENT - 1000] > w[SEGMENT - 100]);
    }

    #[test]
    fn norm_stats_match_torch_semantics() {
        // mono of [1,3] channels -> [2,2,...]? Use distinct L/R:
        // L = [1,2,3,4], R = [3,4,5,6] -> mono = [2,3,4,5]; mean 3.5,
        // std (Bessel) = sqrt(5/3)
        let mix = vec![1.0, 2.0, 3.0, 4.0, 3.0, 4.0, 5.0, 6.0];
        let (mean, std) = norm_stats(&mix, 4);
        assert!((mean - 3.5).abs() < 1e-6);
        assert!((std - (5.0f32 / 3.0).sqrt()).abs() < 1e-6);
    }
}
