//! The model downloader against a tiny HTTP server on 127.0.0.1 (no network):
//! a fresh download, resuming after a dropped connection, a corrupt file,
//! cancelling, and a server that ignores Range.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use karaoke_core::models::{download_pack_from, sha256_file, status_of, Manifest, ModelFile, Pack};
use karaoke_core::Error;
use sha2::{Digest, Sha256};

#[derive(Default)]
struct Behaviour {
    /// Close the connection after this many body bytes (first request only).
    cut_after: Option<usize>,
    /// Answer 200 with the whole file even when asked for a range.
    ignore_range: bool,
    /// Serve these bytes instead of the real file.
    corrupt: bool,
}

struct Server {
    base: String,
    ranges_seen: Arc<Mutex<Vec<String>>>,
    requests: Arc<AtomicUsize>,
}

fn serve(files: HashMap<String, Vec<u8>>, b: Behaviour) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let ranges_seen = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(AtomicUsize::new(0));
    let (rs, rq) = (ranges_seen.clone(), requests.clone());
    let b = Arc::new(b);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let n = rq.fetch_add(1, Ordering::SeqCst);
            handle(stream, &files, &b, n == 0, &rs);
        }
    });
    Server { base, ranges_seen, requests }
}

fn handle(mut s: TcpStream, files: &HashMap<String, Vec<u8>>, b: &Behaviour, first: bool, rs: &Mutex<Vec<String>>) {
    let mut reader = BufReader::new(s.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let path = line.split_whitespace().nth(1).unwrap_or("/").trim_start_matches("/v1/").to_string();
    let mut range: Option<usize> = None;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).unwrap();
        if h.trim().is_empty() {
            break;
        }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("range: bytes=") {
            rs.lock().unwrap().push(v.trim().to_string());
            range = v.trim().trim_end_matches('-').parse().ok();
        }
    }
    let Some(body) = files.get(&path) else {
        let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let body: Vec<u8> = if b.corrupt { body.iter().map(|x| x ^ 0xff).collect() } else { body.clone() };
    let (status, start) = match range {
        Some(r) if !b.ignore_range && r < body.len() => ("206 Partial Content", r),
        _ => ("200 OK", 0),
    };
    let rest = &body[start..];
    let mut head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", rest.len());
    if start > 0 {
        head += &format!("Content-Range: bytes {start}-{}/{}\r\n", body.len() - 1, body.len());
    }
    head += "\r\n";
    let _ = s.write_all(head.as_bytes());
    let send = match (first, b.cut_after) {
        (true, Some(n)) => &rest[..n.min(rest.len())],
        _ => rest,
    };
    let _ = s.write_all(send);
    let _ = s.flush();
}

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("karaoke-models-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Two files of pseudo-random bytes, their manifest, and the bytes.
fn fixture() -> (Manifest, HashMap<String, Vec<u8>>) {
    let mut seed = 0x1234_5678u32;
    let mut bytes = |n: usize| -> Vec<u8> {
        (0..n)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 24) as u8
            })
            .collect()
    };
    let files: HashMap<String, Vec<u8>> = [
        ("big.onnx".to_string(), bytes(700_000)),
        ("sub/small.json".to_string(), bytes(1_000)),
    ]
    .into_iter()
    .collect();
    let mut entries = Vec::new();
    for (path, data) in &files {
        let sha256 = Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect();
        entries.push(ModelFile { pack: Pack::Core, path: path.clone(), size: data.len() as u64, sha256 });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    (Manifest { mirror_path: "v1".into(), files: entries }, files)
}

fn run(dir: &PathBuf, m: &Manifest, base: &str, cancel: &AtomicBool) -> (Result<(), Error>, Vec<u64>) {
    let mut seen = Vec::new();
    let r = download_pack_from(dir, m, Pack::Core, base, "baritoad-test", cancel, &mut |p| seen.push(p.done));
    (r, seen)
}

#[test]
fn a_fresh_download_lands_every_file_verified() {
    let (m, files) = fixture();
    let srv = serve(files.clone(), Behaviour::default());
    let dir = tmp_dir("fresh");
    let (r, seen) = run(&dir, &m, &srv.base, &AtomicBool::new(false));
    r.unwrap();
    assert_eq!(std::fs::read(dir.join("big.onnx")).unwrap(), files["big.onnx"]);
    assert_eq!(std::fs::read(dir.join("sub").join("small.json")).unwrap(), files["sub/small.json"]);
    assert!(status_of(&dir, &m).iter().all(|s| s.pack != Pack::Core || s.installed));
    assert_eq!(*seen.last().unwrap(), 701_000, "progress ends at the pack size");
    assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress only goes up");
    // Already there: no requests.
    let before = srv.requests.load(Ordering::SeqCst);
    run(&dir, &m, &srv.base, &AtomicBool::new(false)).0.unwrap();
    assert_eq!(srv.requests.load(Ordering::SeqCst), before);
}

#[test]
fn a_dropped_connection_resumes_where_it_stopped() {
    let (m, files) = fixture();
    let srv = serve(files.clone(), Behaviour { cut_after: Some(250_000), ..Default::default() });
    let dir = tmp_dir("resume");
    let (first, _) = run(&dir, &m, &srv.base, &AtomicBool::new(false));
    assert!(matches!(first, Err(Error::Network(_))), "{first:?}");
    assert_eq!(std::fs::metadata(dir.join("big.onnx.part")).unwrap().len(), 250_000);
    let st = status_of(&dir, &m).into_iter().find(|s| s.pack == Pack::Core).unwrap();
    assert!(!st.installed);
    assert_eq!(st.bytes_present, 250_000, "the partial file counts");

    run(&dir, &m, &srv.base, &AtomicBool::new(false)).0.unwrap();
    assert_eq!(std::fs::read(dir.join("big.onnx")).unwrap(), files["big.onnx"]);
    assert!(!dir.join("big.onnx.part").exists());
    assert_eq!(srv.ranges_seen.lock().unwrap().as_slice(), ["250000-"]);
}

#[test]
fn a_server_that_ignores_range_starts_the_file_over() {
    let (m, files) = fixture();
    let srv = serve(files.clone(), Behaviour { cut_after: Some(100_000), ignore_range: true, ..Default::default() });
    let dir = tmp_dir("norange");
    assert!(run(&dir, &m, &srv.base, &AtomicBool::new(false)).0.is_err());
    run(&dir, &m, &srv.base, &AtomicBool::new(false)).0.unwrap();
    assert_eq!(std::fs::read(dir.join("big.onnx")).unwrap(), files["big.onnx"]);
}

#[test]
fn a_file_that_fails_its_checksum_is_removed() {
    let (m, files) = fixture();
    let srv = serve(files, Behaviour { corrupt: true, ..Default::default() });
    let dir = tmp_dir("corrupt");
    let (r, _) = run(&dir, &m, &srv.base, &AtomicBool::new(false));
    assert!(matches!(r, Err(Error::Model(ref msg)) if msg.contains("checksum")), "{r:?}");
    assert!(!dir.join("big.onnx").exists() && !dir.join("big.onnx.part").exists());
}

#[test]
fn cancelling_keeps_the_partial_file() {
    let (m, files) = fixture();
    let srv = serve(files, Behaviour::default());
    let dir = tmp_dir("cancel");
    let cancel = AtomicBool::new(true);
    let (r, _) = run(&dir, &m, &srv.base, &cancel);
    assert!(matches!(r, Err(Error::Cancelled)), "{r:?}");
    assert!(dir.join("big.onnx.part").exists());
    assert!(!dir.join("big.onnx").exists());
}

#[test]
fn a_missing_file_on_the_mirror_says_so() {
    let (m, _) = fixture();
    let srv = serve(HashMap::new(), Behaviour::default());
    let dir = tmp_dir("missing");
    let (r, _) = run(&dir, &m, &srv.base, &AtomicBool::new(false));
    assert!(matches!(r, Err(Error::Network(ref msg)) if msg.contains("404")), "{r:?}");
}

#[test]
fn sha256_file_matches_the_in_memory_digest() {
    let dir = tmp_dir("sha");
    let p = dir.join("f.bin");
    std::fs::write(&p, b"baritoad").unwrap();
    let want: String = Sha256::digest(b"baritoad").iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(sha256_file(&p).unwrap(), want);
}
