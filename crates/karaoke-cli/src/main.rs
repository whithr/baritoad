//! `karaoke` — command-line front end for the karaoke pipeline
//! (GPL-3.0-or-later).
//!
//! Phase 1:
//! - `karaoke generate` — the full pipeline (separate → clean lyrics → align
//!   → export) as a resumable job with a persisted manifest
//! - `karaoke jobs list` — every job the registry knows, with status
//! - `karaoke accuracy` — word-timing error vs hand-made UltraStar
//!   references, plus the synthetic `--self-check`
//! - `karaoke separate` — split a user-owned song into vocals + instrumental
//! - `karaoke align` — word-align pasted lyrics to the vocal stem (runs
//!   separation first when no stem is provided; auto-transcribes when no
//!   lyrics are given). Pasted lyrics go through the cleanup
//!   pass first; the change summary lands on stderr (and in `--json`).
//! - `karaoke export` — render a timing map as LRC / ASS / UltraStar
//! - `karaoke lyrics clean` — dry-run preview of the lyric cleanup pass
//! - `karaoke scan` — how the desktop app's Import Folder… will read a folder:
//!   each song's lyrics pairing, title/artist, collection, and lyrics-format
//!   problems (`--json` for agents preparing a folder — docs/IMPORTING.md)
//!
//! Progress goes to stderr; `--json` puts a machine-readable summary on stdout.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::{Args, Parser, Subcommand, ValueEnum};

use karaoke_core::accuracy::{self, AccuracyReport, ErrorStats, SELF_CHECK_BOUND_MS};
use karaoke_core::alignment::{AlignConfig, Aligner};
use karaoke_core::audio;
use karaoke_core::formats::{self, lrc, ultrastar, ExportMeta, Format};
use karaoke_core::import::{self, LyricsFile};
use karaoke_core::lyrics::{self, CleanLyrics};
use karaoke_core::pipeline::manifest::{self, JobManifest, StageId};
use karaoke_core::pipeline::{self, GenerateRequest, PipelineEvent};
use karaoke_core::timing::WordTimingMap;
use karaoke_core::output::{FileSink, OutputFile, OutputFormat, StemSink};
use karaoke_core::separation::{self, EpChoice, Event, ParityReport, SeparateStats};
use karaoke_core::timing::LyricSource;

#[derive(Parser)]
#[command(
    name = "karaoke",
    version,
    about = "Turn a song you own into a karaoke track — local processing only"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the full pipeline (separate → clean lyrics → align → export) as a
    /// resumable job — reruns skip stages whose inputs are unchanged
    Generate(GenerateArgs),
    /// Job registry
    #[command(subcommand)]
    Jobs(JobsCmd),
    /// Word-timing accuracy vs a hand-made UltraStar reference (or the
    /// synthetic export→import self-check)
    Accuracy(AccuracyArgs),
    /// Separate a song into vocals + instrumental (drums/bass/other mixed down)
    Separate(SeparateArgs),
    /// Word-align lyrics to a song's vocal stem (separates first if needed;
    /// auto-transcribes when no lyrics are given)
    Align(AlignArgs),
    /// Export a timing map to a karaoke interchange format (Enhanced LRC,
    /// ASS karaoke subtitles, or UltraStar .txt)
    Export(ExportArgs),
    /// Lyric utilities
    #[command(subcommand)]
    Lyrics(LyricsCmd),
    /// Show how Import Folder… (desktop app) will read folders or files:
    /// which lyrics each song pairs with, its title/artist and collection,
    /// and lyrics-format problems worth fixing first. Reads only — nothing
    /// is imported or changed.
    Scan(ScanArgs),
}

#[derive(Args)]
struct ScanArgs {
    /// Folders (searched recursively) and/or audio files
    #[arg(required = true)]
    paths: Vec<PathBuf>,

    /// Print a machine-readable JSON report to stdout
    #[arg(long)]
    json: bool,

    /// Exit with an error while any lyrics file has warnings or matched no
    /// song. (Songs without lyrics are fine — they get transcribed.)
    #[arg(long)]
    strict: bool,

    /// With --strict, also fail while any song has no usable lyrics
    #[arg(long, requires = "strict")]
    require_lyrics: bool,
}

#[derive(Args)]
struct GenerateArgs {
    /// Input audio file — the original song the user owns
    audio: PathBuf,

    /// Text file with pasted lyrics (golden path; auto-transcribes when
    /// omitted). Changing this file later re-runs cleanup + align + export
    /// on the next `generate` while reusing the stems.
    #[arg(long)]
    lyrics: Option<PathBuf>,

    /// Export formats, comma-separated (default: lrc,ass,ultrastar)
    #[arg(long, value_delimiter = ',')]
    export: Vec<ExportFormatArg>,

    /// Output directory for stems, map, exports, and the job manifest
    /// (default: "<input stem>-karaoke" next to the input)
    #[arg(long)]
    out_dir: Option<PathBuf>,

    /// Model root containing htdemucs.onnx, whisper-small/ and wav2vec2/
    /// (default: %LOCALAPPDATA%\baritoad\models)
    #[arg(long)]
    model_dir: Option<PathBuf>,

    /// Jobs registry directory (default: %LOCALAPPDATA%\baritoad\jobs)
    #[arg(long)]
    jobs_dir: Option<PathBuf>,

    /// Execution provider. `auto` runs separation, wav2vec2, and the whisper
    /// encoder on DirectML (each parity-gated, falling back to CPU); `cpu`
    /// pins everything to the CPU.
    #[arg(long, value_enum, default_value_t = EpArg::Auto)]
    ep: EpArg,

    /// Separation model (htdemucs-ft = the four fine-tuned files, 4x slower)
    #[arg(long = "sep-model", value_enum, default_value_t = ModelArg::Htdemucs)]
    sep_model: ModelArg,

    /// Separation segment overlap fraction, 0..=0.9 (default 0.25)
    #[arg(long = "sep-overlap", default_value_t = 0.25)]
    sep_overlap: f32,

    /// Separation pinned-shift passes to average (default 0)
    #[arg(long = "sep-shifts", default_value_t = 0)]
    sep_shifts: usize,

    /// Use the dynamic-quantized whisper decoder
    #[arg(long)]
    int8: bool,

    /// Onset-bias correction in seconds (default: the spike-measured -0.055)
    #[arg(long, allow_hyphen_values = true)]
    onset_bias: Option<f64>,

    /// Song title for exports (default: the audio file stem)
    #[arg(long)]
    title: Option<String>,

    /// Artist name for exports
    #[arg(long)]
    artist: Option<String>,

    /// Redo every stage, ignoring the manifest
    #[arg(long)]
    force: bool,

    /// Redo one stage (repeatable); downstream stages rerun automatically
    #[arg(long = "force-stage", value_enum)]
    force_stage: Vec<StageArg>,

    /// Print the machine-readable job summary to stdout
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum StageArg {
    Separate,
    CleanLyrics,
    Align,
    Export,
}

impl From<StageArg> for StageId {
    fn from(v: StageArg) -> Self {
        match v {
            StageArg::Separate => StageId::Separate,
            StageArg::CleanLyrics => StageId::CleanLyrics,
            StageArg::Align => StageId::Align,
            StageArg::Export => StageId::Export,
        }
    }
}

#[derive(Subcommand)]
enum JobsCmd {
    /// List every job in the registry, newest first
    List(JobsListArgs),
}

#[derive(Args)]
struct JobsListArgs {
    /// Jobs registry directory (default: %LOCALAPPDATA%\baritoad\jobs)
    #[arg(long)]
    jobs_dir: Option<PathBuf>,

    /// Print machine-readable JSON to stdout
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct AccuracyArgs {
    /// What to grade: a job out-dir (or its job.json), a timing-map
    /// .align.json, or an audio file (the pipeline runs / resumes first).
    /// Omit when using --suite.
    target: Option<PathBuf>,

    /// Hand-made UltraStar .txt reference to grade against
    #[arg(long = "ref")]
    reference: Option<PathBuf>,

    /// Synthetic self-check: export the map as UltraStar, re-import, grade
    /// against the same map — error must stay within one beat (50 ms)
    #[arg(long)]
    self_check: bool,

    /// Grade a folder of (audio + reference .txt) pairs in one run:
    /// "<stem>.ultrastar.txt" (or "<stem>.txt") beside each audio file is
    /// the reference; optional "<stem>.lyrics.txt" is pasted lyrics
    #[arg(long)]
    suite: Option<PathBuf>,

    /// Pasted-lyrics file (single-target mode, when the pipeline must run)
    #[arg(long)]
    lyrics: Option<PathBuf>,

    /// Model root (default: %LOCALAPPDATA%\baritoad\models)
    #[arg(long)]
    model_dir: Option<PathBuf>,

    /// Jobs registry directory (default: %LOCALAPPDATA%\baritoad\jobs)
    #[arg(long)]
    jobs_dir: Option<PathBuf>,

    /// Execution provider when the pipeline runs
    #[arg(long, value_enum, default_value_t = EpArg::Auto)]
    ep: EpArg,

    /// Print machine-readable JSON to stdout
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct ExportArgs {
    /// Timing-map JSON produced by `karaoke align`
    map: PathBuf,

    /// Output format
    #[arg(long, value_enum)]
    format: ExportFormatArg,

    /// Output file (default: beside the map, "<song>.<ext>" — e.g.
    /// "song.align.json" -> "song.lrc" / "song.ass" / "song.ultrastar.txt")
    #[arg(long)]
    out: Option<PathBuf>,

    /// Audio file name the export should reference (UltraStar #MP3);
    /// omitted from the file when not given
    #[arg(long)]
    audio_name: Option<String>,

    /// Song title (default: derived from the map's file name)
    #[arg(long)]
    title: Option<String>,

    /// Artist name
    #[arg(long)]
    artist: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum ExportFormatArg {
    Lrc,
    Ass,
    Ultrastar,
}

impl From<ExportFormatArg> for Format {
    fn from(v: ExportFormatArg) -> Self {
        match v {
            ExportFormatArg::Lrc => Format::Lrc,
            ExportFormatArg::Ass => Format::Ass,
            ExportFormatArg::Ultrastar => Format::UltraStar,
        }
    }
}

#[derive(Subcommand)]
enum LyricsCmd {
    /// Dry-run the lyric cleanup pass: cleaned text on stdout, change
    /// summary on stderr — nothing is written
    Clean(LyricsCleanArgs),
}

#[derive(Args)]
struct LyricsCleanArgs {
    /// Text file with pasted lyrics (Genius/AZLyrics-style dirt is fine)
    file: PathBuf,

    /// Print a machine-readable JSON report (lines, words, edits) to stdout
    /// instead of the cleaned text
    #[arg(long)]
    json: bool,

    /// Only the change summary and counts (stderr) — no lyrics text printed
    #[arg(long, conflicts_with = "json")]
    summary: bool,
}

#[derive(Args)]
struct SeparateArgs {
    /// Input audio file (mp3/flac/wav/m4a/ogg)
    audio: PathBuf,

    /// Output directory (default: "<input stem>-stems" next to the input)
    #[arg(long)]
    out_dir: Option<PathBuf>,

    /// Directory containing htdemucs.onnx
    /// (default: %LOCALAPPDATA%\baritoad\models)
    #[arg(long)]
    model_dir: Option<PathBuf>,

    /// Execution provider
    #[arg(long, value_enum, default_value_t = EpArg::Auto)]
    ep: EpArg,

    /// Output format for the stems
    #[arg(long, value_enum, default_value_t = FormatArg::Wav)]
    format: FormatArg,

    /// Also write the individual drums/bass/other stems
    #[arg(long)]
    all_stems: bool,

    /// Separation model (htdemucs-ft needs the four htdemucs_ft_*.onnx
    /// files in the model dir; 4x inference time, best quality)
    #[arg(long, value_enum, default_value_t = ModelArg::Htdemucs)]
    model: ModelArg,

    /// Segment overlap fraction, 0..=0.9 (higher = fewer seam artifacts,
    /// ~1/(1-overlap)x inference time; demucs default 0.25)
    #[arg(long, default_value_t = 0.25)]
    overlap: f32,

    /// Pinned-shift passes to average (demucs shift trick, made
    /// deterministic; 0 = off, each pass costs one full inference sweep)
    #[arg(long, default_value_t = 0)]
    shifts: usize,

    /// Print a machine-readable JSON summary to stdout
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct AlignArgs {
    /// Input audio file — the original song the user owns
    audio: PathBuf,

    /// Text file with the pasted lyrics (ground truth; whisper is only used
    /// for rough anchors). The cleanup pass runs automatically.
    /// When omitted, the vocal stem is auto-transcribed and the whisper
    /// transcript becomes the lyric source (marked as such in the output) —
    /// pasted lyrics are dramatically more accurate.
    #[arg(long)]
    lyrics: Option<PathBuf>,

    /// Pre-separated vocal stem (skips the separation stage)
    #[arg(long)]
    vocals: Option<PathBuf>,

    /// Output timing-map path (default: "<input stem>.align.json" next to the input)
    #[arg(long)]
    out: Option<PathBuf>,

    /// Model root containing htdemucs.onnx, whisper-small/ and wav2vec2/
    /// (default: %LOCALAPPDATA%\baritoad\models)
    #[arg(long)]
    model_dir: Option<PathBuf>,

    /// Execution provider. The whisper decoder always runs on CPU (DirectML
    /// measured 4x slower for it — spike REPORT). Here DirectML for wav2vec2
    /// and the whisper encoder is opt-in (`dml`, parity-gated, 10 s
    /// dispatches under the TDR watchdog — alignment::w2v docs); `auto` uses
    /// DML for separation only. (`generate` and the app use it for both.)
    #[arg(long, value_enum, default_value_t = EpArg::Auto)]
    ep: EpArg,

    /// Use the dynamic-quantized whisper decoder (faster, slightly lower fidelity)
    #[arg(long)]
    int8: bool,

    /// Also run whisper over pasted lyrics to report per-word anchors
    /// (diagnostic; the alignment itself never uses them, so it is off by
    /// default and the anchored % reads 0 without it)
    #[arg(long)]
    whisper_anchors: bool,

    /// Onset-bias correction in seconds (default: the spike-measured -0.055)
    #[arg(long, allow_hyphen_values = true)]
    onset_bias: Option<f64>,

    /// Also export the timing map in these formats, written beside the map
    /// (comma-separated: lrc,ass,ultrastar)
    #[arg(long, value_delimiter = ',')]
    export: Vec<ExportFormatArg>,

    /// Print a machine-readable JSON summary to stdout
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Copy, ValueEnum)]
enum EpArg {
    Auto,
    Dml,
    Cpu,
}

impl From<EpArg> for EpChoice {
    fn from(v: EpArg) -> Self {
        match v {
            EpArg::Auto => EpChoice::Auto,
            EpArg::Dml => EpChoice::DirectML,
            EpArg::Cpu => EpChoice::Cpu,
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum ModelArg {
    Htdemucs,
    HtdemucsFt,
}

impl From<ModelArg> for separation::ModelKind {
    fn from(v: ModelArg) -> Self {
        match v {
            ModelArg::Htdemucs => separation::ModelKind::Htdemucs,
            ModelArg::HtdemucsFt => separation::ModelKind::HtdemucsFt,
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum FormatArg {
    Wav,
    Flac,
}

impl From<FormatArg> for OutputFormat {
    fn from(v: FormatArg) -> Self {
        match v {
            FormatArg::Wav => OutputFormat::Wav,
            FormatArg::Flac => OutputFormat::Flac,
        }
    }
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.cmd {
        Cmd::Generate(args) => run_generate(&args),
        Cmd::Jobs(JobsCmd::List(args)) => run_jobs_list(&args),
        Cmd::Accuracy(args) => run_accuracy(&args),
        Cmd::Separate(args) => run_separate(&args),
        Cmd::Align(args) => run_align(&args),
        Cmd::Export(args) => run_export(&args),
        Cmd::Lyrics(LyricsCmd::Clean(args)) => run_lyrics_clean(&args),
        Cmd::Scan(args) => run_scan(&args),
    };
    let code = match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn default_stems_dir(audio: &Path) -> PathBuf {
    let stem = audio
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "song".into());
    audio
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join(format!("{stem}-stems"))
}

/// One full separation run: decode → model+parity → streamed separate → files.
struct SeparationRun {
    files: Vec<OutputFile>,
    stats: SeparateStats,
    ep_used: separation::EpKind,
    reports: Vec<ParityReport>,
    duration_s: f64,
    source_sample_rate: u32,
    source_channels: usize,
    decode_notes: Vec<String>,
    decode_s: f64,
    model_init_s: f64,
    parity_s: f64,
    separate_s: f64,
    write_s: f64,
}

impl SeparationRun {
    fn vocals_path(&self) -> Option<&Path> {
        self.files
            .iter()
            .find(|f| f.name == "vocals")
            .map(|f| f.path.as_path())
    }
}

fn separate_file(
    audio_path: &Path,
    out_dir: &Path,
    model_dir: &Path,
    ep: EpChoice,
    format: OutputFormat,
    all_stems: bool,
    opts: separation::SeparateOptions,
    model: separation::ModelKind,
) -> Result<SeparationRun, Box<dyn std::error::Error>> {
    let parity_cache = separation::default_parity_cache_path();

    eprintln!("decoding {} ...", audio_path.display());
    let t0 = Instant::now();
    let decoded = audio::decode_to_stereo_44k(audio_path)?;
    let decode_s = t0.elapsed().as_secs_f64();
    for note in &decoded.notes {
        eprintln!("  note: {note}");
    }
    eprintln!(
        "  {:.1}s audio ({} Hz, {} ch source) decoded in {:.2}s",
        decoded.duration_seconds(),
        decoded.source_sample_rate,
        decoded.source_channels,
        decode_s
    );

    // Pass plan: normally one pass over one resident session set. htdemucs_ft
    // with --all-stems must never hold four sessions at once on a GPU
    // (ModelKind docs: VRAM peak hangs the device) — it stages one sub-model
    // at a time, dropping each session before the next; the vocals pass also
    // writes the instrumental (mix − vocals).
    enum PassSink {
        Main { all_stems: bool },
        Single { stem: usize, name: &'static str },
    }
    type Pass = (Vec<PathBuf>, PassSink, Option<&'static str>);
    let passes: Vec<Pass> = if model == separation::ModelKind::HtdemucsFt && all_stems {
        (0..separation::NUM_SOURCES)
            .map(|k| {
                (
                    vec![model_dir.join(separation::FT_MODEL_FILE_NAMES[k])],
                    if k == separation::VOCALS_INDEX {
                        PassSink::Main { all_stems: false }
                    } else {
                        PassSink::Single {
                            stem: k,
                            name: separation::SOURCES[k],
                        }
                    },
                    Some(separation::SOURCES[k]),
                )
            })
            .collect()
    } else {
        vec![(
            model.paths_for(model_dir, all_stems),
            PassSink::Main { all_stems },
            None,
        )]
    };

    let mut on_event = |e: &Event| match e {
        Event::ModelInit { ep } => eprintln!("loading model on {ep} ..."),
        Event::ModelReady { ep, seconds } => {
            eprintln!("  {ep} session ready in {seconds:.2}s")
        }
        Event::ParityCheck { ep } => {
            eprintln!("  golden-segment parity check ({ep}) ...")
        }
        Event::Parity(r) => match (r.snr_db, r.from_cache) {
            (Some(snr), false) => eprintln!(
                "  parity {}: {:.1} dB vs CPU baseline -> {}",
                r.ep,
                snr,
                if r.passed { "pass" } else { "FAIL" }
            ),
            (Some(snr), true) => {
                eprintln!("  parity {}: pass (cached, {:.1} dB)", r.ep, snr)
            }
            (None, true) => eprintln!("  parity {}: pass (cached)", r.ep),
            (None, false) => eprintln!(
                "  sanity {}: {}",
                r.ep,
                if r.passed { "pass" } else { "FAIL" }
            ),
        },
        Event::Fallback { from, reason } => {
            eprintln!("  {from} unusable: {reason}")
        }
        Event::Note(n) => eprintln!("  note: {n}"),
    };
    let mut files: Vec<OutputFile> = Vec::new();
    let mut reports: Vec<ParityReport> = Vec::new();
    let mut ep_used: Option<separation::EpKind> = None;
    let mut segments = 0usize;
    let mut infer_seconds = 0.0f64;
    let mut model_init_s = 0.0f64;
    let mut parity_s = 0.0f64;
    let mut separate_s = 0.0f64;
    let mut write_s = 0.0f64;

    for (paths, sink_spec, label) in passes {
        if let Some(l) = label {
            eprintln!("[{l} sub-model]");
        }
        let prepared =
            separation::prepare_model(&paths, ep, Some(&parity_cache), &mut on_event)?;
        let pass_ep = prepared.model.ep;
        ep_used.get_or_insert(pass_ep);
        model_init_s += prepared.init_seconds;
        parity_s += prepared.parity_seconds;
        reports.extend(prepared.reports);

        let mut sink = match sink_spec {
            PassSink::Main { all_stems } => FileSink::new(out_dir, format, all_stems)?,
            PassSink::Single { stem, name } => {
                FileSink::single_stem(out_dir, format, stem, name)?
            }
        };
        let t1 = Instant::now();
        let mut pass_model = prepared.model;
        let stats = separation::separate_streamed(
            &decoded.samples,
            decoded.len,
            &mut pass_model,
            &mut sink,
            opts,
            &mut |done, total| {
                match label {
                    Some(l) => eprint!("\rseparating [{l}]: {done}/{total} segments"),
                    None => eprint!("\rseparating: {done}/{total} segments"),
                }
                let _ = std::io::stderr().flush();
            },
        )?;
        eprintln!();
        // Free the session (and its GPU memory) before the next staged pass
        // builds one — the whole point of staging.
        drop(pass_model);
        let pass_separate_s = t1.elapsed().as_secs_f64();
        separate_s += pass_separate_s;
        let t2 = Instant::now();
        files.extend(sink.finalize()?);
        write_s += t2.elapsed().as_secs_f64();
        segments += stats.segments;
        eprintln!(
            "separation pass done: {} segments in {:.1}s (inference {:.1}s, {pass_ep})",
            stats.segments, pass_separate_s, stats.infer_seconds
        );
        infer_seconds += stats.infer_seconds;
    }
    for f in &files {
        eprintln!("  wrote {}", f.path.display());
    }

    Ok(SeparationRun {
        files,
        stats: SeparateStats {
            segments,
            infer_seconds,
        },
        ep_used: ep_used.expect("at least one separation pass"),
        reports,
        duration_s: decoded.duration_seconds(),
        source_sample_rate: decoded.source_sample_rate,
        source_channels: decoded.source_channels,
        decode_notes: decoded.notes,
        decode_s,
        model_init_s,
        parity_s,
        separate_s,
        write_s,
    })
}

fn run_separate(args: &SeparateArgs) -> Result<(), Box<dyn std::error::Error>> {
    let t_total = Instant::now();
    let model_dir = args
        .model_dir
        .clone()
        .unwrap_or_else(separation::default_model_dir);
    let out_dir = args
        .out_dir
        .clone()
        .unwrap_or_else(|| default_stems_dir(&args.audio));

    let run = separate_file(
        &args.audio,
        &out_dir,
        &model_dir,
        args.ep.into(),
        args.format.into(),
        args.all_stems,
        separation::SeparateOptions {
            overlap: args.overlap,
            shifts: args.shifts,
        },
        args.model.into(),
    )?;
    let total_s = t_total.elapsed().as_secs_f64();

    if args.json {
        let model: separation::ModelKind = args.model.into();
        let model_paths = model.paths_for(&model_dir, args.all_stems);
        let summary = serde_json::json!({
            "input": args.audio,
            "duration_s": run.duration_s,
            "source_sample_rate": run.source_sample_rate,
            "source_channels": run.source_channels,
            "decode_notes": run.decode_notes,
            "model": {
                "kind": model.as_str(),
                "paths": model_paths,
                "size_bytes": model_paths
                    .iter()
                    .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
                    .sum::<u64>(),
            },
            "quality": { "overlap": args.overlap, "shifts": args.shifts },
            "ep_requested": EpChoice::from(args.ep).as_str(),
            "ep_used": run.ep_used.as_str(),
            "parity": parity_json(&run.reports),
            "segments": run.stats.segments,
            "outputs": run.files,
            "timings_s": {
                "decode": round3(run.decode_s),
                "model_init": round3(run.model_init_s),
                "parity": round3(run.parity_s),
                "separate": round3(run.separate_s),
                "inference": round3(run.stats.infer_seconds),
                "write": round3(run.write_s),
                "total": round3(total_s),
            },
        });
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        println!(
            "separated {} -> {} ({} segments, {} in {:.1}s)",
            args.audio.display(),
            out_dir.display(),
            run.stats.segments,
            run.ep_used,
            total_s
        );
    }
    Ok(())
}

fn run_align(args: &AlignArgs) -> Result<(), Box<dyn std::error::Error>> {
    let t_total = Instant::now();
    let model_dir = args
        .model_dir
        .clone()
        .unwrap_or_else(separation::default_model_dir);

    // ---- lyric cleanup pass (runs before alignment) ----
    let cleaned: Option<CleanLyrics> = match &args.lyrics {
        Some(path) => {
            let raw = std::fs::read_to_string(path)
                .map_err(|e| format!("cannot read lyrics {}: {e}", path.display()))?;
            let c = lyrics::clean(&raw);
            eprintln!("lyric cleanup: {}", c.summary());
            for e in &c.edits {
                eprintln!("  {e}");
            }
            if c.word_count() == 0 {
                return Err("lyrics contain no words after cleanup".into());
            }
            Some(c)
        }
        None => {
            eprintln!(
                "no --lyrics given: will auto-transcribe the vocal stem \
                 (pasted lyrics give dramatically better alignment)"
            );
            None
        }
    };

    // ---- get the vocal stem (production input for alignment) ----
    let mut separation_run: Option<SeparationRun> = None;
    let vocals_path: PathBuf = match &args.vocals {
        Some(p) => {
            eprintln!("using provided vocal stem {}", p.display());
            p.clone()
        }
        None => {
            let stems_dir = default_stems_dir(&args.audio);
            let existing = stems_dir.join("vocals.wav");
            if existing.is_file() {
                eprintln!(
                    "reusing existing vocal stem {} (delete it to re-separate)",
                    existing.display()
                );
                existing
            } else {
                let run = separate_file(
                    &args.audio,
                    &stems_dir,
                    &model_dir,
                    args.ep.into(),
                    OutputFormat::Wav,
                    false,
                    separation::SeparateOptions::default(),
                    separation::ModelKind::Htdemucs,
                )?;
                let p = run
                    .vocals_path()
                    .ok_or("separation produced no vocals output")?
                    .to_path_buf();
                separation_run = Some(run);
                p
            }
        }
    };

    // ---- decode stem to 16 kHz mono on the original-song timeline ----
    let t0 = Instant::now();
    let vocals = audio::decode_to_mono_16k(&vocals_path)?;
    let decode_s = t0.elapsed().as_secs_f64();
    eprintln!(
        "vocal stem: {:.1}s decoded to 16 kHz mono in {decode_s:.2}s",
        vocals.duration_s
    );

    // ---- load aligner (sessions reused across chunks; whisper on CPU) ----
    let cfg = AlignConfig {
        whisper_int8: args.int8,
        // DML for wav2vec2 is explicit-opt-in only (TDR risk — see
        // karaoke_core::alignment::w2v module docs)
        w2v_try_dml: matches!(args.ep, EpArg::Dml),
        whisper_anchors: args.whisper_anchors,
        onset_bias_s: args
            .onset_bias
            .unwrap_or(karaoke_core::alignment::CTC_ONSET_BIAS_S),
        ..AlignConfig::default()
    };
    let t1 = Instant::now();
    let (mut aligner, notes) = Aligner::load(&model_dir, cfg)?;
    let load_s = t1.elapsed().as_secs_f64();
    for n in &notes {
        eprintln!("  note: {n}");
    }
    eprintln!("alignment models loaded in {load_s:.1}s");

    // ---- align ----
    let mut progress = |_fraction: Option<f64>, m: &str| eprintln!("  {m}");
    let mut out = match &cleaned {
        Some(c) => {
            let words = c.lyric_words();
            aligner.align_words(&vocals.samples, &words, &mut progress)?
        }
        None => aligner.align_transcribe(&vocals.samples, &mut progress)?,
    };
    if let Some(c) = &cleaned {
        // stable link back to lyric line/word structure (exporters are
        // line-oriented)
        c.annotate_map(&mut out.map)?;
    }

    // ---- sanity checks (monotonic, in-bounds, coverage) ----
    let violations = out.map.validate();
    let aligned_words = out
        .map
        .words
        .iter()
        .filter(|w| w.end > w.start)
        .count();
    let coverage_pct = 100.0 * aligned_words as f64 / out.map.words.len().max(1) as f64;
    let anchored_pct = 100.0 * out.stats.n_anchored as f64 / out.map.words.len().max(1) as f64;
    eprintln!(
        "sanity: {} | coverage {aligned_words}/{} words ({coverage_pct:.1}%) | anchored {anchored_pct:.1}% | {} unsung span(s)",
        if violations.is_empty() {
            "monotonic, in-bounds".to_string()
        } else {
            format!("{} violation(s)!", violations.len())
        },
        out.map.words.len(),
        out.map.unsung_spans.len(),
    );
    for v in &violations {
        eprintln!("  sanity violation: {v}");
    }

    // ---- write the timing map ----
    let out_path = args.out.clone().unwrap_or_else(|| {
        let stem = args
            .audio
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "song".into());
        args.audio
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
            .join(format!("{stem}.align.json"))
    });
    std::fs::write(&out_path, out.map.to_json_pretty()?)?;
    eprintln!("wrote {}", out_path.display());

    // ---- optional exports, written beside the map ----
    let mut export_paths: Vec<PathBuf> = Vec::new();
    if !args.export.is_empty() {
        let base = export_base(&out_path);
        let meta = ExportMeta {
            title: args
                .audio
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned()),
            artist: None,
            audio_name: args
                .audio
                .file_name()
                .map(|s| s.to_string_lossy().into_owned()),
        };
        let mut seen: Vec<ExportFormatArg> = Vec::new();
        for &f in &args.export {
            if seen.contains(&f) {
                continue;
            }
            seen.push(f);
            let format: Format = f.into();
            let path = base.with_file_name(format!(
                "{}.{}",
                base.file_name().unwrap_or_default().to_string_lossy(),
                format.extension()
            ));
            write_export(&out.map, &meta, format, &path)?;
            eprintln!("wrote {}", path.display());
            export_paths.push(path);
        }
    }
    let total_s = t_total.elapsed().as_secs_f64();

    if args.json {
        let summary = serde_json::json!({
            "input": args.audio,
            "lyrics": args.lyrics,
            "lyric_source": match out.map.lyric_source {
                Some(LyricSource::Pasted) => "pasted",
                Some(LyricSource::Transcribed) => "transcribed",
                Some(LyricSource::Imported) => "imported",
                None => "unknown",
            },
            "cleanup": cleaned.as_ref().map(|c| serde_json::json!({
                "summary": c.summary(),
                "edits": c.edits,
                "lines_kept": c.lines.len(),
                "words_kept": c.word_count(),
            })),
            "vocals": vocals_path,
            "timing_map": out_path,
            "exports": export_paths,
            "separation": separation_run.as_ref().map(|r| serde_json::json!({
                "ep_used": r.ep_used.as_str(),
                "segments": r.stats.segments,
                "parity": parity_json(&r.reports),
                "timings_s": {
                    "decode": round3(r.decode_s),
                    "model_init": round3(r.model_init_s),
                    "separate": round3(r.separate_s),
                    "inference": round3(r.stats.infer_seconds),
                },
            })),
            "align": {
                "stats": out.stats,
                "model_load_s": round3(load_s),
                "stem_decode_s": round3(decode_s),
                "onset_bias_s": aligner.cfg.onset_bias_s,
                "transcript": out.transcript,
            },
            "sanity": {
                "violations": violations,
                "coverage_pct": round3(coverage_pct),
                "anchored_pct": round3(anchored_pct),
                "unsung_spans": out.map.unsung_spans.len(),
            },
            "total_s": round3(total_s),
        });
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        println!(
            "aligned {} words -> {} ({} anchored, {:.1}s total)",
            out.map.words.len(),
            out_path.display(),
            out.stats.n_anchored,
            total_s
        );
    }
    if violations.is_empty() {
        Ok(())
    } else {
        Err("timing-map sanity violations (see stderr)".into())
    }
}

/// Default export base beside the map: "<dir>/song" for "<dir>/song.align.json"
/// (strips ".json", then a trailing ".align").
fn export_base(map_path: &Path) -> PathBuf {
    let stem = map_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "song".into());
    let stem = stem.strip_suffix(".align").unwrap_or(&stem).to_string();
    map_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join(stem)
}

/// Render + write one export; returns the path written.
fn write_export(
    map: &WordTimingMap,
    meta: &ExportMeta,
    format: Format,
    out: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let rendered = formats::export(map, meta, format);
    std::fs::write(out, rendered)
        .map_err(|e| format!("cannot write {}: {e}", out.display()))?;
    Ok(())
}

/// `karaoke export` — render a timing map as LRC / ASS / UltraStar.
/// Exporters consume the map's original-song time verbatim
/// (tempo-aware translation is the player clock's job, never the file's).
fn run_export(args: &ExportArgs) -> Result<(), Box<dyn std::error::Error>> {
    let raw = std::fs::read_to_string(&args.map)
        .map_err(|e| format!("cannot read timing map {}: {e}", args.map.display()))?;
    let map = WordTimingMap::from_json(&raw)?;
    if map.words.is_empty() {
        return Err("timing map has no words — nothing to export".into());
    }
    for v in map.validate() {
        eprintln!("warning: timing map: {v}");
    }
    let base = export_base(&args.map);
    let meta = ExportMeta {
        title: args.title.clone().or_else(|| {
            base.file_name().map(|s| s.to_string_lossy().into_owned())
        }),
        artist: args.artist.clone(),
        audio_name: args.audio_name.clone(),
    };
    let format: Format = args.format.into();
    let out = args.out.clone().unwrap_or_else(|| {
        base.with_file_name(format!(
            "{}.{}",
            base.file_name().unwrap_or_default().to_string_lossy(),
            format.extension()
        ))
    });
    write_export(&map, &meta, format, &out)?;
    println!(
        "exported {} words -> {} ({})",
        map.words.len(),
        out.display(),
        format.as_str()
    );
    Ok(())
}

/// `karaoke lyrics clean` — dry-run preview of the cleanup pass. Cleaned
/// text (or `--json` report) on stdout, change summary on stderr; nothing is
/// written to disk.
fn run_lyrics_clean(args: &LyricsCleanArgs) -> Result<(), Box<dyn std::error::Error>> {
    let raw = import::read_text_file(&args.file)
        .map_err(|e| format!("cannot read lyrics {}: {e}", args.file.display()))?;
    let cleaned = lyrics::clean(&raw);
    eprintln!("lyric cleanup: {}", cleaned.summary());
    for e in &cleaned.edits {
        eprintln!("  {e}");
    }
    eprintln!(
        "kept {} line(s), {} word(s)",
        cleaned.lines.len(),
        cleaned.word_count()
    );
    if args.summary {
        return Ok(());
    }
    if args.json {
        let report = serde_json::json!({
            "input": args.file,
            "summary": cleaned.summary(),
            "edits": cleaned.edits,
            "lines": cleaned.lines,
            "lines_kept": cleaned.lines.len(),
            "words_kept": cleaned.word_count(),
            "cleaned_text": cleaned.to_text(),
        });
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", cleaned.to_text());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// karaoke scan (bulk-import preparation — docs/IMPORTING.md)
// ---------------------------------------------------------------------------

fn run_scan(args: &ScanArgs) -> Result<(), Box<dyn std::error::Error>> {
    let mut scan = import::scan(&args.paths);
    // The app test-decodes each song's audio and leaves out what it can't
    // read (WMA, Opus…); so does this check.
    let mut unreadable_audio: Vec<(std::path::PathBuf, String)> = Vec::new();
    scan.items.retain(|i| match karaoke_core::audio::check_decodable(&i.audio) {
        Ok(()) => true,
        Err(e) => {
            unreadable_audio.push((i.audio.clone(), e.to_string()));
            false
        }
    });
    let mut songs = Vec::new();
    let (mut with_lyrics, mut transcribe, mut unreadable, mut warned) = (0usize, 0usize, 0usize, 0usize);
    for item in &scan.items {
        // What the import will align: text as-is, LRC stripped to its words.
        let text = match &item.lyrics {
            LyricsFile::Text { path } => Some(import::read_text_file(path)?),
            LyricsFile::Lrc { path } => Some(lrc::lyrics_text(&import::read_text_file(path)?).text),
            _ => None,
        };
        let check = text.as_deref().map(import::check_lyrics);
        match &item.lyrics {
            LyricsFile::Text { .. } | LyricsFile::Lrc { .. } | LyricsFile::UltraStar { .. } => with_lyrics += 1,
            LyricsFile::Unreadable { .. } => {
                unreadable += 1;
                transcribe += 1;
            }
            LyricsFile::None => transcribe += 1,
        }
        if check.as_ref().is_some_and(|c| !c.warnings.is_empty()) {
            warned += 1;
        }
        songs.push((item, check));
    }

    if args.json {
        let report = serde_json::json!({
            "songs": songs.iter().map(|(item, check)| {
                let mut v = serde_json::to_value(item).unwrap_or_default();
                v["lyrics_check"] = serde_json::to_value(check).unwrap_or_default();
                v
            }).collect::<Vec<_>>(),
            "unmatched_lyrics": scan.unmatched_lyrics,
            "unreadable_audio": unreadable_audio.iter().map(|(p, why)| serde_json::json!({ "path": p, "reason": why })).collect::<Vec<_>>(),
            "summary": {
                "songs": scan.items.len(),
                "with_lyrics": with_lyrics,
                "will_transcribe": transcribe,
                "unreadable_ultrastar": unreadable,
                "lyrics_with_warnings": warned,
                "unmatched_lyrics": scan.unmatched_lyrics.len(),
                "unreadable_audio": unreadable_audio.len(),
            },
        });
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for (item, check) in &songs {
            let who = match &item.artist {
                Some(a) => format!("{a} - {}", item.title),
                None => item.title.clone(),
            };
            let lyrics = match &item.lyrics {
                LyricsFile::Text { path } => format!("lyrics {}", file_name(path)),
                LyricsFile::Lrc { path } => format!("LRC {}", file_name(path)),
                LyricsFile::UltraStar { path } => format!("UltraStar timings {}", file_name(path)),
                LyricsFile::Unreadable { path, reason } => format!("UNREADABLE {} ({reason}) — will transcribe", file_name(path)),
                LyricsFile::None => "no lyrics — will transcribe".into(),
            };
            let coll = item.collection.as_deref().map(|c| format!("  [{c}]")).unwrap_or_default();
            let source = match item.title_source {
                import::TitleSource::Ultrastar => "UltraStar header",
                import::TitleSource::Tags => "tags",
                import::TitleSource::Lrc => "LRC header",
                import::TitleSource::Filename => "file name",
            };
            println!("{who}{coll}  (title from {source})\n    {}\n    {lyrics}", item.audio.display());
            if let Some(c) = check {
                println!("    {} lines, {} words kept ({})", c.lines, c.words, c.cleanup);
                for w in &c.warnings {
                    println!("    warning: {w}");
                }
            }
        }
        for p in &scan.unmatched_lyrics {
            println!("unmatched lyrics file: {}", p.display());
        }
        for (p, why) in &unreadable_audio {
            println!("can't read the audio of {} ({why}) — left out", p.display());
        }
        println!(
            "\n{} song(s): {with_lyrics} with lyrics, {transcribe} will be transcribed, {warned} lyrics file(s) with warnings, {} unmatched lyrics file(s), {} unreadable audio file(s)",
            scan.items.len(),
            scan.unmatched_lyrics.len(),
            unreadable_audio.len()
        );
    }

    let missing = if args.require_lyrics { transcribe } else { 0 };
    if args.strict && (missing > 0 || warned > 0 || !scan.unmatched_lyrics.is_empty() || !unreadable_audio.is_empty()) {
        let mut why = vec![
            format!("{warned} lyrics file(s) with warnings"),
            format!("{} unmatched lyrics file(s)", scan.unmatched_lyrics.len()),
            format!("{} unreadable audio file(s)", unreadable_audio.len()),
        ];
        if args.require_lyrics {
            why.insert(0, format!("{transcribe} song(s) without usable lyrics"));
        }
        return Err(format!("not ready: {}", why.join(", ")).into());
    }
    Ok(())
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// karaoke generate / jobs / accuracy (Phase 1 milestone 5)
// ---------------------------------------------------------------------------

/// Render pipeline events to stderr. Fractional progress (separation
/// segments) redraws one line; everything else is line-per-event.
struct EventPrinter {
    line_open: bool,
}

impl EventPrinter {
    fn new() -> Self {
        Self { line_open: false }
    }

    fn close_line(&mut self) {
        if self.line_open {
            eprintln!();
            self.line_open = false;
        }
    }

    fn print(&mut self, e: &PipelineEvent) {
        match e {
            PipelineEvent::StageStarted { stage } => {
                self.close_line();
                eprintln!("[{stage}] started");
            }
            PipelineEvent::StageProgress {
                stage,
                fraction: Some(f),
                message,
            } if *f < 1.0 => {
                eprint!(
                    "\r[{stage}] {:3.0}% {}",
                    f * 100.0,
                    message.as_deref().unwrap_or("")
                );
                let _ = std::io::stderr().flush();
                self.line_open = true;
            }
            PipelineEvent::StageProgress { stage, message, .. } => {
                self.close_line();
                if let Some(m) = message {
                    eprintln!("[{stage}] {m}");
                }
            }
            PipelineEvent::StageSkipped { stage, reason } => {
                self.close_line();
                eprintln!("[{stage}] skipped: {reason}");
            }
            PipelineEvent::StageCompleted { stage, seconds } => {
                self.close_line();
                eprintln!("[{stage}] done in {seconds:.1}s");
            }
            PipelineEvent::StageFailed { stage, message } => {
                self.close_line();
                eprintln!("[{stage}] FAILED: {message}");
            }
            PipelineEvent::Note { message } => {
                self.close_line();
                eprintln!("note: {message}");
            }
        }
    }
}

fn generate_request_from(args: &GenerateArgs) -> GenerateRequest {
    let mut req = GenerateRequest::new(args.audio.clone());
    req.lyrics = args.lyrics.clone();
    req.out_dir = args.out_dir.clone();
    req.model_dir = args.model_dir.clone();
    req.jobs_dir = args.jobs_dir.clone();
    req.ep = args.ep.into();
    req.sep_model = args.sep_model.into();
    req.sep_options = separation::SeparateOptions {
        overlap: args.sep_overlap,
        shifts: args.sep_shifts,
    };
    if !args.export.is_empty() {
        let mut formats: Vec<Format> = Vec::new();
        for &f in &args.export {
            let f: Format = f.into();
            if !formats.contains(&f) {
                formats.push(f);
            }
        }
        req.exports = formats;
    }
    req.title = args.title.clone();
    req.artist = args.artist.clone();
    req.whisper_int8 = args.int8;
    req.onset_bias_s = args.onset_bias;
    req.force = args.force;
    req.force_stages = args.force_stage.iter().map(|&s| s.into()).collect();
    req
}

fn run_generate(args: &GenerateArgs) -> Result<(), Box<dyn std::error::Error>> {
    let req = generate_request_from(args);
    let mut printer = EventPrinter::new();
    let outcome = pipeline::generate(&req, &mut |e| printer.print(e))?;
    printer.close_line();

    if args.json {
        let summary = serde_json::json!({
            "job_id": outcome.manifest.job_id,
            "manifest": outcome.manifest_path,
            "map": outcome.map_path,
            "exports": outcome.export_paths,
            "stages": outcome.stages,
            "status": outcome.manifest.summary_status(),
            "total_s": round3(outcome.total_s),
        });
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        let ran: Vec<String> = outcome
            .stages
            .iter()
            .map(|s| {
                if s.ran {
                    format!("{} {:.1}s", s.stage, s.seconds)
                } else {
                    format!("{} (skipped)", s.stage)
                }
            })
            .collect();
        println!(
            "job {} {} in {:.1}s: {}",
            outcome.manifest.job_id,
            outcome.manifest.summary_status(),
            outcome.total_s,
            ran.join(", ")
        );
        println!("  manifest: {}", outcome.manifest_path.display());
        println!("  map:      {}", outcome.map_path.display());
        for p in &outcome.export_paths {
            println!("  export:   {}", p.display());
        }
    }
    Ok(())
}

fn ago(unix: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dt = now.saturating_sub(unix);
    match dt {
        0..=59 => format!("{dt}s ago"),
        60..=3599 => format!("{}m ago", dt / 60),
        3600..=86399 => format!("{}h ago", dt / 3600),
        _ => format!("{}d ago", dt / 86400),
    }
}

fn run_jobs_list(args: &JobsListArgs) -> Result<(), Box<dyn std::error::Error>> {
    let jobs_dir = args
        .jobs_dir
        .clone()
        .unwrap_or_else(manifest::default_jobs_dir);
    let jobs = manifest::list_jobs(&jobs_dir)?;
    if args.json {
        let rows: Vec<serde_json::Value> = jobs
            .iter()
            .map(|(ptr, man)| {
                serde_json::json!({
                    "job_id": ptr.job_id,
                    "audio": ptr.audio,
                    "out_dir": ptr.out_dir,
                    "manifest": ptr.manifest,
                    "updated_unix": ptr.updated_unix,
                    "status": man.as_ref().map(|m| m.summary_status()),
                    "stages": man.as_ref().map(|m| &m.stages),
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }
    if jobs.is_empty() {
        println!("no jobs in {}", jobs_dir.display());
        return Ok(());
    }
    println!(
        "{:<14} {:<22} {:<10} {}",
        "JOB", "STATUS", "UPDATED", "AUDIO"
    );
    for (ptr, man) in &jobs {
        let status = man
            .as_ref()
            .map(|m| m.summary_status())
            .unwrap_or_else(|| "missing".into());
        let audio = ptr
            .audio
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| ptr.audio.display().to_string());
        println!(
            "{:<14} {:<22} {:<10} {}",
            ptr.job_id,
            status,
            ago(ptr.updated_unix),
            audio
        );
    }
    Ok(())
}

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "m4a", "ogg", "opus", "aac"];

fn is_audio_file(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Resolve an accuracy target to (song name, timing map). Audio files run
/// (or resume — the manifest decides) the pipeline first.
fn resolve_map(
    target: &Path,
    lyrics: Option<&Path>,
    model_dir: Option<&Path>,
    jobs_dir: Option<&Path>,
    ep: EpArg,
) -> Result<(String, WordTimingMap), Box<dyn std::error::Error>> {
    let name = |p: &Path| {
        p.file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.display().to_string())
    };
    let load_map = |p: &Path| -> Result<WordTimingMap, Box<dyn std::error::Error>> {
        let raw = std::fs::read_to_string(p)
            .map_err(|e| format!("cannot read timing map {}: {e}", p.display()))?;
        Ok(WordTimingMap::from_json(&raw)?)
    };
    let from_manifest = |p: &Path| -> Result<(String, WordTimingMap), Box<dyn std::error::Error>> {
        let man = JobManifest::load(p)?;
        let map_path = man
            .artifact_path(StageId::Align, "map")
            .ok_or_else(|| {
                format!(
                    "job {} has no completed align stage (status {}) — run `karaoke generate` first",
                    man.job_id,
                    man.summary_status()
                )
            })?;
        Ok((name(&man.audio.path), load_map(map_path)?))
    };

    if target.is_dir() {
        return from_manifest(&target.join(manifest::MANIFEST_FILE_NAME));
    }
    if target.file_name().and_then(|s| s.to_str()) == Some(manifest::MANIFEST_FILE_NAME) {
        return from_manifest(target);
    }
    let fname = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if fname.ends_with(".align.json") {
        return Ok((
            fname.trim_end_matches(".align.json").to_string(),
            load_map(target)?,
        ));
    }
    if is_audio_file(target) {
        let mut req = GenerateRequest::new(target.to_path_buf());
        req.lyrics = lyrics.map(|p| p.to_path_buf());
        req.model_dir = model_dir.map(|p| p.to_path_buf());
        req.jobs_dir = jobs_dir.map(|p| p.to_path_buf());
        req.ep = ep.into();
        let mut printer = EventPrinter::new();
        let outcome = pipeline::generate(&req, &mut |e| printer.print(e))?;
        printer.close_line();
        return Ok((name(target), load_map(&outcome.map_path)?));
    }
    Err(format!(
        "cannot grade {}: expected a job dir, job.json, .align.json map, or audio file",
        target.display()
    )
    .into())
}

fn accuracy_row(name: &str, r: &AccuracyReport) -> String {
    let s = &r.stats;
    format!(
        "{name:<24} {:>5} {:>7} {:>8} {:>8} {:>8} {:>8} {:>7} {:>8} {:>5} {:>6}",
        r.n_ref,
        r.n_matched,
        fmt_ms(s.median_ms),
        fmt_ms(s.p90_ms),
        fmt_ms(s.p95_ms),
        fmt_ms(s.max_ms),
        fmt_pct(s.pct_within_50ms),
        fmt_pct(s.pct_within_100ms),
        r.unmatched_ref.len(),
        r.unmatched_hyp.len(),
    )
}

fn accuracy_header() -> String {
    format!(
        "{:<24} {:>5} {:>7} {:>8} {:>8} {:>8} {:>8} {:>7} {:>8} {:>5} {:>6}",
        "SONG", "REF", "MATCH", "MEDIAN", "P90", "P95", "MAX", "<=50MS", "<=100MS", "MISS", "EXTRA"
    )
}

fn fmt_ms(v: f64) -> String {
    if v.is_nan() {
        "-".into()
    } else {
        format!("{v:.0}ms")
    }
}

fn fmt_pct(v: f64) -> String {
    if v.is_nan() {
        "-".into()
    } else {
        format!("{v:.1}%")
    }
}

fn print_unmatched(r: &AccuracyReport) {
    for u in &r.unmatched_ref {
        eprintln!(
            "  missed reference word {} \"{}\" at {:.2}s",
            u.index, u.word, u.start
        );
    }
    for u in &r.unmatched_hyp {
        eprintln!(
            "  hypothesis word {} \"{}\" at {:.2}s has no reference",
            u.index, u.word, u.start
        );
    }
}

fn run_accuracy(args: &AccuracyArgs) -> Result<(), Box<dyn std::error::Error>> {
    // ---- suite mode: grade a folder of (audio + reference) pairs ----
    if let Some(suite_dir) = &args.suite {
        return run_accuracy_suite(args, suite_dir);
    }

    let target = args
        .target
        .as_ref()
        .ok_or("pass a target (job dir / job.json / .align.json / audio) or --suite")?;
    let (name, map) = resolve_map(
        target,
        args.lyrics.as_deref(),
        args.model_dir.as_deref(),
        args.jobs_dir.as_deref(),
        args.ep,
    )?;

    if args.self_check {
        let meta = ExportMeta {
            title: Some(name.clone()),
            artist: None,
            audio_name: None,
        };
        let r = accuracy::self_check(&map, &meta)?;
        let pass = r.unmatched_ref.is_empty()
            && r.unmatched_hyp.is_empty()
            && r.stats.max_ms <= SELF_CHECK_BOUND_MS + 1e-6;
        if args.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "song": name,
                    "mode": "self_check",
                    "bound_ms": SELF_CHECK_BOUND_MS,
                    "pass": pass,
                    "report": r,
                }))?
            );
        } else {
            println!("{}", accuracy_header());
            println!("{}", accuracy_row(&name, &r));
            print_unmatched(&r);
            println!(
                "self-check ({} words): max onset error {} vs quantization bound {:.0}ms -> {}",
                r.n_matched,
                fmt_ms(r.stats.max_ms),
                SELF_CHECK_BOUND_MS,
                if pass { "PASS" } else { "FAIL" }
            );
        }
        if !pass {
            return Err("self-check failed (see report)".into());
        }
        return Ok(());
    }

    let ref_path = args
        .reference
        .as_ref()
        .ok_or("pass --ref <ultrastar.txt> (or --self-check)")?;
    let raw = std::fs::read_to_string(ref_path)
        .map_err(|e| format!("cannot read reference {}: {e}", ref_path.display()))?;
    let song = ultrastar::import(&raw)?;
    let refs = accuracy::ref_words(&song);
    let r = accuracy::grade(&map, &refs);
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "song": name,
                "reference": ref_path,
                "report": r,
            }))?
        );
    } else {
        println!("{}", accuracy_header());
        println!("{}", accuracy_row(&name, &r));
        print_unmatched(&r);
    }
    Ok(())
}

fn run_accuracy_suite(
    args: &AccuracyArgs,
    suite_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    // pair every audio file with "<stem>.ultrastar.txt" (preferred) or
    // "<stem>.txt"; "<stem>.lyrics.txt" beside it is pasted lyrics
    let mut entries: Vec<PathBuf> = std::fs::read_dir(suite_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| is_audio_file(p))
        .collect();
    entries.sort();
    if entries.is_empty() {
        return Err(format!("no audio files in {}", suite_dir.display()).into());
    }

    let mut rows: Vec<(String, AccuracyReport)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for audio in &entries {
        let stem = audio
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ref_path = [
            suite_dir.join(format!("{stem}.ultrastar.txt")),
            suite_dir.join(format!("{stem}.txt")),
        ]
        .into_iter()
        .find(|p| p.is_file());
        let Some(ref_path) = ref_path else {
            skipped.push(format!("{stem}: no reference .txt"));
            continue;
        };
        let lyrics_path = suite_dir.join(format!("{stem}.lyrics.txt"));
        let lyrics = lyrics_path.is_file().then_some(lyrics_path);

        eprintln!("== {stem} ==");
        let (name, map) = resolve_map(
            audio,
            lyrics.as_deref(),
            args.model_dir.as_deref(),
            args.jobs_dir.as_deref(),
            args.ep,
        )?;
        let raw = std::fs::read_to_string(&ref_path)
            .map_err(|e| format!("cannot read reference {}: {e}", ref_path.display()))?;
        let song = ultrastar::import(&raw)
            .map_err(|e| format!("{}: {e}", ref_path.display()))?;
        let r = accuracy::grade(&map, &accuracy::ref_words(&song));
        rows.push((name, r));
    }

    // aggregate: pool every matched pair's signed error
    let pooled: Vec<f64> = rows
        .iter()
        .flat_map(|(_, r)| r.matched.iter().map(|p| p.error_s))
        .collect();
    let agg = ErrorStats::from_signed_errors(&pooled);
    let miss: usize = rows.iter().map(|(_, r)| r.unmatched_ref.len()).sum();
    let extra: usize = rows.iter().map(|(_, r)| r.unmatched_hyp.len()).sum();

    if args.json {
        let songs: Vec<serde_json::Value> = rows
            .iter()
            .map(|(n, r)| serde_json::json!({"song": n, "report": r}))
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "suite": suite_dir,
                "songs": songs,
                "skipped": skipped,
                "aggregate": {
                    "stats": agg,
                    "unmatched_ref": miss,
                    "unmatched_hyp": extra,
                },
            }))?
        );
    } else {
        println!("{}", accuracy_header());
        for (n, r) in &rows {
            println!("{}", accuracy_row(n, r));
        }
        for s in &skipped {
            eprintln!("skipped {s}");
        }
        println!(
            "{:<24} {:>5} {:>7} {:>8} {:>8} {:>8} {:>8} {:>7} {:>8} {:>5} {:>6}",
            "AGGREGATE",
            rows.iter().map(|(_, r)| r.n_ref).sum::<usize>(),
            agg.n,
            fmt_ms(agg.median_ms),
            fmt_ms(agg.p90_ms),
            fmt_ms(agg.p95_ms),
            fmt_ms(agg.max_ms),
            fmt_pct(agg.pct_within_50ms),
            fmt_pct(agg.pct_within_100ms),
            miss,
            extra,
        );
    }
    Ok(())
}

fn parity_json(reports: &[ParityReport]) -> Vec<serde_json::Value> {
    reports
        .iter()
        .map(|r| {
            serde_json::json!({
                "ep": r.ep,
                "snr_db": r.snr_db,
                "passed": r.passed,
                "from_cache": r.from_cache,
            })
        })
        .collect()
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}
