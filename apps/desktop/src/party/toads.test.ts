import { describe, expect, test } from "vitest";
import { COLOURS, DEFAULT_TOAD, FACES, HATS, isToad, toadRects, toadRows, toadSvg, type Toad } from "./toads";

describe("toads", () => {
  test("the default toad is the app's 16-px mark", () => {
    const rows = toadRows(DEFAULT_TOAD);
    // The same rows as TOAD in win98/icons.tsx.
    expect(rows[1]).toBe("..KKKK....KKKK..");
    expect(rows[2]).toBe(".KWOOOK..KWOOOK.");
    expect(rows[5]).toBe("KGGGGLGGGGLGGGGK");
    expect(rows[8]).toBe("KKRRRRRRRRRRRRKK");
    expect(rows[14]).toBe("...KKKKKKKKKK...");
  });

  test("every combination stays on the 16×20 grid", () => {
    for (const face of FACES)
      for (const colour of COLOURS)
        for (const hat of HATS) {
          const t: Toad = { face, colour, hat };
          for (const r of toadRects(t)) {
            expect(r.x).toBeGreaterThanOrEqual(0);
            expect(r.x + r.w).toBeLessThanOrEqual(16);
            expect(r.y).toBeGreaterThanOrEqual(-4);
            expect(r.y).toBeLessThanOrEqual(15);
            expect(r.fill).toMatch(/^#[0-9a-f]{3,6}$/i);
          }
        }
  });

  test("colour recolours the greens only", () => {
    const pink = toadRects({ ...DEFAULT_TOAD, colour: "pink" }).map((r) => r.fill);
    expect(pink).toContain("#c84a8a");
    expect(pink).not.toContain("#4c9420");
  });

  test("svg is crisp at a whole scale", () => {
    const s = toadSvg({ face: "grin", colour: "blue", hat: "crown" }, 3);
    expect(s).toContain('width="48" height="60"');
    expect(s).toContain('shape-rendering="crispEdges"');
  });

  test("isToad checks every part", () => {
    expect(isToad(DEFAULT_TOAD)).toBe(true);
    expect(isToad({ face: "sing", colour: "red", hat: "none" })).toBe(false);
    expect(isToad(null)).toBe(false);
  });
});
