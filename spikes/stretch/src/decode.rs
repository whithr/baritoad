//! Minimal mp3 decode via symphonia -> interleaved stereo f32.

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub struct DecodedSong {
    /// Interleaved stereo (always 2ch; mono is duplicated).
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

impl DecodedSong {
    pub fn frames(&self) -> usize {
        self.samples.len() / 2
    }
    pub fn duration_s(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }
}

pub fn decode(path: &Path) -> Result<DecodedSong, String> {
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("probe: {e}"))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no audio track")?;
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder: {e}"))?;

    let mut sample_rate = 0u32;
    let mut channels = 0usize;
    let mut interleaved: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break, // EOF or fatal; either way stop
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                sample_rate = spec.rate;
                channels = spec.channels.count();
                let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                buf.copy_interleaved_ref(decoded);
                interleaved.extend_from_slice(buf.samples());
            }
            Err(_) => continue, // skip bad packet
        }
    }

    if sample_rate == 0 || interleaved.is_empty() {
        return Err("no samples decoded".into());
    }

    let samples = match channels {
        1 => interleaved.iter().flat_map(|&s| [s, s]).collect(),
        2 => interleaved,
        n => {
            // downmix first two channels
            interleaved
                .chunks(n)
                .flat_map(|c| [c[0], c[1]])
                .collect()
        }
    };

    Ok(DecodedSong { samples, sample_rate })
}
