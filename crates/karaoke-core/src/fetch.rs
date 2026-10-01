//! Add from URL: fetch a song's audio from a link with yt-dlp (PLAN.md §5
//! "Add from URL (yt-dlp)", §6). yt-dlp is an external program run as a
//! subprocess — never linked or imported — and Deno, when present, is handed
//! to it as the JavaScript runtime YouTube needs. Everything runs on the
//! user's machine against the link the user pasted; the file lands in their
//! library like any imported song.
//!
//! Formats: the decoder (Symphonia) reads AAC/M4A, MP3, FLAC, WAV and
//! Vorbis, so [`FORMAT_DECODABLE`] asks for one of those. yt-dlp's `ba`
//! (audio-only) filter misses sites that describe audio files with a cover
//! image's resolution (archive.org), hence the plain `[ext=…]` fallbacks.
//! With an ffmpeg on hand, anything else (YouTube's Opus) is converted to
//! FLAC — lossless, so no second generation of loss.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Formats the decoder reads, best first; no conversion needed.
pub const FORMAT_DECODABLE: &str =
    "ba[ext=m4a]/ba[acodec^=mp4a]/[acodec=flac]/[ext=flac]/[ext=wav]/[acodec=mp3]/[ext=mp3]/ba[acodec=vorbis]/b[ext=mp4][acodec^=mp4a]";
/// With ffmpeg: the decodable formats first, then whatever audio there is.
pub const FORMAT_ANY: &str =
    "ba[ext=m4a]/ba[acodec^=mp4a]/[acodec=flac]/[ext=flac]/[ext=wav]/[acodec=mp3]/[ext=mp3]/ba[acodec=vorbis]/ba/b";

const PROGRESS_PREFIX: &str = "KPROG ";
const POSTPROCESS_PREFIX: &str = "KPOST ";
const STDERR_TAIL: usize = 30;
const CHECK_TIMEOUT: Duration = Duration::from_secs(120);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(120);

/// Longest title/artist kept in a file name (Windows paths top out at 260
/// characters, and the job folder repeats the stem).
const NAME_PART_MAX: usize = 60;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The programs Add from URL runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tools {
    pub ytdlp: PathBuf,
    /// JavaScript runtime for YouTube (passed as `--js-runtimes deno:…`).
    pub deno: Option<PathBuf>,
    /// Lets yt-dlp convert audio the decoder can't read.
    pub ffmpeg: Option<PathBuf>,
}

/// `name` with the platform's executable suffix.
pub fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// First `name` executable on PATH.
pub fn on_path(name: &str) -> Option<PathBuf> {
    let file = exe_name(name);
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(&file))
            .find(|p| p.is_file())
    })
}

impl Tools {
    /// Find yt-dlp: `KARAOKE_YTDLP`, then each of `dirs` in order, then
    /// PATH. Deno and ffmpeg are looked up the same way (`KARAOKE_DENO`,
    /// `KARAOKE_FFMPEG`), each optional.
    pub fn locate(dirs: &[PathBuf]) -> Option<Tools> {
        let find = |env: &str, name: &str| -> Option<PathBuf> {
            std::env::var_os(env)
                .map(PathBuf::from)
                .filter(|p| p.is_file())
                .or_else(|| dirs.iter().map(|d| d.join(exe_name(name))).find(|p| p.is_file()))
                .or_else(|| on_path(name))
        };
        Some(Tools {
            ytdlp: find("KARAOKE_YTDLP", "yt-dlp")?,
            deno: find("KARAOKE_DENO", "deno"),
            ffmpeg: find("KARAOKE_FFMPEG", "ffmpeg"),
        })
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.ytdlp);
        // The user's own yt-dlp config files must not reshape our output, and
        // a piped stdout on Windows would otherwise be the ANSI code page —
        // file paths with non-ASCII letters must come back intact.
        cmd.args(["--ignore-config", "--no-warnings", "--encoding", "utf-8"])
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8");
        if let Some(deno) = &self.deno {
            cmd.arg("--js-runtimes").arg(format!("deno:{}", deno.display()));
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    /// `yt-dlp --version`.
    pub fn version(&self) -> Result<String> {
        let out = self.command().arg("--version").output().map_err(|e| spawn_err(&self.ytdlp, e))?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// `yt-dlp -U`: update this copy in place (it must be writable — the
    /// app's data folder, never the install folder). Returns yt-dlp's last
    /// line ("yt-dlp is up to date (…)", "Updated yt-dlp to …").
    pub fn update(&self) -> Result<String> {
        let mut cmd = self.command();
        cmd.arg("-U");
        let run = run_collect(cmd, UPDATE_TIMEOUT, &self.ytdlp)?;
        let last = run.stdout.lines().chain(run.stderr.lines()).rfind(|l| !l.trim().is_empty());
        let msg = last.unwrap_or("").trim().to_string();
        if run.ok {
            Ok(msg)
        } else {
            Err(Error::Fetch(format!("yt-dlp couldn't update itself: {msg}")))
        }
    }

    /// What a link points at: one song, or a playlist's songs (listed flat —
    /// fast, and each one is fetched in full when its turn comes).
    ///
    /// A video opened from a playlist or a YouTube Mix carries the list in
    /// its link (`watch?v=…&list=…`); that's the one video (`--no-playlist`
    /// — yt-dlp's default would take the whole list, dozens of songs for a
    /// Mix). Only a link to the playlist itself expands.
    pub fn check_link(&self, url: &str) -> Result<Vec<Link>> {
        let url = url.trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(Error::InvalidInput(format!("not a web link: {url}")));
        }
        let mut cmd = self.command();
        cmd.args(["-J", "--flat-playlist", "--no-playlist", "--"]).arg(url);
        let run = run_collect(cmd, CHECK_TIMEOUT, &self.ytdlp)?;
        if !run.ok {
            return Err(Error::Fetch(error_message(&run.stderr)));
        }
        let info: RawInfo = serde_json::from_str(run.stdout.trim())
            .map_err(|e| Error::Fetch(format!("yt-dlp sent something we couldn't read: {e}")))?;
        Ok(links_from(info, url))
    }

    /// Download `url`'s audio to `<stem_path>.<ext>`, reporting progress
    /// (`fraction`, message). `cancelled` is polled a few times a second; when
    /// it turns true yt-dlp is stopped and the result is
    /// [`Error::Cancelled`]. A finished file already at that path is reused
    /// (yt-dlp skips the download), so a resumed job doesn't fetch twice.
    pub fn download(
        &self,
        url: &str,
        stem_path: &Path,
        on_progress: &mut dyn FnMut(Option<f64>, &str),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<PathBuf> {
        if let Some(dir) = stem_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let template = format!("{}.%(ext)s", stem_path.display().to_string().replace('%', "%%"));
        let mut cmd = self.command();
        cmd.args(["--no-playlist", "--newline", "--progress", "--no-mtime"])
            .arg("--progress-template")
            .arg(format!(
                "download:{PROGRESS_PREFIX}%(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s"
            ))
            .arg("--progress-template")
            .arg(format!("postprocess:{POSTPROCESS_PREFIX}%(progress.postprocessor)s"))
            .args(["--print", "after_move:filepath"])
            .arg("-o")
            .arg(&template);
        match &self.ffmpeg {
            Some(ff) => {
                cmd.args(["-f", FORMAT_ANY])
                    .arg("--ffmpeg-location")
                    .arg(ff)
                    .args(["-x", "--audio-format", "opus>flac/webm>flac/best"]);
            }
            None => {
                cmd.args(["-f", FORMAT_DECODABLE]);
            }
        }
        cmd.arg("--").arg(url);

        let mut child = cmd.spawn().map_err(|e| spawn_err(&self.ytdlp, e))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let (tx, rx) = mpsc::channel::<Option<String>>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(Some(line)).is_err() {
                    return;
                }
            }
            let _ = tx.send(None);
        });
        let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL)));
        let tail_w = tail.clone();
        let err_thread = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let mut t = tail_w.lock().unwrap();
                if t.len() == STDERR_TAIL {
                    t.pop_front();
                }
                t.push_back(line);
            }
        });

        let mut final_path: Option<PathBuf> = None;
        on_progress(None, "Starting the download");
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(line)) => {
                    if let Some(rest) = line.strip_prefix(PROGRESS_PREFIX) {
                        if let Some(f) = progress_fraction(rest) {
                            on_progress(Some(f), "Downloading");
                        }
                    } else if line.starts_with(POSTPROCESS_PREFIX) {
                        on_progress(None, "Converting the audio");
                    } else {
                        let p = PathBuf::from(line.trim());
                        if !line.trim().is_empty() && p.is_absolute() {
                            final_path = Some(p);
                        }
                    }
                }
                Ok(None) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {
                    if cancelled() {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(Error::Cancelled);
                    }
                }
            }
        }
        let status = child.wait()?;
        let _ = err_thread.join();
        let stderr_text: String = tail.lock().unwrap().iter().map(|l| format!("{l}\n")).collect();
        if !status.success() {
            return Err(Error::Fetch(error_message(&stderr_text)));
        }
        match final_path.filter(|p| p.is_file()) {
            Some(p) => Ok(p),
            None => Err(Error::Fetch("yt-dlp finished but didn't say where it saved the file".into())),
        }
    }
}

/// One song a link points at.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Link {
    /// The song's own page (a playlist entry's, not the playlist's).
    pub url: String,
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_s: Option<f64>,
    /// yt-dlp's extractor name ("Youtube", "archive.org").
    pub site: String,
    /// A JPEG/PNG thumbnail for cover art, when the site lists one.
    pub thumbnail: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawThumb {
    url: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawInfo {
    #[serde(rename = "_type")]
    kind: Option<String>,
    id: Option<String>,
    title: Option<String>,
    track: Option<String>,
    artist: Option<String>,
    artists: Option<Vec<String>>,
    creator: Option<String>,
    uploader: Option<String>,
    channel: Option<String>,
    duration: Option<f64>,
    webpage_url: Option<String>,
    url: Option<String>,
    extractor_key: Option<String>,
    extractor: Option<String>,
    ie_key: Option<String>,
    thumbnail: Option<String>,
    thumbnails: Option<Vec<RawThumb>>,
    entries: Option<Vec<RawInfo>>,
}

fn links_from(info: RawInfo, asked: &str) -> Vec<Link> {
    if info.kind.as_deref() == Some("playlist") {
        let site = info.extractor_key.clone().or(info.extractor.clone()).unwrap_or_default();
        return info
            .entries
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| link_from(e, None, &site))
            .collect();
    }
    let site = info.extractor_key.clone().or(info.extractor.clone()).unwrap_or_default();
    link_from(info, Some(asked), &site).into_iter().collect()
}

fn link_from(e: RawInfo, asked: Option<&str>, site: &str) -> Option<Link> {
    let url = e
        .webpage_url
        .clone()
        .or_else(|| e.url.clone().filter(|u| u.starts_with("http")))
        .or_else(|| asked.map(String::from))?;
    let (title, artist) = song_meta(&e);
    if title.is_empty() {
        return None;
    }
    Some(Link {
        id: e.id.clone().unwrap_or_else(|| url.clone()),
        url,
        title,
        artist,
        duration_s: e.duration.filter(|d| *d > 0.0),
        site: e.ie_key.clone().or(e.extractor_key.clone()).unwrap_or_else(|| site.to_string()),
        thumbnail: pick_thumbnail(&e),
    })
}

/// The largest JPEG/PNG thumbnail (cover art; WebP needs a converter).
fn pick_thumbnail(e: &RawInfo) -> Option<String> {
    let still = |u: &str| {
        let path = u.split(['?', '#']).next().unwrap_or(u).to_lowercase();
        path.ends_with(".jpg") || path.ends_with(".jpeg") || path.ends_with(".png")
    };
    let listed = e
        .thumbnails
        .iter()
        .flatten()
        .filter_map(|t| t.url.as_deref().filter(|u| still(u)).map(|u| (t.width.unwrap_or(0) * t.height.unwrap_or(0), u)))
        .max_by_key(|(area, _)| *area)
        .map(|(_, u)| u.to_string());
    listed.or_else(|| e.thumbnail.clone().filter(|u| still(u)))
}

/// Title and artist for a fetched song: the site's music metadata when it has
/// some (YouTube Music's track/artist, archive.org's creator), else
/// "Artist - Title" read from the video title, else the channel — with video
/// noise ("(Official Video)", "[Lyrics]") taken out so the lyrics lookup
/// matches.
fn song_meta(e: &RawInfo) -> (String, Option<String>) {
    let credited = e
        .artist
        .clone()
        .or_else(|| e.artists.as_ref().filter(|a| !a.is_empty()).map(|a| a.join(", ")))
        .or_else(|| e.creator.clone())
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());
    let raw_title = e.title.clone().unwrap_or_default();
    let (title, artist) = match (e.track.as_deref().map(str::trim).filter(|t| !t.is_empty()), credited) {
        (Some(track), Some(artist)) => (track.to_string(), Some(artist)),
        (track, credited) => match split_artist_title(&raw_title) {
            Some((a, t)) => (t, credited.or(Some(a))),
            None => (track.map(String::from).unwrap_or(raw_title), credited.or_else(|| channel_artist(e))),
        },
    };
    (tidy_case(&clean_title(&title)), artist.map(|a| tidy_case(&clean_artist(&a))).filter(|a| !a.is_empty()))
}

/// "Artist - Title" (also en/em dashes), split at the first dash.
fn split_artist_title(s: &str) -> Option<(String, String)> {
    for sep in [" - ", " – ", " — ", " -- "] {
        if let Some((a, t)) = s.split_once(sep) {
            let (a, t) = (a.trim(), t.trim());
            if !a.is_empty() && !t.is_empty() {
                return Some((a.to_string(), t.to_string()));
            }
        }
    }
    None
}

/// A channel name that reads as an artist: "Artist - Topic" (YouTube's
/// auto-generated music channels), "ArtistVEVO", or a plain name — not an
/// uploader's email address.
fn channel_artist(e: &RawInfo) -> Option<String> {
    let c = e.channel.clone().or_else(|| e.uploader.clone())?;
    let c = c.trim();
    if c.is_empty() || c.contains('@') {
        return None;
    }
    let c = c.strip_suffix(" - Topic").unwrap_or(c);
    let c = c.strip_suffix("VEVO").unwrap_or(c).trim();
    (!c.is_empty()).then(|| c.to_string())
}

/// Words that mark a bracketed group as video noise, not part of the title.
const NOISE: &[&str] = &[
    "official", "video", "audio", "lyric", "lyrics", "visualizer", "visualiser", "hd", "hq", "4k", "remaster",
    "remastered", "mv", "m/v", "explicit", "music", "clip", "live performance", "full song",
];

/// Drop bracketed noise groups and anything after a " | ".
pub fn clean_title(s: &str) -> String {
    let s = s.split(" | ").next().unwrap_or(s);
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find(['(', '[']) {
        let close_ch = if rest[open..].starts_with('(') { ')' } else { ']' };
        match rest[open..].find(close_ch) {
            Some(rel) => {
                let inner = rest[open + 1..open + rel].to_lowercase();
                let noisy = NOISE.iter().any(|w| inner.split(|c: char| !c.is_alphanumeric() && c != '/').any(|t| t == *w) || (w.contains(' ') && inner.contains(w)));
                if noisy {
                    out.push_str(&rest[..open]);
                } else {
                    out.push_str(&rest[..open + rel + 1]);
                }
                rest = &rest[open + rel + 1..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_artist(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_suffix(" - Topic").unwrap_or(s);
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// ALL-CAPS catalogue titles ("TAKE ME OUT TO THE BALL GAME") become title
/// case; anything with lowercase in it is left as written.
fn tidy_case(s: &str) -> String {
    let letters: Vec<char> = s.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() < 4 || letters.iter().any(|c| c.is_lowercase()) {
        return s.to_string();
    }
    s.split(' ')
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(f) => f.to_uppercase().chain(cs.flat_map(char::to_lowercase)).collect(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// File stem for a fetched song: "Artist - Title [id]", safe on every
/// filesystem, short enough for Windows paths. Long ids (archive.org's run
/// to 70+ characters) are shortened to a stable hash.
pub fn file_stem(title: &str, artist: Option<&str>, id: &str) -> String {
    let part = |s: &str| -> String {
        let cleaned: String = s
            .chars()
            .map(|c| if c.is_control() || r#"<>:"/\|?*%"#.contains(c) { ' ' } else { c })
            .collect();
        let words = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
        let cut: String = words.chars().take(NAME_PART_MAX).collect();
        cut.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string()
    };
    let title = part(title);
    let title = if title.is_empty() { "Song".to_string() } else { title };
    let id = part(id);
    let id = if id.len() <= 16 && !id.contains(' ') {
        id
    } else {
        crate::pipeline::hash::sha256_hex(id.as_bytes())[..10].to_string()
    };
    match artist.map(part).filter(|a| !a.is_empty()) {
        Some(a) => format!("{a} - {title} [{id}]"),
        None => format!("{title} [{id}]"),
    }
}

/// `downloaded total estimate` (yt-dlp prints "NA" for unknowns).
fn progress_fraction(rest: &str) -> Option<f64> {
    let mut it = rest.split_whitespace().map(|t| t.parse::<f64>().ok());
    let done = it.next().flatten()?;
    let total = it.next().flatten();
    let estimate = it.next().flatten();
    let total = total.or(estimate).filter(|t| *t > 0.0)?;
    Some((done / total).clamp(0.0, 1.0))
}

/// yt-dlp's "ERROR: …" lines, minus the "[site] id:" prefix, with a plain
/// explanation for the failures people actually hit.
fn error_message(stderr: &str) -> String {
    let errors: Vec<&str> = stderr
        .lines()
        .filter_map(|l| l.trim().strip_prefix("ERROR:"))
        .map(str::trim)
        .collect();
    let raw = if errors.is_empty() {
        stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("yt-dlp failed").trim().to_string()
    } else {
        errors.join(" ")
    };
    // "[youtube] abc123: Video unavailable" → "Video unavailable"
    let msg = match raw.strip_prefix('[').and_then(|r| r.split_once("] ")).and_then(|(_, r)| r.split_once(": ")) {
        Some((_, m)) => m.to_string(),
        None => raw.clone(),
    };
    if msg.contains("Requested format is not available") {
        return "This link doesn't offer audio baritoad can read (AAC, MP3, FLAC, WAV or Vorbis), and there's no ffmpeg to convert it.".into();
    }
    if msg.contains("Unsupported URL") {
        return "yt-dlp doesn't know how to get audio from this link.".into();
    }
    msg
}

struct Collected {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Run to completion with a time limit, collecting both streams.
fn run_collect(mut cmd: Command, limit: Duration, exe: &Path) -> Result<Collected> {
    let mut child = cmd.spawn().map_err(|e| spawn_err(exe, e))?;
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut out, &mut s);
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut err, &mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Fetch(format!("yt-dlp took longer than {} s and was stopped", limit.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    Ok(Collected {
        ok: status.success(),
        stdout: out_t.join().unwrap_or_default(),
        stderr: err_t.join().unwrap_or_default(),
    })
}

fn spawn_err(exe: &Path, e: std::io::Error) -> Error {
    Error::Fetch(format!("couldn't start {}: {e}", exe.display()))
}

/// Download a small file (cover art) over HTTPS with the system TLS stack.
pub fn download_small(url: &str, dest: &Path, user_agent: &str) -> Result<()> {
    const LIMIT: u64 = 10 * 1024 * 1024;
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(20)))
            .user_agent(user_agent)
            .tls_config(tls)
            .build(),
    );
    let mut resp = agent.get(url).call().map_err(|e| Error::Network(format!("{url}: {e}")))?;
    let bytes = resp
        .body_mut()
        .with_config()
        .limit(LIMIT)
        .read_to_vec()
        .map_err(|e| Error::Network(format!("{url}: {e}")))?;
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(dest, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(json: &str) -> RawInfo {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn music_metadata_wins_and_catalogue_caps_are_tidied() {
        // archive.org's shape (a 1908 public-domain 78).
        let e = info(r#"{"_type":"video","id":"78_take-me-out","title":"TAKE ME OUT TO THE BALL GAME",
            "track":"TAKE ME OUT TO THE BALL GAME","creator":"Harvey Hindermeyer","uploader":"uploader@example.org",
            "duration":157.62,"extractor_key":"ArchiveOrg","webpage_url":"https://archive.org/details/78_take-me-out"}"#);
        assert_eq!(song_meta(&e), ("Take Me Out To The Ball Game".into(), Some("Harvey Hindermeyer".into())));
    }

    #[test]
    fn video_titles_split_and_lose_their_noise() {
        let e = info(r#"{"title":"Some Artist - Some Song (Official Music Video) [HD]","channel":"SomeArtistVEVO"}"#);
        assert_eq!(song_meta(&e), ("Some Song".into(), Some("Some Artist".into())));
        let e = info(r#"{"title":"Another Song (Lyrics) | Big Playlist Channel","channel":"Another Artist - Topic"}"#);
        assert_eq!(song_meta(&e), ("Another Song".into(), Some("Another Artist".into())));
        // Brackets that are part of the title stay.
        let e = info(r#"{"title":"Band - Song (Part II) (Official Audio)"}"#);
        assert_eq!(song_meta(&e), ("Song (Part II)".into(), Some("Band".into())));
        let e = info(r#"{"title":"Band - Song (feat. Guest) [Official Video]"}"#);
        assert_eq!(song_meta(&e).0, "Song (feat. Guest)");
    }

    #[test]
    fn email_uploaders_are_not_artists() {
        let e = info(r#"{"title":"A Plain Title","uploader":"someone@example.org"}"#);
        assert_eq!(song_meta(&e), ("A Plain Title".into(), None));
    }

    #[test]
    fn playlists_list_their_entries() {
        let e = info(r#"{"_type":"playlist","id":"PL1","title":"Party","extractor_key":"YoutubeTab","entries":[
            {"_type":"url","ie_key":"Youtube","id":"aaaaaaaaaaa","url":"https://www.youtube.com/watch?v=aaaaaaaaaaa",
             "title":"First Band - First Song","duration":201.0,"channel":"First Band"},
            {"_type":"url","ie_key":"Youtube","id":"bbbbbbbbbbb","url":"https://www.youtube.com/watch?v=bbbbbbbbbbb",
             "title":"Second Song (Official Video)","duration":180.5,"channel":"Second Band - Topic",
             "thumbnails":[{"url":"https://i.ytimg.com/vi/b/hqdefault.jpg?x=1","width":480,"height":360},
                           {"url":"https://i.ytimg.com/vi/b/maxres.webp","width":1280,"height":720}]}]}"#);
        let links = links_from(e, "https://www.youtube.com/playlist?list=PL1");
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].url, "https://www.youtube.com/watch?v=aaaaaaaaaaa");
        assert_eq!((links[0].title.as_str(), links[0].artist.as_deref()), ("First Song", Some("First Band")));
        assert_eq!((links[1].title.as_str(), links[1].artist.as_deref()), ("Second Song", Some("Second Band")));
        assert_eq!(links[1].site, "Youtube");
        assert_eq!(links[1].thumbnail.as_deref(), Some("https://i.ytimg.com/vi/b/hqdefault.jpg?x=1"));
    }

    #[test]
    fn a_single_video_keeps_the_asked_url_when_the_site_gives_none() {
        let e = info(r#"{"_type":"video","id":"x1","title":"Song","duration":90}"#);
        let links = links_from(e, "https://example.org/v/x1");
        assert_eq!(links[0].url, "https://example.org/v/x1");
        assert_eq!(links[0].duration_s, Some(90.0));
    }

    #[test]
    fn file_stems_are_safe_and_short() {
        assert_eq!(file_stem("Song: Part 1?", Some("A/B"), "abc123DEF45"), "A B - Song Part 1 [abc123DEF45]");
        let long = "x".repeat(200);
        let stem = file_stem(&long, None, "78_take-me-out-to-the-ball-game_harvey-hindermeyer_gbia0111514b");
        assert!(stem.len() < 80, "{stem}");
        assert!(stem.ends_with(']'));
        // the hash is stable, so a resumed job finds its own file again
        assert_eq!(stem, file_stem(&long, None, "78_take-me-out-to-the-ball-game_harvey-hindermeyer_gbia0111514b"));
        assert_eq!(file_stem("   ", None, "id"), "Song [id]");
        assert!(!file_stem("100% Pure", None, "id").contains('%'));
    }

    #[test]
    fn progress_lines_parse_with_unknown_totals() {
        assert_eq!(progress_fraction("50 100 NA"), Some(0.5));
        assert_eq!(progress_fraction("50 NA 200"), Some(0.25));
        assert_eq!(progress_fraction("50 NA NA"), None);
        assert_eq!(progress_fraction("NA NA NA"), None);
    }

    #[test]
    fn errors_read_plainly() {
        let stderr = "WARNING: something\nERROR: [youtube] abc: Video unavailable. This video is private\n";
        assert_eq!(error_message(stderr), "Video unavailable. This video is private");
        let fmt = "ERROR: [archive.org] x: Requested format is not available. Use --list-formats";
        assert!(error_message(fmt).contains("doesn't offer audio baritoad can read"));
        assert_eq!(error_message("plain failure\n"), "plain failure");
    }
}
