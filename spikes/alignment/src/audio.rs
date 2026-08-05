//! mp3 decode (symphonia) -> mono f32 -> 16 kHz resample (rubato).

use anyhow::{anyhow, Context, Result};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Decode an audio file to mono f32 at its native sample rate.
pub fn decode_mono(path: &Path) -> Result<(Vec<f32>, u32)> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    )?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("no default track"))?;
    let track_id = track.id;
    let mut decoder =
        symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;

    let mut sample_rate = 0u32;
    let mut mono: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue, // skip bad frame
            Err(e) => return Err(e.into()),
        };
        sample_rate = decoded.spec().rate;
        append_mono(&decoded, &mut mono);
    }
    if mono.is_empty() {
        return Err(anyhow!("decoded zero samples"));
    }
    Ok((mono, sample_rate))
}

fn append_mono(buf: &AudioBufferRef, out: &mut Vec<f32>) {
    macro_rules! mix {
        ($b:expr, $conv:expr) => {{
            let b = $b;
            let ch = b.spec().channels.count();
            let n = b.frames();
            let inv = 1.0f32 / ch as f32;
            for i in 0..n {
                let mut acc = 0.0f32;
                for c in 0..ch {
                    acc += $conv(b.chan(c)[i]);
                }
                out.push(acc * inv);
            }
        }};
    }
    match buf {
        AudioBufferRef::F32(b) => mix!(b, |v: f32| v),
        AudioBufferRef::F64(b) => mix!(b, |v: f64| v as f32),
        AudioBufferRef::S16(b) => mix!(b, |v: i16| v as f32 / 32768.0),
        AudioBufferRef::S32(b) => mix!(b, |v: i32| v as f32 / 2147483648.0),
        AudioBufferRef::U8(b) => mix!(b, |v: u8| (v as f32 - 128.0) / 128.0),
        AudioBufferRef::S24(b) => mix!(b, |v: symphonia::core::sample::i24| v.inner() as f32
            / 8388608.0),
        _ => unimplemented!("unhandled sample format"),
    }
}

/// High-quality sinc resample to `to_rate`.
pub fn resample(input: &[f32], from_rate: u32, to_rate: u32) -> Result<Vec<f32>> {
    if from_rate == to_rate {
        return Ok(input.to_vec());
    }
    use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
    let params = SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Cubic,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };
    let chunk = 8192usize;
    let mut rs = SincFixedIn::<f32>::new(
        to_rate as f64 / from_rate as f64,
        1.1,
        params,
        chunk,
        1,
    )?;
    let mut out: Vec<f32> = Vec::with_capacity(input.len() * to_rate as usize / from_rate as usize + 16);
    let mut pos = 0usize;
    let mut inbuf = vec![vec![0.0f32; chunk]];
    while pos < input.len() {
        let n = (input.len() - pos).min(chunk);
        inbuf[0][..n].copy_from_slice(&input[pos..pos + n]);
        if n < chunk {
            // final partial chunk
            let waves = rs.process_partial(Some(&[&inbuf[0][..n]]), None)?;
            out.extend_from_slice(&waves[0]);
        } else {
            let waves = rs.process(&[&inbuf[0][..]], None)?;
            out.extend_from_slice(&waves[0]);
        }
        pos += n;
    }
    // flush tail
    let waves = rs.process_partial::<&[f32]>(None, None)?;
    out.extend_from_slice(&waves[0]);
    Ok(out)
}
