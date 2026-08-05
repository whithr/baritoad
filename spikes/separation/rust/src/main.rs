//! Separation spike: run the htdemucs ONNX export from Rust via ONNX Runtime.
//!
//! Replicates demucs's apply_model(shifts=0, split=True, overlap=0.25):
//!   - outer normalization by mono-reference mean/std
//!   - 7.8 s segments, 25% overlap, triangular blending weights
//!   - last chunk padded with real left-context + zero right pad, center-trimmed
//!
//! Usage: separation-spike <model.onnx> <input.wav> <out_dir> [cpu|directml]

use ndarray::{Array3, ArrayViewD};
use std::path::Path;
use std::time::Instant;

const SEGMENT: usize = 343_980; // int(7.8 * 44100), fixed by the export
const SOURCES: [&str; 4] = ["drums", "bass", "other", "vocals"];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: {} <model.onnx> <input.wav> <out_dir> [cpu|directml]", args[0]);
        std::process::exit(2);
    }
    let (model_path, wav_path, out_dir) = (&args[1], &args[2], &args[3]);
    let ep = args.get(4).map(String::as_str).unwrap_or("cpu");

    // ---- load audio ----
    let t_load = Instant::now();
    let mut reader = hound::WavReader::open(wav_path).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 44_100, "expected 44.1 kHz input");
    assert_eq!(spec.channels, 2, "expected stereo input");
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().map(|s| s.unwrap() as f32 / max).collect()
        }
    };
    let len = samples.len() / 2;
    // deinterleave to (2, len)
    let mut mix = vec![0f32; 2 * len];
    for i in 0..len {
        mix[i] = samples[2 * i];
        mix[len + i] = samples[2 * i + 1];
    }
    println!("loaded {} samples/ch ({:.1}s) in {:.2?}", len, len as f32 / 44100.0, t_load.elapsed());

    // ---- outer normalization (demucs.api: mono ref mean/std) ----
    let mono_mean = (0..len).map(|i| (mix[i] + mix[len + i]) as f64 / 2.0).sum::<f64>() / len as f64;
    let var = (0..len)
        .map(|i| {
            let m = (mix[i] + mix[len + i]) as f64 / 2.0 - mono_mean;
            m * m
        })
        .sum::<f64>()
        / (len as f64 - 1.0); // torch.std uses Bessel correction
    let std = var.sqrt();
    let (mean_f, std_f) = (mono_mean as f32, std as f32);
    for v in mix.iter_mut() {
        *v = (*v - mean_f) / std_f;
    }

    // ---- ONNX session ----
    let t_sess = Instant::now();
    let mut builder = ort::session::Session::builder()
        .expect("session builder")
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
        .expect("opt level");
    if ep.starts_with("directml") {
        if ep != "directml-fused" {
            builder = builder
                .with_config_entry("ep.dml.disable_graph_fusion", "1")
                .expect("config entry");
        }
        builder = builder
            .with_execution_providers([ort::ep::DirectML::default().build().error_on_failure()])
            .expect("directml ep");
    }
    let mut session = builder.commit_from_file(model_path).expect("load model");
    println!("session ({ep}) ready in {:.2?}", t_sess.elapsed());

    // ---- segmented inference with triangular overlap-add ----
    let stride = (0.75 * SEGMENT as f64) as usize; // int((1-0.25)*segment)
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
        *w /= wmax; // transition_power = 1.0
    }

    let mut out = vec![0f32; 4 * 2 * len];
    let mut sum_weight = vec![0f32; len];
    let mut infer_total = std::time::Duration::ZERO;
    let mut n_segments = 0u32;
    let t_all = Instant::now();

    let mut offset = 0usize;
    while offset < len {
        let chunk_len = SEGMENT.min(len - offset);
        // TensorChunk::padded — pull real context on the left, zeros where the
        // song ends; delta//2 shift, then center_trim afterwards.
        let delta = SEGMENT - chunk_len;
        let start = offset as i64 - (delta / 2) as i64;
        let end = start + SEGMENT as i64;
        let c_start = start.max(0) as usize;
        let c_end = (end.min(len as i64)) as usize;
        let pad_left = (c_start as i64 - start) as usize;
        let trim = delta / 2; // center_trim removes (SEGMENT - chunk_len)/2 from left

        let mut input = Array3::<f32>::zeros((1, 2, SEGMENT));
        for ch in 0..2 {
            for i in c_start..c_end {
                input[[0, ch, pad_left + (i - c_start)]] = mix[ch * len + i];
            }
        }

        let t0 = Instant::now();
        let outputs = session
            .run(ort::inputs!["mix" => ort::value::TensorRef::from_array_view(&input).unwrap()])
            .expect("inference");
        let stems: ArrayViewD<f32> = outputs["stems"].try_extract_array::<f32>().expect("extract");
        infer_total += t0.elapsed();
        n_segments += 1;

        for s in 0..4 {
            for ch in 0..2 {
                let base = (s * 2 + ch) * len;
                for i in 0..chunk_len {
                    let w = weight[i];
                    out[base + offset + i] += w * stems[[0, s, ch, trim + i]];
                }
            }
        }
        for i in 0..chunk_len {
            sum_weight[offset + i] += weight[i];
        }
        offset += stride;
    }

    for s in 0..4 {
        for ch in 0..2 {
            let base = (s * 2 + ch) * len;
            for i in 0..len {
                out[base + i] = out[base + i] / sum_weight[i] * std_f + mean_f;
            }
        }
    }
    let wall = t_all.elapsed();
    println!(
        "separated {:.1}s audio: {} segments, inference {:.2?}, total {:.2?} ({ep})",
        len as f32 / 44100.0,
        n_segments,
        infer_total,
        wall
    );

    // ---- write stems ----
    std::fs::create_dir_all(out_dir).expect("mkdir");
    let wspec = hound::WavSpec {
        channels: 2,
        sample_rate: 44_100,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    for (s, name) in SOURCES.iter().enumerate() {
        let path = Path::new(out_dir).join(format!("{name}.wav"));
        let mut w = hound::WavWriter::create(&path, wspec).expect("wav create");
        for i in 0..len {
            w.write_sample(out[(s * 2) * len + i]).unwrap();
            w.write_sample(out[(s * 2 + 1) * len + i]).unwrap();
        }
        w.finalize().unwrap();
    }
    // instrumental = drums + bass + other (the karaoke output)
    let path = Path::new(out_dir).join("instrumental.wav");
    let mut w = hound::WavWriter::create(&path, wspec).expect("wav create");
    for i in 0..len {
        for ch in 0..2 {
            let v: f32 = (0..3).map(|s| out[(s * 2 + ch) * len + i]).sum();
            w.write_sample(v).unwrap();
        }
    }
    w.finalize().unwrap();
    println!("stems written to {out_dir}");
    println!(
        "TIMING ep={ep} audio_s={:.1} segments={} infer_s={:.2} wall_s={:.2}",
        len as f32 / 44100.0,
        n_segments,
        infer_total.as_secs_f64(),
        wall.as_secs_f64()
    );
}
