// End to end against a running relay (`pnpm dev` in another terminal, or
// RELAY=https://... for a deployed one): a fake host app and fake guests go
// through a whole party. Prints each check and the pick → app → guest time.
//
//   node test/e2e.mjs
const BASE = process.env.RELAY ?? "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

/** A socket with a queue of received frames and a `next(t)` that waits for one. */
function open(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  };
  const ready = new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const closed = new Promise((r) => (ws.onclose = (e) => r(e)));
  return {
    ws,
    ready,
    closed,
    send: (m) => ws.send(JSON.stringify(m)),
    next(t, ms = 3000) {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ t, resolve });
        setTimeout(() => reject(new Error(`no ${t} within ${ms} ms`)), ms);
      });
    },
  };
}

const toad = { face: "grin", colour: "pink", hat: "bow" };
const songs = [
  { id: "s0000000001", title: "Back On My BS", artist: "Pip", duration: 201, collections: ["Cassie's hits"] },
  { id: "s0000000002", title: "Wildflowers", artist: "Tom Petty", duration: 190, collections: [] },
];

// ---- the host opens a room
const host = open(`${WS}/host`);
await host.ready;
host.send({ v: 1, t: "hello", app: "baritoad/e2e" });
const room = await host.next("room");
check(/^[a-z0-9]{10}$/.test(room.room) && room.secret.length === 48, "room opens with an id and a secret");
const [, , r, key] = new URL(room.joinUrl).pathname.split("/");
check(r === room.room && /^[a-z0-9]{6}$/.test(key), `join link ${room.joinUrl}`);
host.send({ v: 1, t: "listing", songs });
host.send({ v: 1, t: "queue", entries: [{ id: "e1", song: "s0000000002" }] });

// ---- the page
const page = await fetch(room.joinUrl);
const html = await page.text();
check(page.status === 200 && html.includes("/guest.js") && page.headers.get("content-security-policy")?.includes("default-src 'none'"), "guest page served with a strict CSP");

// ---- a guest joins
const g = open(`${WS}/g/${room.room}/${key}`);
await g.ready;
g.send({ t: "join", name: "  Cassie \t ", toad });
const welcome = await g.next("welcome");
check(welcome.name === "Cassie" && welcome.songs.length === 2 && welcome.entries.length === 1 && welcome.hostHere, "guest gets the list, the queue, a cleaned name");
const joined = await host.next("guest_joined");
check(joined.name === "Cassie" && joined.toad.hat === "bow" && joined.guest === welcome.guest, "host hears who joined");

// ---- a pick goes to the app and back
const t0 = performance.now();
g.send({ t: "pick", song: "s0000000001" });
const req = await host.next("request");
check(req.guest === welcome.guest && req.song === "s0000000001", "the pick reaches the app");
host.send({ v: 1, t: "request_result", req: req.req, ok: true });
host.send({
  v: 1,
  t: "queue",
  entries: [
    { id: "e1", song: "s0000000002" },
    { id: "e2", song: "s0000000001", singer: "Cassie", toad, guest: welcome.guest },
  ],
  nowPlaying: "e1",
});
const picked = await g.next("picked");
const pickMs = performance.now() - t0;
const q = await g.next("queue");
check(picked.ok, `the guest hears it's in (pick → app → guest ${pickMs.toFixed(0)} ms on this relay)`);
check(q.entries[1].mine === true && !JSON.stringify(q).includes(welcome.guest) && q.nowPlaying === "e1", "the guest's queue marks theirs, shows no guest ids");

// ---- a refused pick
g.send({ t: "pick", song: "s0000000002" });
const req2 = await host.next("request");
host.send({ v: 1, t: "request_result", req: req2.req, ok: false, code: "limit" });
const refused = await g.next("picked");
check(!refused.ok && refused.code === "limit", "a refusal reaches the guest with its reason");

// ---- take back
g.send({ t: "withdraw", entry: "e2" });
const w = await host.next("withdraw");
check(w.entry === "e2" && w.guest === welcome.guest, "take back reaches the app");

// ---- a bad name
const bad = open(`${WS}/g/${room.room}/${key}`);
await bad.ready;
bad.send({ t: "join", name: "   ", toad });
check((await bad.next("bye")).why === "invalid", "an empty name is refused");
bad.ws.close();

// ---- a new code: old links stop working
host.send({ v: 1, t: "new_code" });
const room2 = await host.next("room");
check(room2.room === room.room && room2.joinUrl !== room.joinUrl, "new code, same room");
const stale = open(`${WS}/g/${room.room}/${key}`);
await stale.ready;
check((await stale.next("bye")).why === "gone", "the old link says it's gone");

// ---- the host drops and comes back with its secret
host.ws.close();
check((await g.next("host")).here === false, "guests hear the host is away");
const thief = open(`${WS}/host?room=${room.room}`);
await thief.ready;
thief.send({ v: 1, t: "hello", app: "x", resume: { room: room.room, secret: "nope" } });
check((await thief.next("error")).code === "room_taken", "someone else can't take the room");
const back = open(`${WS}/host?room=${room.room}`);
await back.ready;
back.send({ v: 1, t: "hello", app: "baritoad/e2e", resume: { room: room.room, secret: room.secret } });
const again = await back.next("room");
check(again.room === room.room && again.joinUrl === room2.joinUrl, "the host resumes its room");
check((await back.next("guest_joined")).guest === welcome.guest, "…and hears who's still here");
check((await g.next("host")).here === true, "guests hear the host is back");

// ---- an old protocol version
const old = open(`${WS}/host`);
await old.ready;
old.send({ v: 2, t: "hello", app: "future" });
check((await old.next("error")).code === "version", "another protocol version is refused");

// ---- kick, then end the party
back.send({ v: 1, t: "kick", guest: welcome.guest });
check((await g.next("bye")).why === "kicked", "a kicked guest is told");
check((await back.next("guest_left")).guest === welcome.guest, "the host hears they left");
const g2 = open(`${WS}/g/${room.room}/${new URL(room2.joinUrl).pathname.split("/")[3]}`);
await g2.ready;
g2.send({ t: "join", name: "Dev", toad: { face: "cool", colour: "blue", hat: "cap" } });
await g2.next("welcome");
back.send({ v: 1, t: "close" });
check((await g2.next("bye")).why === "closed", "ending the party tells the guests");
const gone = open(`${WS}/host?room=${room.room}`);
await gone.ready;
gone.send({ v: 1, t: "hello", app: "baritoad/e2e", resume: { room: room.room, secret: room.secret } });
check((await gone.next("error")).code === "room_gone", "an ended party is gone for good");

for (const s of [g2, back, old, gone, thief, stale]) s.ws.close();
await sleep(100);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
