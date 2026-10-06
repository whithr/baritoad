# baritoad party relay

The server behind party mode ([docs/PARTY.md](../../docs/PARTY.md)): the
desktop app keeps one outbound WebSocket to it, guests' phones load the party
page from it, and it passes the song list and the queue between them. Open
source, GPL-3.0-or-later, like the app. We host the official one; the app
connects to it unless told otherwise (`KARAOKE_PARTY_RELAY`), and anyone can
run their own.

Wire protocol: [docs/PARTY-PROTOCOL.md](../../docs/PARTY-PROTOCOL.md).

## What it keeps, and for how long

One Cloudflare Durable Object per party (`src/room.ts`), holding in its own
storage only while the party is open:

- the room id, the host's secret and the current join key
- the song list the app sent (per song: an opaque id, title, artist,
  duration, collection names)
- the queue the app sent (entry id, song, singer name, toad, guest id)
- each guest's display name and toad

Never audio, lyrics, timing maps, cover art or anything from the host's files —
the app doesn't send them. It's all deleted when the host ends the party,
10 minutes after the host's connection drops, or 12 hours after the party
started. Guests' ids never reach other guests; their pages see only which
entries are their own.

## Limits (no accounts, so these instead)

| Limit | Value | Where |
|---|---|---|
| New parties per address | 10 an hour | `src/limiter.ts` (the address is hashed, and forgotten after an hour) |
| Guests per party | 40 | `LIMITS` in `src/room.ts` |
| Messages per guest | 30 a minute | `LIMITS` |
| Largest message | 512 KB | `LIMITS` |
| Party lifetime | 12 hours | `LIMITS` |
| Host away | 10 minutes | `LIMITS` |

On Cloudflare's free plan the worst case is party mode stopping until the
next day, never a bill. Each party's object sleeps between messages
(WebSocket hibernation), which is what keeps it free.

## Running it

```
cd services/relay
pnpm install
pnpm dev        # http://127.0.0.1:8787 — no Cloudflare account needed
pnpm e2e        # a fake app and fake guests through a whole party (needs dev running)
pnpm test       # unit tests
pnpm typecheck
```

Point the app at a local relay with `KARAOKE_PARTY_RELAY=ws://127.0.0.1:8787`.

Deploying (`pnpm run deploy` — plain `pnpm deploy` is a built-in pnpm command) publishes to the Cloudflare account `wrangler login`
signed in to. No secrets live in this folder: the account's API token stays
with wrangler or in CI settings.

## Layout

- `src/worker.ts` — routes: `/host` (the app's socket), `/j/ROOM/KEY` (the
  guest page the QR code opens), `/g/ROOM/KEY` (a guest's socket)
- `src/room.ts` — one party (Durable Object, hibernating WebSockets)
- `src/limiter.ts` — new parties per address
- `src/shared.ts` — the frames, name cleaning, what guests see of the queue
- `src/guest/` — the guest page: make your toad → pick a song → you're in
  line. Toads come from the app's own `apps/desktop/src/party/toads.ts`.
- `scripts/build-guest.mjs` — bundles the page into `public/`

## Dependencies

Nothing at runtime: the Worker bundles only this folder's code and the app's
`toads.ts`. Development only: wrangler, workerd (via wrangler), esbuild,
TypeScript, vitest, @cloudflare/workers-types — MIT or Apache-2.0
themselves, with transitive ISC, BSD-3-Clause and CC0 packages and sharp
(Apache-2.0 with LGPL-3.0 libvips, via wrangler); none of it reaches the
deployed Worker. The guest
page uses the app's Pixel Operator font (CC0, copied at build). No AGPL code
([docs/DEPENDENCIES.md](../../docs/DEPENDENCIES.md)).
