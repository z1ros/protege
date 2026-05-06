import { describe, it, expect } from "vitest";
import { computeRank } from "./rank.js";
import { FALLBACK_DISTRIBUTION } from "./cohort.js";

describe("rank tier mapping", () => {
  it("a low headline with no floor violation returns Learner", () => {
    const r = computeRank({
      headline: 80,
      dominantField: "web",
      pillars: {
        comprehension:  { score: 100, ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        execution:      { score: 90,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        diagnostics:    { score: 80,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        verification:   { score: 70,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        stewardship:    { score: 60,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        aiPartnership:  { score: 500, ciHalfWidth: 250, ciCoverage: 0.0, pending: true },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.rank).toBe("learner");
    expect(r.floorViolation).toBeNull();
  });

  it("high headline + all pillars high → Senior", () => {
    const r = computeRank({
      headline: 880,
      dominantField: "web",
      pillars: {
        comprehension:  { score: 720, ciHalfWidth: 30, ciCoverage: 0.8, pending: false },
        execution:      { score: 690, ciHalfWidth: 35, ciCoverage: 0.8, pending: false },
        diagnostics:    { score: 660, ciHalfWidth: 40, ciCoverage: 0.8, pending: false },
        verification:   { score: 650, ciHalfWidth: 45, ciCoverage: 0.8, pending: false },
        stewardship:    { score: 740, ciHalfWidth: 30, ciCoverage: 0.8, pending: false },
        aiPartnership:  { score: 680, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.rank).toBe("senior");
  });

  it("would-be-Senior with verification floor violation caps at Mid", () => {
    const r = computeRank({
      headline: 880,
      dominantField: "ml",
      pillars: {
        comprehension:  { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        execution:      { score: 680, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        diagnostics:    { score: 690, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        verification:   { score: 480, ciHalfWidth: 70, ciCoverage: 0.8, pending: false },
        stewardship:    { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        aiPartnership:  { score: 680, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.rank).toBe("mid");
    expect(r.uncappedRank).toBe("senior");
    expect(r.floorViolation?.pillar).toBe("verification");
  });

  it("pending pillars do not trigger floor violation", () => {
    const r = computeRank({
      headline: 700,
      dominantField: "web",
      pillars: {
        comprehension:  { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        execution:      { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        diagnostics:    { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        verification:   { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        stewardship:    { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        aiPartnership:  { score: 500, ciHalfWidth: 250, ciCoverage: 0.0, pending: true },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.floorViolation).toBeNull();
  });
});
