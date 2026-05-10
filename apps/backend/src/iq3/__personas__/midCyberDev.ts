import type { EchoEvent } from "@protege/types";
import type { Persona } from "./runPersona.js";

/**
 * Mid-level Cyber-Sec Developer — 4 yrs, paranoid testing habits,
 * skim-reads more than deep-reads (security work is breadth-heavy),
 * rarely uses AI for code-gen.
 *
 * Behavioral signature:
 *   - mix of deep + skim + jump-in reads (skim majority)
 *   - very few AI events (security-conscious)
 *   - heavy save-trigger tests (CI-like local watch)
 *   - moderate-quality commits with conventional prefixes
 *   - debug-with-stack-trace prompts when AI used (rare)
 *
 * Expected: mid rank, sec field dominant.
 */
export const midCyberDev: Persona = {
  id: "persona:midCyberDev",
  description: "Mid cyber-sec developer (4y) — testing-heavy, AI-light",

  field: {
    // Heavy sec-specific deps + .sol files; .py kept low because the
    // archaeology weighs each .py as ml/dataEng/generalist signal,
    // which would dilute the sec dominance.
    repoSignals: {
      packageJsonDeps: [],
      requirementsTxt: [
        "cryptography",
        "pwntools",
        "scapy",
        "pycryptodome",
        "impacket",
      ],
      fileExtensions: { ".sol": 25, ".sh": 18, ".py": 6 },
    },
    selfDeclared: "sec",
    conceptCounts: {
      "concept:tls-handshake": 6,
      "concept:race-condition": 9,
      "concept:fuzzing": 5,
    },
  },

  events: () => {
    const events: EchoEvent[] = [];
    const t0 = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;

    // 20 deep reads, 15 skim, 5 jump-in (security work tends breadth)
    for (let i = 0; i < 20; i++) {
      events.push({
        type: "read_pattern_observed",
        ts: t0 + i * 90_000,
        pattern: "deep",
        msToFirstEdit: 60_000,
        navCount: 4,
      });
    }
    for (let i = 0; i < 15; i++) {
      events.push({
        type: "read_pattern_observed",
        ts: t0 + i * 60_000 + day,
        pattern: "skim",
        msToFirstEdit: 12_000,
        navCount: 1,
      });
    }
    for (let i = 0; i < 5; i++) {
      events.push({
        type: "read_pattern_observed",
        ts: t0 + i * 60_000 + 2 * day,
        pattern: "jump-in",
        msToFirstEdit: 2000,
        navCount: 0,
      });
    }

    // Few AI events; when used, iterated thoughtfully
    for (let i = 0; i < 5; i++) {
      events.push({
        type: "ai_accept_outcome_observed",
        ts: t0 + i * 7_200_000 + 3 * day,
        outcome: "iterated",
        editFraction: 0.45,
      });
    }

    // 12 debug-with-stack prompts
    for (let i = 0; i < 12; i++) {
      events.push({
        type: "chat_turn",
        ts: t0 + i * 600_000 + 4 * day,
        intent: "debug",
        charCount: 240,
        containsStackTraceOrLineRef: true,
        containsConstraintWords: false,
        acceptedAi: false,
      });
    }

    // Heavy save-trigger test bursts
    for (let burst = 0; burst < 6; burst++) {
      const tBurst = t0 + burst * 3 * 3_600_000 + 5 * day;
      for (let i = 0; i < 4; i++) {
        events.push({
          type: "test_run_result",
          ts: tBurst + i * 4 * 60_000,
          file: "tests/test_protocol.py",
          tests: 18,
          passed: 18,
          durationMs: 1200,
          trigger: "save",
        });
      }
    }

    // Conventional commits, sometimes terse
    for (let i = 0; i < 10; i++) {
      events.push({
        type: "commit_detected",
        ts: t0 + i * 6 * 3_600_000 + 6 * day,
        sha: `s${i.toString().padStart(7, "0")}`,
        message:
          i % 2 === 0
            ? "fix(crypto): constant-time compare to prevent timing oracle"
            : "test: add fuzzing harness for parser",
        filesTouched: ["src/crypto.py"],
      });
    }

    return events;
  },

  expect: {
    rank: "mid",
    dominantField: "sec",
    headlineRange: [430, 760],
    confidenceMin: 0.35,
    pillarRanges: {
      testing: [500, 1000],
    },
  },
};
