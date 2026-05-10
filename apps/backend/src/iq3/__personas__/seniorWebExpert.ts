import type { EchoEvent } from "@protege/types";
import type { Persona } from "./runPersona.js";

/**
 * Senior Web Developer — 10 yrs, all six pillars strong.
 *
 * Behavioral signature:
 *   - deep reads dominate (Comprehension)
 *   - efficient AI partner: long specific prompts, iterates output
 *     (AI Partnership + Comprehension)
 *   - debug prompts include stack traces (Diagnostics)
 *   - plan prompts include constraints (Comprehension)
 *   - manual + save test bursts (Verification)
 *   - thoughtful conventional commits with rationale (Stewardship)
 *
 * Expected: senior rank, web field dominant, headline >=620.
 */
export const seniorWebExpert: Persona = {
  id: "persona:seniorWebExpert",
  description: "Senior web developer (10y) — high across all pillars",

  field: {
    repoSignals: {
      packageJsonDeps: [
        "react",
        "next",
        "tailwindcss",
        "vite",
        "webpack",
      ],
      fileExtensions: { ".tsx": 120, ".ts": 80, ".css": 40 },
    },
    selfDeclared: "web",
    conceptCounts: {
      "concept:react-suspense": 14,
      "concept:bundle-splitting": 8,
      "concept:csp-headers": 5,
    },
  },

  events: () => {
    const events: EchoEvent[] = [];
    const t0 = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;

    // 50 deep reads
    for (let i = 0; i < 50; i++) {
      events.push({
        type: "read_pattern_observed",
        ts: t0 + i * 30_000,
        pattern: "deep",
        msToFirstEdit: 50_000,
        navCount: 4,
      });
    }

    // 20 AI suggestion accepts that get iterated meaningfully
    for (let i = 0; i < 20; i++) {
      events.push({
        type: "ai_accept_outcome_observed",
        ts: t0 + i * 300_000 + day,
        outcome: "iterated",
        editFraction: 0.4,
      });
    }

    // 25 specific prompts (long, focused)
    for (let i = 0; i < 25; i++) {
      events.push({
        type: "chat_turn",
        ts: t0 + i * 240_000 + 2 * day,
        intent: "specific",
        charCount: 320,
        containsStackTraceOrLineRef: false,
        containsConstraintWords: true,
        acceptedAi: true,
      });
    }

    // 18 debug prompts with stack traces
    for (let i = 0; i < 18; i++) {
      events.push({
        type: "chat_turn",
        ts: t0 + i * 480_000 + 3 * day,
        intent: "debug",
        charCount: 410,
        containsStackTraceOrLineRef: true,
        containsConstraintWords: false,
        acceptedAi: false,
      });
    }

    // 12 plan prompts with constraints
    for (let i = 0; i < 12; i++) {
      events.push({
        type: "chat_turn",
        ts: t0 + i * 1_200_000 + 4 * day,
        intent: "plan",
        charCount: 290,
        containsStackTraceOrLineRef: false,
        containsConstraintWords: true,
        acceptedAi: false,
      });
    }

    // Heavy test bursts (6 manual, 6 save)
    for (let burst = 0; burst < 6; burst++) {
      const tBurst = t0 + burst * 2 * 3_600_000 + 5 * day;
      for (let i = 0; i < 4; i++) {
        events.push({
          type: "test_run_result",
          ts: tBurst + i * 5 * 60_000,
          file: "src/__tests__/feature.test.tsx",
          tests: 16,
          passed: 16,
          durationMs: 950,
          trigger: "manual",
        });
      }
    }
    for (let burst = 0; burst < 6; burst++) {
      const tBurst = t0 + burst * 2 * 3_600_000 + 6 * day;
      for (let i = 0; i < 4; i++) {
        events.push({
          type: "test_run_result",
          ts: tBurst + i * 5 * 60_000,
          file: "src/__tests__/feature.test.tsx",
          tests: 16,
          passed: 16,
          durationMs: 950,
          trigger: "save",
        });
      }
    }

    // Conventional commits with rationale
    for (let i = 0; i < 18; i++) {
      events.push({
        type: "commit_detected",
        ts: t0 + i * 3 * 3_600_000 + 7 * day,
        sha: `w${i.toString().padStart(7, "0")}`,
        message:
          "feat(checkout): batch coupon revalidation because the per-row call was hitting the rate limit on the pricing edge function",
        filesTouched: ["app/checkout/coupon.ts", "app/checkout/__tests__/coupon.test.ts"],
      });
    }

    return events;
  },

  expect: {
    // KNOWN GAP: see seniorMlEng — Diagnostics floor blocks "senior"
    // until the error_appeared/error_cleared producers ship. We
    // assert uncappedRank instead so the harness still verifies the
    // pre-floor pipeline behavior is correct.
    uncappedRank: "senior",
    dominantField: "web",
    headlineRange: [620, 920],
    confidenceMin: 0.4,
    pillarRanges: {
      reading: [550, 1000],
      testing: [550, 1000],
      maintainability: [550, 1000],
    },
  },
};
