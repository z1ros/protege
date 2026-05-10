import type { EchoEvent } from "@protege/types";
import type { Persona } from "./runPersona.js";

/**
 * Junior Web Developer — 6 months in, ships features but leans on AI.
 *
 * Behavioral signature:
 *   - jumps into files and edits within seconds (reads-before-writes low)
 *   - pastes large AI blocks and accepts as-is (authorship-self low)
 *   - vague short prompts; rare debug-with-stack-trace (AI-partnership low)
 *   - one-line commit messages, "fix"/"wip" frequent (maintainability low)
 *   - rarely runs tests (testing low)
 *
 * Expected outcome: junior rank, web field dominant, headline ~250-450.
 */
export const juniorWebDev: Persona = {
  id: "persona:juniorWebDev",
  description: "Junior web developer (6mo) — paste-and-pray, low rigor",

  field: {
    repoSignals: {
      packageJsonDeps: ["react", "next", "tailwindcss", "vite"],
      fileExtensions: { ".tsx": 40, ".css": 12, ".ts": 8 },
    },
    selfDeclared: "web",
  },

  events: () => {
    const events: EchoEvent[] = [];
    const t0 = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;

    // 30 jump-in reads (no reading before edit)
    for (let i = 0; i < 30; i++) {
      events.push({
        type: "read_pattern_observed",
        ts: t0 + i * 1000,
        pattern: "jump-in",
        msToFirstEdit: 1500,
        navCount: 0,
      });
    }

    // 25 large AI pastes kept as-is (no authorship of own code)
    for (let i = 0; i < 25; i++) {
      events.push({
        type: "paste_outcome_observed",
        ts: t0 + i * 60_000 + day,
        outcome: "kept-as-is",
        source: "ai-chat-output",
        chars: 8000 + i * 100,
      });
    }

    // 25 AI suggestion accepts with no edit (no iteration)
    for (let i = 0; i < 25; i++) {
      events.push({
        type: "ai_accept_outcome_observed",
        ts: t0 + i * 30_000 + 2 * day,
        outcome: "no-edit",
        editFraction: 0,
      });
    }

    // 30 vague short chat prompts ("fix it", "why broken", etc.)
    for (let i = 0; i < 30; i++) {
      events.push({
        type: "chat_turn",
        ts: t0 + i * 120_000 + 3 * day,
        intent: "vague",
        charCount: 22,
        containsStackTraceOrLineRef: false,
        containsConstraintWords: false,
        acceptedAi: true,
      });
    }

    // 12 wip/fix one-liner commits — low maintainability signal
    for (let i = 0; i < 12; i++) {
      events.push({
        type: "commit_detected",
        ts: t0 + i * 3_600_000 + 4 * day,
        sha: `j${i.toString().padStart(7, "0")}`,
        message: i % 2 === 0 ? "wip" : "fix",
        filesTouched: ["src/App.tsx"],
      });
    }

    return events;
  },

  expect: {
    rank: "junior",
    dominantField: "web",
    headlineRange: [200, 480],
    confidenceMin: 0.3,
  },
};
