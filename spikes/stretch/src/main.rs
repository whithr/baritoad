mod analysis;
mod cmd_latency;
mod cmd_live;
mod cmd_quality;
mod decode;
mod engine;
mod ffi;

use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    match args.get(1).map(|s| s.as_str()) {
        Some("latency") => cmd_latency::run(),
        Some("quality") => {
            let testdata = args
                .get(2)
                .map(PathBuf::from)
                .unwrap_or_else(|| manifest.join("../testdata"));
            let out = manifest.join("out");
            std::fs::create_dir_all(&out).unwrap();
            cmd_quality::run(&testdata, &out);
        }
        Some("live") => {
            let use_mmcss = args.iter().any(|a| a == "--mmcss");
            let song = args
                .iter()
                .skip(2)
                .find(|a| !a.starts_with("--"))
                .map(PathBuf::from)
                .unwrap_or_else(|| manifest.join("../testdata/wildflowers.mp3"));
            cmd_live::run(&song, use_mmcss);
        }
        _ => {
            eprintln!("usage: stretch-spike <latency|quality [testdata_dir]|live [song.mp3]>");
            std::process::exit(2);
        }
    }
}
