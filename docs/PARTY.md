# Party mode — design

Status: **designed, not built.** Party mode is free — it runs through our
relay, but nobody signs in (PLAN.md §3 v1.x, §8; owner decision 2026-10-01).
It starts after v1.0 ships (PLAN.md §9 Phase 4). This page is the design the desktop side will be built
to. The wire protocol is in [PARTY-PROTOCOL.md](PARTY-PROTOCOL.md).

## What it is

The host starts a party. A QR code shows on the TV. Guests scan it and get a
web page on their phone — no app, no sign-in. They make a toad (a name, a
colour, a hat), pick a song from the host's library, and land in the
up-next queue. The TV shows the queue with each singer's toad and name.
Nobody signs in — not the host, not the guests.

## What leaves the host's machine

Only while a party is open, and only this:

- **The song list:** for each song that already has timings, a per-party song
  id, title, artist, duration, and the names of the collections it's in.
- **The queue:** entry id, song id, singer name, toad.
- **What's playing now:** its song id.

Never: audio, lyrics, timing maps, cover art, file paths, or file hashes.
`Song` and `QueueEntry` carry local paths today, so the party code projects
them into its own metadata-only types, and a test checks that nothing else
gets out.

Guests send a display name and a toad, nothing else (PLAN.md §8). The relay
keeps the room in that party's own storage only while it's open, and deletes
it when the host ends the party or has been disconnected for 10 minutes.

## Who decides

The desktop app owns the queue. A guest's pick travels relay → app; the app
applies it through the same `LibraryStore` queue functions the Library uses,
then publishes the new queue, and the relay passes it on to the guests.

- **Picks go straight into the queue** (owner decision 2026-10-01). The host
  can reorder, remove, or kick a guest. Each guest can have at most 2 songs
  waiting (a setting); a song without timings, or one that isn't in the
  list, is refused.
- Every queue change — from the Library, the Stage, or a guest — is emitted
  from Rust as `karaoke://queue`, so both windows update live.

## The pieces

**Desktop (this repo, open):**

- `karaoke-core` gains a `party` module with no I/O: the protocol types, the
  song-list projection, the request rules, and toad validation.
- The library store gains singer, toad, and guest columns on the queue
  (schema v4).
- `src-tauri/src/party.rs`: the relay client. It runs on its own thread like
  the game watcher (`gaming.rs`) and holds one outbound WebSocket
  (`tungstenite`, native TLS like `ureq`) — no listening port, so no firewall
  prompt and no same-network requirement. It emits `karaoke://party` (status,
  join link, guest count).
- QR codes come from `qrcodegen` and are drawn as crisp SVG squares.
- UI: a **Party** menu in the Library (Start party…, New join code, End
  party); a Party dialog saying plainly what's shared, with the guest list and
  Kick; a Singer column in Up next; and a Stage join screen between songs —
  big QR, "scan to join", and the queue with toads and names. While a party
  is open, the Library status bar stops saying nothing is uploaded and says
  what is.

**Relay and guest page (ours, closed source, separate private repo):**
hosted on Cloudflare Workers, one small object per party that sleeps
between messages (owner decision 2026-10-01). The guest page is the
site's phone flow made real: make your toad → pick a song (search,
collections) → "you're #N in line" → start over. It never carries audio or
lyrics, and it never touches the host's files.

## Toads

Guests' toads come from the toad family the site draws (faces, colours,
things to wear — the same 16×20 grid and palette as the app's 16-px toad).
On the Stage and in Up next they're drawn at whole-pixel multiples, crisp,
never smoothed. This is a party-mode exception to DESIGN.md's toad rule
(owner decision 2026-10-01); the plain singing toad stays the app's mark.
A toad's colour is never the only way to tell singers apart — the name is
always shown with it.

## Keeping it free

Party mode costs us relay time, so the relay is built to stay on
Cloudflare's free plan as long as it can:

- **Sleep between messages.** Each party's object hibernates when nothing is
  happening. That's why its state lives in the party's own storage rather than
  memory, which a sleeping object loses.
- **Keepalive that doesn't wake it.** The app keeps its connection alive with
  WebSocket protocol pings, which Cloudflare answers without waking the
  object. App-level "ping" messages would keep it awake the whole party.
- **Abuse limits instead of accounts.** The app is open and the protocol is
  public, so anyone can open rooms. The relay caps new rooms per IP, guests
  per room, and how long a room lives. On the free plan the worst case is
  party mode stopping until the next day, never a surprise bill.

Estimate, to be measured in milestone 3: a 3-hour party with 8 guests should
fit the free plan's daily allowance dozens of times over, as long as the
object sleeps between messages.

## New dependencies

Each gets a PLAN.md §6 row in the change that adds it: `tungstenite` (and the
crates it brings) and `qrcodegen`.

## Milestones (after v1.0)

1. Queue groundwork, if v1.0's queue auto-advance work didn't already do it:
   schema v4, `karaoke://queue`, the Singer column, the between-songs Stage
   screen.
2. The `party` core module, the protocol doc filled in, tests.
3. Relay and guest page MVP with a development token (private repo).
4. Relay client, Party menu and dialog, QR, Stage join screen, toads —
   tested end to end with a real phone on cellular.
5. Abuse limits, hosting, launch copy.

## How it will be checked

- Unit tests: protocol round-trip; the song-list JSON contains no path or hash
  fields; request rules; the v3 → v4 schema upgrade.
- The bench mock gains party commands and fake guests, so the UI can be built
  and screenshotted without the relay.
- End to end: a local relay, the real app, and a phone on cellular — scan,
  make a toad, pick a song, see it on the Stage, remove it; drop the Wi-Fi and
  watch it reconnect; log every relay frame and confirm nothing but the list
  above goes out. Measured, with numbers: pick-to-Stage latency, and song-list
  size for a 500-song library.
