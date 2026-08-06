//! Dev probe for the player_load hang: replicate do_load step by step with
//! timing logs. Not shipped; run with
//!   cargo run -p karaoke-core --example loadprobe -- <instrumental> <vocals>

use std::path::Path;
use std::time::Instant;

use karaoke_core::audio;
use karaoke_core::player::Player;

fn main() {
    let inst = std::env::args().nth(1).expect("usage: loadprobe <inst> <voc>");
    let voc = std::env::args().nth(2).expect("usage: loadprobe <inst> <voc>");
    let t = Instant::now();

    eprintln!("[{:>8.3?}] Player::new (device open + negotiate)...", t.elapsed());
    let mut p = Player::new().expect("Player::new");
    eprintln!("[{:>8.3?}] device: {:?}", t.elapsed(), p.device_info());

    eprintln!("[{:>8.3?}] decode instrumental...", t.elapsed());
    let inst_audio = audio::decode_to_stereo_44k(Path::new(&inst)).expect("decode inst");
    eprintln!("[{:>8.3?}] decode vocals...", t.elapsed());
    let voc_audio = audio::decode_to_stereo_44k(Path::new(&voc)).expect("decode voc");
    eprintln!("[{:>8.3?}] load_decoded (resample + stream build + play)...", t.elapsed());
    p.load_decoded(inst_audio, Some(voc_audio)).expect("load_decoded");
    eprintln!("[{:>8.3?}] loaded: dur {:.2}s", t.elapsed(), p.duration_seconds());

    p.play();
    std::thread::sleep(std::time::Duration::from_secs(2));
    eprintln!(
        "[{:>8.3?}] after 2s play: clock {:.3}s, diag {:?}",
        t.elapsed(),
        p.clock().position_seconds(),
        p.diagnostics()
    );
}
