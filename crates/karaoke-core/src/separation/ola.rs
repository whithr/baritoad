//! Streamed overlap-add segmentation — the spike's whole-song accumulation
//! rebuilt with bounded memory (REPORT.md hardening item 3).
//!
//! Replicates demucs `apply_model(split=True)` semantics: outer mono-reference
//! mean/std normalization, 7.8 s segments with triangular blending,
//! real-left-context padding + center-trim on short chunks. Two quality knobs
//! beyond the spike's fixed `shifts=0, overlap=0.25`:
//!
//! - `overlap` — segment overlap fraction (demucs `overlap`); more overlap =
//!   more segments blended per sample, fewer seam artifacts, ~1/(1-overlap)×
//!   inference cost.
//! - `shifts` — demucs's shift equivariance trick: run the whole split pass
//!   over the signal delayed by a sub-second offset, undo the delay, average
//!   the passes. demucs draws offsets at random (REPORT.md item 6:
//!   nondeterministic); we pin them to evenly spaced midpoints of
//!   `[0, MAX_SHIFT)` so runs are reproducible and the parity gate stays
//!   meaningful. `shifts=0` is the single un-shifted pass. Cost is `shifts`×.
//!
//! The arithmetic per sample of the default single pass is identical to the
//! spike's (same contribution order, same divide-then-denormalize), so output
//! parity with the spike path is exact.
//!
//! Memory: the decoded mix stays in memory (2 × len f32); each shift pass
//! holds a sliding window of one segment (8 × SEGMENT f32 ≈ 11 MB) plus a
//! short queue of finalized samples awaiting cross-pass averaging (bounded by
//! MAX_SHIFT + one stride of skew). Samples flush to the sink as soon as
//! every pass has finalized them.

use std::collections::VecDeque;

use ndarray::Array3;

use crate::error::{Error, Result};
use crate::output::StemSink;
use crate::separation::model::SegmentInfer;
use crate::separation::{NUM_SOURCES, SEGMENT};

/// Default-quality segment hop: `int((1 - 0.25) * SEGMENT)`.
pub const STRIDE: usize = SEGMENT / 4 * 3;

/// demucs shift-trick padding: `int(0.5 * samplerate)` = 0.5 s at 44.1 kHz.
pub const MAX_SHIFT: usize = 22_050;

/// Separation quality knobs. `Default` matches the spike / demucs defaults.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SeparateOptions {
    /// Segment overlap fraction in `[0, 0.9]` (demucs default 0.25).
    pub overlap: f32,
    /// Number of pinned-shift passes to average; 0 = single un-shifted pass.
    pub shifts: usize,
}

impl Default for SeparateOptions {
    fn default() -> Self {
        Self {
            overlap: 0.25,
            shifts: 0,
        }
    }
}

impl SeparateOptions {
    /// Segment hop derived from `overlap` (demucs `stride`).
    pub fn stride(&self) -> usize {
        ((1.0 - self.overlap as f64) * SEGMENT as f64) as usize
    }

    /// Lead (delay) in samples for each pass. Offsets are the midpoints of
    /// `shifts` equal divisions of `[0, MAX_SHIFT)` — deterministic, and never
    /// 0 or MAX_SHIFT so every shifted pass is genuinely shifted.
    fn leads(&self) -> Vec<usize> {
        if self.shifts == 0 {
            return vec![0];
        }
        (0..self.shifts)
            .map(|k| MAX_SHIFT - (2 * k + 1) * MAX_SHIFT / (2 * self.shifts))
            .collect()
    }

    /// Total inference segments for a song of `len` samples (progress total).
    pub fn total_segments(&self, len: usize) -> usize {
        let stride = self.stride();
        self.leads()
            .iter()
            .map(|lead| (lead + len).div_ceil(stride))
            .sum()
    }

    fn validate(&self) -> Result<()> {
        if !(0.0..=0.9).contains(&self.overlap) {
            return Err(Error::InvalidInput(format!(
                "separation overlap {} outside [0, 0.9]",
                self.overlap
            )));
        }
        Ok(())
    }
}

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

/// Segments needed to cover `len` samples at the default stride.
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

/// One shift pass: streamed split-OLA over the song delayed by `lead` zeros
/// (demucs pads the *normalized* signal, so the pad region is normalized-
/// domain silence). Pass coordinate `j` maps to mix sample `j - lead`.
struct ShiftPass {
    lead: usize,
    /// Pass length: `lead + song_len` (demucs's shifted view ends exactly at
    /// the song end).
    len: usize,
    /// Next segment start, pass coordinates. Also the accumulation-window
    /// base: `acc[·][0]` is pass sample `seg_start`.
    seg_start: usize,
    acc: Vec<Vec<f32>>,
    sum_weight: Vec<f32>,
    /// Finalized, denormalized samples in mix coordinates, awaiting the
    /// cross-pass combiner (pre-mix pad samples are dropped at flush).
    queues: Vec<VecDeque<f32>>,
    done: bool,
}

impl ShiftPass {
    fn new(lead: usize, song_len: usize) -> Self {
        Self {
            lead,
            len: lead + song_len,
            seg_start: 0,
            acc: (0..NUM_SOURCES * 2).map(|_| vec![0f32; SEGMENT]).collect(),
            sum_weight: vec![0f32; SEGMENT],
            queues: (0..NUM_SOURCES * 2).map(|_| VecDeque::new()).collect(),
            done: false,
        }
    }

    /// Run one segment of inference and finalize the samples that can no
    /// longer receive contributions. Returns inference wall time.
    #[allow(clippy::too_many_arguments)]
    fn advance(
        &mut self,
        mix_l: &[f32],
        mix_r: &[f32],
        mean: f32,
        inv_std: f32,
        std: f32,
        weight: &[f32],
        stride: usize,
        input: &mut Array3<f32>,
        model: &mut dyn SegmentInfer,
    ) -> Result<f64> {
        debug_assert!(!self.done);
        let o = self.seg_start;
        let chunk_len = SEGMENT.min(self.len - o);
        // TensorChunk::padded — pull real context on the left, zeros where the
        // signal ends; delta//2 shift, then center_trim afterwards.
        let delta = SEGMENT - chunk_len;
        let start = o as i64 - (delta / 2) as i64;
        let end = start + SEGMENT as i64;
        let c_start = start.max(0) as usize;
        let c_end = end.min(self.len as i64) as usize;
        let pad_left = (c_start as i64 - start) as usize;
        let trim = delta / 2;

        input.fill(0.0);
        // Real (non-pad) samples: pass coords [c_start, c_end) ∩ [lead, len).
        let r_start = c_start.max(self.lead);
        let r_end = c_end; // self.len == self.lead + song_len bounds this
        for (ch, src) in [mix_l, mix_r].into_iter().enumerate() {
            for j in r_start..r_end {
                input[[0, ch, pad_left + (j - c_start)]] =
                    (src[j - self.lead] - mean) * inv_std;
            }
        }

        let t0 = std::time::Instant::now();
        let stems = model.infer(input)?;
        let infer_s = t0.elapsed().as_secs_f64();

        for s in 0..NUM_SOURCES {
            for ch in 0..2 {
                let a = &mut self.acc[s * 2 + ch];
                for i in 0..chunk_len {
                    a[i] += weight[i] * stems[[0, s, ch, trim + i]];
                }
            }
        }
        for i in 0..chunk_len {
            self.sum_weight[i] += weight[i];
        }

        // Samples in [o, o + stride) get no further contributions (the next
        // segment starts at o + stride) — finalize into the queues,
        // discarding the pre-mix pad region.
        let next = o + stride;
        let flush_n = if next < self.len { stride } else { chunk_len };
        for sc in 0..NUM_SOURCES * 2 {
            let q = &mut self.queues[sc];
            for i in 0..flush_n {
                if o + i >= self.lead {
                    q.push_back(self.acc[sc][i] / self.sum_weight[i] * std + mean);
                }
            }
        }

        // Slide the window left by flush_n.
        for a in self.acc.iter_mut() {
            a.copy_within(flush_n.., 0);
            a[SEGMENT - flush_n..].fill(0.0);
        }
        self.sum_weight.copy_within(flush_n.., 0);
        self.sum_weight[SEGMENT - flush_n..].fill(0.0);

        self.seg_start = next;
        if next >= self.len {
            self.done = true;
        }
        Ok(infer_s)
    }
}

/// Run the full streamed separation over planar stereo `mix` (`2 * len`
/// samples), pushing finalized blocks into `sink` — along with the matching
/// original-mix range, so sinks can build complement outputs like
/// instrumental = mix − vocals — and reporting per-segment progress via
/// `on_segment(done, total)`.
pub fn separate_streamed(
    mix: &[f32],
    len: usize,
    model: &mut dyn SegmentInfer,
    sink: &mut dyn StemSink,
    opts: SeparateOptions,
    on_segment: &mut dyn FnMut(usize, usize),
) -> Result<SeparateStats> {
    assert!(len > 0 && mix.len() >= 2 * len, "planar stereo mix required");
    opts.validate()?;
    let stride = opts.stride();
    let (mean, std) = norm_stats(mix, len);
    let inv_std = 1.0 / std;
    let (mix_l, mix_r) = mix.split_at(len);
    let weight = blend_weights();

    let mut passes: Vec<ShiftPass> = opts
        .leads()
        .into_iter()
        .map(|lead| ShiftPass::new(lead, len))
        .collect();
    let n_passes = passes.len();
    let inv_n = 1.0 / n_passes as f32;
    let total = opts.total_segments(len);

    let mut input = Array3::<f32>::zeros((1, 2, SEGMENT));
    let mut flush: Vec<Vec<f32>> = (0..NUM_SOURCES * 2).map(|_| Vec::new()).collect();
    let mut infer_seconds = 0.0f64;
    let mut done = 0usize;
    let mut emit_pos = 0usize;

    while emit_pos < len {
        let mut advanced = false;
        for p in passes.iter_mut() {
            if !p.done {
                infer_seconds += p.advance(
                    mix_l, mix_r, mean, inv_std, std, &weight, stride, &mut input, model,
                )?;
                done += 1;
                on_segment(done, total);
                advanced = true;
            }
        }

        // Emit every sample all passes have finalized, averaged across passes.
        let ready = passes
            .iter()
            .map(|p| p.queues[0].len())
            .min()
            .unwrap_or(0);
        if ready > 0 {
            for f in flush.iter_mut() {
                f.clear();
                f.resize(ready, 0.0);
            }
            for p in passes.iter_mut() {
                for sc in 0..NUM_SOURCES * 2 {
                    let f = &mut flush[sc];
                    let q = &mut p.queues[sc];
                    for (i, v) in q.drain(..ready).enumerate() {
                        f[i] += v;
                    }
                }
            }
            if n_passes > 1 {
                for f in flush.iter_mut() {
                    for v in f.iter_mut() {
                        *v *= inv_n;
                    }
                }
            }
            sink.write(
                &flush,
                (
                    &mix_l[emit_pos..emit_pos + ready],
                    &mix_r[emit_pos..emit_pos + ready],
                ),
                ready,
            )?;
            emit_pos += ready;
        } else if !advanced {
            // All passes finished but samples are missing — an accounting bug,
            // not a user error; fail loudly rather than loop forever.
            return Err(Error::Inference(format!(
                "overlap-add stalled at {emit_pos}/{len} samples"
            )));
        }
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

    /// Deterministic mock: stem s = input scaled by (s+1)/4, plus a small
    /// nonlinearity (catches trim/blend bugs) and a segment-position-dependent
    /// term. The position term is what makes the mock sensitive to
    /// segmentation: a pointwise model is shift-equivariant (shift-averaging
    /// is a mathematical no-op for it), so without position dependence, shift
    /// plumbing errors could cancel out invisibly.
    struct MockModel;
    impl SegmentInfer for MockModel {
        fn infer(&mut self, input: &Array3<f32>) -> Result<Array4<f32>> {
            let mut out = Array4::<f32>::zeros((1, NUM_SOURCES, 2, SEGMENT));
            for s in 0..NUM_SOURCES {
                let k = (s as f32 + 1.0) / 4.0;
                for ch in 0..2 {
                    for i in 0..SEGMENT {
                        let x = input[[0, ch, i]];
                        let pos = (i & 1023) as f32 / 1024.0;
                        out[[0, s, ch, i]] = k * x + 0.001 * x * x + 0.0005 * x * pos;
                    }
                }
            }
            Ok(out)
        }
    }

    /// Whole-song-in-memory reference implementing demucs semantics directly:
    /// per shift pass, pad the normalized signal with `lead` zeros, run the
    /// naive split-OLA (the spike's algorithm verbatim), drop the pad, then
    /// average passes in the normalized domain and denormalize once.
    fn separate_naive(mix: &[f32], len: usize, opts: SeparateOptions) -> Vec<Vec<f32>> {
        let stride = opts.stride();
        let (mean, std) = norm_stats(mix, len);
        let leads = opts.leads();
        let mut avg: Vec<Vec<f32>> = (0..NUM_SOURCES * 2).map(|_| vec![0f32; len]).collect();
        let mut model = MockModel;
        for &lead in &leads {
            let plen = lead + len;
            // normalized, planar, zero-padded on the left
            let mut nsig = vec![0f32; 2 * plen];
            for ch in 0..2 {
                for i in 0..len {
                    nsig[ch * plen + lead + i] = (mix[ch * len + i] - mean) / std;
                }
            }
            let mut out: Vec<Vec<f32>> =
                (0..NUM_SOURCES * 2).map(|_| vec![0f32; plen]).collect();
            let mut sum_weight = vec![0f32; plen];
            let weight = blend_weights();
            let mut offset = 0usize;
            while offset < plen {
                let chunk_len = SEGMENT.min(plen - offset);
                let delta = SEGMENT - chunk_len;
                let start = offset as i64 - (delta / 2) as i64;
                let end = start + SEGMENT as i64;
                let c_start = start.max(0) as usize;
                let c_end = end.min(plen as i64) as usize;
                let pad_left = (c_start as i64 - start) as usize;
                let trim = delta / 2;

                let mut input = Array3::<f32>::zeros((1, 2, SEGMENT));
                for ch in 0..2 {
                    for i in c_start..c_end {
                        input[[0, ch, pad_left + (i - c_start)]] = nsig[ch * plen + i];
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
                offset += stride;
            }
            for sc in 0..NUM_SOURCES * 2 {
                for i in 0..len {
                    avg[sc][i] += out[sc][lead + i] / sum_weight[lead + i];
                }
            }
        }
        let inv_n = 1.0 / leads.len() as f32;
        for sc in 0..NUM_SOURCES * 2 {
            for i in 0..len {
                avg[sc][i] = avg[sc][i] * inv_n * std + mean;
            }
        }
        avg
    }

    struct VecSink {
        data: Vec<Vec<f32>>,
        /// Planar copy of the original mix, for verifying the mix blocks
        /// passed to `write`.
        mix_ref: Vec<f32>,
        len: usize,
    }
    impl StemSink for VecSink {
        fn write(&mut self, block: &[Vec<f32>], mix: (&[f32], &[f32]), n: usize) -> Result<()> {
            // The mix block must track the emit frontier exactly — verified
            // against the absolute position implied by prior writes.
            let pos = self.data[0].len();
            assert_eq!(&self.mix_ref[pos..pos + n], mix.0);
            assert_eq!(&self.mix_ref[self.len + pos..self.len + pos + n], mix.1);
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

    fn check(len: usize, opts: SeparateOptions) {
        let mix = test_mix(len);
        let expected = separate_naive(&mix, len, opts);
        let mut sink = VecSink {
            data: (0..NUM_SOURCES * 2).map(|_| Vec::new()).collect(),
            mix_ref: mix.clone(),
            len,
        };
        let mut model = MockModel;
        let mut last = (0, 0);
        let stats = separate_streamed(&mix, len, &mut model, &mut sink, opts, &mut |d, t| {
            last = (d, t)
        })
        .unwrap();
        assert_eq!(stats.segments, opts.total_segments(len));
        assert_eq!(last, (stats.segments, stats.segments));
        for sc in 0..NUM_SOURCES * 2 {
            assert_eq!(sink.data[sc].len(), len, "len mismatch stem-ch {sc}");
            for i in 0..len {
                let (a, b) = (expected[sc][i], sink.data[sc][i]);
                assert!(
                    (a - b).abs() <= 2e-6 * a.abs().max(1.0),
                    "stem-ch {sc} sample {i}: naive={a} streamed={b} (len={len}, {opts:?})"
                );
            }
        }
    }

    fn check_len(len: usize) {
        check(len, SeparateOptions::default());
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
    fn streamed_matches_naive_high_overlap() {
        check(
            900_000,
            SeparateOptions {
                overlap: 0.5,
                shifts: 0,
            },
        );
    }

    #[test]
    fn streamed_matches_naive_with_shifts() {
        check(
            900_000,
            SeparateOptions {
                overlap: 0.25,
                shifts: 2,
            },
        );
        // shifted pass over a song shorter than one segment
        check(
            100_000,
            SeparateOptions {
                overlap: 0.25,
                shifts: 1,
            },
        );
    }

    #[test]
    fn streamed_matches_naive_hq_combo() {
        check(
            2 * STRIDE + 12_345,
            SeparateOptions {
                overlap: 0.5,
                shifts: 2,
            },
        );
    }

    #[test]
    fn shift_average_differs_from_single_pass() {
        // Guards against shifts silently collapsing into one pass: the mock
        // model is nonlinear, so a genuine shifted average must differ.
        let len = 500_000;
        let mix = test_mix(len);
        let base = separate_naive(&mix, len, SeparateOptions::default());
        let shifted = separate_naive(
            &mix,
            len,
            SeparateOptions {
                overlap: 0.25,
                shifts: 2,
            },
        );
        let max_diff = (0..len)
            .map(|i| (base[0][i] - shifted[0][i]).abs())
            .fold(0.0f32, f32::max);
        assert!(max_diff > 1e-6, "shifted average identical to single pass");
    }

    #[test]
    fn pinned_shift_leads_are_deterministic_interior_offsets() {
        let one = SeparateOptions {
            overlap: 0.25,
            shifts: 1,
        };
        assert_eq!(one.leads(), vec![MAX_SHIFT - MAX_SHIFT / 2]); // 11025
        let two = SeparateOptions {
            overlap: 0.25,
            shifts: 2,
        };
        let leads = two.leads();
        assert_eq!(leads.len(), 2);
        for &l in &leads {
            assert!(l > 0 && l < MAX_SHIFT, "lead {l} not interior");
        }
        assert_ne!(leads[0], leads[1]);
        // Default: exactly one un-shifted pass.
        assert_eq!(SeparateOptions::default().leads(), vec![0]);
    }

    #[test]
    fn overlap_out_of_range_is_rejected() {
        let mix = test_mix(1000);
        let mut sink = VecSink {
            data: (0..NUM_SOURCES * 2).map(|_| Vec::new()).collect(),
            mix_ref: mix.clone(),
            len: 1000,
        };
        let mut model = MockModel;
        let bad = SeparateOptions {
            overlap: 0.99,
            shifts: 0,
        };
        assert!(
            separate_streamed(&mix, 1000, &mut model, &mut sink, bad, &mut |_, _| {}).is_err()
        );
    }

    #[test]
    fn stride_and_weights_match_demucs_constants() {
        assert_eq!(SEGMENT, 343_980);
        assert_eq!(STRIDE, 257_985); // int(0.75 * 343980)
        assert_eq!(SeparateOptions::default().stride(), STRIDE);
        assert_eq!(
            SeparateOptions {
                overlap: 0.5,
                shifts: 0
            }
            .stride(),
            171_990
        );
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
