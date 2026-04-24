import { describe, expect, it } from "vitest";
import { computeAuthorshipRatio } from "../store.js";

describe("computeAuthorshipRatio", () => {
  it("human=0, ai=0 → null (no data)", () => {
    expect(computeAuthorshipRatio(0, 0)).toBeNull();
  });

  it("human=10, ai=0 → 1.0 (fully human)", () => {
    expect(computeAuthorshipRatio(10, 0)).toBe(1);
  });

  it("human=0, ai=10 → 0.0 (fully AI)", () => {
    expect(computeAuthorshipRatio(0, 10)).toBe(0);
  });

  it("human=7, ai=3 → 0.7", () => {
    expect(computeAuthorshipRatio(7, 3)).toBeCloseTo(0.7, 10);
  });

  it("negative human, positive ai → clamps human to 0 → 0", () => {
    // Defensive: caller's bump function already clamps, but we defend anyway.
    expect(computeAuthorshipRatio(-1, 5)).toBe(0);
  });

  it("both zero after clamping (human=-5, ai=0) → null", () => {
    expect(computeAuthorshipRatio(-5, 0)).toBeNull();
  });

  it("NaN human → null", () => {
    expect(computeAuthorshipRatio(Number.NaN, 5)).toBeNull();
  });

  it("NaN ai → null", () => {
    expect(computeAuthorshipRatio(5, Number.NaN)).toBeNull();
  });

  it("Infinity → null", () => {
    expect(computeAuthorshipRatio(Number.POSITIVE_INFINITY, 1)).toBeNull();
  });
});
