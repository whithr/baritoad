//! cpal-based live playback prototype: play a song excerpt through Signalsmith
//! Stretch on the real audio callback, change pitch/tempo settings from another
//! thread on a schedule, and measure:
//!   - scheduling latency: time from the control thread's request to the audio
//!     callback picking it up
//!   - per-callback process() cost vs the callback's real-time budget
//!   - callback cadence gaps and device-reported errors (underruns)
//!   - output continuity around each change (captured output, max sample delta)
//!
//! Output volume is deliberately reduced (0.15x) — it plays on the default
//! output device. Amplitude scaling does not affect any timing measurement.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::analysis::max_delta;
use crate::decode;
use crate::ffi::Stretch;

// MMCSS: register the audio callback thread as "Pro Audio" so the scheduler
// stops preempting it for tens of ms (cpal does not do this itself on WASAPI).
// Toggled via --mmcss to measure the difference.
#[link(name = "avrt")]
extern "system" {
    fn AvSetMmThreadCharacteristicsW(
        task_name: *const u16,
        task_index: *mut u32,
    ) -> *mut std::ffi::c_void;
}

fn register_pro_audio() {
    let name: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
    let mut index = 0u32;
    let h = unsafe { AvSetMmThreadCharacteristicsW(name.as_ptr(), &mut index) };
    if h.is_null() {
        eprintln!("AvSetMmThreadCharacteristicsW failed");
    }
}

struct Shared {
    pitch_bits: AtomicU32,   // f32 semitones
    rate_bits: AtomicU64,    // f64 tempo rate (1.0 = normal)
    change_id: AtomicU64,
    request_ns: AtomicU64,   // t0-relative nanos of the last change request
    done: AtomicBool,
}

#[derive(Default)]
struct Stats {
    callback_start_ns: Vec<u64>,
    callback_frames: Vec<u32>,
    proc_ns: Vec<u64>,
    apply_latency_ns: Vec<u64>,
    apply_positions: Vec<usize>, // index into captured at the moment a change was applied
    captured: Vec<f32>,          // mono (left), pre-volume
}

pub fn run(song_path: &std::path::Path, use_mmcss: bool) {
    println!("MMCSS Pro Audio registration: {}", if use_mmcss { "ON" } else { "OFF" });
    let song = decode::decode(song_path).expect("decode song");
    let file_sr = song.sample_rate;

    let host = cpal::default_host();
    let device = match host.default_output_device() {
        Some(d) => d,
        None => {
            eprintln!("BLOCKED: no default audio output device available");
            return;
        }
    };
    let config = device.default_output_config().expect("default output config");
    println!(
        "device: {:?}, default config: {} Hz, {} ch, {:?}, buffer {:?}",
        device.name().unwrap_or_default(),
        config.sample_rate().0,
        config.channels(),
        config.sample_format(),
        config.buffer_size()
    );
    assert_eq!(
        config.sample_format(),
        cpal::SampleFormat::F32,
        "spike only handles f32 output"
    );
    let dev_sr = config.sample_rate().0;
    let dev_channels = config.channels() as usize;
    assert!(dev_channels >= 2, "need a stereo output device");

    // Feeding at file_sr/dev_sr input frames per output frame makes the
    // stretcher do the samplerate bridging (pitch-preserving, tempo-correct).
    let base_rate = file_sr as f64 / dev_sr as f64;

    // ~25 s excerpt starting 30% in.
    let start = (song.frames() as f64 * 0.30) as usize;
    let ex_frames = ((25.0 * file_sr as f64) as usize).min(song.frames() - start);
    let excerpt: Vec<f32> = song.samples[start * 2..(start + ex_frames) * 2].to_vec();

    let shared = Arc::new(Shared {
        pitch_bits: AtomicU32::new(0.0f32.to_bits()),
        rate_bits: AtomicU64::new(1.0f64.to_bits()),
        change_id: AtomicU64::new(0),
        request_ns: AtomicU64::new(0),
        done: AtomicBool::new(false),
    });
    let stats = Arc::new(Mutex::new(Stats::default()));
    let err_count = Arc::new(AtomicU64::new(0));
    let t0 = Instant::now();

    let mut stretch = Stretch::preset_default(2, dev_sr);
    stretch.set_transpose_semitones(0.0, 8000.0 / dev_sr as f32);

    let stream = {
        let shared = shared.clone();
        let stats = stats.clone();
        let err_count = err_count.clone();
        let mut cursor_frames = 0usize;
        let mut acc = 0.0f64;
        let mut last_id = 0u64;
        let mut mmcss_done = false;
        let mut scratch: Vec<f32> = Vec::new();
        let excerpt = excerpt; // move
        let stream_config: cpal::StreamConfig = config.into();

        device
            .build_output_stream(
                &stream_config,
                move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                    let cb_start = Instant::now();
                    if use_mmcss && !mmcss_done {
                        register_pro_audio();
                        mmcss_done = true;
                    }
                    let out_frames = data.len() / dev_channels;

                    // Pick up any pending setting change.
                    let id = shared.change_id.load(Ordering::Acquire);
                    let mut applied_now = false;
                    if id != last_id {
                        last_id = id;
                        let semis = f32::from_bits(shared.pitch_bits.load(Ordering::Relaxed));
                        stretch.set_transpose_semitones(semis, 8000.0 / dev_sr as f32);
                        applied_now = true;
                    }
                    let tempo = f64::from_bits(shared.rate_bits.load(Ordering::Relaxed));
                    let rate = base_rate * tempo;

                    // Take input.
                    let total = excerpt.len() / 2;
                    acc += out_frames as f64 * rate;
                    let n = acc.floor() as usize;
                    acc -= n as f64;
                    let s = cursor_frames.min(total);
                    let e = (s + n).min(total);
                    cursor_frames = e;
                    if s >= total {
                        shared.done.store(true, Ordering::Release);
                        data.fill(0.0);
                        return;
                    }
                    let input = &excerpt[s * 2..e * 2];

                    scratch.resize(out_frames * 2, 0.0);
                    let p0 = Instant::now();
                    stretch.process(input, &mut scratch);
                    let proc_ns = p0.elapsed().as_nanos() as u64;

                    for f in 0..out_frames {
                        data[f * dev_channels] = scratch[f * 2] * 0.15;
                        data[f * dev_channels + 1] = scratch[f * 2 + 1] * 0.15;
                        for c in 2..dev_channels {
                            data[f * dev_channels + c] = 0.0;
                        }
                    }

                    if let Ok(mut st) = stats.try_lock() {
                        let now_ns = (cb_start - t0).as_nanos() as u64;
                        if applied_now {
                            let req = shared.request_ns.load(Ordering::Relaxed);
                            st.apply_latency_ns.push(now_ns.saturating_sub(req));
                            let pos = st.captured.len();
                            st.apply_positions.push(pos);
                        }
                        st.callback_start_ns.push(now_ns);
                        st.callback_frames.push(out_frames as u32);
                        st.proc_ns.push(proc_ns);
                        st.captured.extend(scratch.chunks(2).map(|c| c[0]));
                    }
                },
                move |e| {
                    eprintln!("stream error: {e}");
                    err_count.fetch_add(1, Ordering::Relaxed);
                },
                None,
            )
            .expect("build stream")
    };
    stream.play().expect("play");

    // Setting schedule: (seconds, semitones, tempo rate)
    let schedule: &[(f64, f32, f64)] = &[
        (2.5, 3.0, 1.0),
        (5.0, 3.0, 0.8),
        (7.5, -6.0, 0.8),
        (10.0, -6.0, 1.2),
        (12.5, 6.0, 1.2),
        (15.0, 0.0, 1.0),
        (17.5, -3.0, 1.2),
        (20.0, 0.0, 1.0),
    ];
    for &(t, semis, tempo) in schedule {
        while t0.elapsed().as_secs_f64() < t {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        shared.rate_bits.store(tempo.to_bits(), Ordering::Relaxed);
        shared.pitch_bits.store(semis.to_bits(), Ordering::Relaxed);
        shared
            .request_ns
            .store(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
        shared.change_id.fetch_add(1, Ordering::Release);
        println!("t={t:.1}s -> pitch {semis:+.0} st, tempo {tempo:.2}x");
    }
    while t0.elapsed().as_secs_f64() < 23.0 && !shared.done.load(Ordering::Acquire) {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    drop(stream);

    // Report.
    let st = stats.lock().unwrap();
    let n = st.callback_start_ns.len();
    println!("\ncallbacks: {n}, stream errors (underruns etc.): {}", err_count.load(Ordering::Relaxed));
    if n < 10 {
        eprintln!("too few callbacks to analyze");
        return;
    }

    let mut proc_ms: Vec<f64> = st.proc_ns.iter().map(|&v| v as f64 / 1e6).collect();
    proc_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let budgets_ms: Vec<f64> = st
        .callback_frames
        .iter()
        .map(|&f| f as f64 / dev_sr as f64 * 1000.0)
        .collect();
    let min_budget = budgets_ms.iter().cloned().fold(f64::MAX, f64::min);
    use crate::analysis::percentile;
    println!(
        "process() per callback: p50 {:.3} ms, p99 {:.3} ms, max {:.3} ms; callback budget (min) {:.2} ms; frames/callback (min..max) {}..{}",
        percentile(&proc_ms, 50.0),
        percentile(&proc_ms, 99.0),
        proc_ms.last().unwrap(),
        min_budget,
        st.callback_frames.iter().min().unwrap(),
        st.callback_frames.iter().max().unwrap(),
    );

    // Localize worst process() call and top outliers.
    let (worst_idx, worst_ns) = st
        .proc_ns
        .iter()
        .enumerate()
        .max_by_key(|(_, &v)| v)
        .unwrap();
    println!(
        "worst process(): callback #{worst_idx} of {n} at t={:.3}s ({:.3} ms)",
        st.callback_start_ns[worst_idx] as f64 / 1e9,
        *worst_ns as f64 / 1e6
    );
    let mut over_1ms: Vec<(usize, f64)> = st
        .proc_ns
        .iter()
        .enumerate()
        .filter(|(_, &v)| v > 1_000_000)
        .map(|(i, &v)| (i, v as f64 / 1e6))
        .collect();
    over_1ms.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    over_1ms.truncate(10);
    println!("callbacks with process() > 1 ms (top 10, index@time): {:?}",
        over_1ms
            .iter()
            .map(|&(i, ms)| format!("#{i}@{:.2}s:{:.2}ms", st.callback_start_ns[i] as f64 / 1e9, ms))
            .collect::<Vec<_>>());

    let mut gaps_ms: Vec<f64> = st
        .callback_start_ns
        .windows(2)
        .map(|w| (w[1] - w[0]) as f64 / 1e6)
        .collect();
    gaps_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "callback cadence: median {:.2} ms, p99 {:.2} ms, max {:.2} ms",
        percentile(&gaps_ms, 50.0),
        percentile(&gaps_ms, 99.0),
        gaps_ms.last().unwrap()
    );

    let lat_ms: Vec<f64> = st.apply_latency_ns.iter().map(|&v| v as f64 / 1e6).collect();
    println!("scheduling latency (request -> callback pickup), per change: {:?} ms",
        lat_ms.iter().map(|v| (v * 100.0).round() / 100.0).collect::<Vec<_>>());

    // Continuity around each applied change.
    let sr = dev_sr as f64;
    let global_max_delta = max_delta(&st.captured, 1, st.captured.len());
    println!("captured output: {} frames, global max sample delta {:.4}", st.captured.len(), global_max_delta);
    for (i, &pos) in st.apply_positions.iter().enumerate() {
        let w0 = pos.saturating_sub((0.05 * sr) as usize);
        let w1 = (pos + (0.5 * sr) as usize).min(st.captured.len());
        let d = max_delta(&st.captured, w0, w1);
        println!("change {}: max delta within +-[50,500] ms window = {:.4} (global {:.4})", i + 1, d, global_max_delta);
    }
}
