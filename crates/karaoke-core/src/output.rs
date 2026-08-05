//! Stem output sinks: streamed WAV (32-bit float) or FLAC.
//!
//! The separation stage pushes finalized blocks as they leave the streamed
//! overlap-add, so WAV output never holds a whole song in memory. FLAC
//! (`flacenc`, pure Rust) currently requires whole-signal encode, so the FLAC
//! sink buffers integer samples and encodes at finalize — still far smaller
//! than the spike's whole-song float accumulation.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::separation::{NUM_SOURCES, SAMPLE_RATE, SOURCES, VOCALS_INDEX};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Wav,
    Flac,
}

impl OutputFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            OutputFormat::Wav => "wav",
            OutputFormat::Flac => "flac",
        }
    }
}

/// Receives finalized (denormalized) stem samples in stream order.
/// `block[stem * 2 + ch][0..n]` — stems in [`SOURCES`] order.
pub trait StemSink {
    fn write(&mut self, block: &[Vec<f32>], n: usize) -> Result<()>;
    fn finalize(&mut self) -> Result<Vec<OutputFile>>;
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OutputFile {
    pub name: String,
    pub path: PathBuf,
}

enum Backend {
    Wav(hound::WavWriter<BufWriter<File>>),
    /// Interleaved 16-bit samples (stored as i32 for flacenc), encoded at finalize.
    Flac(Vec<i32>),
}

struct Output {
    name: String,
    path: PathBuf,
    /// Stem indices summed into this output (e.g. instrumental = drums+bass+other).
    stems: Vec<usize>,
    backend: Backend,
}

/// Writes `vocals` + `instrumental` (and optionally every raw stem) to files.
pub struct FileSink {
    outputs: Vec<Output>,
    finalized: bool,
}

impl FileSink {
    pub fn new(out_dir: &Path, format: OutputFormat, all_stems: bool) -> Result<Self> {
        std::fs::create_dir_all(out_dir)?;
        let mut plans: Vec<(String, Vec<usize>)> = vec![
            ("vocals".into(), vec![VOCALS_INDEX]),
            (
                "instrumental".into(),
                (0..NUM_SOURCES).filter(|&s| s != VOCALS_INDEX).collect(),
            ),
        ];
        if all_stems {
            for (s, name) in SOURCES.iter().enumerate() {
                if s != VOCALS_INDEX {
                    plans.push(((*name).into(), vec![s]));
                }
            }
        }
        let mut outputs = Vec::with_capacity(plans.len());
        for (name, stems) in plans {
            let path = out_dir.join(format!("{name}.{}", format.extension()));
            let backend = match format {
                OutputFormat::Wav => {
                    let spec = hound::WavSpec {
                        channels: 2,
                        sample_rate: SAMPLE_RATE,
                        bits_per_sample: 32,
                        sample_format: hound::SampleFormat::Float,
                    };
                    Backend::Wav(hound::WavWriter::create(&path, spec)?)
                }
                OutputFormat::Flac => Backend::Flac(Vec::new()),
            };
            outputs.push(Output {
                name,
                path,
                stems,
                backend,
            });
        }
        Ok(Self {
            outputs,
            finalized: false,
        })
    }
}

impl StemSink for FileSink {
    fn write(&mut self, block: &[Vec<f32>], n: usize) -> Result<()> {
        debug_assert_eq!(block.len(), NUM_SOURCES * 2);
        for out in &mut self.outputs {
            for i in 0..n {
                for ch in 0..2 {
                    let v: f32 = out.stems.iter().map(|&s| block[s * 2 + ch][i]).sum();
                    match &mut out.backend {
                        Backend::Wav(w) => w.write_sample(v)?,
                        Backend::Flac(buf) => {
                            buf.push((v.clamp(-1.0, 1.0) * 32767.0).round() as i32)
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn finalize(&mut self) -> Result<Vec<OutputFile>> {
        if self.finalized {
            return Err(Error::Encode("sink already finalized".into()));
        }
        self.finalized = true;
        let mut files = Vec::with_capacity(self.outputs.len());
        for out in self.outputs.drain(..) {
            match out.backend {
                Backend::Wav(w) => w.finalize()?,
                Backend::Flac(buf) => write_flac(&out.path, &buf)?,
            }
            files.push(OutputFile {
                name: out.name,
                path: out.path,
            });
        }
        Ok(files)
    }
}

/// Encode interleaved stereo 16-bit samples to a FLAC file.
fn write_flac(path: &Path, interleaved: &[i32]) -> Result<()> {
    use flacenc::bitsink::ByteSink;
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;

    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|(_, e)| Error::Encode(format!("flac config: {e}")))?;
    let source = flacenc::source::MemSource::from_samples(
        interleaved,
        2,
        16,
        SAMPLE_RATE as usize,
    );
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| Error::Encode(format!("flac encode: {e}")))?;
    let mut sink = ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|e| Error::Encode(format!("flac write: {e}")))?;
    std::fs::write(path, sink.as_slice())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a block in sink layout from per-stem-channel closures.
    fn block(n: usize, f: impl Fn(usize, usize) -> f32) -> Vec<Vec<f32>> {
        (0..NUM_SOURCES * 2)
            .map(|sc| (0..n).map(|i| f(sc, i)).collect())
            .collect()
    }

    #[test]
    fn wav_sink_writes_vocals_and_instrumental_sum() {
        let dir = std::env::temp_dir().join("karaoke-core-test-sink1");
        let _ = std::fs::remove_dir_all(&dir);
        let mut sink = FileSink::new(&dir, OutputFormat::Wav, false).unwrap();
        let n = 1000;
        // stem s, channel ch, sample i -> (s+1) * 0.01 (constant per stem)
        let b = block(n, |sc, _i| ((sc / 2) as f32 + 1.0) * 0.01);
        sink.write(&b, n).unwrap();
        let files = sink.finalize().unwrap();
        assert_eq!(files.len(), 2);

        let mut r = hound::WavReader::open(dir.join("vocals.wav")).unwrap();
        let v: Vec<f32> = r.samples::<f32>().map(|s| s.unwrap()).collect();
        assert_eq!(v.len(), 2 * n);
        assert!((v[0] - 0.04).abs() < 1e-6); // vocals = stem 3 -> 0.04

        let mut r = hound::WavReader::open(dir.join("instrumental.wav")).unwrap();
        let v: Vec<f32> = r.samples::<f32>().map(|s| s.unwrap()).collect();
        assert!((v[0] - 0.06).abs() < 1e-6); // 0.01+0.02+0.03
    }

    #[test]
    fn flac_roundtrips_through_symphonia() {
        let dir = std::env::temp_dir().join("karaoke-core-test-sink2");
        let _ = std::fs::remove_dir_all(&dir);
        let mut sink = FileSink::new(&dir, OutputFormat::Flac, false).unwrap();
        let n = 8192;
        let b = block(n, |sc, i| {
            0.3 * ((sc + 1) as f32 * 0.001 * i as f32).sin()
        });
        sink.write(&b, n).unwrap();
        sink.finalize().unwrap();

        let d = crate::audio::decode_to_stereo_44k(&dir.join("vocals.flac")).unwrap();
        assert_eq!(d.len, n);
        // Expected: quantized stem-3 signal
        let max_err = (0..n)
            .map(|i| (d.samples[i] - b[6][i]).abs())
            .fold(0.0f32, f32::max);
        assert!(max_err < 1.0 / 32000.0, "max_err={max_err}");
    }
}
