# Contributing to baritoad

Thanks for wanting to help. Bug reports, timing problems with a particular
kind of song, and pull requests are all welcome.

## Reporting a bug

Open an issue with what you did, what you expected and what happened, plus
your Windows version and graphics card. **Don't attach songs or lyrics** —
they're almost always copyrighted. Describe the song instead (genre, length,
anything unusual about it).

## Pull requests

- Read [CLAUDE.md](CLAUDE.md) first — despite the name, it's the project's
  rulebook for humans and coding agents alike. The hard rules there aren't
  negotiable: no bundled music, no uploading user audio, no lyrics scraping,
  nothing but metadata through the party relay.
- A new dependency or model updates the matrix in
  [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) in the same change, and has to
  be GPL-3.0-compatible and redistributable.
- Never commit audio, model weights or real song lyrics. Test fixtures use
  invented lines or public-domain songs.
- Performance claims need measured numbers: song length, hardware, wall time.
- Run the checks before you push:
  ```
  cargo test -p karaoke-core -p karaoke-desktop
  cd apps/desktop && pnpm test && pnpm build
  ```
- Copy in the app follows [DESIGN.md](DESIGN.md): plain, short, and
  "baritoad" is always lowercase.

## Sign your commits (DCO)

baritoad uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. By adding a `Signed-off-by:` line to each commit, you
certify that you wrote the change or otherwise have the right to submit it
under the project's license (GPL-3.0-or-later). `git commit -s` adds the
line for you:

```
Signed-off-by: Your Name <you@example.com>
```

## License

By contributing, you agree that your contributions are licensed under
GPL-3.0-or-later, including the additional permission for GPU runtimes
described in the [README](README.md#license).
