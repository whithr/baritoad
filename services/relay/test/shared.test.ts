import { describe, expect, test } from "vitest";
import { cleanName, forGuest, frame, randomId, type SharedEntry } from "../src/shared";

describe("names", () => {
  // The same cases as karaoke-core party::tests::names_and_toads.
  test("clean like the app does", () => {
    expect(cleanName("  Cassie \t  B. ")).toBe("Cassie B.");
    expect(cleanName("a really long name indeed")).toBe("a really long");
    expect(cleanName(" \u0007 ")).toBeNull();
    expect(cleanName(42)).toBeNull();
  });
});

describe("what guests see of the queue", () => {
  const entries: SharedEntry[] = [
    { id: "e1", song: "s1" },
    { id: "e2", song: "s2", singer: "Cassie", toad: { face: "grin", colour: "pink", hat: "bow" }, guest: "g-cassie" },
    { id: "e3", song: "s3", singer: "Dev", toad: { face: "cool", colour: "blue", hat: "cap" }, guest: "g-dev" },
  ];

  test("nobody's guest id, only which entries are theirs", () => {
    const seen = forGuest(entries, "g-cassie");
    expect(JSON.stringify(seen)).not.toContain("g-cassie");
    expect(JSON.stringify(seen)).not.toContain("g-dev");
    expect(seen.map((e) => !!e.mine)).toEqual([false, true, false]);
    expect(seen[1].singer).toBe("Cassie");
  });
});

describe("frames", () => {
  test("carry the protocol version", () => {
    expect(JSON.parse(frame({ t: "guest_left", guest: "g" }))).toEqual({ v: 1, t: "guest_left", guest: "g" });
  });

  test("ids use the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) expect(randomId(10)).toMatch(/^[a-hjkmnp-z2-9]{10}$/);
  });
});
