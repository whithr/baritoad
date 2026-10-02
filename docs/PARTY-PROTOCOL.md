# Party relay protocol — draft v1

Status: **draft, not implemented.** This is the wire protocol between the
desktop app and the party relay (design: [PARTY.md](PARTY.md)). It lives in
the open repo so anyone can see exactly what the app sends — and so a fork
can run its own relay. The relay itself is ours and closed (PLAN.md §5, §8).

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
| `queue` | `entries: [{id, song, singer?, toad?}]`, `nowPlaying?` (song id) | after every queue change |
| `request_result` | `req`, `ok` or `code` (`limit`, `unknown_song`, `not_ready`) | answering a `request` |
| `kick` | `guest` | host removes a guest |
| `new_code` | — | host rotates the join link |
| `close` | — | host ends the party |

Song ids are per-party and opaque — not library database ids.

**Relay → app**

| `t` | Fields | When |
|---|---|---|
| `room` | `room`, `secret`, `joinUrl` | the room is open (new or resumed) |
| `guest_joined` | `guest`, `name`, `toad: {colour, hat}` | a guest finished making their toad |
| `request` | `req`, `guest`, `song` | a guest picked a song |
| `withdraw` | `guest`, `entry` | a guest pressed "start over" |
| `guest_left` | `guest` | a guest closed the page or was kicked |
| `error` | `code`, `message` | too many rooms from here, room full, room gone |

## Limits (to settle while building)

- Names: up to 14 characters, trimmed; toads: colour and hat from fixed
  lists.
- Song list size: measure for a 500-song library before choosing whether to
  page it.
