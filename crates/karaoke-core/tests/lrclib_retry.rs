//! LRCLIB lookups survive a busy server: a 503 is tried again, and only a
//! server that stays busy fails the lookup. A local stand-in plays LRCLIB.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use karaoke_core::lrclib::{Client, Query};

const RECORD: &str = r#"{"id":37377040,"trackName":"Dine N'Dash","artistName":"The Strokes","albumName":"Reality Awaits","duration":303.0,"instrumental":false,"plainLyrics":"line one\nline two","syncedLyrics":null}"#;

/// Answers each request with the next of `replies` (status, body), then 404s;
/// returns the base URL and the request count.
fn serve(replies: Vec<(u16, &'static str)>) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let n = count.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let mut reader = BufReader::new(s.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                    break;
                }
            }
            let i = n.fetch_add(1, Ordering::SeqCst);
            let (status, body) = replies.get(i).copied().unwrap_or((404, "{}"));
            let reason = match status {
                200 => "OK",
                503 => "Service Unavailable",
                _ => "Not Found",
            };
            let _ = write!(
                s,
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nRetry-After: 0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (base, count)
}

fn query() -> Query {
    Query { title: "Dine N'Dash".into(), artist: Some("The Strokes".into()), album: None, duration_s: Some(304.0) }
}

#[test]
fn a_busy_answer_is_tried_again() {
    let (base, count) = serve(vec![(503, "busy"), (200, RECORD)]);
    let rec = Client::with_base(&base, "baritoad-test").lookup(&query()).expect("lookup").expect("found");
    assert_eq!(rec.id, 37377040);
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[test]
fn a_server_that_stays_busy_says_so() {
    let (base, count) = serve(vec![(503, "busy"); 3]);
    let err = Client::with_base(&base, "baritoad-test").lookup(&query()).unwrap_err().to_string();
    assert!(err.contains("busy right now (HTTP 503)"), "{err}");
    assert_eq!(count.load(Ordering::SeqCst), 3, "three tries, then give up");
}
