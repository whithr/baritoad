// baritoad's party relay (docs/PARTY.md): routes the app's socket and the
// guests' to their party's Durable Object, and serves the guest page.
//
//   GET /host[?room=ID]   WebSocket for the desktop app (a new room, or its
//                         own room again after a dropped connection)
//   GET /j/ROOM/KEY       the guest page (what the QR code opens)
//   GET /g/ROOM/KEY       WebSocket for a guest's phone
//
// Open source (GPL-3.0-or-later) like the app. Nothing here needs a secret.

import { Limiter } from "./limiter";
import { Room, type Env } from "./room";
import { randomId } from "./shared";

export { Limiter, Room };

const ROOM_RE = /^[a-z0-9]{10}$/;
const KEY_RE = /^[a-z0-9]{6}$/;

async function ipKey(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`baritoad-rooms:${ip}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function forward(env: Env, room: string, request: Request, headers: Record<string, string>): Promise<Response> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
  const h = new Headers(request.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  h.set("X-Baritoad-Room", room);
  return stub.fetch(new Request(request.url, { headers: h }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const ws = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const origin = env.PUBLIC_ORIGIN || url.origin;

    if (parts[0] === "host" && parts.length === 1) {
      if (!ws) return new Response("baritoad party relay: WebSocket only", { status: 426 });
      const resume = url.searchParams.get("room");
      if (resume) {
        if (!ROOM_RE.test(resume)) return new Response("bad room", { status: 400 });
        return forward(env, resume, request, { "X-Baritoad-Role": "host", "X-Baritoad-Origin": origin });
      }
      const limit = await env.LIMITS.get(env.LIMITS.idFromName(await ipKey(request))).fetch("https://limit/");
      const { allowed } = (await limit.json()) as { allowed: boolean };
      if (!allowed) return new Response("Too many parties from here this hour — try again later.", { status: 429 });
      return forward(env, randomId(10), request, { "X-Baritoad-Role": "host", "X-Baritoad-Origin": origin });
    }

    if ((parts[0] === "g" || parts[0] === "j") && parts.length === 3) {
      const [, room, key] = parts;
      if (!ROOM_RE.test(room) || !KEY_RE.test(key)) return new Response("Not found", { status: 404 });
      if (parts[0] === "g") {
        if (!ws) return new Response("WebSocket only", { status: 426 });
        return forward(env, room, request, { "X-Baritoad-Role": "guest", "X-Baritoad-Key": key });
      }
      // The guest page; the script finds the room and key in its own URL.
      const page = await env.ASSETS.fetch(new Request(new URL("/guest.html", url)));
      return new Response(page.body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    }

    if (parts.length === 0) return Response.redirect("https://baritoad.com/", 302);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
