// What the relay and the guest page agree on, and the app ⇄ relay frames
// (docs/PARTY-PROTOCOL.md — karaoke-core `party` holds the app's side).
// The toad lists come from the app's own toads.ts, so phone and TV can't
// disagree about what a toad is.

import { isToad, type Toad } from "../../../apps/desktop/src/party/toads";

export { isToad, type Toad };

export const PROTOCOL_VERSION = 1;

/** One song as guests see it (metadata only — the app projects it). */
export interface ListedSong {
  id: string;
  title: string;
  artist?: string;
  duration?: number;
  collections: string[];
}

/** One queue entry as the app sends it. */
export interface SharedEntry {
  id: string;
  song: string;
  singer?: string;
  toad?: Toad;
  guest?: string;
}

/** One queue entry as a guest sees it: no guest ids, just whether it's theirs. */
export interface GuestEntry {
  id: string;
  song: string;
  singer?: string;
  toad?: Toad;
  mine?: true;
}

export type RefuseCode = "limit" | "unknown_song" | "not_ready" | "host_away" | "not_joined";

// ---- app ⇄ relay (v1) -------------------------------------------------------

export type AppMsg =
  | { t: "hello"; app: string; resume?: { room: string; secret: string } }
  | { t: "listing"; songs: ListedSong[] }
  | { t: "queue"; entries: SharedEntry[]; nowPlaying?: string }
  | { t: "request_result"; req: string; ok: boolean; code?: RefuseCode }
  | { t: "kick"; guest: string }
  | { t: "new_code" }
  | { t: "close" };

export type RelayMsg =
  | { t: "room"; room: string; secret: string; joinUrl: string }
  | { t: "guest_joined"; guest: string; name: string; toad: Toad }
  | { t: "request"; req: string; guest: string; song: string }
  | { t: "withdraw"; guest: string; entry: string }
  | { t: "guest_left"; guest: string }
  | { t: "error"; code: string; message: string };

// ---- guest page ⇄ relay -----------------------------------------------------

export type GuestUp =
  | { t: "join"; name: string; toad: Toad; guest?: string }
  | { t: "pick"; song: string }
  | { t: "withdraw"; entry: string };

export type GuestDown =
  | { t: "welcome"; guest: string; name: string; toad: Toad; songs: ListedSong[]; entries: GuestEntry[]; nowPlaying?: string; hostHere: boolean }
  | { t: "listing"; songs: ListedSong[] }
  | { t: "queue"; entries: GuestEntry[]; nowPlaying?: string }
  | { t: "picked"; ok: boolean; code?: RefuseCode }
  | { t: "host"; here: boolean }
  | { t: "bye"; why: "kicked" | "closed" | "gone" | "full" | "invalid" };

/** A frame with the protocol version, for the app. */
export const frame = (m: RelayMsg) => JSON.stringify({ v: PROTOCOL_VERSION, ...m });

/** The longest display name, in characters (karaoke-core `party::NAME_MAX`). */
export const NAME_MAX = 14;

/** A display name as the TV shows it — the same rule as `party::clean_name`. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = [...raw]
    .map((c) => (/\s/.test(c) ? " " : c))
    // eslint-disable-next-line no-control-regex
    .filter((c) => !/[\u0000-\u001f\u007f-\u009f]/.test(c))
    .join("")
    .split(" ")
    .filter(Boolean)
    .join(" ");
  const name = [...collapsed].slice(0, NAME_MAX).join("").trimEnd();
  return name ? name : null;
}

/** The queue for one guest: their own entries marked, nobody's guest id shown. */
export function forGuest(entries: SharedEntry[], guest: string | undefined): GuestEntry[] {
  return entries.map(({ guest: g, ...e }) => (guest && g === guest ? { ...e, mine: true as const } : e));
}

/** Random id from an unambiguous alphabet. */
export function randomId(n: number): string {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}
