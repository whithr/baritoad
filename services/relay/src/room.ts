// One party: a Durable Object that holds the host's socket and the guests',
// with the WebSocket hibernation API so it sleeps between messages (that's
// what keeps party mode on the free plan — docs/PARTY.md "Keeping it free").
// Everything it knows lives in its own storage while the party is open — the
// song list, the queue, the guests' names and toads — and is deleted when the
// host ends the party, after 10 minutes without the host, or after 12 hours.
// It never sees audio, lyrics or anything from the host's files.

import { DurableObject } from "cloudflare:workers";
import {
  cleanName,
  forGuest,
  frame,
  isToad,
  PROTOCOL_VERSION,
  randomId,
  type AppMsg,
  type GuestDown,
  type GuestUp,
  type ListedSong,
  type RelayMsg,
  type SharedEntry,
  type Toad,
} from "./shared";

export interface Env {
  ROOMS: DurableObjectNamespace;
  LIMITS: DurableObjectNamespace;
  ASSETS: Fetcher;
  PUBLIC_ORIGIN?: string;
}

/** The limits that keep a free service from being run over. */
export const LIMITS = {
  guestsPerRoom: 40,
  hostAwayMs: 10 * 60 * 1000,
  roomLifetimeMs: 12 * 60 * 60 * 1000,
  /** Messages a guest may send per minute. */
  guestMessagesPerMinute: 30,
  /** Largest frame accepted from anyone, in bytes (a 500-song list fits). */
  maxFrameBytes: 512 * 1024,
};

interface Meta {
  room: string;
  secret: string;
  key: string;
  origin: string;
  created: number;
  /** When the host's socket closed, if it's away. */
  hostAwaySince?: number;
}

interface GuestInfo {
  name: string;
  toad: Toad;
}

/** A host socket counts once its hello checks out (`authed`). */
type Attachment = { role: "host"; authed?: true } | { role: "guest"; guest?: string; window?: number; sent?: number };

export class Room extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const role = request.headers.get("X-Baritoad-Role");
    const room = request.headers.get("X-Baritoad-Room") ?? "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (role === "host") {
      // It replaces the old connection only once its hello checks out.
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ role: "host" } satisfies Attachment);
      // Remember where to send people until hello says more.
      await this.ctx.storage.put("pending-room", { room, origin: request.headers.get("X-Baritoad-Origin") ?? "" });
    } else {
      const meta = await this.meta();
      this.ctx.acceptWebSocket(server, ["guest"]);
      server.serializeAttachment({ role: "guest" } satisfies Attachment);
      if (!meta || meta.key !== request.headers.get("X-Baritoad-Key")) {
        this.toGuest(server, { t: "bye", why: "gone" });
        server.close(4004, "gone");
      } else if (this.ctx.getWebSockets("guest").length > LIMITS.guestsPerRoom) {
        this.toGuest(server, { t: "bye", why: "full" });
        server.close(4029, "full");
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------- frames

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > LIMITS.maxFrameBytes) return;
    const att = ws.deserializeAttachment() as Attachment;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (att.role === "host") await this.fromHost(ws, msg as AppMsg & { v?: number });
    else await this.fromGuest(ws, att, msg as GuestUp);
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment;
    if (att.role === "host") {
      if (!att.authed) return; // never got in (wrong secret, old version)
      if (this.hosts().some((w) => w !== ws)) return; // replaced, not gone
      const meta = await this.meta();
      if (!meta) return;
      meta.hostAwaySince = Date.now();
      await this.ctx.storage.put("meta", meta);
      await this.ctx.storage.setAlarm(Date.now() + LIMITS.hostAwayMs);
      this.toGuests({ t: "host", here: false });
    } else if (att.guest) {
      this.toHost({ t: "guest_left", guest: att.guest });
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /** The host away too long, or the room too old: end it. */
  async alarm() {
    const meta = await this.meta();
    if (!meta) return;
    const now = Date.now();
    const away = meta.hostAwaySince != null && now - meta.hostAwaySince >= LIMITS.hostAwayMs;
    const old = now - meta.created >= LIMITS.roomLifetimeMs;
    if (away || old) {
      await this.end(old ? "closed" : "gone");
    } else {
      await this.ctx.storage.setAlarm(meta.hostAwaySince != null ? meta.hostAwaySince + LIMITS.hostAwayMs : meta.created + LIMITS.roomLifetimeMs);
    }
  }

  // ---------------------------------------------------------------- host

  private async fromHost(ws: WebSocket, m: AppMsg & { v?: number }) {
    if (m.v !== PROTOCOL_VERSION) {
      this.send(ws, { t: "error", code: "version", message: `This relay speaks protocol ${PROTOCOL_VERSION}; please update baritoad.` });
      ws.close(4426, "version");
      return;
    }
    if (m.t === "hello") return this.hello(ws, m);
    const meta = await this.meta();
    const att = ws.deserializeAttachment() as Attachment;
    if (!meta || att.role !== "host" || !att.authed) return; // hello first
    switch (m.t) {
      case "listing":
        if (!Array.isArray(m.songs)) return;
        await this.ctx.storage.put("listing", m.songs);
        this.toGuests({ t: "listing", songs: m.songs });
        return;
      case "queue": {
        if (!Array.isArray(m.entries)) return;
        const q = { entries: m.entries, nowPlaying: m.nowPlaying };
        await this.ctx.storage.put("queue", q);
        for (const g of this.ctx.getWebSockets("guest")) {
          const a = g.deserializeAttachment() as Attachment;
          if (a.role === "guest" && a.guest) this.toGuest(g, { t: "queue", entries: forGuest(q.entries, a.guest), nowPlaying: q.nowPlaying });
        }
        return;
      }
      case "request_result": {
        const pending = (await this.ctx.storage.get<Record<string, string>>("pending")) ?? {};
        const guest = pending[m.req];
        delete pending[m.req];
        await this.ctx.storage.put("pending", pending);
        if (guest) for (const g of this.guestSockets(guest)) this.toGuest(g, { t: "picked", ok: !!m.ok, code: m.code });
        return;
      }
      case "kick": {
        for (const g of this.guestSockets(m.guest)) {
          this.toGuest(g, { t: "bye", why: "kicked" });
          g.serializeAttachment({ role: "guest" } satisfies Attachment);
          g.close(4003, "kicked");
        }
        const guests = (await this.ctx.storage.get<Record<string, GuestInfo>>("guests")) ?? {};
        delete guests[m.guest];
        await this.ctx.storage.put("guests", guests);
        this.toHost({ t: "guest_left", guest: m.guest });
        return;
      }
      case "new_code":
        meta.key = randomId(6);
        await this.ctx.storage.put("meta", meta);
        this.send(ws, this.roomMsg(meta));
        return;
      case "close":
        await this.end("closed");
        return;
    }
  }

  private async hello(ws: WebSocket, m: Extract<AppMsg, { t: "hello" }>) {
    let meta = await this.meta();
    const pending = await this.ctx.storage.get<{ room: string; origin: string }>("pending-room");
    if (meta) {
      if (!m.resume || m.resume.secret !== meta.secret || m.resume.room !== meta.room) {
        this.send(ws, { t: "error", code: "room_taken", message: "That party belongs to someone else." });
        ws.close(4001, "room_taken");
        return;
      }
      meta.hostAwaySince = undefined;
      if (pending?.origin) meta.origin = pending.origin;
    } else {
      if (m.resume) {
        // The room is gone (ended, or the host was away too long).
        this.send(ws, { t: "error", code: "room_gone", message: "That party has ended." });
        ws.close(4004, "room_gone");
        return;
      }
      const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
      meta = { room: pending?.room ?? randomId(10), secret, key: randomId(6), origin: pending?.origin ?? "", created: Date.now() };
    }
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(meta.created + LIMITS.roomLifetimeMs);
    // In: this socket is the host now, and an older one (the app before it
    // reconnected) goes.
    for (const old of this.hosts()) if (old !== ws) old.close(4000, "replaced");
    ws.serializeAttachment({ role: "host", authed: true } satisfies Attachment);
    this.send(ws, this.roomMsg(meta));
    this.toGuests({ t: "host", here: true });
    // Tell the app who's here (it may have restarted).
    const guests = (await this.ctx.storage.get<Record<string, GuestInfo>>("guests")) ?? {};
    for (const g of this.ctx.getWebSockets("guest")) {
      const a = g.deserializeAttachment() as Attachment;
      if (a.role === "guest" && a.guest && guests[a.guest]) this.send(ws, { t: "guest_joined", guest: a.guest, ...guests[a.guest] });
    }
  }

  private roomMsg(meta: Meta): RelayMsg {
    return { t: "room", room: meta.room, secret: meta.secret, joinUrl: `${meta.origin}/j/${meta.room}/${meta.key}` };
  }

  // ---------------------------------------------------------------- guests

  private async fromGuest(ws: WebSocket, att: Extract<Attachment, { role: "guest" }>, m: GuestUp) {
    // A small rate limit per socket (kept in its attachment, so it survives sleep).
    const minute = Math.floor(Date.now() / 60000);
    const sent = att.window === minute ? (att.sent ?? 0) + 1 : 1;
    ws.serializeAttachment({ ...att, window: minute, sent });
    if (sent > LIMITS.guestMessagesPerMinute) return;
    const meta = await this.meta();
    if (!meta) return;
    switch (m.t) {
      case "join": {
        const name = cleanName(m.name);
        if (!name || !isToad(m.toad)) {
          this.toGuest(ws, { t: "bye", why: "invalid" });
          return;
        }
        const toad: Toad = { face: m.toad.face, colour: m.toad.colour, hat: m.toad.hat };
        const guests = (await this.ctx.storage.get<Record<string, GuestInfo>>("guests")) ?? {};
        // Back after a reload: same guest, so their songs stay theirs.
        const guest = typeof m.guest === "string" && guests[m.guest] ? m.guest : randomId(12);
        guests[guest] = { name, toad };
        await this.ctx.storage.put("guests", guests);
        ws.serializeAttachment({ role: "guest", guest, window: minute, sent } satisfies Attachment);
        const songs = (await this.ctx.storage.get<ListedSong[]>("listing")) ?? [];
        const q = (await this.ctx.storage.get<{ entries: SharedEntry[]; nowPlaying?: string }>("queue")) ?? { entries: [] };
        this.toGuest(ws, {
          t: "welcome",
          guest,
          name,
          toad,
          songs,
          entries: forGuest(q.entries, guest),
          nowPlaying: q.nowPlaying,
          hostHere: this.hosts().length > 0,
        });
        this.toHost({ t: "guest_joined", guest, name, toad });
        return;
      }
      case "pick": {
        if (!att.guest) return this.toGuest(ws, { t: "picked", ok: false, code: "not_joined" });
        if (this.hosts().length === 0) return this.toGuest(ws, { t: "picked", ok: false, code: "host_away" });
        if (typeof m.song !== "string") return;
        const req = randomId(8);
        const pending = (await this.ctx.storage.get<Record<string, string>>("pending")) ?? {};
        pending[req] = att.guest;
        await this.ctx.storage.put("pending", pending);
        this.toHost({ t: "request", req, guest: att.guest, song: m.song });
        return;
      }
      case "withdraw":
        if (att.guest && typeof m.entry === "string") this.toHost({ t: "withdraw", guest: att.guest, entry: m.entry });
        return;
    }
  }

  // ---------------------------------------------------------------- helpers

  private meta() {
    return this.ctx.storage.get<Meta>("meta");
  }

  /** The host's socket(s) that got in. */
  private hosts() {
    return this.ctx.getWebSockets("host").filter((h) => (h.deserializeAttachment() as Attachment).role === "host" && (h.deserializeAttachment() as { authed?: true }).authed);
  }

  private guestSockets(guest: string) {
    return this.ctx.getWebSockets("guest").filter((g) => {
      const a = g.deserializeAttachment() as Attachment;
      return a.role === "guest" && a.guest === guest;
    });
  }

  private send(ws: WebSocket, m: RelayMsg) {
    try {
      ws.send(frame(m));
    } catch {
      // closing
    }
  }

  private toHost(m: RelayMsg) {
    for (const h of this.hosts()) this.send(h, m);
  }

  private toGuest(ws: WebSocket, m: GuestDown) {
    try {
      ws.send(JSON.stringify(m));
    } catch {
      // closing
    }
  }

  private toGuests(m: GuestDown) {
    for (const g of this.ctx.getWebSockets("guest")) {
      const a = g.deserializeAttachment() as Attachment;
      if (a.role === "guest" && a.guest) this.toGuest(g, m);
    }
  }

  /** End the party: tell everyone, close every socket, forget everything. */
  private async end(why: "closed" | "gone") {
    for (const g of this.ctx.getWebSockets("guest")) {
      this.toGuest(g, { t: "bye", why });
      g.close(4000, why);
    }
    for (const h of this.ctx.getWebSockets("host")) h.close(1000, "closed");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
