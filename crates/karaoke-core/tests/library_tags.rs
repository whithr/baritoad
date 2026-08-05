//! Tag-reading tests against a tiny self-generated tagged WAV — invented
//! title/artist and fake cover bytes written with lofty at test time. No
//! copyrighted fixtures ever land in the repo (CLAUDE.md hard rule; the
//! .gitignore blocks *.wav anyway — these live in the OS temp dir).

use std::path::PathBuf;

use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{Tag, TagType};

use karaoke_core::library::{read_tags, save_cover};

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("karaoke-tags-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 0.5 s of silence, 16-bit mono 8 kHz — the smallest honest WAV.
fn write_wav(path: &PathBuf) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 8000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for _ in 0..4000 {
        w.write_sample(0i16).unwrap();
    }
    w.finalize().unwrap();
}

// Fake cover bytes: lofty stores picture data verbatim; validity as an image
// is the UI's concern, identity/round-trip is what we test.
const COVER_BYTES: &[u8] = b"\x89PNG-not-really-but-bytes-are-bytes";

fn write_tagged_wav(dir: &PathBuf, with_cover: bool) -> PathBuf {
    let path = dir.join("fixture.wav");
    write_wav(&path);
    let mut tag = Tag::new(TagType::Id3v2);
    tag.set_title("Paper Lanterns".into());
    tag.set_artist("The Invented Band".into());
    tag.set_album("Test Fixtures Vol. 1".into());
    if with_cover {
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Png),
            None,
            COVER_BYTES.to_vec(),
        ));
    }
    tag.save_to_path(&path, WriteOptions::default()).unwrap();
    path
}

#[test]
fn reads_title_artist_album_cover_and_duration() {
    let dir = tmp_dir("read");
    let path = write_tagged_wav(&dir, true);

    let tags = read_tags(&path).unwrap();
    assert_eq!(tags.title.as_deref(), Some("Paper Lanterns"));
    assert_eq!(tags.artist.as_deref(), Some("The Invented Band"));
    assert_eq!(tags.album.as_deref(), Some("Test Fixtures Vol. 1"));

    let d = tags.duration_s.expect("duration from properties");
    assert!((d - 0.5).abs() < 0.1, "expected ~0.5 s, got {d}");

    let cover = tags.cover.expect("embedded front cover");
    assert_eq!(cover.data, COVER_BYTES);
    assert_eq!(cover.mime.as_deref(), Some("image/png"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn untagged_file_reads_as_all_none_not_error() {
    let dir = tmp_dir("untagged");
    let path = dir.join("bare.wav");
    write_wav(&path);

    let tags = read_tags(&path).unwrap();
    assert!(tags.title.is_none());
    assert!(tags.artist.is_none());
    assert!(tags.cover.is_none());
    assert!(tags.duration_s.is_some(), "duration still comes from properties");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unreadable_file_is_an_error() {
    let dir = tmp_dir("garbage");
    let path = dir.join("noise.bin");
    std::fs::write(&path, b"definitely not audio").unwrap();
    assert!(read_tags(&path).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn save_cover_is_hash_named_and_deduplicates() {
    let dir = tmp_dir("covers");
    let covers = dir.join("covers");
    let path = write_tagged_wav(&dir, true);
    let cover = read_tags(&path).unwrap().cover.unwrap();

    let p1 = save_cover(&cover, &covers).unwrap();
    assert!(p1.is_file());
    assert_eq!(p1.extension().and_then(|e| e.to_str()), Some("png"));
    assert_eq!(std::fs::read(&p1).unwrap(), COVER_BYTES);

    // Same art again (same song re-imported, or another song sharing art):
    // same file, no duplicate.
    let p2 = save_cover(&cover, &covers).unwrap();
    assert_eq!(p1, p2);
    assert_eq!(std::fs::read_dir(&covers).unwrap().count(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}
