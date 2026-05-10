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
    expect(h.pillars.aiLiteracy.pending).toBe(true);
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

  // --- §4.2 AI Partnership conditionality tests ---

  /**
   * Spec §4.2: pending AI Partnership (aiEventCount < threshold) contributes
   * a neutral score of 500 at 0.5× weight. A high-scoring user whose AI
   * Partnership pillar is ACTIVE (full weight, high score) should outrank
   * the same user whose AI Partnership is still PENDING.
   *
   * Construction:
   *   - Build a strong base state with many positive reading + writing
   *     matchKeys (drives non-AI pillars well above 500).
   *   - State A (pending): no AI events — aiLiteracy stays pending.
   *   - State B (active-high): same base state + enough AI events with
   *     high-quality AI matchKeys to activate aiLiteracy at a high score.
   *     Activation needs aiEventCount >= 5 AND aiEventCount/eventCount >= 0.05.
   *     We pass isAiEvent:true so applyMatchKeys bumps aiEventCount.
   */
  it("pending AI Partnership pulls headline DOWN vs active high-quality AI usage (spec §4.2)", () => {
    // Build a shared base: push other pillars above 500 with strong non-AI evidence.
    let base = initialUserState("u2");
    for (let i = 0; i < 30; i++) {
      base = applyMatchKeys(base, [
        "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
        "test_run_result.trigger=manual.session_count>=3",
      ]);
    }

    // State A — pending: no AI events, aiLiteracy.pending = true.
    const statePending = base;
    expect(statePending.aiEventCount).toBe(0);

    // State B — active with high-quality AI usage.
    // Need aiEventCount >= 5 AND aiEventCount/eventCount >= 0.05.
    // We apply 10 AI events (isAiEvent:true) with positive iteratesOnAiOutput
    // and overridesAiConfidently matchKeys to push aiLiteracy score above 500.
    let stateActiveHigh = base;
    for (let i = 0; i < 10; i++) {
      stateActiveHigh = applyMatchKeys(
        stateActiveHigh,
        [
          "ai_suggestion_accepted.then.text_change.editFraction>=0.3.in_window=5min",
          "ai_suggestion_rejected.session_count>=3",
        ],
        { isAiEvent: true },
      );
    }

    // Sanity: AI Partnership should now be active (not pending).
    const hActiveHigh = computeHeadline(stateActiveHigh, FALLBACK_DISTRIBUTION);
    expect(hActiveHigh.pillars.aiLiteracy.pending).toBe(false);
    // And the active aiLiteracy score should be above neutral 500.
    expect(hActiveHigh.pillars.aiLiteracy.score).toBeGreaterThan(500);

    const hPending = computeHeadline(statePending, FALLBACK_DISTRIBUTION);
    expect(hPending.pillars.aiLiteracy.pending).toBe(true);

    // Core assertion: active high-quality AI usage → higher headline.
    expect(hActiveHigh.score).toBeGreaterThan(hPending.score);
  });

  /**
   * Spec §4.2: the 0.5× weight reduction for pending AI Partnership matters.
   * When other pillars are above 500, a pending pillar (500 at 0.5× weight)
   * dilutes the headline LESS than the same pillar at full weight (500 at 1×).
   * i.e., pending score > full-weight-neutral score.
   *
   * We test this by comparing three states derived from the same high base:
   *   - statePending: aiLiteracy pending (0.5× weight, score=500)
   *   - stateActiveNeutral: aiLiteracy active but with neutral/ambiguous AI
   *     matchKeys that leave the score near 500
   *   - stateActiveHigh: aiLiteracy active with strongly positive matchKeys
   *
   * Expected ordering: stateActiveHigh > statePending > stateActiveNeutral
   * (or at least: statePending > stateActiveNeutral, proving 0.5× matters).
   *
   * "Neutral activation" is achieved by applying opposing matchKeys that
   * cancel out, keeping the posterior near the uniform prior (score ≈ 500).
   */
  it("pending AI (0.5× weight) keeps headline higher than full-weight neutral AI (spec §4.2 weight reduction)", () => {
    // Build strong base pushing non-AI pillars above 500.
    let base = initialUserState("u3");
    for (let i = 0; i < 30; i++) {
      base = applyMatchKeys(base, [
        "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
        "test_run_result.trigger=manual.session_count>=3",
      ]);
    }

    // statePending: no AI events → pending, 0.5× weight, score=500.
    const statePending = base;

    // stateActiveNeutral: activate aiLiteracy with cancelling evidence
    // (positive + negative matchKeys balanced so score stays near 500).
    // Apply enough events to satisfy thresholds (aiEventCount ≥ 5, ≥ 5%).
    let stateActiveNeutral = base;
    for (let i = 0; i < 10; i++) {
      // Alternate positive and negative AI matchKeys to keep posterior near uniform.
      stateActiveNeutral = applyMatchKeys(
        stateActiveNeutral,
        [
          "ai_suggestion_accepted.then.text_change.editFraction>=0.3.in_window=5min", // positive iteratesOnAiOutput
          "ai_suggestion_accepted.no_edit.in_window=30min",                            // negative iteratesOnAiOutput
        ],
        { isAiEvent: true },
      );
    }

    const hPending = computeHeadline(statePending, FALLBACK_DISTRIBUTION);
    const hActiveNeutral = computeHeadline(stateActiveNeutral, FALLBACK_DISTRIBUTION);

    expect(hPending.pillars.aiLiteracy.pending).toBe(true);
    expect(hActiveNeutral.pillars.aiLiteracy.pending).toBe(false);

    // When other pillars are above 500, diluting with full-weight neutral (1×)
    // pulls the headline down more than half-weight neutral (0.5×).
    // Therefore pending score should exceed full-weight-neutral score.
    expect(hPending.score).toBeGreaterThan(hActiveNeutral.score);
  });

  /**
   * Spec §4.2: verify the activation threshold boundary.
   * aiEventCount=4 → still pending; aiEventCount=5 (at ≥5% of total) → active.
   */
  it("aiLiteracy flips from pending to active exactly at threshold (aiEventCount=5, ≥5%)", () => {
    let stateFour = initialUserState("u4");
    // Apply 4 AI events — still below AI_THRESHOLD_MIN_COUNT=5.
    for (let i = 0; i < 4; i++) {
      stateFour = applyMatchKeys(
        stateFour,
        ["ai_suggestion_accepted.then.text_change.editFraction>=0.3.in_window=5min"],
        { isAiEvent: true },
      );
    }
    const hFour = computeHeadline(stateFour, FALLBACK_DISTRIBUTION);
    expect(hFour.pillars.aiLiteracy.pending).toBe(true);

    // Apply one more AI event — now aiEventCount=5, eventCount=5, proportion=1.0 ≥ 0.05.
    const stateFive = applyMatchKeys(
      stateFour,
      ["ai_suggestion_accepted.then.text_change.editFraction>=0.3.in_window=5min"],
      { isAiEvent: true },
    );
    const hFive = computeHeadline(stateFive, FALLBACK_DISTRIBUTION);
    expect(hFive.pillars.aiLiteracy.pending).toBe(false);
  });
});
