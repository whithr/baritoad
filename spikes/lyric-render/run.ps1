# Runs the lyric-render spike benchmark (Windows / WebView2).
# Builds if needed, launches the app; the benchmark is fully automatic
# (~70 s: 1 s calibrate + 2 modes x (3 s warmup + 30 s measure)), writes
# results/run-<epoch>.json and exits by itself.
# Keep the window visible and unobstructed while it runs — occluded windows
# get rAF-throttled by the compositor and the numbers become meaningless.
$ErrorActionPreference = "Stop"
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$root = $PSScriptRoot
cargo build --release --manifest-path "$root\src-tauri\Cargo.toml"
& "$root\src-tauri\target\release\lyric-render-spike.exe"
Get-ChildItem "$root\results" | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content
