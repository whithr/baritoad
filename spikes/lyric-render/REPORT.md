# Spike report: lyric-render — 60 fps lyric rendering in a Tauri webview

**Verdict: partial** — Windows/WebView2 holds ~120 fps with zero dropped frames in the representative scene (both DOM and canvas renderers); WebKitGTK could not be measured because no Linux machine is available. Per the spike contract (spikes/README.md §4), macOS/Windows results alone cap this at "partial", with the concrete Linux test plan below.

## What was built

A minimal Tauri 2 app (`src-tauri/`) wrapping a fully automatic, instrumented
karaoke player scene (`ui/index.html`, vanilla JS, no frontend deps):

- Scrolling lyric view: 200 lines / 1,199 words with a deterministic synthetic
  timing map (seeded PRNG; 4-8 words per line, 250-550 ms per word — realistic
  karaoke density). No audio is involved; this spike measures rendering only.
- Per-frame work, matching the real player: smooth interpolated scroll toward
  the active line, per-word progressive highlight wipe on the current word,
  animated background wash, progress bar — all updated every frame.
- **Two render paths**, both measured each run:
  - `dom` — line/word DOM elements, transform-based scroll, CSS
    `background-clip: text` gradient wipe (compositor-friendly path).
  - `canvas` — full-window canvas-2D redraw every frame (text, wipe via clip
    rect, background gradient, progress bar) at devicePixelRatio.
- Harness: 1 s refresh-rate calibration, then per mode 3 s warmup + **30 s
  measurement** of requestAnimationFrame deltas; stats written to
  `results/run-<epoch>.json` via a Tauri command; app self-quits.

## Numbers

**Hardware:** Intel i7-9700K (8C/8T), NVIDIA RTX 2080 SUPER (driver 32.0.15.9636),
32 GB RAM, Windows 10 Pro 19045, display 3440x1440 @ **120 Hz**,
WebView2 runtime 151.0.4129.59 (Chromium 151). Machine otherwise idle,
window foreground and unoccluded.

**Input:** synthetic 200-line / 1,199-word timing map (above); 30 s measured
window per mode per run. rAF is vsync'd at 120 Hz, so the frame budget
measured here is **8.33 ms — twice as strict as the 60 fps target**.
"over 60 fps budget" counts frames longer than 16.9 ms.

| Run | Mode | avg fps | p50 | p95 | p99 | max | frames >16.9 ms | frames >34 ms |
|---|---|---|---|---|---|---|---|---|
| windowed 1280x800 | dom | 119.7 | 8.3 ms | 8.4 ms | 8.5 ms | 16.7 ms | 0 / 3591 | 0 |
| windowed 1280x800 | canvas | 119.8 | 8.3 ms | 8.4 ms | 8.5 ms | 9.0 ms | 0 / 3596 | 0 |
| maximized 3440x1387 | dom | 119.8 | 8.3 ms | 8.4 ms | 8.5 ms | 16.7 ms | 0 / 3594 | 0 |
| maximized 3440x1387 | canvas | 118.8 | 8.3 ms | 8.5 ms | 8.5 ms | 33.4 ms | 9 / 3564 (0.25%) | 0 |

(A third run taken immediately after a fresh `cargo build`, with post-build
disk/AV activity still settling, showed 48-84 frames over 1.5x refresh —
kept in `results/` as a reminder that these measurements need an idle machine.)

**Vs pass criteria:**

- *Scrolling lyrics + per-word highlight + progress bar at sustained 60 fps in
  a representative scene*: **met on Windows/WebView2**, with margin — the scene
  sustains ~120 fps at 3440x1387; worst mode/run had 0.25% of frames over the
  60 fps budget and none over 34 ms (no visible stutter).
- *Measured on WebKitGTK*: **not met — no Linux machine available.** No WSL
  distro is installed on this machine, and WSLg would render WebKitGTK through
  llvmpipe/RDP compositing — numbers from it would not be trustworthy either
  way. Contract says this makes the verdict **partial**, not pass.

## Repro

From a clean checkout, on Windows with Rust >=1.77 and the WebView2 runtime:

```powershell
powershell -File spikes\lyric-render\run.ps1
```

or manually:

```powershell
cargo build --release --manifest-path spikes\lyric-render\src-tauri\Cargo.toml
spikes\lyric-render\src-tauri\target\release\lyric-render-spike.exe
```

The window runs ~70 s (1 s calibrate + 2 x (3 s warmup + 30 s measure)),
writes `spikes/lyric-render/results/run-<epoch>.json`, and exits itself.
Keep the window visible: occluded windows are rAF-throttled by the compositor
and the numbers become meaningless. On Linux the same commands apply
(`cargo build --release` + run the binary); the harness and results format are
platform-independent.

## Linux (WebKitGTK) test plan — what "partial -> pass" requires

Hardware needed: any x86_64 Linux install — a spare machine, dual-boot, or a
live-USB Ubuntu session on this desktop qualifies. **Not WSLg** (software GL,
not representative). Ideally test the *weakest* realistic target: an Intel
iGPU laptop, X11 and Wayland both.

1. Ubuntu 24.04: `sudo apt install libwebkit2gtk-4.1-dev build-essential curl libssl-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev`, install rustup.
2. `cargo build --release --manifest-path spikes/lyric-render/src-tauri/Cargo.toml` and run the binary — the identical harness runs and writes the same JSON.
3. Run matrix: {dom, canvas} x {default, `WEBKIT_DISABLE_COMPOSITING_MODE=1`} x {X11, Wayland}, windowed and fullscreen, machine idle.
4. Pass bar on WebKitGTK: p99 frame delta <= 16.7 ms over the 30 s window in the fullscreen scene, no frames > 34 ms (the "visible stutter" threshold), on at least one of the two render paths.

## Risks discovered

1. **High-refresh displays raise the bar.** WebView2 vsyncs rAF at the panel
   rate (120 Hz here). A player loop tuned to "16 ms is fine" will judder on
   120/144 Hz panels. Per-frame work must fit ~8 ms on such panels, not 16 ms
   (the clock itself stays refresh-agnostic since it derives from audio-device
   position).
2. **DOM beat canvas on Windows.** The compositor path (transforms +
   background-clip) was *cheaper* than full canvas-2D redraw at 3440 px wide
   (0 vs 9 over-budget frames). The design sketches the player as
   "WebGL/canvas renderer" — on WebKitGTK the ranking may invert (its DOM
   compositing is the historically weak part), so keep both paths until the
   Linux measurement decides. The spike app deliberately ships both.
3. **Measurement hygiene matters.** Post-build disk/AV activity produced an
   order-of-magnitude more dropped frames in an otherwise identical run.
   Any future perf harness should discard runs with background load.
4. **rAF throttling when occluded** means in-app fps telemetry cannot
   distinguish "slow renderer" from "window hidden"; Phase 1 fps
   instrumentation should gate on document visibility/focus.
5. Toolchain trivia: tauri-build (Windows) requires `icons/icon.ico` and its
   ICO parser rejects .NET `Icon.Save` output (nonzero reserved field) — the
   checked-in icon is a hand-assembled PNG-in-ICO.
6. **Not yet representative of full load:** no concurrent audio
   decode/stretch was running. Those live on Rust threads, not the webview
   main thread, so impact should be small, but Phase 1 should re-measure with
   real playback + the lyric-sync IPC clock active.

## Licensing

Only Tauri 2 (MIT/Apache-2.0, already in the docs/DEPENDENCIES.md matrix) plus
serde/serde_json (MIT/Apache-2.0) are used; spike-only harness, nothing new
ships in the product binary. No model weights, no audio files.

## Recommendation

Treat Windows/WebView2 as de-risked with wide margin. Do **not** start the
wgpu fallback yet — the fallback trigger is a WebKitGTK failure that has not
been measured. Next action: run this exact harness on real Linux hardware
(see test plan above; a live-USB session on this desktop is the zero-hardware
option) and upgrade the verdict to pass/fail on those numbers. In Phase 1,
keep the DOM and canvas renderers behind a switch until the WebKitGTK numbers
pick the winner, and budget per-frame work for 8 ms (120 Hz panels), not 16 ms.
