import type { EchoEvent } from "@protege/types";
import type { Persona } from "./runPersona.js";

/**
 * Senior ML Engineer — 8 yrs, deep debugging, rigorous testing,
 * AI-skeptic (always iterates on output, never accepts as-is).
 *
 * Behavioral signature:
 *   - reads files deeply (>=2 navigations, >=30s before first edit)
 *   - rare AI pastes; when pasted, always iterated (authorship-self high)
 *   - long debug prompts with stack traces (Diagnostics high)
 *   - constrained plan prompts (Comprehension/AI Partnership high)
 *   - heavy manual + save test runs (Verification high)
 *   - thoughtful conventional commits with rationale (Stewardship high)
 */
export const seniorMlEng: Persona = {
  id: "persona:seniorMlEng",
  description: "Senior ML engineer (8y) — debugging + testing heavy",

  field: {
    repoSignals: {
      packageJsonDeps: [],
      requirementsTxt: ["torch", "transformers", "datasets", "numpy", "pandas"],
      fileExtensions: { ".py": 80, ".ipynb": 25 },
    },
    selfDeclared: "ml",
    conceptCounts: {
      "concept:gradient-descent": 12,
      "concept:transformer-attention": 8,
      "concept:loss-function": 15,
    },
  },

  events: () => {
    const events: EchoEvent[] = [];
    const t0 = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;

    // 40 deep reads (>=30s + >=2 navs before first edit)
    for (let i = 0; i < 40; i++) {
      events.push({
        type: "read_pattern_observed",
        ts: t0 + i * 60_000,
        pattern: "deep",
        msToFirstEdit: 45_000,
        navCount: 3,
      });
    }

    // 8 AI accepts that get iterated heavily (>=30% edit fraction)
    for (let i = 0; i < 8; i++) {
      events.push({
        type: "ai_accept_outcome_observed",
        ts: t0 + i * 600_000 + day,
        outcome: "iterated",
        editFraction: 0.55,
      });
    }

    // 25 debug-with-stack-trace prompts
    for (let i = 0; i < 25; i++) {
      events.push({
        type: "chat_turn",
        ts: t0 + i * 300_000 + 2 * day,
        intent: "debug",
        charCount: 380,
        containsStackTraceOrLineRef: true,
        containsConstraintWords: false,
        acceptedAi: false,
      });
    }

    // 15 plan prompts with constraints
    for (let i = 0; i < 15; i++) {
      events.push({
        type: "chat_turn",
        ts: t0 + i * 600_000 + 3 * day,
        intent: "plan",
        charCount: 280,
        containsStackTraceOrLineRef: false,
        containsConstraintWords: true,
        acceptedAi: false,
      });
    }

    // Heavy manual test sessions (5 bursts of >=4 manual runs in 30min)
    for (let burst = 0; burst < 5; burst++) {
      const tBurst = t0 + burst * 3 * 3_600_000 + 4 * day;
      for (let i = 0; i < 4; i++) {
        events.push({
          type: "test_run_result",
          ts: tBurst + i * 5 * 60_000,
          file: "tests/test_loss.py",
          tests: 12,
          passed: 12,
          durationMs: 800,
          trigger: "manual",
        });
      }
    }

    // Conventional commits with rationale
    for (let i = 0; i < 15; i++) {
      events.push({
        type: "commit_detected",
        ts: t0 + i * 4 * 3_600_000 + 5 * day,
        sha: `m${i.toString().padStart(7, "0")}`,
        message:
          "fix(loss): clamp gradient norm at 1.0 because exploding-gradient regression hit the eval set after the lr bump in #214",
        filesTouched: ["src/loss.py", "tests/test_loss.py"],
      });
    }

    return events;
  },

  expect: {
    // KNOWN GAP — TWO COMPOUNDING ISSUES KEEP THIS PERSONA AT "MID":
    //
    // 1. The Diagnostics-trait matchers (`error_appeared` /
    //    `error_cleared`) have no producer in iq3Hook today. The
    //    pillar therefore stays at the neutral 500.
    //
    // 2. The ML cohort weights Diagnostics at 1.2 (the highest of
    //    any pillar in any field). So Diagnostics=500 drags the
    //    composite headline down hard for ML users specifically.
    //    Even when every other pillar lands at ~770, the headline
    //    lands ~720 — exactly at the edge of senior's 720-cutoff in
    //    the ML fallback distribution.
    //
    // Net effect: an ML user with otherwise senior-level signal
    // CANNOT be ranked senior today. uncappedRank is "mid". Once
    // (1) ships, expect this to flip to senior.
    uncappedRank: "mid",
    dominantField: "ml",
    headlineRange: [620, 760],
    confidenceMin: 0.4,
    pillarRanges: {
      testing: [550, 1000],
    },
  },
};
