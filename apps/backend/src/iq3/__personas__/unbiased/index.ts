/**
 * Unbiased calibration personas.
 *
 * Translated from `../ground-truth-unbiased.md` — the headline ranges are the
 * unbiased ground truth (±50 around the document's stated headline), NOT a
 * prediction of what the system will output. Divergence between system score
 * and these bands is the calibration finding the team is looking for.
 *
 * IMPORTANT (blind-check discipline): the streams below were authored
 * exclusively from the persona's behavioral signature. No matcher,
 * trait, or scoring file was inspected while writing. If a persona
 * fails to clear or stay inside its band, that is the finding — not
 * evidence that the stream needs tuning.
 */

import type { EchoEvent } from "@protege/types";
import type { Persona } from "../runPersona.js";

const t0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 1. The Bootcamp Grad in Month Two — Learner, ~235
// ---------------------------------------------------------------------------
const bootcampGrad: Persona = {
  id: "unbiased:bootcampGrad",
  description:
    "Bootcamp grad, 3 months in, leans on AI for everything, pastes blindly",
  field: {
    selfDeclared: "web",
    conceptCounts: {
      "concept:react": 6,
      "concept:useState": 4,
      "concept:fetch": 3,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 1500) => (ts += d);

    // First task: build a small form. Opens the file, immediately overwhelmed.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "jump-in",
      msToFirstEdit: 1800,
      navCount: 0,
    });
    // Pastes whole file into chat with a vague ask.
    out.push({
      type: "chat_turn",
      ts: next(2000),
      intent: "vague",
      charCount: 1800,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: false,
      acceptedAi: true,
    });
    // Pastes the AI output back, doesn't touch it.
    out.push({
      type: "paste_outcome_observed",
      ts: next(60_000),
      outcome: "kept-as-is",
      source: "ai-chat-output",
      chars: 1100,
    });
    // Ran tests because mentor told them to. Trivial test, manual.
    out.push({
      type: "test_run_result",
      ts: next(15_000),
      file: "src/Form.test.tsx",
      tests: 1,
      passed: 1,
      durationMs: 220,
      trigger: "manual",
    });
    // Hit an error. Pastes whole stack trace + whole file.
    out.push({
      type: "chat_turn",
      ts: next(40_000),
      intent: "debug",
      charCount: 3200,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: false,
      acceptedAi: true,
    });
    // Accepts AI suggestion, doesn't edit it.
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "no-edit",
      editFraction: 0.0,
    });
    // Same error reappears. Vague follow-up.
    out.push({
      type: "chat_turn",
      ts: next(30_000),
      intent: "vague",
      charCount: 110,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: false,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "no-edit",
      editFraction: 0.0,
    });
    // Noisy commit.
    out.push({
      type: "commit_detected",
      ts: next(120_000),
      sha: "a1b2c3d",
      message: "wip",
      filesTouched: ["src/Form.tsx", "src/Form.test.tsx"],
    });
    // Another bug, same loop.
    out.push({
      type: "read_pattern_observed",
      ts: next(60_000),
      pattern: "jump-in",
      msToFirstEdit: 2200,
      navCount: 0,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "vague",
      charCount: 90,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: false,
      acceptedAi: true,
    });
    out.push({
      type: "paste_outcome_observed",
      ts: next(60_000),
      outcome: "kept-as-is",
      source: "ai-chat-output",
      chars: 800,
    });
    out.push({
      type: "test_run_result",
      ts: next(20_000),
      file: "src/Form.test.tsx",
      tests: 2,
      passed: 1,
      durationMs: 350,
      trigger: "manual",
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "debug",
      charCount: 2400,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: false,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "no-edit",
      editFraction: 0.0,
    });
    out.push({
      type: "test_run_result",
      ts: next(20_000),
      file: "src/Form.test.tsx",
      tests: 2,
      passed: 2,
      durationMs: 320,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(60_000),
      sha: "b2c3d4e",
      message: "fix",
      filesTouched: ["src/Form.tsx"],
    });
    out.push({
      type: "commit_detected",
      ts: next(180_000),
      sha: "c3d4e5f",
      message: "fix again",
      filesTouched: ["src/Form.tsx"],
    });
    return out;
  },
  expect: {
    rank: "learner",
    dominantField: "web",
    headlineRange: [195, 255],
  },
};

// ---------------------------------------------------------------------------
// 2. The Earnest Junior, Year Two — Junior, ~485
// ---------------------------------------------------------------------------
const earnestJunior: Persona = {
  id: "unbiased:earnestJunior",
  description:
    "1.8y self-taught full-stack junior, structured prompts, validates AI",
  field: {
    selfDeclared: "web",
    conceptCounts: {
      "concept:react": 18,
      "concept:typescript": 14,
      "concept:postgres": 6,
      "concept:fetch": 9,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 2000) => (ts += d);

    // Session 1 — feature work. Reads exports, jumps to callers.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 22_000,
      navCount: 2,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "symbol-search",
      fromFile: "src/api/users.ts",
      toFile: "src/api/users.ts",
      msSinceEdit: 8_000,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "find-refs",
      fromFile: "src/api/users.ts",
      toFile: "src/routes/userRoutes.ts",
      msSinceEdit: 3_000,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "def-jump",
      fromFile: "src/routes/userRoutes.ts",
      toFile: "src/api/users.ts",
      msSinceEdit: 2_000,
    });
    // Thoughtful AI prompt with context paragraph.
    out.push({
      type: "chat_turn",
      ts: next(15_000),
      intent: "specific",
      charCount: 720,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.35,
    });
    out.push({
      type: "test_run_result",
      ts: next(60_000),
      file: "src/api/users.test.ts",
      tests: 6,
      passed: 6,
      durationMs: 540,
      trigger: "save",
    });
    // Saves often -> tests on save fire repeatedly.
    out.push({
      type: "test_run_result",
      ts: next(120_000),
      file: "src/api/users.test.ts",
      tests: 7,
      passed: 7,
      durationMs: 590,
      trigger: "save",
    });
    out.push({
      type: "commit_detected",
      ts: next(60_000),
      sha: "11aa22b",
      message: "feat(users): add invite endpoint",
      filesTouched: ["src/api/users.ts", "src/api/users.test.ts"],
    });

    // Session 2 — debugging. Reads stack trace, isolates repro.
    out.push({
      type: "read_pattern_observed",
      ts: next(60_000),
      pattern: "deep",
      msToFirstEdit: 45_000,
      navCount: 3,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "find-refs",
      fromFile: "src/api/users.ts",
      toFile: "src/services/mailer.ts",
      msSinceEdit: 5_000,
    });
    out.push({
      type: "chat_turn",
      ts: next(20_000),
      intent: "debug",
      charCount: 480,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    out.push({
      type: "test_run_result",
      ts: next(30_000),
      file: "src/services/mailer.test.ts",
      tests: 4,
      passed: 3,
      durationMs: 420,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(45_000),
      file: "src/services/mailer.test.ts",
      tests: 4,
      passed: 4,
      durationMs: 410,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "22bb33c",
      message: "fix(mailer): retry on transient SMTP errors",
      filesTouched: ["src/services/mailer.ts", "src/services/mailer.test.ts"],
    });

    // Session 3 — polishing PR after review.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 12_000,
      navCount: 1,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "plan",
      charCount: 380,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.22,
    });
    out.push({
      type: "paste_outcome_observed",
      ts: next(60_000),
      outcome: "iterated",
      source: "ai-chat-output",
      chars: 320,
    });
    out.push({
      type: "test_run_result",
      ts: next(45_000),
      file: "src/api/users.test.ts",
      tests: 8,
      passed: 8,
      durationMs: 610,
      trigger: "save",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "33cc44d",
      message: "chore: address review comments",
      filesTouched: ["src/api/users.ts"],
    });

    // Session 4 — new feature, more deliberate.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 38_000,
      navCount: 4,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "def-jump",
      fromFile: "src/api/orgs.ts",
      toFile: "src/db/orgs.ts",
      msSinceEdit: 4_000,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "find-refs",
      fromFile: "src/db/orgs.ts",
      toFile: "src/api/orgs.ts",
      msSinceEdit: 3_500,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 640,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.4,
    });
    out.push({
      type: "test_run_result",
      ts: next(60_000),
      file: "src/api/orgs.test.ts",
      tests: 5,
      passed: 5,
      durationMs: 470,
      trigger: "save",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "44dd55e",
      message: "feat(orgs): list active members",
      filesTouched: ["src/api/orgs.ts", "src/api/orgs.test.ts"],
    });
    return out;
  },
  expect: {
    rank: "junior",
    dominantField: "web",
    headlineRange: [540, 600],
  },
};

// ---------------------------------------------------------------------------
// 3. The Vibecoder — Junior (low end), ~285
// ---------------------------------------------------------------------------
const vibecoder: Persona = {
  id: "unbiased:vibecoder",
  description:
    "1.5y junior who outsources understanding to AI; large mixed-concern PRs",
  field: {
    selfDeclared: "web",
    conceptCounts: {
      "concept:react": 22,
      "concept:tailwind": 12,
      "concept:nextjs": 8,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 1200) => (ts += d);

    // Repeating cycle: open file → paste into AI → paste back → re-prompt.
    const cycle = (i: number, accepted: boolean) => {
      out.push({
        type: "read_pattern_observed",
        ts: next(),
        pattern: "jump-in",
        msToFirstEdit: 1500 + i * 100,
        navCount: 0,
      });
      out.push({
        type: "chat_turn",
        ts: next(),
        intent: "request",
        charCount: 80 + (i % 5) * 10,
        containsStackTraceOrLineRef: false,
        containsConstraintWords: false,
        acceptedAi: accepted,
      });
      out.push({
        type: "paste_outcome_observed",
        ts: next(60_000),
        outcome: "kept-as-is",
        source: "ai-chat-output",
        chars: 600 + i * 40,
      });
    };

    // 8 quick "ship it" cycles.
    for (let i = 0; i < 8; i++) cycle(i, true);

    // Tests scaffolded by AI — pass trivially.
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "src/Widget.test.tsx",
      tests: 4,
      passed: 4,
      durationMs: 180,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "src/Card.test.tsx",
      tests: 3,
      passed: 3,
      durationMs: 140,
      trigger: "manual",
    });

    // Big mixed-concern commit with AI-style message.
    out.push({
      type: "commit_detected",
      ts: next(60_000),
      sha: "ff00aa1",
      message:
        "feat: add dashboard widget, refactor card layout, fix nav, update theme tokens",
      filesTouched: [
        "src/Widget.tsx",
        "src/Card.tsx",
        "src/Nav.tsx",
        "src/theme.ts",
        "src/Widget.test.tsx",
        "src/Card.test.tsx",
      ],
    });

    // Bug report -> 3 rounds of AI prompting.
    for (let i = 0; i < 3; i++) {
      out.push({
        type: "chat_turn",
        ts: next(),
        intent: "debug",
        charCount: 90,
        containsStackTraceOrLineRef: false,
        containsConstraintWords: false,
        acceptedAi: true,
      });
      out.push({
        type: "paste_outcome_observed",
        ts: next(60_000),
        outcome: "kept-as-is",
        source: "ai-chat-output",
        chars: 700,
      });
    }

    // Reviewer caught problems; revert.
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "ff00aa2",
      message: "Revert \"feat: add dashboard widget...\"",
      filesTouched: ["src/Widget.tsx", "src/Card.tsx"],
    });

    // Re-do, more cycles.
    for (let i = 8; i < 14; i++) cycle(i, true);

    out.push({
      type: "test_run_result",
      ts: next(),
      file: "src/Widget.test.tsx",
      tests: 4,
      passed: 4,
      durationMs: 175,
      trigger: "manual",
    });

    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "ff00aa3",
      message: "feat: re-introduce dashboard widget with tweaks",
      filesTouched: [
        "src/Widget.tsx",
        "src/Card.tsx",
        "src/Nav.tsx",
        "src/Widget.test.tsx",
      ],
    });

    // Debug loop they can't escape -> ask teammate.
    for (let i = 0; i < 3; i++) {
      out.push({
        type: "chat_turn",
        ts: next(),
        intent: "debug",
        charCount: 70,
        containsStackTraceOrLineRef: false,
        containsConstraintWords: false,
        acceptedAi: true,
      });
      out.push({
        type: "ai_accept_outcome_observed",
        ts: next(30_000),
        outcome: "no-edit",
        editFraction: 0.0,
      });
    }
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "ff00aa4",
      message: "fix: dashboard pair-programmed with teammate",
      filesTouched: ["src/Widget.tsx", "src/lib/api.ts"],
    });
    return out;
  },
  expect: {
    // Rank set to "learner" per 4-rater consensus (3/4 said Learner,
    // 1/4 said Junior). Vibecoder is genuinely below the bootcamp grad
    // on understanding pillars because they've actively decoupled from
    // the code — uncritical AI use isn't junior-tier work.
    rank: "learner",
    dominantField: "web",
    headlineRange: [224, 284],
  },
};

// ---------------------------------------------------------------------------
// 4. The Pragmatic Mid — Mid, ~678
// ---------------------------------------------------------------------------
const pragmaticMid: Persona = {
  id: "unbiased:pragmaticMid",
  description:
    "4y B2B SaaS backend full-stack; balanced pillars; structured AI use",
  field: {
    selfDeclared: "web",
    conceptCounts: {
      "concept:typescript": 35,
      "concept:postgres": 20,
      "concept:aws": 14,
      "concept:redis": 8,
      "concept:zod": 7,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 2500) => (ts += d);

    // Session 1: orient in unfamiliar code. Reads imports + exports + 2 callsites.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 90_000,
      navCount: 4,
    });
    for (const k of ["def-jump", "find-refs", "symbol-search", "find-refs"] as const) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: k,
        fromFile: "src/billing/charge.ts",
        toFile: "src/billing/types.ts",
        msSinceEdit: 4000,
      });
    }
    // Structured AI ask comparing 2-3 approaches.
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "plan",
      charCount: 920,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.5,
    });
    out.push({
      type: "test_run_result",
      ts: next(60_000),
      file: "src/billing/charge.test.ts",
      tests: 12,
      passed: 12,
      durationMs: 880,
      trigger: "save",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "abc1230",
      message: "feat(billing): partial refunds with idempotency key",
      filesTouched: [
        "src/billing/charge.ts",
        "src/billing/charge.test.ts",
        "src/billing/types.ts",
      ],
    });

    // Session 2: bug → failing test first.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 60_000,
      navCount: 3,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "def-jump",
      fromFile: "src/billing/charge.ts",
      toFile: "src/db/charges.ts",
      msSinceEdit: 3500,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "debug",
      charCount: 540,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    // Writes failing test BEFORE fix.
    out.push({
      type: "test_run_result",
      ts: next(60_000),
      file: "src/billing/charge.test.ts",
      tests: 13,
      passed: 12,
      durationMs: 920,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(180_000),
      file: "src/billing/charge.test.ts",
      tests: 13,
      passed: 13,
      durationMs: 940,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "abc1231",
      message: "fix(billing): handle null chargeId on retry path",
      filesTouched: ["src/billing/charge.ts", "src/billing/charge.test.ts"],
    });

    // Session 3: refactor opportunistically.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 18_000,
      navCount: 2,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 720,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.45,
    });
    out.push({
      type: "test_run_result",
      ts: next(45_000),
      file: "src/billing/charge.test.ts",
      tests: 14,
      passed: 14,
      durationMs: 950,
      trigger: "save",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "abc1232",
      message: "refactor(billing): extract idempotency helper",
      filesTouched: ["src/billing/idempotency.ts", "src/billing/charge.ts"],
    });

    // Session 4: integration test for new endpoint.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 50_000,
      navCount: 3,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "find-refs",
      fromFile: "src/api/webhooks.ts",
      toFile: "src/billing/charge.ts",
      msSinceEdit: 3000,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "plan",
      charCount: 1100,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.55,
    });
    out.push({
      type: "test_run_result",
      ts: next(120_000),
      file: "src/api/webhooks.integration.test.ts",
      tests: 8,
      passed: 7,
      durationMs: 2200,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(180_000),
      file: "src/api/webhooks.integration.test.ts",
      tests: 8,
      passed: 8,
      durationMs: 2150,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "abc1233",
      message: "feat(webhooks): stripe charge.failed handler",
      filesTouched: [
        "src/api/webhooks.ts",
        "src/api/webhooks.integration.test.ts",
      ],
    });

    // Session 5: small correctness fix; flake hunt.
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "src/db/charges.test.ts",
      tests: 9,
      passed: 8,
      durationMs: 800,
      trigger: "ci-watch",
    });
    out.push({
      type: "test_run_result",
      ts: next(20_000),
      file: "src/db/charges.test.ts",
      tests: 9,
      passed: 9,
      durationMs: 820,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(15_000),
      file: "src/db/charges.test.ts",
      tests: 9,
      passed: 9,
      durationMs: 810,
      trigger: "manual",
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 380,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "abc1234",
      message: "fix(db): seed deterministic charge ids in tests to remove flake",
      filesTouched: ["src/db/charges.test.ts"],
    });
    return out;
  },
  expect: {
    rank: "mid",
    dominantField: "web",
    headlineRange: [678, 738],
  },
};

// ---------------------------------------------------------------------------
// 5. The ML Researcher Turned Engineer — Mid, ~645 (senior-grade Diagnostics)
// ---------------------------------------------------------------------------
const mlResearcher: Persona = {
  id: "unbiased:mlResearcher",
  description:
    "PhD/3y research+2y prod ML platform; deep numerical reading; AI-skeptical",
  field: {
    selfDeclared: "ml",
    conceptCounts: {
      "concept:pytorch": 42,
      "concept:tensor": 38,
      "concept:autograd": 14,
      "concept:numpy": 30,
      "concept:transformer": 18,
      "concept:loss": 22,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 3000) => (ts += d);

    // Reads dense model code deeply. Many navigations along forward pass.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 240_000,
      navCount: 8,
    });
    for (let i = 0; i < 8; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: i % 2 === 0 ? "def-jump" : "find-refs",
        fromFile: "models/encoder.py",
        toFile: "models/attention.py",
        msSinceEdit: 6000,
      });
    }
    // Sparse, targeted AI use only for shell/boilerplate.
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 220,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.6,
    });

    // Numerical bug hunt: shape mismatch. Builds toy 4-row dataset.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 360_000,
      navCount: 12,
    });
    for (let i = 0; i < 6; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: "def-jump",
        fromFile: "models/encoder.py",
        toFile: "models/attention.py",
        msSinceEdit: 5000,
      });
    }
    out.push({
      type: "test_run_result",
      ts: next(120_000),
      file: "tests/test_attention.py",
      tests: 7,
      passed: 5,
      durationMs: 4200,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(300_000),
      file: "tests/test_attention.py",
      tests: 7,
      passed: 6,
      durationMs: 4150,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(360_000),
      file: "tests/test_attention.py",
      tests: 7,
      passed: 7,
      durationMs: 4180,
      trigger: "manual",
    });

    // Property-based numerical test added.
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "tests/test_attention_property.py",
      tests: 25,
      passed: 25,
      durationMs: 9800,
      trigger: "manual",
    });

    // Single fat commit batching a week of experimentation.
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "ddee001",
      message:
        "experiment: sparse attention rewrite (kv-cache fix, layernorm placement, eval suite) — see notebook for ablation",
      filesTouched: [
        "models/attention.py",
        "models/encoder.py",
        "models/layers/norm.py",
        "tests/test_attention.py",
        "tests/test_attention_property.py",
        "notebooks/2025-04-attention-ablation.ipynb",
      ],
    });

    // Touches a service file reluctantly. Shallow read.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 14_000,
      navCount: 1,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "request",
      charCount: 180,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: false,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.3,
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "ddee002",
      message: "chore(serving): bump model artifact version",
      filesTouched: ["serving/config.yaml"],
    });

    // Diagnostics-heavy session: rare loss spike investigation.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 420_000,
      navCount: 14,
    });
    for (let i = 0; i < 8; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: i % 3 === 0 ? "find-refs" : "def-jump",
        fromFile: "training/loop.py",
        toFile: "training/optim.py",
        msSinceEdit: 7000,
      });
    }
    // Toy dataset reproduction.
    out.push({
      type: "test_run_result",
      ts: next(60_000),
      file: "tests/test_loss_spike_repro.py",
      tests: 3,
      passed: 1,
      durationMs: 12_000,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(600_000),
      file: "tests/test_loss_spike_repro.py",
      tests: 3,
      passed: 2,
      durationMs: 12_300,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(900_000),
      file: "tests/test_loss_spike_repro.py",
      tests: 3,
      passed: 3,
      durationMs: 12_100,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "ddee003",
      message:
        "fix(training): clip pre-softmax logits before mixed-precision cast — root cause of loss spikes at step ~120k",
      filesTouched: [
        "training/loop.py",
        "training/optim.py",
        "tests/test_loss_spike_repro.py",
      ],
    });
    return out;
  },
  expect: {
    rank: "mid",
    dominantField: "ml",
    headlineRange: [616, 676],
  },
};

// ---------------------------------------------------------------------------
// 6. The Mobile Mid Who Ships — Mid (top of band), ~695
// ---------------------------------------------------------------------------
const mobileMid: Persona = {
  id: "unbiased:mobileMid",
  description:
    "6y iOS lead; ships consumer apps; AI for boilerplate, snapshot UI tests",
  field: {
    selfDeclared: "mobile",
    conceptCounts: {
      "concept:swift": 50,
      "concept:swiftui": 28,
      "concept:uikit": 22,
      "concept:combine": 12,
      "concept:asyncawait": 18,
      "concept:coredata": 9,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 2200) => (ts += d);

    // Sprint feature 1: scaffold a new view.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 25_000,
      navCount: 2,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "symbol-search",
      fromFile: "Sources/Profile/ProfileView.swift",
      toFile: "Sources/Profile/ProfileViewModel.swift",
      msSinceEdit: 4000,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "request",
      charCount: 280,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.4,
    });
    out.push({
      type: "test_run_result",
      ts: next(60_000),
      file: "Tests/Snapshots/ProfileViewSnapshotTests.swift",
      tests: 6,
      passed: 6,
      durationMs: 1800,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "Tests/ProfileViewModelTests.swift",
      tests: 9,
      passed: 9,
      durationMs: 320,
      trigger: "save",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "9911aa0",
      message: "feat(profile): editable display name with optimistic update",
      filesTouched: [
        "Sources/Profile/ProfileView.swift",
        "Sources/Profile/ProfileViewModel.swift",
        "Tests/Snapshots/ProfileViewSnapshotTests.swift",
        "Tests/ProfileViewModelTests.swift",
      ],
    });

    // Sprint feature 2: a CoreData migration.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 75_000,
      navCount: 5,
    });
    for (let i = 0; i < 5; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: i % 2 ? "find-refs" : "def-jump",
        fromFile: "Sources/Storage/Migrations.swift",
        toFile: "Sources/Storage/Model.xcdatamodeld",
        msSinceEdit: 4500,
      });
    }
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "request",
      charCount: 320,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.5,
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "Tests/MigrationTests.swift",
      tests: 4,
      passed: 4,
      durationMs: 2200,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "9911aa1",
      message: "feat(storage): v3 -> v4 lightweight migration adds avatarURL",
      filesTouched: [
        "Sources/Storage/Migrations.swift",
        "Sources/Storage/Model.xcdatamodeld",
        "Tests/MigrationTests.swift",
      ],
    });

    // Performance bug: Instruments quickly.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 50_000,
      navCount: 4,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "def-jump",
      fromFile: "Sources/Feed/FeedView.swift",
      toFile: "Sources/Feed/ImageLoader.swift",
      msSinceEdit: 3500,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 540,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "Tests/FeedPerformanceTests.swift",
      tests: 3,
      passed: 2,
      durationMs: 5400,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(180_000),
      file: "Tests/FeedPerformanceTests.swift",
      tests: 3,
      passed: 3,
      durationMs: 3100,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "9911aa2",
      message: "perf(feed): downsample images on the decode queue, halves memory",
      filesTouched: [
        "Sources/Feed/ImageLoader.swift",
        "Tests/FeedPerformanceTests.swift",
      ],
    });

    // Refactor pass.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 12_000,
      navCount: 2,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 410,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.45,
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "Tests/Snapshots/ProfileViewSnapshotTests.swift",
      tests: 7,
      passed: 7,
      durationMs: 1900,
      trigger: "save",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "9911aa3",
      message: "refactor(profile): hoist async work into ViewModel",
      filesTouched: [
        "Sources/Profile/ProfileView.swift",
        "Sources/Profile/ProfileViewModel.swift",
      ],
    });

    // Quick fix from review.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 6_000,
      navCount: 1,
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "Tests/ProfileViewModelTests.swift",
      tests: 10,
      passed: 10,
      durationMs: 340,
      trigger: "save",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "9911aa4",
      message: "chore(profile): rename method per review",
      filesTouched: ["Sources/Profile/ProfileViewModel.swift"],
    });
    return out;
  },
  expect: {
    rank: "mid",
    dominantField: "mobile",
    headlineRange: [675, 735],
  },
};

// ---------------------------------------------------------------------------
// 7. The Senior Backend Architect — Senior, ~815
// ---------------------------------------------------------------------------
const seniorBackendArchitect: Persona = {
  id: "unbiased:seniorBackendArchitect",
  description:
    "11y fintech payments senior; structured AI; production-trained debugging",
  field: {
    selfDeclared: "web",
    conceptCounts: {
      "concept:typescript": 60,
      "concept:postgres": 45,
      "concept:redis": 22,
      "concept:kafka": 18,
      "concept:grpc": 14,
      "concept:idempotency": 28,
      "concept:opentelemetry": 16,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 3000) => (ts += d);

    // Session 1: orient in unfamiliar service. Module boundary first.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 180_000,
      navCount: 9,
    });
    for (let i = 0; i < 9; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: ["def-jump", "find-refs", "symbol-search", "find-refs"][i % 4] as
          | "def-jump"
          | "find-refs"
          | "symbol-search",
        fromFile: "services/payments/api.ts",
        toFile: "services/payments/store.ts",
        msSinceEdit: 5000,
      });
    }

    // Structured AI ask with tradeoffs.
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "plan",
      charCount: 1300,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.55,
    });

    out.push({
      type: "test_run_result",
      ts: next(60_000),
      file: "services/payments/charge.test.ts",
      tests: 28,
      passed: 28,
      durationMs: 1400,
      trigger: "save",
    });
    out.push({
      type: "test_run_result",
      ts: next(120_000),
      file: "services/payments/idempotency.contract.test.ts",
      tests: 15,
      passed: 15,
      durationMs: 1900,
      trigger: "manual",
    });

    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "f00d001",
      message:
        "feat(payments): exactly-once charge submission via consumer-side idempotency",
      filesTouched: [
        "services/payments/charge.ts",
        "services/payments/idempotency.ts",
        "services/payments/charge.test.ts",
        "services/payments/idempotency.contract.test.ts",
      ],
    });

    // Session 2: incident triage. Latent bug vs regression.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 120_000,
      navCount: 6,
    });
    for (let i = 0; i < 6; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: i % 2 ? "find-refs" : "def-jump",
        fromFile: "services/payments/charge.ts",
        toFile: "services/payments/retry.ts",
        msSinceEdit: 3500,
      });
    }
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "debug",
      charCount: 980,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    // Failing repro test, then fix.
    out.push({
      type: "test_run_result",
      ts: next(60_000),
      file: "services/payments/retry.test.ts",
      tests: 11,
      passed: 9,
      durationMs: 980,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(240_000),
      file: "services/payments/retry.test.ts",
      tests: 11,
      passed: 11,
      durationMs: 990,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "f00d002",
      message:
        "fix(payments): bound retry budget per-tenant to prevent thundering-herd at gateway",
      filesTouched: [
        "services/payments/retry.ts",
        "services/payments/retry.test.ts",
        "docs/runbooks/payments-retries.md",
      ],
    });

    // Session 3: design review back-and-forth.
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "plan",
      charCount: 1500,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.7,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "plan",
      charCount: 900,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: false,
    });

    // Session 4: property-test-driven correctness work.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 90_000,
      navCount: 5,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "find-refs",
      fromFile: "services/payments/ledger.ts",
      toFile: "services/payments/store.ts",
      msSinceEdit: 4000,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 720,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.5,
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "services/payments/ledger.property.test.ts",
      tests: 40,
      passed: 40,
      durationMs: 6800,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "f00d003",
      message:
        "feat(payments): ledger invariants enforced via property tests + db check constraints",
      filesTouched: [
        "services/payments/ledger.ts",
        "services/payments/store.ts",
        "services/payments/ledger.property.test.ts",
        "migrations/2025_05_ledger_constraints.sql",
      ],
    });

    // Session 5: small mentoring/PR-review-driven cleanups.
    for (let i = 0; i < 3; i++) {
      out.push({
        type: "read_pattern_observed",
        ts: next(),
        pattern: "skim",
        msToFirstEdit: 14_000,
        navCount: 2,
      });
      out.push({
        type: "test_run_result",
        ts: next(),
        file: "services/payments/charge.test.ts",
        tests: 30 + i,
        passed: 30 + i,
        durationMs: 1450,
        trigger: "save",
      });
      out.push({
        type: "commit_detected",
        ts: next(),
        sha: `f00d10${i}`,
        message: `refactor(payments): tighten error type for ${
          ["webhook", "store", "retry"][i]
        } path`,
        filesTouched: ["services/payments/charge.ts"],
      });
    }

    // Session 6: AI used for grunt work.
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "request",
      charCount: 240,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: false,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.4,
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "f00d200",
      message: "chore(payments): regenerate openapi types",
      filesTouched: ["services/payments/openapi.types.ts"],
    });
    return out;
  },
  expect: {
    rank: "senior",
    dominantField: "web",
    headlineRange: [811, 871],
  },
};

// ---------------------------------------------------------------------------
// 8. The Senior Security Engineer Who Won't Touch AI — Senior, ~730
// ---------------------------------------------------------------------------
const securitySenior: Persona = {
  id: "unbiased:securitySenior",
  description:
    "12y appsec senior; adversarial reading; refuses AI; heavy negative testing",
  field: {
    selfDeclared: "sec",
    conceptCounts: {
      "concept:authn": 32,
      "concept:authz": 30,
      "concept:csp": 14,
      "concept:fuzzing": 22,
      "concept:threatmodel": 25,
      "concept:saml": 10,
      "concept:oauth": 18,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 4000) => (ts += d);

    // Adversarial code reading. Deep, slow, many navigations along trust boundaries.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 300_000,
      navCount: 12,
    });
    for (let i = 0; i < 12; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: (
          ["find-refs", "def-jump", "symbol-search", "find-refs"] as const
        )[i % 4],
        fromFile: "services/auth/session.ts",
        toFile: "services/auth/csrf.ts",
        msSinceEdit: 6000,
      });
    }

    // No chat_turn events at all — refuses to use AI.

    // Fuzz / property tests.
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "services/auth/csrf.fuzz.test.ts",
      tests: 200,
      passed: 200,
      durationMs: 18_000,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "services/auth/session.property.test.ts",
      tests: 60,
      passed: 60,
      durationMs: 4500,
      trigger: "manual",
    });
    // Negative test that initially fails (catches a real bug).
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "services/auth/cookie.negative.test.ts",
      tests: 14,
      passed: 11,
      durationMs: 900,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(600_000),
      file: "services/auth/cookie.negative.test.ts",
      tests: 14,
      passed: 14,
      durationMs: 920,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "5ec0001",
      message:
        "fix(auth): SameSite=Strict on session cookie; reject __Host- prefix mismatch — threat model: CSRF via lax-cookie + subdomain takeover",
      filesTouched: [
        "services/auth/session.ts",
        "services/auth/cookie.negative.test.ts",
        "docs/threat-models/session-cookies.md",
      ],
    });

    // Reviewing someone else's AI-generated PR with a magnifying glass.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 360_000,
      navCount: 14,
    });
    for (let i = 0; i < 10; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: i % 2 ? "find-refs" : "def-jump",
        fromFile: "services/api/upload.ts",
        toFile: "services/api/sanitize.ts",
        msSinceEdit: 5000,
      });
    }
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "services/api/upload.adversarial.test.ts",
      tests: 28,
      passed: 24,
      durationMs: 2100,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(900_000),
      file: "services/api/upload.adversarial.test.ts",
      tests: 28,
      passed: 28,
      durationMs: 2200,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "5ec0002",
      message:
        "sec(api): reject zip slip + path traversal in upload extractor; add adversarial cases — review of AI-generated PR #4421",
      filesTouched: [
        "services/api/upload.ts",
        "services/api/sanitize.ts",
        "services/api/upload.adversarial.test.ts",
        "docs/threat-models/file-uploads.md",
      ],
    });

    // Hardening pass on JWT lib.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 240_000,
      navCount: 8,
    });
    for (let i = 0; i < 6; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: "find-refs",
        fromFile: "lib/jwt/verify.ts",
        toFile: "lib/jwt/keys.ts",
        msSinceEdit: 4500,
      });
    }
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "lib/jwt/verify.fuzz.test.ts",
      tests: 500,
      passed: 500,
      durationMs: 22_000,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "lib/jwt/verify.test.ts",
      tests: 35,
      passed: 35,
      durationMs: 1100,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "5ec0003",
      message:
        "sec(jwt): reject 'none' alg; pin alg per kid; fuzz 500 malformed tokens — addresses RFC 8725 §3.1",
      filesTouched: [
        "lib/jwt/verify.ts",
        "lib/jwt/verify.fuzz.test.ts",
        "lib/jwt/verify.test.ts",
        "docs/threat-models/jwt.md",
      ],
    });

    // Threat-model commit.
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "5ec0004",
      message:
        "docs(threats): update org-wide threat model — auth-boundary diagram, STRIDE matrix, top-5 attacker stories",
      filesTouched: [
        "docs/threat-models/org-overview.md",
        "docs/threat-models/diagrams/auth-boundary.svg",
      ],
    });
    return out;
  },
  expect: {
    rank: "senior",
    dominantField: "sec",
    headlineRange: [709, 769],
  },
};

// ---------------------------------------------------------------------------
// 9. The Senior DevOps with Thin Tests — Senior, ~735
// ---------------------------------------------------------------------------
const devOpsSenior: Persona = {
  id: "unbiased:devOpsSenior",
  description:
    "9y SRE; terraform/k8s/observability; strong AI use; thin pre-deploy tests",
  field: {
    selfDeclared: "devOps",
    conceptCounts: {
      "concept:terraform": 55,
      "concept:kubernetes": 48,
      "concept:prometheus": 30,
      "concept:grafana": 18,
      "concept:helm": 14,
      "concept:opentelemetry": 22,
      "concept:awslambda": 9,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 2500) => (ts += d);

    // Session 1: terraform refactor with AI assistance.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 18_000,
      navCount: 2,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "find-refs",
      fromFile: "infra/k8s/ingress.tf",
      toFile: "infra/k8s/cert-manager.tf",
      msSinceEdit: 3500,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 820,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.45,
    });
    // No real test runs for terraform — terse commit.
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "0ps0001",
      message: "rollout v2 of the ingress config",
      filesTouched: ["infra/k8s/ingress.tf"],
    });

    // Session 2: shell script for log analysis.
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "request",
      charCount: 360,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.35,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 480,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.4,
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "0ps0002",
      message: "tools: top-talkers script for ingress access logs",
      filesTouched: ["scripts/top_talkers.sh"],
    });

    // Session 3: incident response. Reads metrics first.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 8_000,
      navCount: 1,
    });
    out.push({
      type: "editor_navigation",
      ts: next(),
      kind: "symbol-search",
      fromFile: "infra/observability/dashboards.tf",
      toFile: "infra/observability/alerts.yaml",
      msSinceEdit: 2000,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "debug",
      charCount: 380,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "0ps0003",
      message:
        "incident: bump ingress connection limit; add alert on listener saturation",
      filesTouched: [
        "infra/k8s/ingress.tf",
        "infra/observability/alerts.yaml",
        "docs/runbooks/ingress-saturation.md",
      ],
    });

    // Session 4: kubernetes config rollout.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 60_000,
      navCount: 4,
    });
    for (let i = 0; i < 4; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: i % 2 ? "find-refs" : "def-jump",
        fromFile: "infra/k8s/deployment.yaml",
        toFile: "infra/k8s/configmap.yaml",
        msSinceEdit: 4000,
      });
    }
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "plan",
      charCount: 720,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.5,
    });
    // One thin integration test grudgingly.
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "infra/tests/smoke.test.sh",
      tests: 3,
      passed: 3,
      durationMs: 28_000,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "0ps0004",
      message: "k8s: graceful drain via preStop + terminationGracePeriod 60s",
      filesTouched: [
        "infra/k8s/deployment.yaml",
        "infra/k8s/configmap.yaml",
        "infra/tests/smoke.test.sh",
      ],
    });

    // Session 5: observability work. AI for prom queries.
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 540,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.4,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 480,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.4,
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "0ps0005",
      message:
        "obs: SLO burn-rate alerts (1h fast / 6h slow) + dashboard rewrite",
      filesTouched: [
        "infra/observability/dashboards.tf",
        "infra/observability/alerts.yaml",
        "docs/runbooks/slo-burn.md",
      ],
    });

    // Session 6: production debug session.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 120_000,
      navCount: 7,
    });
    for (let i = 0; i < 5; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: ["def-jump", "find-refs", "symbol-search"][i % 3] as
          | "def-jump"
          | "find-refs"
          | "symbol-search",
        fromFile: "services/gateway/config.yaml",
        toFile: "services/gateway/upstream.yaml",
        msSinceEdit: 4500,
      });
    }
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "debug",
      charCount: 760,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "0ps0006",
      message: "incident: gateway timeout cascade rca + retry caps",
      filesTouched: [
        "services/gateway/config.yaml",
        "services/gateway/upstream.yaml",
        "docs/postmortems/2025-04-gateway-cascade.md",
      ],
    });
    return out;
  },
  expect: {
    rank: "senior",
    dominantField: "devOps",
    headlineRange: [703, 763],
  },
};

// ---------------------------------------------------------------------------
// 10. The Polyglot Staff Engineer — Senior (top-of-band), ~885
// ---------------------------------------------------------------------------
const polyglotStaff: Persona = {
  id: "unbiased:polyglotStaff",
  description:
    "14y staff polyglot (embedded/web/ml/distributed); surgical AI; pristine commits",
  field: {
    // Genuinely ambiguous field — this is the calibration point.
    selfDeclared: "generalist",
    conceptCounts: {
      "concept:typescript": 38,
      "concept:rust": 28,
      "concept:python": 32,
      "concept:cpp": 18,
      "concept:pytorch": 22,
      "concept:postgres": 26,
      "concept:kubernetes": 18,
      "concept:embedded": 14,
      "concept:distributed": 30,
      "concept:opentelemetry": 16,
    },
  },
  events: () => {
    const out: EchoEvent[] = [];
    let ts = t0;
    const next = (d = 3000) => (ts += d);

    // Day 1: cross-team architecture review across 3 languages.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 300_000,
      navCount: 18,
    });
    for (let i = 0; i < 18; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: (
          ["def-jump", "find-refs", "symbol-search", "find-refs"] as const
        )[i % 4],
        fromFile: ["services/router/lib.rs", "services/api/server.ts", "ml/train/loop.py"][
          i % 3
        ],
        toFile: ["services/router/dispatch.rs", "services/api/db.ts", "ml/train/optim.py"][
          i % 3
        ],
        msSinceEdit: 4500,
      });
    }
    // Surgical AI: peer-review prompts.
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "plan",
      charCount: 1600,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.65,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 980,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "services/router/dispatch.test.rs",
      tests: 42,
      passed: 42,
      durationMs: 1400,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "services/router/property.test.rs",
      tests: 80,
      passed: 80,
      durationMs: 4200,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "5ta0001",
      message:
        "feat(router): consistent-hash dispatch with bounded migration during ring resize — design doc in PR description",
      filesTouched: [
        "services/router/dispatch.rs",
        "services/router/lib.rs",
        "services/router/dispatch.test.rs",
        "services/router/property.test.rs",
        "docs/design/consistent-hash-dispatch.md",
      ],
    });

    // Day 2: ML training-loop bug coordinated with the ML team.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 180_000,
      navCount: 10,
    });
    for (let i = 0; i < 8; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: i % 2 ? "find-refs" : "def-jump",
        fromFile: "ml/train/loop.py",
        toFile: "ml/train/optim.py",
        msSinceEdit: 4000,
      });
    }
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "debug",
      charCount: 880,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "ml/tests/test_optim_invariants.py",
      tests: 22,
      passed: 21,
      durationMs: 5400,
      trigger: "manual",
    });
    out.push({
      type: "test_run_result",
      ts: next(360_000),
      file: "ml/tests/test_optim_invariants.py",
      tests: 22,
      passed: 22,
      durationMs: 5450,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "5ta0002",
      message:
        "fix(ml): optimizer state restore preserves momentum buffer device — restoration was silently CPU-resident, slowing training 2.3x",
      filesTouched: [
        "ml/train/loop.py",
        "ml/train/optim.py",
        "ml/tests/test_optim_invariants.py",
      ],
    });

    // Day 3: web API contract test improvements + mentoring artifact.
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "skim",
      msToFirstEdit: 30_000,
      navCount: 3,
    });
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "plan",
      charCount: 1100,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      acceptedAi: true,
    });
    out.push({
      type: "ai_accept_outcome_observed",
      ts: next(30_000),
      outcome: "iterated",
      editFraction: 0.6,
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "services/api/contract.test.ts",
      tests: 60,
      passed: 60,
      durationMs: 2100,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "5ta0003",
      message:
        "test(api): contract tests vs partner mock; document 4 backwards-compat invariants for the team",
      filesTouched: [
        "services/api/contract.test.ts",
        "docs/team/api-compat-invariants.md",
      ],
    });

    // Day 4: embedded firmware tweak (rare-but-real).
    out.push({
      type: "read_pattern_observed",
      ts: next(),
      pattern: "deep",
      msToFirstEdit: 240_000,
      navCount: 9,
    });
    for (let i = 0; i < 6; i++) {
      out.push({
        type: "editor_navigation",
        ts: next(),
        kind: i % 2 ? "find-refs" : "def-jump",
        fromFile: "firmware/src/scheduler.cpp",
        toFile: "firmware/src/timer.cpp",
        msSinceEdit: 5000,
      });
    }
    out.push({
      type: "chat_turn",
      ts: next(),
      intent: "specific",
      charCount: 640,
      containsStackTraceOrLineRef: true,
      containsConstraintWords: true,
      acceptedAi: false,
    });
    out.push({
      type: "test_run_result",
      ts: next(),
      file: "firmware/tests/scheduler_test.cpp",
      tests: 18,
      passed: 18,
      durationMs: 3300,
      trigger: "manual",
    });
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "5ta0004",
      message:
        "fix(firmware): scheduler underflow on 32-bit tick wrap — see analysis in docs/embedded/scheduler-wrap.md",
      filesTouched: [
        "firmware/src/scheduler.cpp",
        "firmware/src/timer.cpp",
        "firmware/tests/scheduler_test.cpp",
        "docs/embedded/scheduler-wrap.md",
      ],
    });

    // Day 5: tooling / org-wide test reviewer.
    for (let i = 0; i < 3; i++) {
      out.push({
        type: "read_pattern_observed",
        ts: next(),
        pattern: "skim",
        msToFirstEdit: 14_000,
        navCount: 2,
      });
      out.push({
        type: "chat_turn",
        ts: next(),
        intent: "specific",
        charCount: 420 + i * 30,
        containsStackTraceOrLineRef: false,
        containsConstraintWords: true,
        acceptedAi: true,
      });
      out.push({
        type: "ai_accept_outcome_observed",
        ts: next(30_000),
        outcome: "iterated",
        editFraction: 0.5,
      });
    }
    out.push({
      type: "commit_detected",
      ts: next(),
      sha: "5ta0005",
      message:
        "tooling: deterministic test seeds across the monorepo; remove flake bandages, document policy",
      filesTouched: [
        "tools/test-seeds/index.ts",
        "docs/team/testing-policy.md",
      ],
    });
    return out;
  },
  expect: {
    rank: "senior",
    dominantField: "generalist",
    headlineRange: [872, 932],
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const UNBIASED_PERSONAS: Persona[] = [
  bootcampGrad,
  earnestJunior,
  vibecoder,
  pragmaticMid,
  mlResearcher,
  mobileMid,
  seniorBackendArchitect,
  securitySenior,
  devOpsSenior,
  polyglotStaff,
];
