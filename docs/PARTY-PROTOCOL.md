# Party relay protocol — v1

Status: **v1, being implemented** (karaoke-core `party` holds the types). This is the wire protocol between the
desktop app and the party relay (design: [PARTY.md](PARTY.md)). Both sides
are in this repo — the app's client in `apps/desktop/src-tauri/src/party.rs`,
the relay in `services/relay/` — so anyone can see exactly what goes over the
wire, and a fork can run its own relay.

## Framing

- One outbound WebSocket from the app to the relay, over TLS.
- JSON text frames: `{"v": 1, "t": "<type>", ...}`. Unknown types are ignored;
  a different `v` closes the connection with a "please update" reason.
- Keepalive: a WebSocket protocol ping every 25 s — never an app-level
  message, which would wake the relay's sleeping party object. On a dropped
  connection the app reconnects with backoff and resumes its room with the
  host secret from `room`.
- No sign-in: party mode is free. The relay limits rooms per IP, guests per
  room, and room lifetime instead.

## Messages

**App → relay**

| `t` | Fields | When |
|---|---|---|
| `hello` | `app` (version), `resume?` (`room`, `secret`) | first frame |
| `listing` | `songs: [{id, title, artist, duration, collections}]` | after `room`, and when the library changes |
| `queue` | `entries: [{id, song, singer?, toad?, guest?}]`, `nowPlaying?` (the entry on the Stage) | after every queue change |
| `request_result` | `req`, `ok` or `code` (`limit`, `unknown_song`, `not_ready`) | answering a `request` |
| `kick` | `guest` | host removes a guest |
| `new_code` | — | host rotates the join link |
| `close` | — | host ends the party |

Song ids are per-party and opaque — not library database ids: `s` + 10 hex
characters of sha256(party salt, library id), stable while the party lasts and
meaningless in the next one. Entry ids are `e<n>`. Guest ids are the relay's,
random per party. `guest` on a queue entry lets a guest's page say "you're #N";
a host's own picks have no `singer`, `toad` or `guest`.

**Relay → app**

| `t` | Fields | When |
|---|---|---|
| `room` | `room`, `secret`, `joinUrl` | the room is open (new or resumed) |
| `guest_joined` | `guest`, `name`, `toad: {face, colour, hat}` | a guest finished making their toad |
| `request` | `req`, `guest`, `song` | a guest picked a song |
| `withdraw` | `guest`, `entry` | a guest pressed "start over" |
| `guest_left` | `guest` | a guest closed the page or was kicked |
| `error` | `code`, `message` | too many rooms from here, room full, room gone |

## Values

- Names: control characters removed, whitespace collapsed, trimmed, up to 14
  characters (`party::clean_name`). The relay applies the same rule.
- Toads: `face` one of sing, smile, grin, wink, sleepy, surprised, love, cool,
  belt, nervous, sad; `colour` one of green, pink, blue, gold, purple; `hat`
  one of none, crown, partyhat, cap, bow, headphones, bowtie. Anything else is
  refused.
- `code` on `request_result`: `limit` (the guest has 2 songs waiting — the
  host's setting), `unknown_song`, `not_ready` (lost its timings).
- Song list size: measured 85 KB for a 500-song library (long titles, two
  collections each; `party::tests::a_500_song_list_fits_one_frame`), so it
  goes in one frame and isn't paged. The relay accepts frames up to 512 KB.

## Guest page ⇄ relay

The guest page (served by the relay at `/j/ROOM/KEY`) has its own socket at
`/g/ROOM/KEY`. Plain JSON frames, no version field — the relay serves the
page, so the two always match. Guests never see each other's guest ids: the
relay strips `guest` from queue entries and marks a guest's own with
`mine: true`.

| Guest → relay | Fields |
|---|---|
| `join` | `name`, `toad`, `guest?` (to come back as the same guest after a reload) |
| `pick` | `song` |
| `withdraw` | `entry` |

| Relay → guest | Fields |
|---|---|
| `welcome` | `guest`, `name`, `toad`, `songs`, `entries`, `nowPlaying?`, `hostHere` |
| `listing` | `songs` |
| `queue` | `entries` (with `mine`), `nowPlaying?` |
| `picked` | `ok`, `code?` (`limit`, `unknown_song`, `not_ready`, `host_away`, `not_joined`) |
| `host` | `here` — the app dropped or came back |
| `bye` | `why`: `kicked`, `closed`, `gone` (ended, or the code changed), `full`, `invalid` (no name / bad toad) |

## Routes

- `GET /host` — the app's socket for a new party; `GET /host?room=ROOM` to
  resume its own after a drop (`hello` must carry the room's secret).
- `GET /j/ROOM/KEY` — the guest page. `GET /g/ROOM/KEY` — a guest's socket.
- Room ids are 10 characters, keys 6, from `a–z` and `2–9` without look-alikes.
  New code (`new_code`) changes the key; old links stop working, guests already
  in stay.
