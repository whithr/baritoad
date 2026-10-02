import { describe, expect, it } from "vitest";
import { slotAt } from "./drag";

describe("slotAt", () => {
  // three rows whose middles sit at 11, 33, 55 px
  const mids = [11, 33, 55];

  it("inserts before the first row whose middle is below the pointer", () => {
    expect(slotAt(mids, 0)).toBe(0);
    expect(slotAt(mids, 12)).toBe(1);
    expect(slotAt(mids, 40)).toBe(2);
  });

  it("goes after the last row past its middle", () => {
    expect(slotAt(mids, 56)).toBe(3);
    expect(slotAt(mids, 500)).toBe(3);
  });

  it("is slot 0 in an empty list", () => {
    expect(slotAt([], 30)).toBe(0);
  });
});
