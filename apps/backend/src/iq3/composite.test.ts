import { describe, it, expect } from "vitest";
import { initialUserState, applyMatchKeys } from "./hmm.js";
import { computeHeadline } from "./composite.js";
import { FALLBACK_DISTRIBUTION } from "./cohort.js";

describe("composite headline", () => {
  it("returns a complete headline shape from a fresh user state", () => {
    const s = initialUserState("u1");
    const h = computeHeadline(s, FALLBACK_DISTRIBUTION);
    expect(h.score).toBeGreaterThan(0);
    expect(h.score).toBeLessThan(1100);
    expect(h.rank.rank).toBeDefined();
    expect(h.maturity).toBe("cold");
    expect(h.pillars.aiPartnership.pending).toBe(true);
  });

  it("score grows with positive evidence accumulation", () => {
    let s = initialUserState("u1");
    const before = computeHeadline(s, FALLBACK_DISTRIBUTION).score;
    for (let i = 0; i < 30; i++) {
      s = applyMatchKeys(s, [
        "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
        "test_run_result.trigger=manual.session_count>=3",
      ]);
    }
    const after = computeHeadline(s, FALLBACK_DISTRIBUTION).score;
    expect(after).toBeGreaterThan(before + 50);
  });
});
