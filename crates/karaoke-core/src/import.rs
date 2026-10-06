//! Bulk import: find the songs under the folders (or files) a user hands
//! over, and pair each audio file with its lyrics, so the job queue can
//! batch-process a folder of songs. Pure filesystem work: no pipeline, no
//! library. The app shows the [`Scan`] for review and queues what the user
//! keeps.
//!
//! **Pairing**, per folder, first match wins:
//! 1. an UltraStar `.txt` whose `#AUDIO`/`#MP3` header names the audio file
//!    (the community's song-folder layout — names needn't match);
//! 2. a lyrics file with the audio's name: `Song.txt`, `Song.lyrics.txt` or
//!    `Song.lrc` (an UltraStar `Song.txt` still counts as UltraStar);
//! 3. a folder holding exactly one audio file and one leftover lyrics file
//!    pairs them whatever their names.
//!
//! Everything else imports without lyrics (the aligner transcribes it).
//! Every other `.txt` / `.lrc` counts as a possible lyrics file, and one
//! nobody claimed is reported, so a misnamed file is noticed rather than
//! silently transcribed around — except the usual non-lyrics names
//! ([`NOT_LYRICS`]: readme, license, …), which are ignored.
//!
//! **Collections come from folders.** A folder with exactly one song in it is
//! that song's own folder (the UltraStar layout), so the song belongs to the
//! folder above. A song's collection is the name of the folder it belongs
//! to; songs at the top of a folder of folders get none; a flat folder
//! (every song at its top) is one collection named after itself.
//!
//! **Skipped:** hidden entries, symlinks, and job output — any folder holding
//! a job manifest, or named `*-karaoke` (the pipeline's default out dir sits
//! beside the audio, stems and all, so a re-scan must not import its WAVs).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::formats::{lrc, ultrastar};
use crate::library::tags;
use crate::pipeline::manifest::MANIFEST_FILE_NAME;

/// Files the pipeline decodes (the desktop app's file filter matches):
/// audio, plus videos, whose audio track is read directly (audio.rs). Not
/// WMA or Opus/webm — Symphonia has no decoder for them.
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "wav", "m4a", "ogg", "aac", "aiff", "aif", "mp4", "m4v", "mov", "mkv",
];

/// Music files the pipeline can't decode yet. The scan still finds them, so
/// the app and `karaoke scan` can say why they're left out (their decode
/// check fails) instead of skipping them without a word.
pub const UNSUPPORTED_AUDIO_EXTENSIONS: &[&str] = &["wma", "opus", "webm"];

/// Folders nested deeper than this under a root are not searched.
const MAX_DEPTH: usize = 12;

/// The lyrics a scanned song will import with.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LyricsFile {
    /// No lyrics file — the aligner transcribes the vocals.
    None,
    /// Plain pasted-style lyrics.
    Text { path: PathBuf },
    /// An LRC file, imported as its words ([`lrc::lyrics_text`]).
    Lrc { path: PathBuf },
    /// An UltraStar song file: its hand-made timings are used as they are.
    #[serde(rename = "ultrastar")]
    UltraStar { path: PathBuf },
    /// An UltraStar file paired with this song that can't be used (a duet,
    /// broken note lines); the song would import without lyrics.
    Unreadable { path: PathBuf, reason: String },
}

/// Where a scanned song's title came from (first that has one wins, in
/// this order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    Ultrastar,
    Tags,
    Lrc,
    Filename,
}

/// One song found by [`scan`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScanItem {
    pub audio: PathBuf,
    /// UltraStar header, then the file's tags, then LRC `[ti:]`, then the
    /// "Artist - Title" file name.
    pub title: String,
    pub artist: Option<String>,
    /// Which of those supplied the title — renaming the audio file only
    /// changes a title that came from the file name.
    pub title_source: TitleSource,
    pub lyrics: LyricsFile,
    /// Collection named after the song's folder (module docs).
    pub collection: Option<String>,
    /// From an UltraStar header (`#YEAR`, `#GENRE`, `#LANGUAGE` as a tag
    /// like "en"); the audio's own tags are read when the song registers.
    pub year: Option<i32>,
    pub genre: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Scan {
    /// Songs in path order.
    pub items: Vec<ScanItem>,
    /// `.txt` / `.lrc` files no song claimed.
    pub unmatched_lyrics: Vec<PathBuf>,
}

/// Scan folders and/or files. A folder is searched recursively; a loose
/// audio file is paired from its own folder's listing but only it is
/// imported. Paths that don't exist or aren't audio are ignored.
pub fn scan(paths: &[PathBuf]) -> Scan {
    let mut out = Scan::default();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut loose: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();

    for p in paths {
        if p.is_dir() {
            let mut dirs = Vec::new();
            walk(p, 0, &mut dirs);
            let mut items = Vec::new();
            let mut unmatched = Vec::new();
            for dir in &dirs {
                let listing = Listing::read(dir);
                let (found, left) = pair_folder(&listing, None);
                items.extend(found.into_iter().map(|f| (dir.clone(), listing.audio.len(), f)));
                unmatched.extend(left);
            }
            assign_collections(p, &mut items);
            for (_, _, item) in items {
                if seen.insert(key(&item.audio)) {
                    out.items.push(item);
                }
            }
            out.unmatched_lyrics.extend(unmatched);
        } else if p.is_file() && is_audio(p) {
            if let Some(dir) = p.parent() {
                loose.entry(dir.to_path_buf()).or_default().push(p.clone());
            }
        }
    }

    // Loose files: paired against their folder, never given a collection.
    for (dir, files) in loose {
        let listing = Listing::read(&dir);
        let only: HashSet<PathBuf> = files.iter().map(|f| key(f)).collect();
        let (found, _) = pair_folder(&listing, Some(&only));
        for item in found {
            if seen.insert(key(&item.audio)) {
                out.items.push(item);
            }
        }
    }

    out.items.sort_by_key(|i| key(&i.audio));
    out.unmatched_lyrics.sort_by_key(|p| key(p));
    out.unmatched_lyrics.dedup();
    out
}

/// Read a text file the way lyrics and UltraStar files arrive in the wild:
/// UTF-8 (BOM or not), UTF-16 with a BOM, otherwise Windows-1252 — the
/// legacy encoding most older UltraStar song packs use.
pub fn read_text_file(path: &Path) -> std::io::Result<String> {
    Ok(decode_text(&std::fs::read(path)?))
}

/// See [`read_text_file`].
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if bytes.len() >= 2 && (bytes[..2] == [0xFF, 0xFE] || bytes[..2] == [0xFE, 0xFF]) {
        let le = bytes[0] == 0xFF;
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| cp1252(b)).collect(),
    }
}

/// How a lyrics file will fare: what the cleanup pass keeps, plus format
/// problems it *doesn't* fix — the checklist `karaoke scan` hands a person
/// (or an agent) preparing a folder for import.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LyricsCheck {
    /// Lines and words the lyric cleanup pass keeps (what gets aligned).
    pub lines: usize,
    pub words: usize,
    /// The cleanup pass's one-line summary ("removed 2 section headers").
    pub cleanup: String,
    /// Problems worth fixing by hand, in plain words.
    pub warnings: Vec<String>,
}

/// Check pasted-style lyrics text (see [`LyricsCheck`]).
pub fn check_lyrics(text: &str) -> LyricsCheck {
    let cleaned = crate::lyrics::clean(text);
    let words = cleaned.word_count();
    let raw_lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut warnings = Vec::new();

    if words == 0 {
        warnings.push("no lyric words left after cleanup".to_string());
    } else if words < 15 {
        warnings.push(format!("only {words} words — is this the whole song?"));
    }
    if words > 1500 {
        warnings.push(format!("{words} words — this may hold more than one song"));
    }
    let long = raw_lines.iter().filter(|l| l.chars().count() > 100).count();
    if long > 0 {
        warnings.push(format!(
            "{long} line(s) over 100 characters — put each sung line on its own line"
        ));
    }
    let chords = raw_lines.iter().filter(|l| is_chord_line(l)).count();
    if chords > 0 {
        warnings.push(format!("{chords} chord line(s) — remove chords, keep only the words"));
    }
    let inline = raw_lines.iter().filter(|l| !is_chord_line(l) && has_inline_chord(l)).count();
    if inline > 0 {
        warnings.push(format!(
            "{inline} line(s) with inline [chord] tags like [Am] — remove the tags, keep the words"
        ));
    }
    let stamped = raw_lines.iter().filter(|l| starts_with_timestamp(l)).count();
    if stamped > 0 {
        warnings.push(format!(
            "{stamped} line(s) start with [mm:ss] timestamps — this is an LRC file; give it the .lrc extension"
        ));
    }
    if ["<br", "<p>", "&amp;", "&#39;", "&quot;"].iter().any(|t| text.contains(t)) {
        warnings.push("HTML left over from a web page (<br>, &amp;, …) — replace it with plain text".to_string());
    }
    LyricsCheck {
        lines: cleaned.lines.len(),
        words,
        cleanup: cleaned.summary(),
        warnings,
    }
}

/// "G  D/F#  Em7  Cadd9" — every token a chord name, at least two of them.
fn is_chord_line(line: &str) -> bool {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    tokens.len() >= 2 && tokens.iter().all(|t| is_chord(t))
}

/// ChordPro-style "[Am]we sing [F]along" — a bracketed chord inside a line.
fn has_inline_chord(line: &str) -> bool {
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let Some(close) = after.find(']') else { return false };
        if is_chord(after[..close].trim()) {
            return true;
        }
        rest = &after[close + 1..];
    }
    false
}

fn is_chord(token: &str) -> bool {
    let (main, bass) = match token.split_once('/') {
        Some((m, b)) => (m, Some(b)),
        None => (token, None),
    };
    let root = |s: &str| -> Option<usize> {
        let mut c = s.chars();
        let first = c.next()?;
        if !('A'..='G').contains(&first) {
            return None;
        }
        Some(if matches!(c.next(), Some('#') | Some('b')) { 2 } else { 1 })
    };
    let Some(n) = root(main) else { return false };
    // quality? digits? (sus|add digits)? (b|# 5/9)? — "m7", "maj7", "7sus4", "m7b5"
    let mut rest = &main[n..];
    let take = |rest: &mut &str, options: &[&str]| -> bool {
        match options.iter().find(|o| rest.starts_with(**o)) {
            Some(o) => {
                *rest = &rest[o.len()..];
                true
            }
            None => false,
        }
    };
    let digits = |rest: &mut &str| -> usize {
        let n = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        *rest = &rest[n..];
        n
    };
    take(&mut rest, &["maj", "min", "dim", "aug", "sus", "add", "m", "M"]);
    digits(&mut rest);
    if take(&mut rest, &["sus", "add"]) && digits(&mut rest) == 0 {
        return false;
    }
    if take(&mut rest, &["b", "#"]) && digits(&mut rest) == 0 {
        return false;
    }
    rest.is_empty() && bass.map_or(true, |b| root(b).is_some_and(|k| k == b.len()))
}

fn starts_with_timestamp(line: &str) -> bool {
    line.strip_prefix('[')
        .and_then(|rest| rest.split_once(']'))
        .is_some_and(|(tag, _)| {
            let mut parts = tag.split([':', '.']);
            matches!((parts.next(), parts.next()), (Some(m), Some(s))
                if !m.is_empty() && !s.is_empty()
                    && m.chars().all(|c| c.is_ascii_digit())
                    && s.chars().all(|c| c.is_ascii_digit()))
        })
}

/// A language name as UltraStar files write it ("English", "Deutsch",
/// "Español") — or already a two-letter code — as the library's language
/// tag. Unknown names give `None` (the song keeps its default).
pub fn language_tag(name: &str) -> Option<String> {
    let n = name.trim().to_lowercase();
    const NAMES: &[(&str, &[&str])] = &[
        ("en", &["english", "englisch"]),
        ("de", &["german", "deutsch"]),
        ("es", &["spanish", "español", "espanol", "castellano"]),
        ("fr", &["french", "français", "francais"]),
        ("it", &["italian", "italiano"]),
        ("pt", &["portuguese", "português", "portugues"]),
        ("nl", &["dutch", "nederlands"]),
        ("sv", &["swedish", "svenska"]),
        ("no", &["norwegian", "norsk"]),
        ("da", &["danish", "dansk"]),
        ("fi", &["finnish", "suomi"]),
        ("pl", &["polish", "polski"]),
        ("cs", &["czech", "čeština", "cestina"]),
        ("hu", &["hungarian", "magyar"]),
        ("ru", &["russian", "русский"]),
        ("tr", &["turkish", "türkçe", "turkce"]),
        ("el", &["greek", "ελληνικά"]),
        ("ja", &["japanese", "日本語"]),
        ("ko", &["korean", "한국어"]),
        ("zh", &["chinese", "中文"]),
        ("la", &["latin"]),
    ];
    if let Some((tag, _)) = NAMES.iter().find(|(tag, names)| *tag == n || names.contains(&n.as_str())) {
        return Some((*tag).to_string());
    }
    None
}

/// Title and artist from an "Artist - Title" file name (underscores read as
/// spaces); otherwise the cleaned stem is the title.
pub fn meta_from_filename(path: &Path) -> (String, Option<String>) {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".into());
    let cleaned = stem.replace('_', " ");
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some((artist, title)) = cleaned.split_once(" - ") {
        let artist = artist.trim();
        let title = title.trim();
        if !artist.is_empty() && !title.is_empty() {
            return (title.to_string(), Some(artist.to_string()));
        }
    }
    (cleaned, None)
}

// ---------------------------------------------------------------------------

fn is_audio(p: &Path) -> bool {
    ext_of(p).is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.as_str()) || UNSUPPORTED_AUDIO_EXTENSIONS.contains(&e.as_str()))
}

/// Text files that are never lyrics (compared by lowercase stem).
pub const NOT_LYRICS: &[&str] = &["readme", "read me", "license", "licence", "copying", "changelog"];

fn is_lyrics_candidate(p: &Path) -> bool {
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    ext_of(p).is_some_and(|e| e == "txt" || e == "lrc") && !NOT_LYRICS.contains(&stem.as_str())
}

fn ext_of(p: &Path) -> Option<String> {
    p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase())
}

/// Case-insensitive identity for paths (Windows file names).
fn key(p: &Path) -> PathBuf {
    PathBuf::from(p.to_string_lossy().to_lowercase())
}

fn name_lower(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn is_job_output(dir: &Path) -> bool {
    name_lower(dir).ends_with("-karaoke") || dir.join(MANIFEST_FILE_NAME).is_file()
}

/// Every folder under `dir` (itself included) that may hold songs.
fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if is_job_output(dir) {
        return;
    }
    out.push(dir.to_path_buf());
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut subdirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| !is_hidden(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    subdirs.sort_by_key(|p| key(p));
    for sub in subdirs {
        walk(&sub, depth + 1, out);
    }
}

/// One folder's audio files and lyrics candidates.
struct Listing {
    audio: Vec<PathBuf>,
    lyrics: Vec<PathBuf>,
}

impl Listing {
    fn read(dir: &Path) -> Self {
        let mut audio = Vec::new();
        let mut lyrics = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                if !e.file_type().is_ok_and(|t| t.is_file()) {
                    continue; // directories, and symlinks (never followed)
                }
                let path = e.path();
                if is_hidden(&e.file_name().to_string_lossy()) {
                    continue;
                }
                if is_audio(&path) {
                    audio.push(path);
                } else if is_lyrics_candidate(&path) {
                    lyrics.push(path);
                }
            }
        }
        audio.sort_by_key(|p| key(p));
        lyrics.sort_by_key(|p| key(p));
        Self { audio, lyrics }
    }
}

/// What a lyrics candidate turned out to be.
enum Candidate {
    UltraStar { headers: Vec<(String, String)>, parsed: Result<(), String> },
    Lrc(lrc::LrcLyrics),
    Text { empty: bool },
    Unreadable,
}

fn inspect(path: &Path) -> Candidate {
    let Ok(text) = read_text_file(path) else {
        return Candidate::Unreadable;
    };
    if ext_of(path).as_deref() == Some("lrc") {
        return Candidate::Lrc(lrc::lyrics_text(&text));
    }
    if looks_like_ultrastar(&text) {
        return Candidate::UltraStar {
            headers: ultrastar_headers(&text),
            parsed: ultrastar::import(&text).map(|_| ()).map_err(|e| e.to_string()),
        };
    }
    Candidate::Text {
        empty: text.split_whitespace().next().is_none(),
    }
}

/// UltraStar files open with `#KEY:value` headers including `#TITLE`/`#BPM`.
fn looks_like_ultrastar(text: &str) -> bool {
    let mut first = true;
    for line in text.trim_start_matches('\u{feff}').lines().map(str::trim).filter(|l| !l.is_empty()).take(40) {
        if first && !line.starts_with('#') {
            return false;
        }
        first = false;
        let upper = line.to_ascii_uppercase();
        if upper.starts_with("#TITLE:") || upper.starts_with("#BPM:") {
            return true;
        }
    }
    false
}

/// The `#KEY:value` headers (keys uppercased), read up to the first note —
/// available even when the song body won't parse (a duet still names its
/// audio file and title).
fn ultrastar_headers(text: &str) -> Vec<(String, String)> {
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take_while(|l| l.starts_with('#'))
        .filter_map(|l| l[1..].split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim().to_string()))
        .collect()
}

fn header<'a>(headers: &'a [(String, String)], key: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty())
}

/// Pair one folder's audio with its lyrics (module docs). `only` limits the
/// songs produced to those audio files (loose-file scans). Returns the songs
/// and the candidates nobody claimed.
fn pair_folder(listing: &Listing, only: Option<&HashSet<PathBuf>>) -> (Vec<ScanItem>, Vec<PathBuf>) {
    let candidates: Vec<(PathBuf, Candidate)> =
        listing.lyrics.iter().map(|p| (p.clone(), inspect(p))).collect();
    let mut claimed: HashSet<usize> = HashSet::new();
    let mut paired: BTreeMap<usize, usize> = BTreeMap::new(); // audio idx → candidate idx

    // 1. UltraStar files name their audio.
    for (ci, (_, cand)) in candidates.iter().enumerate() {
        let Candidate::UltraStar { headers, .. } = cand else { continue };
        let Some(named) = header(headers, "AUDIO").or_else(|| header(headers, "MP3")) else { continue };
        let named = named.to_lowercase();
        if let Some(ai) = listing.audio.iter().position(|a| name_lower(a) == named) {
            if !paired.contains_key(&ai) {
                paired.insert(ai, ci);
                claimed.insert(ci);
            }
        }
    }

    // 2. Same name: Song.txt (UltraStar or plain), Song.lyrics.txt, Song.lrc.
    for (ai, audio) in listing.audio.iter().enumerate() {
        if paired.contains_key(&ai) {
            continue;
        }
        let stem = audio.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        let wanted = [format!("{stem}.txt"), format!("{stem}.lyrics.txt"), format!("{stem}.lrc")];
        let found = wanted.iter().find_map(|w| {
            candidates
                .iter()
                .enumerate()
                .find(|(ci, (p, _))| !claimed.contains(ci) && name_lower(p) == *w)
                .map(|(ci, _)| ci)
        });
        if let Some(ci) = found {
            paired.insert(ai, ci);
            claimed.insert(ci);
        }
    }

    // 3. One song, one leftover lyrics file.
    let open_audio: Vec<usize> = (0..listing.audio.len()).filter(|ai| !paired.contains_key(ai)).collect();
    let open_cands: Vec<usize> = (0..candidates.len())
        .filter(|ci| !claimed.contains(ci))
        .filter(|ci| !matches!(candidates[*ci].1, Candidate::Text { empty: true } | Candidate::Unreadable))
        .collect();
    if listing.audio.len() == 1 && open_audio.len() == 1 && open_cands.len() == 1 {
        paired.insert(open_audio[0], open_cands[0]);
        claimed.insert(open_cands[0]);
    }

    let mut items = Vec::new();
    for (ai, audio) in listing.audio.iter().enumerate() {
        if only.is_some_and(|o| !o.contains(&key(audio))) {
            continue;
        }
        let (mut title, mut artist) = meta_from_filename(audio);
        let mut title_source = TitleSource::Filename;
        let mut lyrics = LyricsFile::None;
        let mut us_meta: Option<(Option<String>, Option<String>)> = None;
        let (mut year, mut genre, mut language) = (None, None, None);
        if let Some(&ci) = paired.get(&ai) {
            let (path, cand) = &candidates[ci];
            match cand {
                Candidate::UltraStar { headers, parsed } => {
                    lyrics = match parsed {
                        Ok(()) => LyricsFile::UltraStar { path: path.clone() },
                        Err(reason) => LyricsFile::Unreadable { path: path.clone(), reason: reason.clone() },
                    };
                    us_meta = Some((
                        header(headers, "TITLE").map(String::from),
                        header(headers, "ARTIST").map(String::from),
                    ));
                    year = header(headers, "YEAR")
                        .and_then(|y| y.trim().get(..4)?.parse::<i64>().ok())
                        .and_then(tags::plausible_year);
                    genre = header(headers, "GENRE").and_then(tags::clean_genre);
                    language = header(headers, "LANGUAGE").and_then(language_tag);
                }
                Candidate::Lrc(l) => {
                    if !l.text.is_empty() {
                        lyrics = LyricsFile::Lrc { path: path.clone() };
                    }
                    if let Some(t) = &l.title {
                        title = t.clone();
                        title_source = TitleSource::Lrc;
                    }
                    if l.artist.is_some() {
                        artist = l.artist.clone();
                    }
                }
                Candidate::Text { empty } => {
                    if !empty {
                        lyrics = LyricsFile::Text { path: path.clone() };
                    }
                }
                Candidate::Unreadable => {}
            }
        }
        // The file's own tags beat the name and the LRC header…
        if let Ok(t) = tags::read_tags(audio) {
            if let Some(v) = t.title {
                title = v;
                title_source = TitleSource::Tags;
            }
            if t.artist.is_some() {
                artist = t.artist;
            }
        }
        // …and a hand-made UltraStar header beats the tags.
        if let Some((t, a)) = us_meta {
            if let Some(v) = t {
                title = v;
                title_source = TitleSource::Ultrastar;
            }
            if a.is_some() {
                artist = a;
            }
        }
        items.push(ScanItem {
            audio: audio.clone(),
            title,
            artist,
            title_source,
            lyrics,
            collection: None,
            year,
            genre,
            language,
        });
    }

    let unmatched = candidates
        .into_iter()
        .enumerate()
        .filter(|(ci, (_, c))| !claimed.contains(ci) && !matches!(c, Candidate::Text { empty: true }))
        .map(|(_, (p, _))| p)
        .collect();
    (items, unmatched)
}

/// Name collections after folders (module docs). `items` carry the folder
/// they were found in and that folder's audio count.
fn assign_collections(root: &Path, items: &mut [(PathBuf, usize, ScanItem)]) {
    let root_key = key(root);
    let home = |dir: &Path, audio_in_dir: usize| -> PathBuf {
        // A folder holding one song is that song's own folder.
        if audio_in_dir == 1 && key(dir) != root_key {
            dir.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.to_path_buf())
        } else {
            dir.to_path_buf()
        }
    };
    let homes: Vec<PathBuf> = items.iter().map(|(dir, n, _)| home(dir, *n)).collect();
    let flat = homes.iter().all(|h| key(h) == root_key);
    for ((_, _, item), h) in items.iter_mut().zip(homes) {
        item.collection = if key(&h) != root_key || flat {
            h.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty())
        } else {
            None
        };
    }
}

/// Windows-1252 → char (0x80–0x9F are the printable extras; the rest match
/// Latin-1).
fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
        '\u{90}', '\u{2018}', '\u{2019}', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    match b {
        0x80..=0x9F => HIGH[(b - 0x80) as usize],
        _ => b as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty scratch folder per test (no tempfile dependency).
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("karaoke-import-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Placeholder files: audio content is never read by the scan beyond a
    /// best-effort tag probe (which fails quietly on these).
    fn touch(dir: &Path, rel: &str, body: &str) -> PathBuf {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }

    const US_SONG: &str = "#TITLE:Bohemian Rhapsody\n#ARTIST:Queen\n#MP3:Queen - Bohemian Rhapsody [karaoke].mp3\n\
                           #YEAR:1975\n#GENRE:Rock\n#LANGUAGE:English\n\
                           #BPM:300\n#GAP:1000\n: 0 4 0 Is\n: 5 4 0  this\nE\n";

    fn item<'a>(scan: &'a Scan, file: &str) -> &'a ScanItem {
        scan.items
            .iter()
            .find(|i| name_lower(&i.audio) == file.to_lowercase())
            .unwrap_or_else(|| panic!("{file} not in scan: {:?}", scan.items))
    }

    #[test]
    fn pairs_by_name_and_reports_leftovers() {
        let d = scratch("names");
        touch(&d, "ABBA - Waterloo.flac", "");
        touch(&d, "ABBA - Waterloo.txt", "My my\nat Waterloo\n");
        touch(&d, "Robyn - Dancing On My Own.mp3", "");
        touch(&d, "Robyn - Dancing On My Own.lrc", "[ar:Robyn]\n[00:01.00]Somebody said\n");
        touch(&d, "Nirvana - Lithium.mp3", "");
        touch(&d, "notes.txt", "remember to buy milk");
        touch(&d, "README.txt", "about this pack");
        let s = scan(&[d.clone()]);
        assert_eq!(s.items.len(), 3);
        let w = item(&s, "ABBA - Waterloo.flac");
        assert_eq!((w.title.as_str(), w.artist.as_deref()), ("Waterloo", Some("ABBA")));
        assert_eq!(w.title_source, TitleSource::Filename);
        assert!(matches!(&w.lyrics, LyricsFile::Text { path } if name_lower(path) == "abba - waterloo.txt"));
        assert!(matches!(item(&s, "Robyn - Dancing On My Own.mp3").lyrics, LyricsFile::Lrc { .. }));
        assert_eq!(item(&s, "Nirvana - Lithium.mp3").lyrics, LyricsFile::None);
        assert_eq!(s.unmatched_lyrics, vec![d.join("notes.txt")]);
    }

    #[test]
    fn ultrastar_song_folder_pairs_through_its_header() {
        let d = scratch("ultrastar");
        let song = d.join("Queen - Bohemian Rhapsody");
        touch(&song, "Queen - Bohemian Rhapsody [karaoke].mp3", "");
        touch(&song, "Queen - Bohemian Rhapsody.txt", US_SONG);
        touch(&d, "loose.mp3", "");
        let s = scan(&[d.clone()]);
        let q = item(&s, "Queen - Bohemian Rhapsody [karaoke].mp3");
        assert!(matches!(q.lyrics, LyricsFile::UltraStar { .. }));
        assert_eq!((q.title.as_str(), q.artist.as_deref()), ("Bohemian Rhapsody", Some("Queen")));
        assert_eq!(q.title_source, TitleSource::Ultrastar);
        assert_eq!((q.year, q.genre.as_deref(), q.language.as_deref()), (Some(1975), Some("Rock"), Some("en")));
        // The song folder isn't a collection; the flat root is.
        let root_name = d.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(q.collection.as_deref(), Some(root_name.as_str()));
        assert!(s.unmatched_lyrics.is_empty());
    }

    #[test]
    fn duet_ultrastar_is_unreadable_but_named() {
        let d = scratch("duet");
        touch(&d, "Duet.mp3", "");
        touch(&d, "Duet.txt", "#TITLE:Together\n#ARTIST:Two\n#MP3:Duet.mp3\n#BPM:300\nP1\n: 0 4 0 hi\nE\n");
        let s = scan(&[d]);
        let it = item(&s, "Duet.mp3");
        assert!(matches!(&it.lyrics, LyricsFile::Unreadable { reason, .. } if reason.contains("duet")));
        assert_eq!(it.title, "Together");
    }

    #[test]
    fn collections_follow_folders() {
        let d = scratch("collections");
        touch(&d, "Christmas/Mariah - All I Want.mp3", "");
        touch(&d, "Christmas/Wham - Last Christmas.mp3", "");
        touch(&d, "Christmas/Band Aid - Do They Know/Band Aid - Do They Know.mp3", "");
        touch(&d, "80s/Toto - Africa.mp3", "");
        touch(&d, "80s/a-ha - Take On Me.mp3", "");
        touch(&d, "Top level.mp3", "");
        let s = scan(&[d]);
        assert_eq!(item(&s, "Mariah - All I Want.mp3").collection.as_deref(), Some("Christmas"));
        // A one-song folder belongs to the folder above it.
        assert_eq!(item(&s, "Band Aid - Do They Know.mp3").collection.as_deref(), Some("Christmas"));
        assert_eq!(item(&s, "Toto - Africa.mp3").collection.as_deref(), Some("80s"));
        // Top of a folder of folders: no collection.
        assert_eq!(item(&s, "Top level.mp3").collection, None);
    }

    #[test]
    fn job_output_and_hidden_folders_are_skipped() {
        let d = scratch("skips");
        touch(&d, "Song.mp3", "");
        touch(&d, "Song-karaoke/stems/vocals.wav", "");
        touch(&d, "elsewhere/out/job.json", "{}");
        touch(&d, "elsewhere/out/instrumental.wav", "");
        touch(&d, ".cache/hidden.mp3", "");
        let s = scan(&[d]);
        let names: Vec<String> = s.items.iter().map(|i| name_lower(&i.audio)).collect();
        assert_eq!(names, vec!["song.mp3"]);
    }

    #[test]
    fn loose_files_pair_from_their_folder_without_a_collection() {
        let d = scratch("loose");
        let a = touch(&d, "Picked.mp3", "");
        touch(&d, "Picked.txt", "la la\n");
        touch(&d, "Not picked.mp3", "");
        let s = scan(&[a]);
        assert_eq!(s.items.len(), 1);
        assert!(matches!(s.items[0].lyrics, LyricsFile::Text { .. }));
        assert_eq!(s.items[0].collection, None);
    }

    #[test]
    fn a_lone_song_takes_its_folders_only_lyrics_file() {
        let d = scratch("lone");
        touch(&d, "Some Band/track01.mp3", "");
        touch(&d, "Some Band/lyrics.txt", "words here\n");
        let s = scan(&[d]);
        assert!(matches!(item(&s, "track01.mp3").lyrics, LyricsFile::Text { .. }));
    }

    #[test]
    fn decodes_legacy_encodings() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFcaf\xC3\xA9"), "café");
        assert_eq!(decode_text(b"caf\xE9 \x93hi\x94"), "café \u{201c}hi\u{201d}");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'h', 0, b'i', 0]), "hi");
    }

    #[test]
    fn clean_lyrics_pass_the_check() {
        let text = "[Verse 1]\nWe walked along the river line\nand counted every star in sight\n\n\
                    [Chorus]\nOh the night is ours tonight (x2)\nhold on, hold on\n";
        let c = check_lyrics(text);
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
        assert!(c.words > 15);
        assert!(c.cleanup.contains("section header"), "{}", c.cleanup);
    }

    #[test]
    fn format_problems_are_named() {
        let unbroken = "we walked along the river line and counted every star in sight and the night was ours and nobody could take it away from us at all";
        assert!(check_lyrics(unbroken).warnings.iter().any(|w| w.contains("own line")));
        let chords = "G   D/F#   Em7   C\nwe walked along the river line and counted stars\nAm  F  C  G\n";
        assert!(check_lyrics(chords).warnings.iter().any(|w| w.contains("2 chord line")));
        let lrc = "[00:12.34]we walked along\n[00:15.00]the river line and counted every star in sight tonight\n";
        assert!(check_lyrics(lrc).warnings.iter().any(|w| w.contains(".lrc")));
        let inline = "[Am]we walked along the [F]river line and counted every [C]star in sight tonight\n";
        assert!(check_lyrics(inline).warnings.iter().any(|w| w.contains("inline [chord]")));
        assert!(check_lyrics("[Chorus]\nwe walked along the river line and counted every star in sight\nand the night was ours tonight\n")
            .warnings
            .is_empty());
        let html = "we walked along<br>the river line &amp; counted every star in sight tonight oh yes\n";
        assert!(check_lyrics(html).warnings.iter().any(|w| w.contains("HTML")));
        assert!(check_lyrics("hi there").warnings.iter().any(|w| w.contains("whole song")));
    }

    #[test]
    fn chord_detection_leaves_words_alone() {
        assert!(is_chord_line("C G Am F"));
        assert!(is_chord_line("Bbmaj7  Dsus4  E/G#"));
        assert!(is_chord_line("Am7b5 G7sus4 Cadd9"));
        assert!(!is_chord_line("A Day In The Life"));
        assert!(!is_chord_line("Bad Guy"));
        assert!(!is_chord_line("Dad Bad"));
        assert!(!is_chord_line("C"));
    }

    #[test]
    fn language_names_become_tags() {
        assert_eq!(language_tag("English").as_deref(), Some("en"));
        assert_eq!(language_tag(" Deutsch ").as_deref(), Some("de"));
        assert_eq!(language_tag("Español").as_deref(), Some("es"));
        assert_eq!(language_tag("fr").as_deref(), Some("fr"));
        assert_eq!(language_tag("Klingon"), None);
    }

    #[test]
    fn filename_meta() {
        let (t, a) = meta_from_filename(&Path::new("music").join("Robyn - Dancing_On My Own.mp3"));
        assert_eq!((t.as_str(), a.as_deref()), ("Dancing On My Own", Some("Robyn")));
        let (t, a) = meta_from_filename(Path::new("Solo.mp3"));
        assert_eq!((t.as_str(), a), ("Solo", None));
    }
}
