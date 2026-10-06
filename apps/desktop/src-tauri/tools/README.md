# tools/

External programs that Add from URL runs as separate processes
(docs/DEPENDENCIES.md). Nothing here is committed except this README. Fill
it with:

    pnpm fetch-tools

from `apps/desktop`, which downloads and checksum-verifies:

- `yt-dlp(.exe)`: the official release executable. It's a GPLv3+ combined
  work, so its tagged source tarball lands in `source/` beside it and ships
  with any build that includes it.
- `deno(.exe)`: the JavaScript runtime yt-dlp needs for YouTube (MIT,
  `DENO-LICENSE.md`).
- `VERSIONS.json`: the versions and sha256 of what was fetched.

At runtime the app copies yt-dlp into its data folder
(`%LOCALAPPDATA%\baritoad\tools\`) and runs it from there, so it can update
itself (`yt-dlp -U`). Install folders aren't writable, and changing a file
inside a signed macOS bundle breaks the signature.
