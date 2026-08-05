//! Render the quality matrix: for each test song, a 30 s excerpt processed at
//! each pitch/tempo setting, written as 16-bit wavs for human listening, plus
//! throughput numbers and basic signal sanity stats.

use std::path::Path;
use std::time::Instant;

use crate::decode;
use crate::engine::Feeder;
use crate::ffi::Stretch;

const BLOCK_FRAMES: usize = 512;
const EXCERPT_S: f64 = 30.0;
/// -6 dB pre-gain applied to BOTH the reference and the processed excerpt:
/// the stretcher's output can peak ~2x the input peak on loudness-maximized
/// mixes (measured), and clamping in the wav writer would add distortion not
/// attributable to the algorithm. Level-matched A/B is preserved.
const PRE_GAIN: f32 = 0.5;

struct Setting {
    name: &'static str,
    semitones: f32,
    rate: f64, // input frames per output frame; >1 = faster tempo
}

const SETTINGS: &[Setting] = &[
    Setting { name: "pitch_-6st", semitones: -6.0, rate: 1.0 },
    Setting { name: "pitch_-3st", semitones: -3.0, rate: 1.0 },
    Setting { name: "pitch_+3st", semitones: 3.0, rate: 1.0 },
    Setting { name: "pitch_+6st", semitones: 6.0, rate: 1.0 },
    Setting { name: "tempo_0.80x", semitones: 0.0, rate: 0.8 },
    Setting { name: "tempo_0.90x", semitones: 0.0, rate: 0.9 },
    Setting { name: "tempo_1.10x", semitones: 0.0, rate: 1.1 },
    Setting { name: "tempo_1.20x", semitones: 0.0, rate: 1.2 },
    Setting { name: "combo_+3st_0.90x", semitones: 3.0, rate: 0.9 },
    Setting { name: "combo_-3st_1.20x", semitones: -3.0, rate: 1.2 },
];

pub fn run(testdata: &Path, out_root: &Path) {
    let mut mp3s: Vec<_> = std::fs::read_dir(testdata)
        .expect("read testdata dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map_or(false, |e| e == "mp3"))
        .collect();
    mp3s.sort();
    assert!(!mp3s.is_empty(), "no mp3s in {}", testdata.display());

    println!(
        "song, setting, sr_hz, excerpt_s, wall_s, rtf(wall/input_dur), max_abs(after -6dB pregain), peak_gain_vs_input, clipped_samples, out_frames, expected_out_frames"
    );

    for path in &mp3s {
        let song_name = path.file_stem().unwrap().to_string_lossy().to_string();
        let song = match decode::decode(path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("DECODE FAILED {song_name}: {e}");
                continue;
            }
        };
        let sr = song.sample_rate;
        let total_frames = song.frames();

        // 30 s excerpt starting 40% in (usually verse->chorus territory).
        let start = (total_frames as f64 * 0.40) as usize;
        let ex_frames = ((EXCERPT_S * sr as f64) as usize).min(total_frames - start);
        let excerpt: Vec<f32> = song.samples[start * 2..(start + ex_frames) * 2]
            .iter()
            .map(|&v| v * PRE_GAIN)
            .collect();
        let excerpt = &excerpt[..];
        let excerpt_s = ex_frames as f64 / sr as f64;

        let song_dir = out_root.join(&song_name);
        std::fs::create_dir_all(&song_dir).unwrap();

        write_wav(&song_dir.join("reference.wav"), excerpt, sr);

        for s in SETTINGS {
            let mut stretch = Stretch::preset_default(2, sr);
            // Tonality limit per Signalsmith README recommendation (~8 kHz).
            stretch.set_transpose_semitones(s.semitones, 8000.0 / sr as f32);

            let mut feeder = Feeder::new(excerpt);
            let mut out: Vec<f32> = Vec::with_capacity((excerpt.len() as f64 / s.rate) as usize + 65536);
            let mut block = vec![0.0f32; BLOCK_FRAMES * 2];

            let t0 = Instant::now();
            while !feeder.done() {
                let input = feeder.take(BLOCK_FRAMES, s.rate);
                stretch.process(input, &mut block);
                out.extend_from_slice(&block);
            }
            let tail_frames = stretch.output_latency();
            let mut tail = vec![0.0f32; tail_frames * 2];
            stretch.flush(&mut tail);
            out.extend_from_slice(&tail);
            let wall = t0.elapsed().as_secs_f64();

            let max_abs = out.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
            let clipped = out.iter().filter(|v| v.abs() > 1.0).count();
            let gain_vs_input = max_abs / PRE_GAIN; // output peak relative to input peak scale
            let out_frames = out.len() / 2;
            let expected = (ex_frames as f64 / s.rate) as usize + tail_frames;

            write_wav(&song_dir.join(format!("{}.wav", s.name)), &out, sr);

            println!(
                "{song_name}, {}, {sr}, {excerpt_s:.1}, {wall:.3}, {:.4}, {max_abs:.3}, {gain_vs_input:.3}, {clipped}, {out_frames}, {expected}",
                s.name,
                wall / excerpt_s,
            );
        }

        // Low-latency config variants (40 ms block / 10 ms interval), for ear
        // comparison against the preset_default renders: is the latency win
        // worth the quality cost?
        for (name, semis) in [("lowlat40ms_pitch_+3st", 3.0f32), ("lowlat40ms_pitch_-6st", -6.0)] {
            let block_len = (sr as f64 * 0.040) as usize;
            let interval = (sr as f64 * 0.010) as usize;
            let mut stretch = Stretch::new(2, block_len, interval);
            stretch.set_transpose_semitones(semis, 8000.0 / sr as f32);
            let mut feeder = Feeder::new(excerpt);
            let mut out: Vec<f32> = Vec::with_capacity(excerpt.len() + 65536);
            let mut block = vec![0.0f32; BLOCK_FRAMES * 2];
            while !feeder.done() {
                let input = feeder.take(BLOCK_FRAMES, 1.0);
                stretch.process(input, &mut block);
                out.extend_from_slice(&block);
            }
            write_wav(&song_dir.join(format!("{name}.wav")), &out, sr);
        }

        // Full-song throughput at +3 st (no wav written; timing only).
        let mut stretch = Stretch::preset_default(2, sr);
        stretch.set_transpose_semitones(3.0, 8000.0 / sr as f32);
        let mut feeder = Feeder::new(&song.samples);
        let mut block = vec![0.0f32; BLOCK_FRAMES * 2];
        let t0 = Instant::now();
        let mut frames_out = 0usize;
        while !feeder.done() {
            let input = feeder.take(BLOCK_FRAMES, 1.0);
            stretch.process(input, &mut block);
            frames_out += BLOCK_FRAMES;
        }
        let wall = t0.elapsed().as_secs_f64();
        println!(
            "FULLSONG {song_name}: {:.1} s audio @ {sr} Hz, +3st in {wall:.2} s wall -> rtf {:.4} ({} blocks of {} frames)",
            song.duration_s(),
            wall / song.duration_s(),
            frames_out / BLOCK_FRAMES,
            BLOCK_FRAMES
        );
    }
}

fn write_wav(path: &Path, interleaved: &[f32], sr: u32) {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: sr,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).expect("create wav");
    for &v in interleaved {
        let s = (v.clamp(-1.0, 1.0) * 32767.0) as i16;
        w.write_sample(s).unwrap();
    }
    w.finalize().unwrap();
}
