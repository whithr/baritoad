//! Content hashing for job manifests (SHA-256 via the `sha2` crate —
//! MIT OR Apache-2.0, PLAN.md §6).
//!
//! Resume correctness rests on these hashes: a stage is only skipped when the
//! *content* of its inputs is unchanged, never merely the path or mtime
//! (PLAN.md §5 "job queue, resume").

use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::Result;

/// Hex SHA-256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

/// Hex SHA-256 of a file's contents, streamed (stems can be hundreds of MB).
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(to_hex(&hasher.finalize()))
}

fn to_hex(digest: &[u8]) -> String {
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vector() {
        // SHA-256("abc") — FIPS 180-2 test vector
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn file_hash_matches_bytes_hash() {
        let dir = std::env::temp_dir().join("karaoke-hash-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.bin");
        std::fs::write(&p, b"hello hashing").unwrap();
        assert_eq!(sha256_file(&p).unwrap(), sha256_hex(b"hello hashing"));
        let _ = std::fs::remove_file(&p);
    }
}
