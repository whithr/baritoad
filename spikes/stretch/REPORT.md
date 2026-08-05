# Spike report: `stretch/` — Signalsmith Stretch quality on real music

**Verdict: partial** — the apply-latency/gapless criterion **passes with measured numbers**; the artifact-quality criterion is fully instrumented (65 level-matched A/B listening files rendered) but requires a human listening pass that an automated run cannot perform. No fallback is indicated by anything measured.

## 1. What was tested

Question (spikes/README.md #3): is Signalsmith Stretch good enough for key
(±6 semitones) and tempo (0.8–1.2x) changes on full mixes, applied gapless in
< 100 ms mid-playback in a cpal-based prototype?

- Signalsmith Stretch C++ header (MIT) + signalsmith-linear (MIT), vendored
  under `vendor/` with licenses, driven from Rust via a hand-written FFI over
  the MIT C wrapper from `colinmarc/signalsmith-stretch-rs` v0.1.3.
  (Hand-written because bindgen needs libclang, which this machine lacks;
  production can use the `signalsmith-stretch` crate, MIT, once libclang or a
  cxx-based binding is sorted.)
- Licensing (PLAN.md section 6): Signalsmith Stretch (MIT), cpal (Apache-2.0),
  Symphonia (MPL-2.0) are already in the matrix. Spike-only, non-shipping:
  hound (Apache-2.0), cc (MIT/Apache-2.0). No matrix update required; nothing
  new ships.

**Hardware / OS:** Intel i7-9700K (8C/8T, 3.6 GHz), 64-bit Windows 10 Pro
19045; all DSP single-threaded. Audio device for the live test: Dell AW3418DW
(NVIDIA High Definition Audio), WASAPI shared mode, 48 kHz, f32, ~10 ms
callback period.

**Test songs** (user-supplied local files in `spikes/testdata/`, 44.1 kHz
stereo mp3; title/artist text only per spike rules):

| file | tagged title / artist | length | character |
|---|---|---|---|
| back-on-my-bs | "Back On My BS" — BigXthaPlug | 1:34 | trap/hip-hop, dense loudness-maximized mix |
| dogs | "Dogs" — Elk Darling | 3:09 | indie rock |
| falling-out-of-love | "Falling out of Love" — The Strokes | 6:22 | rock |
| she-said | "SHE SAID" — RIZ LA VIE | 3:33 | alt-R&B |
| wildflowers | "wildflowers" — Ethan Regan | 3:32 | singer-songwriter ballad |

## 2. Numbers vs pass criteria

### Criterion A — apply latency < 100 ms and gapless, mid-playback, cpal: **PASS (measured)**

**Pipeline (algorithmic) apply latency**, measured offline at 48 kHz by
streaming a 440 Hz sine in 512-frame blocks, flipping the transpose setting at
t = 2.0 s, and tracking the old-tone/new-tone Goertzel energy ratio (t10/t50/t90
= time after the setting call at which the new pitch carries 10/50/90% of the
energy):

| config | change | t10 | t50 | t90 |
|---|---|---|---|---|
| preset_default (120 ms block/30 ms interval) | ±6 st, +3 st | 51–53 ms | 61 ms | 69–72 ms |
| preset_cheaper | ±6 st, +3 st | 64–69 ms | 77 ms | 85–88 ms |
| custom 40 ms block / 10 ms interval | ±6 st, +3 st | 16 ms | 21 ms | 29 ms |

**Tempo apply latency**, measured with a linear-chirp input (chirp frequency
encodes input-time, so the output's instantaneous frequency recovers the
input-time trajectory; a piecewise-linear fit finds the rate breakpoint; a
click-train variant was rejected — phase-vocoder transient smearing confounds
it):

| config | rate 1.0 -> 0.5 audible after | fit rms |
|---|---|---|
| preset_default | 50.0 ms | 2.2 ms |
| custom 40/10 ms | 16.0 ms | 1.5 ms |

**Gapless:** across every pitch and tempo change, max sample-to-sample delta
around the change stayed at or marginally above the steady-state baseline
(e.g. 0.0288 baseline vs 0.0421 around a +6 st change — consistent with the
higher-frequency tone, not a click; a hard discontinuity would be an order of
magnitude larger), and the longest near-silent run was 0.02 ms (one sample of a
sine zero-crossing). No gaps, no clicks, in all 9 pitch cases and both tempo
cases, and no outlier deltas around any of the 8 live mid-playback changes.

**Live cpal prototype** (25 s excerpt, 8 scheduled pitch/tempo changes
mid-playback, device at 48 kHz while the file is 44.1 kHz — the stretcher also
did the samplerate bridging via feed ratio):

- Setting request -> audio-callback pickup: 2.2–9.8 ms across 16 changes (2 runs).
- process() cost per ~10 ms callback, **with MMCSS** (see section 4): p50
  0.017 ms, p99 2.7 ms, max 3.0 ms — more than 3x headroom against the 10 ms
  budget.
- Callback cadence with MMCSS: median 10.00 ms, p99 10.5 ms, max 12.1 ms;
  0 stream errors.
- **End-to-end audible apply latency** = scheduling (<= 10 ms) + pipeline t90 +
  ~1 device period (~10 ms): **~80–92 ms with preset_default; ~35–50 ms with
  the 40/10 ms config**. Both under 100 ms; preset_default has little margin,
  the custom config has plenty.

### Criterion B — no objectionable artifacts at ±3 st, honest degradation at ±6: **instrumented, needs ears**

An automated agent ran this spike and cannot judge "objectionable." What exists
for the ~30-minute human pass:

- 65 files in `spikes/stretch/out/<song>/` (330 MB, gitignored): per song a
  `reference.wav` plus 10 settings (±3/±6 st; 0.8/0.9/1.1/1.2x; +3 st @ 0.9x;
  -3 st @ 1.2x), all 30 s excerpts starting 40% in, preset_default, tonality
  limit 8 kHz — and 2 low-latency-config renders (`lowlat40ms_pitch_+3st`,
  `lowlat40ms_pitch_-6st`) to judge whether the 40/10 ms config's latency win
  costs audible quality.
- Everything is level-matched at -6 dB against its reference (see section 4
  overshoot finding), so any distortion heard is the algorithm's, not the wav
  writer's.
- Listening protocol: A/B each setting vs `reference.wav`; attend to lead
  vocal phasiness, cymbal/transient smearing (especially `back-on-my-bs`
  tempo renders — dense mix, and phase vocoders smear transients), bass
  wobble at -6 st, chorus sections. Expected outcome based on Signalsmith's
  published behavior: clean at ±3, audible but usable softening at ±6.

**Objective sanity checks that did run:** output duration correct within 0.05%
of `input/rate` for every render; no unexpected silence; no NaNs; pitch ratios
verified exactly on synthetic tones (Goertzel); varying the feed ratio
mid-stream (44.1 -> 48 kHz bridging plus tempo changes) never produced a
discontinuity.

### Throughput (not a criterion, but a required measurement)

Single-threaded, i7-9700K, 512-frame blocks, preset_default, +3 st: full songs
processed at **RTF 0.019–0.030** (e.g. 6:22 song in 9.7 s; 3:32 song in
4.5–6.3 s) — 33–50x realtime, so offline pre-render of a shifted instrumental
is also viable if we ever want it.

## 3. Repro

From a clean checkout (needs: Rust stable-x86_64-pc-windows-msvc, VS 2022 C++
build tools; test mp3s present in `spikes/testdata/`):

```
cd spikes/stretch
cargo build --release
target\release\stretch-spike.exe latency        # synthetic apply-latency + gapless numbers
target\release\stretch-spike.exe quality        # renders out\<song>\*.wav + throughput table
target\release\stretch-spike.exe live --mmcss   # 23 s live cpal test (plays audio at 0.15x volume)
target\release\stretch-spike.exe live           # same, without MMCSS (reproduces the preemption spikes)
```

## 4. Risks discovered (not in PLAN.md)

1. **cpal does not register its WASAPI callback thread with MMCSS.** Without
   it, mid-stream OS preemption stalled process() for up to **43.5 ms**
   (callback cadence max 49.9 ms) on an idle-ish desktop. One
   `AvSetMmThreadCharacteristicsW("Pro Audio")` call from the first callback
   collapsed the worst case to **3.0 ms** (cadence max 12.1 ms). The Phase 1
   audio engine must do this on Windows (and the macOS/Linux equivalents need
   checking). Also: cpal's error callback reported **zero** errors even during
   the 43 ms stalls — it cannot be trusted as an underrun detector.
2. **Output peak overshoot.** On loudness-maximized mixes the stretcher's
   output peaks up to **2.08x input peak** (thousands of samples over full
   scale on 4 of 5 songs; even at -6 dB pre-gain one song still grazed 1.0).
   The player needs about -8 to -9 dB headroom before the stretcher plus a
   soft limiter/clipper after it whenever stretch/shift is active.
3. **preset_default's 120 ms pipeline leaves little margin** against the
   100 ms apply budget once device buffering is added (~80–92 ms end-to-end
   measured). A 40 ms/10 ms configure() gets ~35–50 ms end-to-end; whether its
   quality is acceptable is exactly what the `lowlat40ms_*` renders are for.
   If ears say no, preset_default still passes — just without slack.
4. **Bindings friction on Windows:** the published `signalsmith-stretch` crate
   (MIT) needs bindgen -> libclang, absent here; this spike hand-wrote the
   30-line extern block instead. Also found a real bug in that crate's C
   wrapper: `signalsmith_stretch_set_formant_base` calls
   `setFormantSemitones` instead of `setFormantBase` — harmless to us now,
   but matters if Phase 1+ uses formant preservation for the vocal-guide
   blend. Vendor-with-patch or upstream a fix.
5. **Transient smearing is real** (inherent to phase vocoders): a click-train
   probe was so smeared at 0.5x that it broke the first tempo-latency
   measurement design. Percussive material in the tempo listening files
   deserves specific attention.

## 5. Recommendation

Proceed on the Signalsmith path; do the ~30-minute listening pass over
`out/` to close criterion B before calling Phase 0 done (any listener; A/B
protocol in section 2B). For Phase 1 hardening:

- MMCSS registration (and per-OS equivalents) in the audio engine — measured
  14x reduction in worst-case callback stall.
- Headroom + soft limiter around the stretcher (-9 dB pre-gain covers the
  2.08x overshoot observed).
- Decide preset_default vs custom 40/10 ms config from the `lowlat40ms_*`
  listening comparison; both meet < 100 ms, the custom config with 2x margin.
- Adopt the streaming feed-ratio architecture from `src/cmd_live.rs`
  (atomics for settings, feed-ratio tempo, stretcher does samplerate
  bridging) — it survived 16 mid-playback changes gapless.
- Bindings: either vendor the MIT C wrapper + hand-written FFI (as here,
  zero extra deps) or fix libclang in CI and use the crate; patch the
  formant-base bug either way.
