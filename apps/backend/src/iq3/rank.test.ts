import { describe, it, expect } from "vitest";
import { computeRank } from "./rank.js";
import { FALLBACK_DISTRIBUTION } from "./cohort.js";

describe("rank tier mapping", () => {
  it("a low headline with no floor violation returns Learner", () => {
    const r = computeRank({
      headline: 80,
      dominantField: "web",
      pillars: {
        reading:  { score: 100, ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        writing:      { score: 90,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        debugging:    { score: 80,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        testing:   { score: 70,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        maintainability:    { score: 60,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        aiLiteracy:  { score: 500, ciHalfWidth: 250, ciCoverage: 0.0, pending: true },
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
        reading:  { score: 720, ciHalfWidth: 30, ciCoverage: 0.8, pending: false },
        writing:      { score: 690, ciHalfWidth: 35, ciCoverage: 0.8, pending: false },
        debugging:    { score: 660, ciHalfWidth: 40, ciCoverage: 0.8, pending: false },
        testing:   { score: 650, ciHalfWidth: 45, ciCoverage: 0.8, pending: false },
        maintainability:    { score: 740, ciHalfWidth: 30, ciCoverage: 0.8, pending: false },
        aiLiteracy:  { score: 680, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.rank).toBe("senior");
  });

  it("would-be-Senior with testing floor violation caps at Mid", () => {
    const r = computeRank({
      headline: 880,
      dominantField: "ml",
      pillars: {
        reading:  { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        writing:      { score: 680, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        debugging:    { score: 690, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        testing:   { score: 480, ciHalfWidth: 70, ciCoverage: 0.8, pending: false },
        maintainability:    { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        aiLiteracy:  { score: 680, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.rank).toBe("mid");
    expect(r.uncappedRank).toBe("senior");
    expect(r.floorViolation?.pillar).toBe("testing");
  });

  it("pending pillars do not trigger floor violation", () => {
    const r = computeRank({
      headline: 700,
      dominantField: "web",
      pillars: {
        reading:  { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        writing:      { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        debugging:    { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        testing:   { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        maintainability:    { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        aiLiteracy:  { score: 500, ciHalfWidth: 250, ciCoverage: 0.0, pending: true },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.floorViolation).toBeNull();
  });
});
