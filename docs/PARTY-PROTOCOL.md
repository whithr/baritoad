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
| `queue` | `entries: [{id, song, singer?, toad?, guest?}]`, `nowPlaying?` (song id) | after every queue change |
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
- Song list size: measure for a 500-song library before choosing whether to
  page it.
