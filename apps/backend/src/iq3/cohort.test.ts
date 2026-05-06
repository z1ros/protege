import { describe, it, expect } from "vitest";
import { percentileForHeadline, FALLBACK_DISTRIBUTION } from "./cohort.js";

describe("cohort percentile lookup", () => {
  it("returns ~0 for a very low score in any field", () => {
    expect(percentileForHeadline("web", 50, FALLBACK_DISTRIBUTION)).toBeLessThan(10);
  });
  it("returns ~99 for a very high score", () => {
    expect(percentileForHeadline("web", 950, FALLBACK_DISTRIBUTION)).toBeGreaterThan(95);
  });
  it("monotonic in headline", () => {
    const a = percentileForHeadline("web", 200, FALLBACK_DISTRIBUTION);
    const b = percentileForHeadline("web", 500, FALLBACK_DISTRIBUTION);
    const c = percentileForHeadline("web", 800, FALLBACK_DISTRIBUTION);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
