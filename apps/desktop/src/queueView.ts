// Up next view logic — pure functions, vitest-covered. The queue itself is
// Rust's (library.rs): an entry stays listed while it's sung (`playing`) and
// leaves when its song finishes or is skipped.

import type { QueueEntry, QueueState } from "./api";

export const EMPTY_QUEUE: QueueState = { entries: [], playing: null };

/** The songs still to come: everything but the entry being sung. */
export function waiting(q: QueueState): QueueEntry[] {
  return q.entries.filter((e) => e.id !== q.playing);
}

/** What the Stage sings after the current song. */
export function upNextOf(q: QueueState): QueueEntry | null {
  return waiting(q)[0] ?? null;
}

/** Fisher–Yates; `rnd` returns [0, 1) and is injectable for tests. */
export function shuffled<T>(xs: readonly T[], rnd: () => number = Math.random): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A drop between rows is a slot 0..n (slot k = before row k). Moving the
 *  entry at `from` there lands it at this index once it's lifted out
 *  (queue_move's `to_index`). */
export function moveTarget(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

// ------------------------------------------------- between-songs countdown

/** The Stage's between-songs countdown. Held = waiting for Sing now. */
export interface Countdown {
  left: number;
  held: boolean;
}

export function startCountdown(seconds: number, auto: boolean): Countdown {
  return { left: Math.max(0, Math.round(seconds)), held: !auto };
}

export function tick(c: Countdown): Countdown {
  return c.held || c.left <= 0 ? c : { ...c, left: c.left - 1 };
}

export function toggleHold(c: Countdown): Countdown {
  return { ...c, held: !c.held };
}

/** Time to start the next song. */
export function due(c: Countdown): boolean {
  return !c.held && c.left <= 0;
}
