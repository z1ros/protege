import { describe, expect, it } from "vitest";
import { bucketFor } from "./w15_conceptsCovered.js";

describe("bucketFor", () => {
  it("hasBeenAuthored=true with null ratio returns 'yours' (sticky)", () => {
    expect(bucketFor(true, null)).toBe("yours");
  });

  it("hasBeenAuthored=true wins even with a sub-threshold ratio", () => {
    expect(bucketFor(true, 0.1)).toBe("yours");
  });

  it("hasBeenAuthored=false with null ratio returns null (belongs to W17)", () => {
    expect(bucketFor(false, null)).toBeNull();
  });

  it("hasBeenAuthored=false with NaN ratio returns null", () => {
    expect(bucketFor(false, Number.NaN)).toBeNull();
  });

  it("hasBeenAuthored=false with ratio 0.3 is 'ai' (below threshold)", () => {
    expect(bucketFor(false, 0.3)).toBe("ai");
  });

  it("hasBeenAuthored=false with ratio 0.49 is 'ai' (just below)", () => {
    expect(bucketFor(false, 0.49)).toBe("ai");
  });

  it("hasBeenAuthored=false with ratio 0.5 is 'yours' (at threshold)", () => {
    expect(bucketFor(false, 0.5)).toBe("yours");
  });

  it("hasBeenAuthored=false with ratio 0.8 is 'yours'", () => {
    expect(bucketFor(false, 0.8)).toBe("yours");
  });

  it("hasBeenAuthored=false with ratio 0 is 'ai' (pure AI)", () => {
    expect(bucketFor(false, 0)).toBe("ai");
  });
});
