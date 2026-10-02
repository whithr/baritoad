// New rooms per address: one small Durable Object per client IP counting the
// rooms it opened this hour. No accounts, so this (with the per-room limits
// in room.ts) is what stops a script from opening rooms forever. Nothing is
// kept but the count and the hour.

import { DurableObject } from "cloudflare:workers";

export const ROOMS_PER_HOUR = 10;

export class Limiter extends DurableObject {
  async fetch(): Promise<Response> {
    const hour = Math.floor(Date.now() / 3_600_000);
    const seen = (await this.ctx.storage.get<{ hour: number; count: number }>("rooms")) ?? { hour, count: 0 };
    const count = seen.hour === hour ? seen.count + 1 : 1;
    await this.ctx.storage.put("rooms", { hour, count });
    // Forget the address an hour after it was last here.
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
    return Response.json({ allowed: count <= ROOMS_PER_HOUR });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
