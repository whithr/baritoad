# baritoad

A karaoke machine for any song you have. Drop in a song (or paste a link),
and baritoad turns the singer way down, lines the lyrics up word by word, and
plays it full screen on your TV. Friends can pick songs from their phones
with party mode.

It's free and open source. It runs on your computer: your songs never get
uploaded anywhere, and there's no account.

It isn't studio karaoke. Vocal removal is done by an AI model, so you'll
sometimes still hear a little of the original singer. We made it because we
sing at home a lot and wanted karaoke versions of songs nobody had made one
for.

## Download

**Windows 10 or 11 (64-bit):** grab the installer from
[Releases](https://github.com/whithr/baritoad/releases/latest).
macOS and Linux are coming later.

- The installer isn't code-signed yet, so Windows may say it doesn't
  recognize the app. Click **More info**, then **Run anyway**.
- The first start downloads the AI models — about 2 GB — from
  `models.baritoad.com`. After that, everything works offline except the
  things that need the internet by nature (below).
- A graphics card makes song preparation much faster (DirectML); it also
  works on the CPU, just slower.

## What it does

- **Make a karaoke version** of a song file (or a link, through yt-dlp):
  separate the vocals, get the lyrics (paste them, look them up on
  [LRCLIB](https://lrclib.net), or let it transcribe), and time every word.
- **Fix the timing** on the Bench, a word-by-word editor, when the automatic
  timing is off.
- **Sing it** on the Stage: full screen, karaoke pages, a vocal-guide slider
  to bring the singer back in, key change (±6 semitones) and tempo change.
- **Collections and an up-next queue** for a night of songs. Imports
  UltraStar `.txt` and LRC; exports LRC, ASS and UltraStar `.txt`.
- **Party mode:** guests scan a QR code on the TV and pick songs from their
  phones. No app, no sign-in.

English songs work best; other languages aren't supported yet.

## Privacy

No telemetry, no account. baritoad goes online only for:

- the first-run model download (and **Tools › Models…** later);
- lyrics lookup on LRCLIB, when you ask — it sends the title, artist, album
  and duration;
- **Add from URL**, when you paste a link — yt-dlp fetches it, and checks for
  its own update at most once a day before a download;
- **party mode**, while you host one. The relay gets the list of ready songs
  (title, artist, duration, collection names), the queue and each guest's
  display name and toad — never audio, lyrics or file paths — and deletes the
  party when it ends. The relay is open source too, in
  [services/relay/](services/relay/); see [docs/PARTY.md](docs/PARTY.md).

## Building from source

You need Rust (stable, MSVC on Windows), Node.js 20+ and pnpm. Then:

```
cd apps/desktop
pnpm install
pnpm fetch-tools   # yt-dlp + Deno for Add from URL (checksum-verified)
pnpm tauri dev
```

`pnpm package` builds the Windows installer. More in
[apps/desktop/README.md](apps/desktop/README.md). macOS and Linux build
(CI checks them on every push) but haven't been tested as releases.

## Layout

- [apps/desktop/](apps/desktop/) — the Tauri app (React webview + Rust shell)
- [crates/karaoke-core/](crates/karaoke-core/) — separation, lyrics,
  alignment, the player engine, the library and the party protocol
- [crates/karaoke-cli/](crates/karaoke-cli/) — the `karaoke` command-line tool
- [services/relay/](services/relay/) — the party relay and guest page
  (Cloudflare Workers)
- [spikes/](spikes/) — the early feasibility prototypes and their measured
  reports
- [DESIGN.md](DESIGN.md) — the baritoad 98 look and copy rules

## Models and licenses

Model weights aren't in this repo; the app downloads them from our mirror.
[MODEL_LICENSES.md](MODEL_LICENSES.md) records where each one comes from and
its license, and [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) covers every
library and tool the app ships. One thing to know: the Demucs separation
weights are, per their author, provided for research purposes and aren't
covered by Demucs' MIT license — details in both files.

## Contributing

Issues and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Commits need a DCO sign-off
(`git commit -s`).

## License

[GPL-3.0-or-later](LICENSE). Build it, use it, change it, share it,
binaries included.

*Additional permission under GNU GPL version 3 section 7:* if you modify this
program, or any covered work, by linking or combining it with Microsoft
DirectML or NVIDIA CUDA, cuDNN or TensorRT (or a modified version of those
libraries), containing parts covered by the terms of those libraries'
licenses, the licensors of this program grant you additional permission to
convey the resulting work.
