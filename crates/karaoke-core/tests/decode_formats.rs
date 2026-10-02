//! Which files an import can read (audio.rs, import::AUDIO_EXTENSIONS):
//! AIFF, Apple Lossless, and the audio track of mp4/mov/mkv videos decode;
//! WMA and Opus/webm are refused up front by `check_decodable`.
//!
//! Needs `ffmpeg` on PATH to make the test files (5 s, a 440 Hz tone over a
//! test-pattern picture) — so it's ignored by default:
//! `cargo test -p karaoke-core --test decode_formats -- --ignored`

use std::path::{Path, PathBuf};
use std::process::Command;

use karaoke_core::audio::{check_decodable, decode_to_stereo_44k};

fn tmp_dir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("karaoke-decode-formats-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// ffmpeg -f lavfi tone (+ picture for videos) → `name`, encoded with `args`.
fn make(dir: &Path, name: &str, video: bool, args: &[&str]) -> PathBuf {
    let out = dir.join(name);
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    cmd.args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5"]);
    if video {
        cmd.args(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=5"]);
    }
    cmd.args(["-ac", "2"]);
    cmd.args(args);
    cmd.arg(&out);
    let st = cmd.status().expect("ffmpeg on PATH");
    assert!(st.success(), "ffmpeg failed for {name}");
    out
}

#[test]
#[ignore = "needs ffmpeg on PATH"]
fn readable_formats_decode_and_the_rest_are_refused() {
    let dir = tmp_dir();
    let readable = [
        make(&dir, "tone.aiff", false, &[]),
        make(&dir, "tone-alac.m4a", false, &["-c:a", "alac"]),
        make(&dir, "tone-aac.m4a", false, &["-c:a", "aac"]),
        make(&dir, "clip.mp4", true, &["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]),
        make(&dir, "clip.mov", true, &["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]),
        make(&dir, "clip.mkv", true, &["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "flac", "-shortest"]),
    ];
    for f in &readable {
        check_decodable(f).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        let d = decode_to_stereo_44k(f).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        let secs = d.len as f64 / 44_100.0;
        assert!((secs - 5.0).abs() < 0.2, "{}: decoded {secs:.2} s", f.display());
        // The tone is there, not silence.
        let peak = d.samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.05, "{}: peak {peak}", f.display());
    }

    let refused = [
        make(&dir, "tone.wma", false, &["-c:a", "wmav2"]),
        make(&dir, "clip.webm", true, &["-c:v", "libvpx-vp9", "-b:v", "200k", "-c:a", "libopus", "-shortest"]),
    ];
    for f in &refused {
        assert!(check_decodable(f).is_err(), "{} should be refused", f.display());
    }
    let _ = std::fs::remove_dir_all(&dir);
}
