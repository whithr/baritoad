//! Audio input: decode any user-owned file (mp3/flac/wav/aiff/m4a incl.
//! Apple Lossless/ogg, and the audio track of an mp4/mov/mkv video) to planar
//! stereo f32 at the pipeline sample rate via Symphonia, resampling with
//! rubato when needed.
//!
//! This replaces the spike's ffmpeg/libsndfile prep scripts — production input
//! is the user's file directly. Video files need no ffmpeg either: Symphonia
//! demuxes their audio track. ffmpeg remains subprocess-only and is reserved
//! for video export (v1.x); it is not used here.

use std::path::Path;

use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymErr;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::error::{Error, Result};

/// Pipeline sample rate — fixed by the htdemucs export (44.1 kHz).
pub const TARGET_SAMPLE_RATE: u32 = 44_100;

/// Decoded, normalized-format audio: planar stereo f32 at 44.1 kHz.
pub struct DecodedAudio {
    /// Planar: `[left 0..len, right 0..len]` — `2 * len` samples total.
    pub samples: Vec<f32>,
    /// Samples per channel.
    pub len: usize,
    pub source_sample_rate: u32,
    pub source_channels: usize,
    /// Human-readable notes about conversions applied (mono upmix, resample,
    /// dropped channels, skipped corrupt packets).
    pub notes: Vec<String>,
}

impl DecodedAudio {
    pub fn duration_seconds(&self) -> f64 {
        self.len as f64 / TARGET_SAMPLE_RATE as f64
    }
}

/// Can this file's audio be read? Probes the container, picks the audio
/// track (a video file's picture track is skipped — Symphonia doesn't know
/// video codecs), builds its decoder and decodes the first packet that
/// isn't corrupt. A few milliseconds, so an import can refuse a file up
/// front instead of failing at the separation stage.
pub fn check_decodable(path: &Path) -> Result<()> {
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| Error::Decode(format!("unrecognized audio format: {e}")))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| Error::Decode("no audio track found".into()))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| Error::Decode(format!("unsupported codec: {e}")))?;
    for _ in 0..256 {
        let packet = format
            .next_packet()
            .map_err(|e| Error::Decode(format!("no audio could be read: {e}")))?;
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(_) => return Ok(()),
            Err(SymErr::DecodeError(_)) => continue,
            Err(e) => return Err(Error::Decode(e.to_string())),
        }
    }
    Err(Error::Decode("no audio could be read from the start of the file".into()))
}

/// Decode `path` to planar stereo f32 at [`TARGET_SAMPLE_RATE`].
///
/// - mono input is duplicated to both channels
/// - >2 channels: the first two are kept (noted)
/// - non-44.1 kHz input is resampled (windowed-sinc, rubato)
/// - gapless trimming enabled so mp3 encoder delay/padding is removed
pub fn decode_to_stereo_44k(path: &Path) -> Result<DecodedAudio> {
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let fmt_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &MetadataOptions::default())
        .map_err(|e| Error::Decode(format!("unrecognized audio format: {e}")))?;
    let mut format = probed.format;

    let track = format
        .default_track()
        .filter(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| Error::Decode("no audio track found".into()))?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| Error::Decode(format!("unsupported codec: {e}")))?;

    let mut notes: Vec<String> = Vec::new();
    let mut src_rate: Option<u32> = codec_params.sample_rate;
    let mut src_channels: Option<usize> = codec_params.channels.map(|c| c.count());
    let mut left: Vec<f32> = Vec::new();
    let mut right: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut skipped_packets = 0usize;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymErr::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymErr::ResetRequired) => break,
            Err(e) => return Err(Error::Decode(e.to_string())),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let (rate, ch) =
                    append_decoded_planar(decoded, &mut sample_buf, &mut left, &mut right);
                src_rate.get_or_insert(rate);
                src_channels.get_or_insert(ch);
            }
            // A corrupt packet is recoverable — skip it, keep decoding.
            Err(SymErr::DecodeError(_)) => skipped_packets += 1,
            Err(e) => return Err(Error::Decode(e.to_string())),
        }
    }

    if left.is_empty() {
        return Err(Error::Decode("no audio samples decoded".into()));
    }
    if skipped_packets > 0 {
        notes.push(format!("skipped {skipped_packets} corrupt packet(s)"));
    }
    let source_channels = src_channels.unwrap_or(2);
    if source_channels == 1 {
        notes.push("mono input duplicated to stereo".into());
    } else if source_channels > 2 {
        notes.push(format!(
            "{source_channels}-channel input: kept first two channels"
        ));
    }
    let source_sample_rate =
        src_rate.ok_or_else(|| Error::Decode("source sample rate unknown".into()))?;

    if source_sample_rate != TARGET_SAMPLE_RATE {
        notes.push(format!(
            "resampled {source_sample_rate} Hz -> {TARGET_SAMPLE_RATE} Hz"
        ));
        let (l, r) = resample_stereo(&left, &right, source_sample_rate, TARGET_SAMPLE_RATE)?;
        left = l;
        right = r;
    }

    let len = left.len().min(right.len());
    let mut samples = Vec::with_capacity(2 * len);
    samples.extend_from_slice(&left[..len]);
    samples.extend_from_slice(&right[..len]);
    Ok(DecodedAudio {
        samples,
        len,
        source_sample_rate,
        source_channels,
        notes,
    })
}

/// Copy one decoded packet into planar stereo (`left`/`right`), applying the
/// same channel normalization as [`decode_to_stereo_44k`]: mono duplicated,
/// >2 channels keep the first two. Returns `(sample_rate, channels)` of the
/// packet. Shared by the full decode and the streaming source.
fn append_decoded_planar(
    decoded: AudioBufferRef<'_>,
    sample_buf: &mut Option<SampleBuffer<f32>>,
    left: &mut Vec<f32>,
    right: &mut Vec<f32>,
) -> (u32, usize) {
    let spec = *decoded.spec();
    let ch = spec.channels.count();
    let needed = decoded.capacity() * ch;
    if sample_buf
        .as_ref()
        .map(|b| b.capacity() < needed)
        .unwrap_or(true)
    {
        *sample_buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
    }
    let buf = sample_buf.as_mut().unwrap();
    buf.copy_interleaved_ref(decoded);
    let samples = buf.samples();
    match ch {
        0 => {}
        1 => {
            left.extend_from_slice(samples);
            right.extend_from_slice(samples);
        }
        _ => {
            for frame in samples.chunks_exact(ch) {
                left.push(frame[0]);
                right.push(frame[1]);
            }
        }
    }
    (spec.rate, ch)
}

/// Chunk-decodable source for the player's streaming (progressive) load path.
///
/// Only sources whose header promises both the frame count *and* the pipeline
/// sample rate (44.1 kHz) are eligible — that is every stem our separation
/// stage writes (WAV). Everything else (VBR MP3 without `n_frames`, foreign
/// sample rates) takes the full-decode fallback, so no output-length
/// guessing ever happens: the player preallocates exactly
/// `expected_device_frames(frames, 44_100, device_rate)` and the
/// `device frame / device rate == original-song time` invariant holds.
pub struct StreamingSource {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    sample_buf: Option<SampleBuffer<f32>>,
    /// Source frames per channel promised by the header (exact for WAV).
    pub frames: u64,
    /// Corrupt packets skipped so far (same recovery as the full decode).
    pub skipped_packets: usize,
    done: bool,
}

/// Open `path` for chunked decoding if it is eligible for the streaming load
/// path (header-known frame count at 44.1 kHz — see [`StreamingSource`]).
/// `Ok(None)` means "not eligible, use [`decode_to_stereo_44k`]"; `Err` means
/// the file cannot be decoded at all.
pub fn open_streaming_44k(path: &Path) -> Result<Option<StreamingSource>> {
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let fmt_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &MetadataOptions::default())
        .map_err(|e| Error::Decode(format!("unrecognized audio format: {e}")))?;
    let format = probed.format;

    let track = format
        .default_track()
        .filter(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| Error::Decode("no audio track found".into()))?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let (frames, rate) = match (codec_params.n_frames, codec_params.sample_rate) {
        (Some(n), Some(r)) => (n, r),
        _ => return Ok(None), // length or rate unknown up front: full decode
    };
    if rate != TARGET_SAMPLE_RATE || frames == 0 {
        return Ok(None);
    }

    let decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| Error::Decode(format!("unsupported codec: {e}")))?;

    Ok(Some(StreamingSource {
        format,
        decoder,
        track_id,
        sample_buf: None,
        frames,
        skipped_packets: 0,
        done: false,
    }))
}

impl StreamingSource {
    /// Decode the next packet and append it as planar stereo to `l`/`r`.
    /// Returns `false` at end of stream. Corrupt packets are skipped (counted
    /// in [`Self::skipped_packets`]), matching the full-decode behavior.
    pub fn next_packet_into(&mut self, l: &mut Vec<f32>, r: &mut Vec<f32>) -> Result<bool> {
        if self.done {
            return Ok(false);
        }
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymErr::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    self.done = true;
                    return Ok(false);
                }
                Err(SymErr::ResetRequired) => {
                    self.done = true;
                    return Ok(false);
                }
                Err(e) => return Err(Error::Decode(e.to_string())),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            match self.decoder.decode(&packet) {
                Ok(decoded) => {
                    append_decoded_planar(decoded, &mut self.sample_buf, l, r);
                    return Ok(true);
                }
                Err(SymErr::DecodeError(_)) => self.skipped_packets += 1,
                Err(e) => return Err(Error::Decode(e.to_string())),
            }
        }
    }
}

/// Alignment-stage sample rate (whisper + wav2vec2 consume 16 kHz mono).
pub const ALIGN_SAMPLE_RATE: u32 = 16_000;

/// Mono 16 kHz audio for the alignment stage, on the original-song timeline.
pub struct MonoAudio {
    pub samples: Vec<f32>,
    /// Duration in original-song seconds (from the 44.1 kHz decode, so the
    /// timeline matches the separation stage exactly).
    pub duration_s: f64,
    pub notes: Vec<String>,
}

/// Decode `path` (typically the separation stage's vocals stem) to mono
/// f32 at [`ALIGN_SAMPLE_RATE`]. Goes through the normalized 44.1 kHz stereo
/// decode so every input format lands on the same timeline, then downmixes
/// and resamples.
pub fn decode_to_mono_16k(path: &Path) -> Result<MonoAudio> {
    let decoded = decode_to_stereo_44k(path)?;
    Ok(downmix_to_mono_16k(&decoded)?)
}

/// Downmix planar stereo 44.1 kHz to mono and resample to
/// [`ALIGN_SAMPLE_RATE`], preserving the timeline (expected-length trim, same
/// as the decode path).
pub fn downmix_to_mono_16k(decoded: &DecodedAudio) -> Result<MonoAudio> {
    let n = decoded.len;
    let mono: Vec<f32> = (0..n)
        .map(|i| 0.5 * (decoded.samples[i] + decoded.samples[n + i]))
        .collect();
    let expected = ((n as u128 * ALIGN_SAMPLE_RATE as u128
        + (TARGET_SAMPLE_RATE as u128) / 2)
        / TARGET_SAMPLE_RATE as u128) as usize;
    let out = resample_channel(&mono, TARGET_SAMPLE_RATE, ALIGN_SAMPLE_RATE, expected)?;
    Ok(MonoAudio {
        samples: out,
        duration_s: n as f64 / TARGET_SAMPLE_RATE as f64,
        notes: decoded.notes.clone(),
    })
}

/// Windowed-sinc resample of one channel from `from` to `to` Hz, trimmed /
/// zero-padded to `expected` samples so the output timeline matches the input.
fn resample_channel(input: &[f32], from: u32, to: u32, expected: usize) -> Result<Vec<f32>> {
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
        WindowFunction,
    };
    if from == to {
        let mut out = input.to_vec();
        out.resize(expected, 0.0);
        return Ok(out);
    }
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let chunk = 1024usize;
    let mut rs = SincFixedIn::<f32>::new(to as f64 / from as f64, 1.1, params, chunk, 1)
        .map_err(|e| Error::Decode(format!("resampler init: {e}")))?;
    let map_err = |e: rubato::ResampleError| Error::Decode(format!("resample: {e}"));
    let mut out: Vec<f32> = Vec::with_capacity(expected + chunk);
    let mut pos = 0usize;
    while pos < input.len() {
        let need = rs.input_frames_next();
        let res = if pos + need <= input.len() {
            let r = rs.process(&[&input[pos..pos + need]], None).map_err(map_err)?;
            pos += need;
            r
        } else {
            let r = rs
                .process_partial(Some(&[&input[pos..]]), None)
                .map_err(map_err)?;
            pos = input.len();
            r
        };
        out.extend_from_slice(&res[0]);
    }
    while out.len() < expected {
        let none: Option<&[&[f32]]> = None;
        let res = rs.process_partial(none, None).map_err(map_err)?;
        if res[0].is_empty() {
            break;
        }
        out.extend_from_slice(&res[0]);
    }
    out.truncate(expected);
    out.resize(expected, 0.0);
    Ok(out)
}

/// Windowed-sinc resample of planar stereo from `from` Hz to `to` Hz.
/// Trims / zero-pads to the duration-preserving expected length so the output
/// timeline still matches the original song (timing maps store
/// original-song time). Used by decode (→ [`TARGET_SAMPLE_RATE`]) and by the
/// player to bring stems to the audio device rate.
pub(crate) fn resample_stereo(
    left: &[f32],
    right: &[f32],
    from: u32,
    to: u32,
) -> Result<(Vec<f32>, Vec<f32>)> {
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
        WindowFunction,
    };

    let len = left.len().min(right.len());
    if from == to {
        return Ok((left[..len].to_vec(), right[..len].to_vec()));
    }
    let ratio = to as f64 / from as f64;
    let expected =
        ((len as u128 * to as u128 + (from as u128) / 2) / from as u128) as usize;

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let chunk = 1024usize;
    let mut rs = SincFixedIn::<f32>::new(ratio, 1.1, params, chunk, 2)
        .map_err(|e| Error::Decode(format!("resampler init: {e}")))?;
    // Note: rubato 0.16's SincFixedIn output is already time-aligned in this
    // concatenate-all-chunks usage — impulse tests at 48k/32k/96k -> 44.1k all
    // measured 0 samples of lag, so `output_delay()` must NOT be skipped here.

    let map_err = |e: rubato::ResampleError| Error::Decode(format!("resample: {e}"));
    let mut out_l: Vec<f32> = Vec::with_capacity(expected + chunk);
    let mut out_r: Vec<f32> = Vec::with_capacity(expected + chunk);
    let mut pos = 0usize;
    while pos < len {
        let need = rs.input_frames_next();
        let res = if pos + need <= len {
            let bufs = [&left[pos..pos + need], &right[pos..pos + need]];
            let r = rs.process(&bufs, None).map_err(map_err)?;
            pos += need;
            r
        } else {
            let bufs = [&left[pos..len], &right[pos..len]];
            let r = rs.process_partial(Some(&bufs), None).map_err(map_err)?;
            pos = len;
            r
        };
        out_l.extend_from_slice(&res[0]);
        out_r.extend_from_slice(&res[1]);
    }
    // Drain internal state until the expected length is covered.
    while out_l.len() < expected {
        let none: Option<&[&[f32]]> = None;
        let res = rs.process_partial(none, None).map_err(map_err)?;
        if res[0].is_empty() {
            break;
        }
        out_l.extend_from_slice(&res[0]);
        out_r.extend_from_slice(&res[1]);
    }

    let take = |v: &mut Vec<f32>| -> Vec<f32> {
        v.truncate(expected);
        v.resize(expected, 0.0); // zero-pad if drain came up short
        std::mem::take(v)
    };
    Ok((take(&mut out_l), take(&mut out_r)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_wav(path: &Path, rate: u32, channels: u16, frames: &[Vec<f32>]) {
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        let n = frames[0].len();
        for i in 0..n {
            for c in frames.iter() {
                w.write_sample((c[i].clamp(-1.0, 1.0) * 32767.0).round() as i16)
                    .unwrap();
            }
        }
        w.finalize().unwrap();
    }

    fn sine(rate: u32, hz: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn decodes_stereo_44k_wav_unchanged() {
        let dir = std::env::temp_dir().join("karaoke-core-test-dec1");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.wav");
        let n = 44_100; // 1 s
        let l = sine(44_100, 440.0, n, 0.5);
        let r = sine(44_100, 220.0, n, 0.25);
        write_wav(&path, 44_100, 2, &[l.clone(), r.clone()]);

        let d = decode_to_stereo_44k(&path).unwrap();
        assert_eq!(d.len, n);
        assert_eq!(d.source_sample_rate, 44_100);
        assert_eq!(d.source_channels, 2);
        // 16-bit quantization is the only expected error
        let max_err = (0..n)
            .map(|i| (d.samples[i] - l[i]).abs().max((d.samples[n + i] - r[i]).abs()))
            .fold(0.0f32, f32::max);
        assert!(max_err < 1.0 / 32000.0, "max_err={max_err}");
    }

    #[test]
    fn mono_is_duplicated() {
        let dir = std::env::temp_dir().join("karaoke-core-test-dec2");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mono.wav");
        let n = 4410;
        let m = sine(44_100, 440.0, n, 0.5);
        write_wav(&path, 44_100, 1, &[m]);

        let d = decode_to_stereo_44k(&path).unwrap();
        assert_eq!(d.len, n);
        assert_eq!(d.source_channels, 1);
        for i in 0..n {
            assert_eq!(d.samples[i], d.samples[n + i]);
        }
    }

    #[test]
    fn mono_16k_downmix_preserves_duration_and_signal() {
        let dir = std::env::temp_dir().join("karaoke-core-test-dec4");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("m16.wav");
        let n = 44_100 * 2; // 2 s
        let l = sine(44_100, 440.0, n, 0.5);
        let r = sine(44_100, 440.0, n, 0.5);
        write_wav(&path, 44_100, 2, &[l, r]);

        let m = decode_to_mono_16k(&path).unwrap();
        assert_eq!(m.samples.len(), 32_000, "2 s must stay 2 s at 16 kHz");
        assert!((m.duration_s - 2.0).abs() < 1e-9);
        // Quadrature estimate of the 440 Hz component mid-file. The resampler
        // has a measured constant ~40 us sub-sample offset (harmless: CTC
        // frames are 20 ms), so the test checks amplitude, bounded offset,
        // and out-of-band residual instead of phase-sensitive sample SNR.
        let (a, b) = (4000usize, m.samples.len() - 4000);
        let (mut ss, mut sc) = (0.0f64, 0.0f64);
        for i in a..b {
            let ph = 2.0 * std::f64::consts::PI * 440.0 * i as f64 / 16_000.0;
            ss += m.samples[i] as f64 * ph.sin();
            sc += m.samples[i] as f64 * ph.cos();
        }
        let nspan = (b - a) as f64;
        let amp = 2.0 * (ss * ss + sc * sc).sqrt() / nspan;
        let phase = sc.atan2(ss);
        let dt_s = phase / (2.0 * std::f64::consts::PI * 440.0);
        assert!((amp - 0.5).abs() < 0.005, "amplitude {amp:.4}, expected 0.5");
        assert!(dt_s.abs() < 0.5e-3, "time offset {:.1} us too large", dt_s * 1e6);
        // residual after removing the best-fit 440 Hz sinusoid = distortion
        let (amp_s, amp_c) = (2.0 * ss / nspan, 2.0 * sc / nspan);
        let mut resid = 0.0f64;
        let mut sig = 0.0f64;
        for i in a..b {
            let ph = 2.0 * std::f64::consts::PI * 440.0 * i as f64 / 16_000.0;
            let fit = amp_s * ph.sin() + amp_c * ph.cos();
            sig += fit * fit;
            resid += (m.samples[i] as f64 - fit).powi(2);
        }
        let snr = 10.0 * (sig / resid.max(1e-30)).log10();
        assert!(snr > 40.0, "distortion too high: {snr:.1} dB");
    }

    #[test]
    fn resamples_48k_to_44k() {
        let dir = std::env::temp_dir().join("karaoke-core-test-dec3");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hz48.wav");
        let n = 48_000; // 1 s at 48 kHz
        let l = sine(48_000, 440.0, n, 0.5);
        let r = sine(48_000, 220.0, n, 0.5);
        write_wav(&path, 48_000, 2, &[l, r]);

        let d = decode_to_stereo_44k(&path).unwrap();
        assert_eq!(d.source_sample_rate, 48_000);
        assert_eq!(d.len, 44_100, "1 s in must be 1 s out");
        // Compare mid-file against an ideal 44.1 kHz sine (skip edges).
        let ideal = sine(44_100, 440.0, d.len, 0.5);
        let (a, b) = (2000usize, d.len - 2000);
        let mut num = 0.0f64;
        let mut den = 0.0f64;
        for i in a..b {
            num += (ideal[i] as f64).powi(2);
            den += ((d.samples[i] - ideal[i]) as f64).powi(2);
        }
        let snr = 10.0 * (num / den.max(1e-30)).log10();
        assert!(snr > 40.0, "resample SNR too low: {snr:.1} dB");
    }
}
