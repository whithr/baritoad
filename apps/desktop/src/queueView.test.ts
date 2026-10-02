import { describe, expect, it } from "vitest";
import type { QueueEntry, Song } from "./api";
import { due, moveTarget, shuffled, startCountdown, tick, toggleHold, upNextOf, waiting } from "./queueView";

const entry = (id: number, title = `Song ${id}`): QueueEntry => ({
  id,
  position: id - 1,
  song: { id: id * 10, title } as Song,
});

describe("waiting / upNextOf", () => {
  const entries = [entry(1), entry(2), entry(3)];

  it("skips the entry being sung", () => {
    expect(waiting({ entries, playing: 1 }).map((e) => e.id)).toEqual([2, 3]);
    expect(upNextOf({ entries, playing: 1 })?.id).toBe(2);
  });

  it("is the head of the list when nothing is playing", () => {
    expect(upNextOf({ entries, playing: null })?.id).toBe(1);
  });

  it("has nothing next when only the playing entry is left", () => {
    expect(upNextOf({ entries: [entry(1)], playing: 1 })).toBeNull();
    expect(upNextOf({ entries: [], playing: null })).toBeNull();
  });
});

describe("shuffled", () => {
  it("keeps every item and leaves the input alone", () => {
    const xs = [1, 2, 3, 4, 5, 6];
    const out = shuffled(xs);
    expect([...out].sort()).toEqual(xs);
    expect(xs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("is a Fisher–Yates over the injected random source", () => {
    // rnd always 0: each step swaps i with 0, a fixed known permutation.
    expect(shuffled([1, 2, 3, 4], () => 0)).toEqual([2, 3, 4, 1]);
    // rnd just under 1: every j = i, nothing moves.
    expect(shuffled([1, 2, 3, 4], () => 0.999)).toEqual([1, 2, 3, 4]);
  });

  it("handles empty and single lists", () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled(["a"])).toEqual(["a"]);
  });
});

describe("moveTarget", () => {
  it("accounts for lifting the dragged entry out", () => {
    // entries a b c d; drag b (1) to before d (slot 3) → index 2.
    expect(moveTarget(1, 3)).toBe(2);
    // drag d (3) to before a (slot 0) → index 0.
    expect(moveTarget(3, 0)).toBe(0);
    // dropping just before or after itself goes nowhere.
    expect(moveTarget(1, 1)).toBe(1);
    expect(moveTarget(1, 2)).toBe(1);
    // to the end (slot 4).
    expect(moveTarget(0, 4)).toBe(3);
  });
});

describe("countdown", () => {
  it("counts down to due when automatic", () => {
    let c = startCountdown(3, true);
    expect(due(c)).toBe(false);
    c = tick(tick(c));
    expect(c.left).toBe(1);
    c = tick(c);
    expect(due(c)).toBe(true);
    expect(tick(c).left).toBe(0);
  });

  it("starts held when automatic advance is off", () => {
    const c = startCountdown(10, false);
    expect(c.held).toBe(true);
    expect(tick(c)).toEqual(c);
    expect(due(c)).toBe(false);
  });

  it("holds and resumes", () => {
    let c = toggleHold(startCountdown(2, true));
    expect(tick(c).left).toBe(2);
    c = toggleHold(c);
    expect(due(tick(tick(c)))).toBe(true);
  });

  it("a held countdown at zero isn't due", () => {
    expect(due({ left: 0, held: true })).toBe(false);
  });
});
