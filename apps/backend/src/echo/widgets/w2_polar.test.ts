import { describe, expect, it } from "vitest";
import { archetypeForPeak } from "./w2_polar.js";

describe("archetypeForPeak", () => {
  it.each([0, 3, 22, 23])("hour %i → night-owl", (h) => {
    expect(archetypeForPeak(h)).toBe("night-owl");
  });

  it.each([4, 7])("hour %i → dawn-coder", (h) => {
    expect(archetypeForPeak(h)).toBe("dawn-coder");
  });

  it.each([8, 11])("hour %i → morning-builder", (h) => {
    expect(archetypeForPeak(h)).toBe("morning-builder");
  });

  it.each([12, 16])("hour %i → afternoon-builder", (h) => {
    expect(archetypeForPeak(h)).toBe("afternoon-builder");
  });

  it.each([17, 21])("hour %i → evening-coder", (h) => {
    expect(archetypeForPeak(h)).toBe("evening-coder");
  });

  // Explicit boundary coverage — each `<` transition point.
  it("boundary 4: dawn-coder, not night-owl", () => {
    expect(archetypeForPeak(4)).toBe("dawn-coder");
  });
  it("boundary 8: morning-builder, not dawn-coder", () => {
    expect(archetypeForPeak(8)).toBe("morning-builder");
  });
  it("boundary 12: afternoon-builder, not morning-builder", () => {
    expect(archetypeForPeak(12)).toBe("afternoon-builder");
  });
  it("boundary 17: evening-coder, not afternoon-builder", () => {
    expect(archetypeForPeak(17)).toBe("evening-coder");
  });
  it("boundary 22: night-owl, not evening-coder", () => {
    expect(archetypeForPeak(22)).toBe("night-owl");
  });
});
