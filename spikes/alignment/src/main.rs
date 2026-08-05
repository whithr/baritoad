//! Phase 0 alignment spike: whisper-small (rough transcript) + wav2vec2-base
//! CTC forced alignment (Rust trellis) via ONNX Runtime. No Python at runtime.
//!
//! Usage: alignment-spike <song.mp3> --weights <dir> --outdir <dir> [--int8] [--dump-debug]

mod audio;
mod ctc;
mod mel;
mod w2v;
mod whisper;

use anyhow::{Context, Result};
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Serialize)]
struct WordTiming {
    word: String,
    start: f64,
    end: f64,
    score: f32,
}

#[derive(Serialize)]
struct Report {
    song: String,
    audio_duration_s: f64,
    sample_rate_in: u32,
    stage_decode_resample_s: f64,
    stage_whisper_s: f64,
    stage_w2v_inference_s: f64,
    stage_trellis_s: f64,
    total_alignment_stage_s: f64, // whisper + w2v + trellis (the PLAN §5 "alignment stage")
    realtime_factor: f64,
    transcript: String,
    n_words: usize,
    n_frames: usize,
    words: Vec<WordTiming>,
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let mut audio_path: Option<PathBuf> = None;
    let mut weights = PathBuf::from("weights");
    let mut outdir = PathBuf::from("out");
    let mut int8 = false;
    let mut dump_debug = false;
    let mut dml = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--weights" => { weights = PathBuf::from(&args[i + 1]); i += 2; }
            "--outdir" => { outdir = PathBuf::from(&args[i + 1]); i += 2; }
            "--int8" => { int8 = true; i += 1; }
            "--dump-debug" => { dump_debug = true; i += 1; }
            "--dml" => { dml = true; i += 1; }
            p => { audio_path = Some(PathBuf::from(p)); i += 1; }
        }
    }
    let audio_path = audio_path.context("usage: alignment-spike <song> [--weights d] [--outdir d] [--int8] [--dump-debug]")?;
    std::fs::create_dir_all(&outdir)?;
    let song = audio_path.file_stem().unwrap().to_string_lossy().to_string();
    let threads = std::thread::available_parallelism()?.get();

    eprintln!("[{song}] decode + resample...");
    let t0 = Instant::now();
    let (mono, sr_in) = audio::decode_mono(&audio_path)?;
    let audio16k = audio::resample(&mono, sr_in, 16000)?;
    let t_decode = t0.elapsed().as_secs_f64();
    let duration = audio16k.len() as f64 / 16000.0;
    eprintln!("[{song}] {duration:.1}s audio @ {sr_in} Hz in, decoded in {t_decode:.2}s");

    // Stage 1: whisper-small rough transcript
    eprintln!("[{song}] whisper-small transcribe (int8={int8})...");
    let t_load0 = Instant::now();
    let mut wh = whisper::Whisper::load(&weights.join("whisper-small"), int8, threads, dml)?;
    eprintln!("[{song}] whisper load: {:.1}s", t_load0.elapsed().as_secs_f64());
    let t1 = Instant::now();
    let (raw_text, first_mel) = wh.transcribe(&audio16k)?;
    drop(wh);
    let t_whisper = t1.elapsed().as_secs_f64();
    eprintln!("[{song}] whisper done in {t_whisper:.1}s: {} chars", raw_text.len());

    // Normalize transcript to wav2vec2 charset
    let words: Vec<String> = raw_text
        .split_whitespace()
        .map(|w| {
            w.chars()
                .filter(|c| c.is_ascii_alphabetic() || *c == '\'')
                .collect::<String>()
                .to_uppercase()
        })
        .filter(|w| !w.is_empty())
        .collect();

    // Stage 2: wav2vec2 emissions + CTC trellis
    eprintln!("[{song}] wav2vec2 emissions...");
    let t_load1 = Instant::now();
    let mut w2 = w2v::W2v::load(&weights.join("wav2vec2"), threads, dml)?;
    eprintln!("[{song}] w2v load: {:.1}s", t_load1.elapsed().as_secs_f64());
    let t2 = Instant::now();
    let em = w2.emissions(&audio16k)?;
    let t_w2v = t2.elapsed().as_secs_f64();
    eprintln!("[{song}] {} frames x {} vocab in {t_w2v:.1}s", em.n_frames, em.n_vocab);

    let (targets, ranges) = w2v::transcript_to_targets(&words, &w2.vocab, w2.word_delim);
    let t3 = Instant::now();
    let spans = ctc::forced_align(&em.logprobs, em.n_frames, em.n_vocab, &targets, w2.blank)?;
    let t_trellis = t3.elapsed().as_secs_f64();
    eprintln!("[{song}] trellis: {} spans in {t_trellis:.3}s", spans.len());

    // token spans -> word timings
    let mut word_timings: Vec<WordTiming> = Vec::with_capacity(words.len());
    // spans are ordered by token_index; index them
    let mut span_by_token: Vec<Option<&ctc::TokenSpan>> = vec![None; targets.len()];
    for s in &spans {
        span_by_token[s.token_index] = Some(s);
    }
    for (wi, (s_idx, e_idx)) in ranges.iter().enumerate() {
        let mut start_f: Option<usize> = None;
        let mut end_f: Option<usize> = None;
        let mut score_acc = 0.0f32;
        let mut score_n = 0u32;
        for ti in *s_idx..*e_idx {
            if let Some(sp) = span_by_token[ti] {
                if start_f.is_none() {
                    start_f = Some(sp.start_frame);
                }
                end_f = Some(sp.end_frame);
                score_acc += sp.score;
                score_n += 1;
            }
        }
        if let (Some(sf), Some(ef)) = (start_f, end_f) {
            word_timings.push(WordTiming {
                word: words[wi].clone(),
                start: sf as f64 * w2v::FRAME_SEC,
                end: ef as f64 * w2v::FRAME_SEC,
                score: if score_n > 0 { score_acc / score_n as f32 } else { 0.0 },
            });
        }
    }

    if dump_debug {
        // raw emissions + targets + first mel chunk for Python cross-validation
        let mut f = std::fs::File::create(outdir.join(format!("{song}.emissions.bin")))?;
        f.write_all(&(em.n_frames as u64).to_le_bytes())?;
        f.write_all(&(em.n_vocab as u64).to_le_bytes())?;
        let bytes: Vec<u8> = em.logprobs.iter().flat_map(|v| v.to_le_bytes()).collect();
        f.write_all(&bytes)?;
        let mut f = std::fs::File::create(outdir.join(format!("{song}.targets.json")))?;
        f.write_all(serde_json::to_string(&targets)?.as_bytes())?;
        let mut f = std::fs::File::create(outdir.join(format!("{song}.audio16k.bin")))?;
        let bytes: Vec<u8> = audio16k.iter().flat_map(|v| v.to_le_bytes()).collect();
        f.write_all(&bytes)?;
        let mut f = std::fs::File::create(outdir.join(format!("{song}.mel0.bin")))?;
        let bytes: Vec<u8> = first_mel.iter().flat_map(|v| v.to_le_bytes()).collect();
        f.write_all(&bytes)?;
        // token spans (frame-level) for exact trellis comparison
        #[derive(Serialize)]
        struct SpanOut { token_index: usize, token_id: usize, start_frame: usize, end_frame: usize }
        let so: Vec<SpanOut> = spans.iter().map(|s| SpanOut {
            token_index: s.token_index, token_id: s.token_id,
            start_frame: s.start_frame, end_frame: s.end_frame }).collect();
        let mut f = std::fs::File::create(outdir.join(format!("{song}.spans.json")))?;
        f.write_all(serde_json::to_string(&so)?.as_bytes())?;
    }

    let report = Report {
        song: song.clone(),
        audio_duration_s: duration,
        sample_rate_in: sr_in,
        stage_decode_resample_s: t_decode,
        stage_whisper_s: t_whisper,
        stage_w2v_inference_s: t_w2v,
        stage_trellis_s: t_trellis,
        total_alignment_stage_s: t_whisper + t_w2v + t_trellis,
        realtime_factor: (t_whisper + t_w2v + t_trellis) / duration,
        transcript: raw_text,
        n_words: word_timings.len(),
        n_frames: em.n_frames,
        words: word_timings,
    };
    let out_path = outdir.join(format!("{song}.align.json"));
    std::fs::write(&out_path, serde_json::to_string_pretty(&report)?)?;
    eprintln!(
        "[{song}] DONE  whisper {:.1}s + w2v {:.1}s + trellis {:.2}s = {:.1}s for {:.0}s audio (rtf {:.2})",
        report.stage_whisper_s, report.stage_w2v_inference_s, report.stage_trellis_s,
        report.total_alignment_stage_s, duration, report.realtime_factor
    );
    println!("{}", out_path.display());
    Ok(())
}
