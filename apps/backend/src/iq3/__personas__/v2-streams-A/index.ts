/**
 * V2 calibration streams — Author A
 *
 * Independent stream authoring for Code IQ v2 calibration. Each persona
 * is encoded by a realistic event stream using the FULL new vocabulary
 * (chat_turn, test_run_result, editor_navigation, read_pattern_observed,
 * paste_outcome_observed, ai_accept_outcome_observed, diagnostic_*,
 * file_saved, text_change, keystroke_batch, ai_suggestion_rejected,
 * line_diff, commit_detected, concept_encountered, file_focus_change).
 *
 * Behavioral fidelity > scoring optimization. Streams are not tuned to
 * any specific matcher rule — they portray what the persona would do.
 */

import type { EchoEvent, Iq3FieldId } from "@protege/types";
import type { Persona } from "../runPersona.js";

const t0 = 1_700_000_000_000;

/* ============================================================
 * Helpers — local per-persona timeline + push convenience
 * ============================================================ */

function makeTimeline() {
  let t = t0;
  const events: EchoEvent[] = [];
  const next = (deltaMs: number) => {
    t += deltaMs;
    return t;
  };
  return {
    events,
    next,
    push(e: EchoEvent) {
      events.push(e);
    },
  };
}

/* ============================================================
 * Persona 1 — Bootcamp Grad (learner / web / ~225)
 *
 * Sparse activity. Mostly jump-in reads, vague AI prompts dumping the
 * whole file, accepts first answer, no-edit accepts. A handful of
 * "fix" / "wip" commits. Tests rarely. Diagnostics sit unresolved
 * for a while because they don't read errors top-down.
 * ============================================================ */
function bootcampGradEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const file = "src/components/UserCard.jsx";
  const utilFile = "src/utils/format.js";

  // Day 1 — opens dashboard ticket cold.
  tl.push({ type: "file_focus_change", ts: tl.next(0), file, language: "javascriptreact" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "jump-in", msToFirstEdit: 4_000, navCount: 0 });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file, concept: "react-hook", language: "javascriptreact" });
  tl.push({ type: "text_change", ts: tl.next(3_000), file, charsAdded: 12, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(2_000), file, chars: 40 });

  // Confused, pastes whole file into AI.
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "vague",
    charCount: 2_400,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    containsExplainKeyword: true,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(45_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1_800 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
  tl.push({ type: "text_change", ts: tl.next(5_000), file, charsAdded: 1_800, charsRemoved: 200 });

  // Save — code half-broken, doesn't notice the warning.
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: file, errorCount: 2 });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(1_000), file, line: 42, severity: "error", message: "Cannot find name 'props'" });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(200), file, line: 51, severity: "warning", message: "useEffect missing dependency" });

  // More AI roundtrips.
  tl.push({
    type: "chat_turn",
    ts: tl.next(90_000),
    intent: "vague",
    charCount: 1_900,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(40_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 950 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.05 });
  tl.push({ type: "file_saved", ts: tl.next(15_000), path: file, errorCount: 1 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(2_000), file, line: 42, durationMs: 240_000 });

  // Half-hearted commit.
  tl.push({
    type: "commit_detected",
    ts: tl.next(5 * 60_000),
    sha: "a1b2c3d",
    message: "fix",
    filesTouched: [file],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file, linesAdded: 38, linesRemoved: 12, rewrittenFingerprints: [] });

  // Day 2 — bumps another bug.
  tl.push({ type: "file_focus_change", ts: tl.next(16 * 60 * 60_000), file: utilFile, language: "javascript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "jump-in", msToFirstEdit: 3_000, navCount: 0 });
  tl.push({ type: "text_change", ts: tl.next(3_000), file: utilFile, charsAdded: 25, charsRemoved: 5 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "debug",
    charCount: 1_700,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(35_000), outcome: "iterated", source: "ai-chat-output", chars: 600 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.15 });

  // Tries to write a test because teammate said so.
  const testFile = "src/utils/__tests__/format.test.js";
  tl.push({ type: "file_focus_change", ts: tl.next(120_000), file: testFile, language: "javascript" });
  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "request",
    charCount: 250,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(40_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 700 });
  tl.push({ type: "file_saved", ts: tl.next(30_000), path: testFile, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: testFile,
    tests: 2,
    passed: 2,
    durationMs: 1_400,
    trigger: "manual",
  });

  // Another commit — same lazy message.
  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "b2c3d4e",
    message: "wip",
    filesTouched: [utilFile, testFile],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: utilFile, linesAdded: 14, linesRemoved: 6, rewrittenFingerprints: [] });

  // Diagnostic still hangs around.
  tl.push({ type: "diagnostic_resolved", ts: tl.next(45 * 60_000), file, line: 51, durationMs: 50 * 60_000 });

  // Day 3 — third "fix" commit with mixed concerns.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file, language: "javascriptreact" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "jump-in", msToFirstEdit: 2_000, navCount: 0 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "vague",
    charCount: 1_500,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(45_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 800 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
  tl.push({ type: "file_saved", ts: tl.next(10_000), path: file, errorCount: 0 });
  tl.push({
    type: "commit_detected",
    ts: tl.next(5 * 60_000),
    sha: "c3d4e5f",
    message: "fix again",
    filesTouched: [file],
  });

  // Day 4 — assigned a small CSS bug.
  const cssFile = "src/components/UserCard.module.css";
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: cssFile, language: "css" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "jump-in", msToFirstEdit: 2_500, navCount: 0 });
  tl.push({ type: "text_change", ts: tl.next(4_000), file: cssFile, charsAdded: 60, charsRemoved: 12 });
  tl.push({ type: "keystroke_burst", ts: tl.next(3_000), file: cssFile, chars: 120 });
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: cssFile, errorCount: 0 });
  // Goes to AI when something else breaks.
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "vague",
    charCount: 1_400,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(35_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 700 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
  tl.push({ type: "file_saved", ts: tl.next(10_000), path: file, errorCount: 0 });
  tl.push({
    type: "commit_detected",
    ts: tl.next(5 * 60_000),
    sha: "d4e5f60",
    message: "actual fix",
    filesTouched: [file, cssFile],
  });

  // Day 5 — small standalone task.
  const helperFile = "src/utils/dates.js";
  tl.push({ type: "file_focus_change", ts: tl.next(22 * 60 * 60_000), file: helperFile, language: "javascript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "jump-in", msToFirstEdit: 3_000, navCount: 0 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "request",
    charCount: 280,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(35_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 500 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
  tl.push({ type: "text_change", ts: tl.next(5_000), file: helperFile, charsAdded: 500, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(10_000), path: helperFile, errorCount: 0 });
  tl.push({
    type: "commit_detected",
    ts: tl.next(8 * 60_000),
    sha: "e5f60a1",
    message: "wip",
    filesTouched: [helperFile],
  });
  // Reviewer asks for tests, AI writes them.
  const helperTest = "src/utils/__tests__/dates.test.js";
  tl.push({ type: "file_focus_change", ts: tl.next(60 * 60_000), file: helperTest, language: "javascript" });
  tl.push({
    type: "chat_turn",
    ts: tl.next(15_000),
    intent: "request",
    charCount: 220,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 600 });
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: helperTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_000),
    file: helperTest,
    tests: 2,
    passed: 2,
    durationMs: 1_300,
    trigger: "manual",
  });
  tl.push({
    type: "commit_detected",
    ts: tl.next(5 * 60_000),
    sha: "f60a1b2",
    message: "tests",
    filesTouched: [helperFile, helperTest],
  });

  return tl.events;
}

/* ============================================================
 * Persona 2 — Earnest Junior, Year Two (junior / web / ~570)
 *
 * Reads tests + exports first, paragraphs of context to AI, asks
 * follow-ups. Conventional commits, address-review cleanups.
 * Catches happy-path edge cases. Resolves debugging in reasonable
 * time with def-jumps to the source.
 * ============================================================ */
function earnestJuniorEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const apiFile = "server/routes/users.ts";
  const svcFile = "server/services/userService.ts";
  const testFile = "server/services/__tests__/userService.test.ts";

  tl.push({ type: "file_focus_change", ts: tl.next(0), file: apiFile, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 95_000, navCount: 4 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: apiFile, toFile: svcFile, msSinceEdit: 0 });
  tl.push({ type: "concept_encountered", ts: tl.next(2_000), file: svcFile, concept: "express-route", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: svcFile, concept: "postgres-query", language: "typescript" });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "find-refs", fromFile: svcFile, toFile: apiFile, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(20_000), kind: "file-bounce", fromFile: apiFile, toFile: testFile, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(40_000), kind: "symbol-search", fromFile: testFile, toFile: svcFile, msSinceEdit: 0 });

  // First edit only after building a model.
  tl.push({ type: "text_change", ts: tl.next(15_000), file: svcFile, charsAdded: 80, charsRemoved: 20 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: svcFile, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(10_000), file: svcFile, charsAdded: 140, charsRemoved: 30 });

  // Paragraph-of-context AI prompt.
  tl.push({
    type: "chat_turn",
    ts: tl.next(45_000),
    intent: "specific",
    charCount: 520,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(35_000), outcome: "iterated", source: "ai-chat-output", chars: 380 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.35 });

  // Follow-up question.
  tl.push({
    type: "chat_turn",
    ts: tl.next(120_000),
    intent: "specific",
    charCount: 280,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: false,
  });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(20_000), file: svcFile });

  // Save with one warning, fixes promptly.
  tl.push({ type: "file_saved", ts: tl.next(10_000), path: svcFile, errorCount: 1 });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(500), file: svcFile, line: 88, severity: "warning", message: "promise not awaited" });
  tl.push({ type: "editor_navigation", ts: tl.next(3_000), kind: "def-jump", fromFile: svcFile, toFile: svcFile, msSinceEdit: 1_000 });
  tl.push({ type: "text_change", ts: tl.next(15_000), file: svcFile, charsAdded: 6, charsRemoved: 6 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: svcFile, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: svcFile, line: 88, durationMs: 22_000 });

  // Writes happy-path test.
  tl.push({ type: "file_focus_change", ts: tl.next(60_000), file: testFile, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "skim", msToFirstEdit: 18_000, navCount: 1 });
  tl.push({ type: "text_change", ts: tl.next(20_000), file: testFile, charsAdded: 220, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(10_000), file: testFile, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(15_000), file: testFile, charsAdded: 180, charsRemoved: 10 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: testFile, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_000),
    file: testFile,
    tests: 6,
    passed: 6,
    durationMs: 3_200,
    trigger: "save",
  });

  // More context-gathering across the day.
  for (let i = 0; i < 6; i++) {
    tl.push({ type: "editor_navigation", ts: tl.next(120_000), kind: i % 2 === 0 ? "def-jump" : "find-refs", fromFile: svcFile, toFile: apiFile, msSinceEdit: 5_000 });
    tl.push({ type: "text_change", ts: tl.next(60_000), file: svcFile, charsAdded: 35 + i * 5, charsRemoved: 10 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: svcFile, chars: 120 });
  }

  // Edge-case test added because she thought of a null-input case.
  tl.push({
    type: "chat_turn",
    ts: tl.next(180_000),
    intent: "plan",
    charCount: 380,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.4 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: testFile, charsAdded: 140, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: testFile, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_000),
    file: testFile,
    tests: 9,
    passed: 9,
    durationMs: 4_100,
    trigger: "save",
  });

  // Conventional commit, decent message.
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "d4e5f6a",
    message: "feat(users): add lookup-by-handle endpoint with null guard",
    filesTouched: [apiFile, svcFile, testFile],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: svcFile, linesAdded: 62, linesRemoved: 14, rewrittenFingerprints: [] });
  tl.push({ type: "line_diff", ts: tl.next(100), file: testFile, linesAdded: 110, linesRemoved: 0, rewrittenFingerprints: [] });

  // Day 2 — debug cycle.
  tl.push({ type: "file_focus_change", ts: tl.next(18 * 60 * 60_000), file: svcFile, language: "typescript" });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(2_000), file: svcFile, line: 142, severity: "error", message: "TypeError: cannot read property 'id' of undefined" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(3_000), pattern: "deep", msToFirstEdit: 75_000, navCount: 3 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: svcFile, toFile: svcFile, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: svcFile, toFile: apiFile, msSinceEdit: 1_000 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "symbol-search", fromFile: apiFile, toFile: testFile, msSinceEdit: 1_000 });

  // Reproduces with a failing test before fixing.
  tl.push({ type: "text_change", ts: tl.next(30_000), file: testFile, charsAdded: 120, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: testFile, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_500),
    file: testFile,
    tests: 10,
    passed: 9,
    durationMs: 4_400,
    trigger: "manual",
  });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: svcFile, charsAdded: 28, charsRemoved: 6 });
  tl.push({ type: "file_saved", ts: tl.next(2_000), path: svcFile, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_500),
    file: testFile,
    tests: 10,
    passed: 10,
    durationMs: 4_300,
    trigger: "save",
  });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: svcFile, line: 142, durationMs: 6 * 60_000 });

  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "e5f6a7b",
    message: "fix(users): null-guard in service when handle missing",
    filesTouched: [svcFile, testFile],
  });

  // Address review cleanup commit.
  tl.push({
    type: "commit_detected",
    ts: tl.next(4 * 60 * 60_000),
    sha: "f6a7b8c",
    message: "chore(users): address review — rename handle to slug",
    filesTouched: [apiFile, svcFile, testFile],
  });

  // Day 3 — picks up another ticket, similar pattern.
  const authFile = "server/auth/passwordReset.ts";
  const authTest = "server/auth/__tests__/passwordReset.test.ts";
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: authFile, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 80_000, navCount: 4 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: authFile, concept: "bcrypt-hash", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: authFile, concept: "token-expiry", language: "typescript" });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: authFile, toFile: svcFile, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "find-refs", fromFile: svcFile, toFile: authFile, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(20_000), kind: "file-bounce", fromFile: authFile, toFile: authTest, msSinceEdit: 0 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "specific",
    charCount: 460,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.4 });
  for (let i = 0; i < 8; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: authFile, charsAdded: 50 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: authFile, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: authFile, errorCount: 0 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: authTest, charsAdded: 280, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: authTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_000),
    file: authTest,
    tests: 5,
    passed: 5,
    durationMs: 2_400,
    trigger: "save",
  });
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "0a7b8c9",
    message: "feat(auth): password reset flow with single-use tokens",
    filesTouched: [authFile, authTest],
  });

  // Day 4 — a debug session on a flaky test she finally realizes is async-timing.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: authTest, language: "typescript" });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_000),
    file: authTest,
    tests: 5,
    passed: 4,
    durationMs: 2_800,
    trigger: "manual",
  });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(5_000), file: authTest, line: 88, severity: "error", message: "TimeoutError: test exceeded 5000ms" });
  tl.push({
    type: "chat_turn",
    ts: tl.next(40_000),
    intent: "debug",
    charCount: 380,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.3 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "def-jump", fromFile: authTest, toFile: authFile, msSinceEdit: 1_000 });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: authTest, charsAdded: 60, charsRemoved: 20 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: authTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_500),
    file: authTest,
    tests: 5,
    passed: 5,
    durationMs: 2_700,
    trigger: "save",
  });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: authTest, line: 88, durationMs: 8 * 60_000 });
  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "1b8c9d0",
    message: "test(auth): await reset token job before assertion to fix flaky timeout",
    filesTouched: [authTest],
  });

  // Day 5 — refactor with code review mindset.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: svcFile, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "skim", msToFirstEdit: 30_000, navCount: 2 });
  for (let i = 0; i < 8; i++) {
    tl.push({ type: "editor_navigation", ts: tl.next(60_000), kind: i % 2 ? "find-refs" : "def-jump", fromFile: svcFile, toFile: i % 3 === 0 ? authFile : apiFile, msSinceEdit: 4_000 });
  }
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "plan",
    charCount: 420,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: false,
  });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(20_000), file: svcFile });
  for (let i = 0; i < 10; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: svcFile, charsAdded: 40 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: svcFile, chars: 130 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: svcFile, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: testFile,
    tests: 10,
    passed: 10,
    durationMs: 4_400,
    trigger: "save",
  });
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "2c9d0e1",
    message: "refactor(users): split repository from service to keep query logic isolated",
    filesTouched: [svcFile],
  });

  // Day 6 — pairs with senior on a hairier feature.
  const sessionFile = "server/auth/session.ts";
  const sessionTest = "server/auth/__tests__/session.test.ts";
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: sessionFile, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 70_000, navCount: 3 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: sessionFile, concept: "rolling-session", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: sessionFile, concept: "redis-store", language: "typescript" });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: sessionFile, toFile: authFile, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "find-refs", fromFile: authFile, toFile: sessionFile, msSinceEdit: 0 });

  tl.push({
    type: "chat_turn",
    ts: tl.next(45_000),
    intent: "plan",
    charCount: 480,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.45 });

  for (let i = 0; i < 12; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: sessionFile, charsAdded: 50 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: sessionFile, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: sessionFile, errorCount: 0 });

  tl.push({ type: "diagnostic_appeared", ts: tl.next(2_000), file: sessionFile, line: 88, severity: "warning", message: "session expiry not refreshed atomically" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: sessionFile, toFile: sessionFile, msSinceEdit: 1_000 });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: sessionFile, charsAdded: 35, charsRemoved: 12 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: sessionFile, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: sessionFile, line: 88, durationMs: 60_000 });

  tl.push({ type: "text_change", ts: tl.next(30_000), file: sessionTest, charsAdded: 380, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: sessionTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_500),
    file: sessionTest,
    tests: 8,
    passed: 8,
    durationMs: 3_400,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "3d0e1f2",
    message: "feat(auth): rolling session with atomic expiry refresh — backed by redis WATCH",
    filesTouched: [sessionFile, sessionTest],
  });

  // Day 7 — small bugfix.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(20 * 60 * 60_000), file: apiFile, line: 220, severity: "error", message: "TypeError: undefined is not a function" });
  tl.push({ type: "file_focus_change", ts: tl.next(2_000), file: apiFile, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 30_000, navCount: 2 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: apiFile, toFile: svcFile, msSinceEdit: 0 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(30_000),
    intent: "debug",
    charCount: 320,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: false,
  });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(20_000), file: apiFile });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: apiFile, charsAdded: 22, charsRemoved: 8 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: apiFile, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: apiFile, line: 220, durationMs: 5 * 60_000 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_500),
    file: testFile,
    tests: 10,
    passed: 10,
    durationMs: 4_400,
    trigger: "save",
  });
  tl.push({
    type: "commit_detected",
    ts: tl.next(8 * 60_000),
    sha: "4e1f203",
    message: "fix(users): null-check on optional handle to avoid TypeError",
    filesTouched: [apiFile],
  });

  return tl.events;
}

/* ============================================================
 * Persona 3 — Vibecoder (learner / web / ~254)
 *
 * 80% AI output, terse "make this work" prompts, accepts no-edit,
 * pastes everything. Mixed-concern PRs with AI commit messages.
 * Reverts are common. Tests assert truthy.
 * ============================================================ */
function vibecoderEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const file = "src/features/checkout/Cart.tsx";
  const file2 = "src/features/checkout/api.ts";
  const file3 = "src/features/checkout/__tests__/Cart.test.tsx";

  tl.push({ type: "file_focus_change", ts: tl.next(0), file, language: "typescriptreact" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(800), pattern: "jump-in", msToFirstEdit: 1_500, navCount: 0 });

  // Pastes whole file + says "make this work".
  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "vague",
    charCount: 3_400,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 2_100 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
  tl.push({ type: "text_change", ts: tl.next(5_000), file, charsAdded: 2_100, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: file, errorCount: 3 });

  // Three more rounds of re-prompting.
  for (let i = 0; i < 3; i++) {
    tl.push({
      type: "chat_turn",
      ts: tl.next(45_000),
      intent: "vague",
      charCount: 1_600 + i * 200,
      containsStackTraceOrLineRef: i > 0,
      containsConstraintWords: false,
      acceptedAi: true,
    });
    tl.push({ type: "paste_outcome_observed", ts: tl.next(35_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1_400 + i * 100 });
    tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.02 });
    tl.push({ type: "text_change", ts: tl.next(3_000), file, charsAdded: 800 + i * 50, charsRemoved: 400 });
  }

  tl.push({ type: "file_saved", ts: tl.next(10_000), path: file, errorCount: 1 });

  // Bounces to api file, same pattern.
  tl.push({ type: "file_focus_change", ts: tl.next(60_000), file: file2, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(800), pattern: "jump-in", msToFirstEdit: 2_000, navCount: 0 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(15_000),
    intent: "vague",
    charCount: 2_800,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1_900 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
  tl.push({ type: "file_saved", ts: tl.next(20_000), path: file2, errorCount: 2 });

  // AI writes the tests.
  tl.push({ type: "file_focus_change", ts: tl.next(120_000), file: file3, language: "typescriptreact" });
  tl.push({
    type: "chat_turn",
    ts: tl.next(15_000),
    intent: "request",
    charCount: 200,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1_200 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: file3, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_000),
    file: file3,
    tests: 4,
    passed: 4,
    durationMs: 1_800,
    trigger: "manual",
  });

  // Big mixed-concern commit, AI-style message.
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "1a2b3c4",
    message: "chore: improvements",
    filesTouched: [file, file2, file3, "src/features/checkout/index.ts", "src/features/checkout/types.ts", "src/features/checkout/utils.ts", "src/App.tsx"],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file, linesAdded: 220, linesRemoved: 80, rewrittenFingerprints: [] });
  tl.push({ type: "line_diff", ts: tl.next(100), file: file2, linesAdded: 180, linesRemoved: 40, rewrittenFingerprints: [] });

  // Diagnostic appears, never resolved by them — undo cycle.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(60_000), file, line: 75, severity: "error", message: "Type 'undefined' is not assignable to 'string'" });
  tl.push({ type: "undo_triggered", ts: tl.next(120_000), file });
  tl.push({ type: "undo_triggered", ts: tl.next(60_000), file });
  tl.push({
    type: "chat_turn",
    ts: tl.next(30_000),
    intent: "vague",
    charCount: 1_700,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(40_000), outcome: "iterated", source: "ai-chat-output", chars: 900 });

  // Reviewer asked for a revert.
  tl.push({
    type: "commit_detected",
    ts: tl.next(60 * 60_000),
    sha: "2b3c4d5",
    message: "Revert \"chore: improvements\"",
    filesTouched: [file, file2, file3],
  });

  // Day 2 — same again.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file, language: "typescriptreact" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(800), pattern: "jump-in", msToFirstEdit: 1_500, navCount: 0 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(15_000),
    intent: "vague",
    charCount: 2_200,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1_500 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
  tl.push({
    type: "commit_detected",
    ts: tl.next(20 * 60_000),
    sha: "3c4d5e6",
    message: "chore: more improvements",
    filesTouched: [file, file2, "src/features/checkout/utils.ts", "src/features/checkout/types.ts", "src/App.tsx"],
  });

  // Day 3 — paste cycle with fewer commits.
  const settingsFile = "src/features/settings/SettingsForm.tsx";
  tl.push({ type: "file_focus_change", ts: tl.next(22 * 60 * 60_000), file: settingsFile, language: "typescriptreact" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(800), pattern: "jump-in", msToFirstEdit: 1_500, navCount: 0 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(15_000),
    intent: "vague",
    charCount: 3_200,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 2_000 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
  tl.push({ type: "text_change", ts: tl.next(5_000), file: settingsFile, charsAdded: 2_000, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: settingsFile, errorCount: 4 });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(1_000), file: settingsFile, line: 33, severity: "error", message: "Type 'undefined' is not assignable to 'string'" });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(200), file: settingsFile, line: 67, severity: "error", message: "Cannot find name 'useFormState'" });

  // Three more vague rounds.
  for (let i = 0; i < 3; i++) {
    tl.push({
      type: "chat_turn",
      ts: tl.next(50_000),
      intent: "vague",
      charCount: 1_700 + i * 100,
      containsStackTraceOrLineRef: i > 0,
      containsConstraintWords: false,
      acceptedAi: true,
    });
    tl.push({ type: "paste_outcome_observed", ts: tl.next(35_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1_300 });
    tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "no-edit", editFraction: 0.0 });
    tl.push({ type: "text_change", ts: tl.next(5_000), file: settingsFile, charsAdded: 700, charsRemoved: 400 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: settingsFile, errorCount: 0 });

  // AI tests.
  const settingsTest = "src/features/settings/__tests__/SettingsForm.test.tsx";
  tl.push({ type: "file_focus_change", ts: tl.next(60_000), file: settingsTest, language: "typescriptreact" });
  tl.push({
    type: "chat_turn",
    ts: tl.next(15_000),
    intent: "request",
    charCount: 180,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1_000 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: settingsTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_000),
    file: settingsTest,
    tests: 5,
    passed: 5,
    durationMs: 2_100,
    trigger: "manual",
  });
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "4d5e6f7",
    message: "feat: settings",
    filesTouched: [settingsFile, settingsTest, "src/features/settings/index.ts", "src/features/settings/api.ts", "src/features/settings/types.ts", "src/App.tsx"],
  });

  // Day 4 — bug from QA, more reverts.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(8 * 60 * 60_000), file: settingsFile, line: 102, severity: "error", message: "Uncaught TypeError: state.user is null" });
  tl.push({
    type: "chat_turn",
    ts: tl.next(30_000),
    intent: "vague",
    charCount: 1_900,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(40_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1_100 });
  tl.push({ type: "undo_triggered", ts: tl.next(60_000), file: settingsFile });
  tl.push({
    type: "chat_turn",
    ts: tl.next(30_000),
    intent: "vague",
    charCount: 2_100,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: false,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(40_000), outcome: "iterated", source: "ai-chat-output", chars: 900 });
  tl.push({ type: "file_saved", ts: tl.next(15_000), path: settingsFile, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: settingsFile, line: 102, durationMs: 25 * 60_000 });
  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "5e6f708",
    message: "fixes",
    filesTouched: [settingsFile, file2, "src/features/settings/api.ts", "src/App.tsx"],
  });

  return tl.events;
}

/* ============================================================
 * Persona 4 — Pragmatic Mid (mid / web / ~708)
 *
 * 4 yrs TS/Postgres/AWS. Reads imports + exports + 1-2 callsites.
 * Constraint-rich AI prompts, comparison of approaches. Failing
 * test BEFORE fix. Conventional commits. Clean, atomic.
 * ============================================================ */
function pragmaticMidEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const handler = "src/api/billing/handlers.ts";
  const repo = "src/api/billing/repository.ts";
  const test = "src/api/billing/__tests__/handlers.test.ts";
  const intTest = "src/api/billing/__tests__/integration.test.ts";

  // Morning — feature work.
  tl.push({ type: "file_focus_change", ts: tl.next(0), file: handler, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "skim", msToFirstEdit: 28_000, navCount: 2 });
  tl.push({ type: "editor_navigation", ts: tl.next(4_000), kind: "def-jump", fromFile: handler, toFile: repo, msSinceEdit: 0 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: repo, concept: "postgres-transaction", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: repo, concept: "stripe-webhook", language: "typescript" });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: repo, toFile: handler, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "file-bounce", fromFile: handler, toFile: test, msSinceEdit: 0 });

  // First edit after building model.
  tl.push({ type: "text_change", ts: tl.next(10_000), file: handler, charsAdded: 80, charsRemoved: 25 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: handler, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(12_000), file: handler, charsAdded: 120, charsRemoved: 30 });

  // AI prompt with constraints + alternatives.
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "plan",
    charCount: 720,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(40_000), outcome: "iterated", editFraction: 0.5 });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(60_000), file: handler });

  // More work.
  for (let i = 0; i < 8; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: handler, charsAdded: 60 + i * 8, charsRemoved: 15 });
    tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: handler, chars: 150 + i * 10 });
  }

  tl.push({ type: "file_saved", ts: tl.next(20_000), path: handler, errorCount: 0 });

  // BUG REPORT — writes failing test first.
  tl.push({ type: "file_focus_change", ts: tl.next(30 * 60_000), file: test, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 60_000, navCount: 3 });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: test, toFile: handler, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "find-refs", fromFile: handler, toFile: repo, msSinceEdit: 1_500 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "symbol-search", fromFile: repo, toFile: test, msSinceEdit: 1_000 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: test, charsAdded: 220, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: test, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_000),
    file: test,
    tests: 8,
    passed: 7,
    durationMs: 3_400,
    trigger: "manual",
  });

  // Diagnostic appears, methodical fix.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(2_000), file: handler, line: 220, severity: "error", message: "race condition: tx not awaited" });
  tl.push({ type: "editor_navigation", ts: tl.next(3_000), kind: "def-jump", fromFile: handler, toFile: handler, msSinceEdit: 0 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: handler, charsAdded: 35, charsRemoved: 12 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: handler, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: handler, line: 220, durationMs: 90_000 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_000),
    file: test,
    tests: 8,
    passed: 8,
    durationMs: 3_500,
    trigger: "save",
  });

  // Adds integration test.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: intTest, language: "typescript" });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: intTest, charsAdded: 380, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: intTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: intTest, charsAdded: 200, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: intTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(4_000),
    file: intTest,
    tests: 5,
    passed: 5,
    durationMs: 9_200,
    trigger: "save",
  });

  // Conventional, atomic commit.
  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "4d5e6f7",
    message: "fix(billing): await tx in webhook handler to prevent dropped events",
    filesTouched: [handler, test],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: handler, linesAdded: 35, linesRemoved: 12, rewrittenFingerprints: [] });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "5e6f7a8",
    message: "test(billing): add integration test for webhook idempotency",
    filesTouched: [intTest],
  });

  // Day 2 — refactor.
  tl.push({ type: "file_focus_change", ts: tl.next(18 * 60 * 60_000), file: repo, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "skim", msToFirstEdit: 25_000, navCount: 2 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: repo, toFile: handler, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: repo, toFile: test, msSinceEdit: 0 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(40_000),
    intent: "specific",
    charCount: 480,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.45 });

  for (let i = 0; i < 12; i++) {
    tl.push({ type: "text_change", ts: tl.next(30_000), file: repo, charsAdded: 40 + i * 4, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: repo, chars: 130 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: repo, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: test,
    tests: 8,
    passed: 8,
    durationMs: 3_400,
    trigger: "save",
  });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_000),
    file: intTest,
    tests: 5,
    passed: 5,
    durationMs: 9_500,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "6f7a8b9",
    message: "refactor(billing): extract retry policy to shared module — keeps handler focused on flow",
    filesTouched: [repo, handler],
  });

  // Day 3 — new feature on a related service.
  const newSvc = "src/api/invoices/handlers.ts";
  const newRepo = "src/api/invoices/repository.ts";
  const newTest = "src/api/invoices/__tests__/handlers.test.ts";
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: newSvc, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "skim", msToFirstEdit: 25_000, navCount: 2 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: newSvc, concept: "invoice-numbering", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: newRepo, concept: "postgres-advisory-lock", language: "typescript" });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: newSvc, toFile: newRepo, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "find-refs", fromFile: newRepo, toFile: handler, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "file-bounce", fromFile: newSvc, toFile: newTest, msSinceEdit: 0 });

  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "plan",
    charCount: 760,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(40_000), outcome: "iterated", editFraction: 0.55 });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(120_000), file: newSvc });

  // Failing test first.
  tl.push({ type: "text_change", ts: tl.next(45_000), file: newTest, charsAdded: 320, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: newTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: newTest, charsAdded: 240, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: newTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_000),
    file: newTest,
    tests: 6,
    passed: 4,
    durationMs: 3_400,
    trigger: "manual",
  });

  // Implementation — many small typing bursts with idle gaps for thinking.
  for (let i = 0; i < 14; i++) {
    tl.push({ type: "text_change", ts: tl.next(60_000), file: newSvc, charsAdded: 50 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: newSvc, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: newSvc, errorCount: 0 });

  // Repository implementation.
  for (let i = 0; i < 10; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: newRepo, charsAdded: 40 + i * 5, charsRemoved: 15 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: newRepo, chars: 130 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: newRepo, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: newTest,
    tests: 6,
    passed: 6,
    durationMs: 3_500,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "7f8a9b0",
    message: "feat(invoices): atomic invoice numbering — uses pg advisory lock to serialize allocation under concurrency",
    filesTouched: [newSvc, newRepo, newTest],
  });

  // Day 4 — pair-programming-style debug with a teammate.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: handler, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 90_000, navCount: 4 });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(2_000), file: handler, line: 305, severity: "error", message: "PG error: deadlock detected" });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: handler, toFile: repo, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "find-refs", fromFile: repo, toFile: newRepo, msSinceEdit: 0 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "debug",
    charCount: 580,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.4 });
  // Reproduce + fix.
  tl.push({ type: "text_change", ts: tl.next(40_000), file: intTest, charsAdded: 220, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: intTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: intTest,
    tests: 6,
    passed: 5,
    durationMs: 11_400,
    trigger: "manual",
  });
  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(60_000), file: repo, charsAdded: 30 + i * 4, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: repo, chars: 130 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: repo, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: intTest,
    tests: 6,
    passed: 6,
    durationMs: 11_600,
    trigger: "save",
  });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: handler, line: 305, durationMs: 18 * 60_000 });
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "8a9b0c1",
    message: "fix(billing): order locks consistently across services to remove deadlock window",
    filesTouched: [repo, intTest],
  });

  // Day 5-6 — review-heavy days, lots of nav, small commits.
  for (let day = 0; day < 2; day++) {
    tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: handler, language: "typescript" });
    tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "skim", msToFirstEdit: 30_000, navCount: 2 });
    for (let i = 0; i < 8; i++) {
      tl.push({
        type: "editor_navigation",
        ts: tl.next(45_000),
        kind: i % 3 === 0 ? "find-refs" : "def-jump",
        fromFile: handler,
        toFile: [repo, newSvc, newRepo, test, intTest][i % 5],
        msSinceEdit: 4_000,
      });
    }
    tl.push({
      type: "chat_turn",
      ts: tl.next(30_000),
      intent: "specific",
      charCount: 420 + day * 60,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      containsQuestionMark: true,
      acceptedAi: true,
    });
    tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.45 });
    for (let i = 0; i < 8; i++) {
      tl.push({ type: "text_change", ts: tl.next(40_000), file: [handler, newSvc][day], charsAdded: 30 + i * 4, charsRemoved: 18 });
      tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: [handler, newSvc][day], chars: 130 });
    }
    tl.push({ type: "file_saved", ts: tl.next(5_000), path: [handler, newSvc][day], errorCount: 0 });
    tl.push({
      type: "test_run_result",
      ts: tl.next(5_000),
      file: [test, newTest][day],
      tests: 8 + day,
      passed: 8 + day,
      durationMs: 3_500,
      trigger: "save",
    });
    tl.push({
      type: "commit_detected",
      ts: tl.next(15 * 60_000),
      sha: `9b0c1d${day}`,
      message: ["refactor(billing): extract webhook signature verifier — used in two places, now testable in isolation",
                "fix(invoices): tighten serial guarantee under retried allocation calls"][day],
      filesTouched: [[handler], [newSvc, newRepo]][day],
    });
  }

  return tl.events;
}

/* ============================================================
 * Persona 5 — ML Researcher (mid / ml / ~646)
 *
 * Traces tensor shapes; ignores web stuff. Rare AI use; treats
 * it as boilerplate-only. Notebook-driven debug. Property tests
 * for numerical code. Batches a week into one commit.
 * ============================================================ */
function mlResearcherEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const model = "models/transformer/attention.py";
  const train = "models/transformer/train.py";
  const nb = "notebooks/debug_attention.ipynb";
  const propTest = "tests/test_attention_properties.py";
  const utils = "models/transformer/utils.py";

  tl.push({ type: "file_focus_change", ts: tl.next(0), file: model, language: "python" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 180_000, navCount: 6 });
  tl.push({ type: "concept_encountered", ts: tl.next(2_000), file: model, concept: "self-attention", language: "python" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: model, concept: "tensor-reshape", language: "python" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: model, concept: "softmax-stability", language: "python" });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "def-jump", fromFile: model, toFile: utils, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(20_000), kind: "find-refs", fromFile: utils, toFile: model, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(25_000), kind: "symbol-search", fromFile: model, toFile: model, msSinceEdit: 5_000 });
  tl.push({ type: "editor_navigation", ts: tl.next(20_000), kind: "def-jump", fromFile: model, toFile: train, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "find-refs", fromFile: train, toFile: model, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "file-bounce", fromFile: model, toFile: nb, msSinceEdit: 0 });

  // Builds toy dataset in notebook.
  tl.push({ type: "file_focus_change", ts: tl.next(20_000), file: nb, language: "python" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 12_000, navCount: 1 });
  tl.push({ type: "text_change", ts: tl.next(20_000), file: nb, charsAdded: 240, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: nb, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: nb, charsAdded: 320, charsRemoved: 40 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: nb, errorCount: 0 });

  // Diagnostic — wrong shape.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(8_000), file: nb, line: 14, severity: "error", message: "RuntimeError: shape mismatch [4, 8, 64] vs [4, 64, 8]" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: nb, toFile: model, msSinceEdit: 1_000 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "symbol-search", fromFile: model, toFile: model, msSinceEdit: 2_000 });

  // Methodical multi-step debug.
  for (let i = 0; i < 5; i++) {
    tl.push({ type: "text_change", ts: tl.next(60_000), file: nb, charsAdded: 80 + i * 10, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: nb, chars: 150 });
    tl.push({ type: "file_saved", ts: tl.next(3_000), path: nb, errorCount: 0 });
  }
  tl.push({ type: "diagnostic_resolved", ts: tl.next(5_000), file: nb, line: 14, durationMs: 8 * 60_000 });

  // Edits attention.py with the fix, deep reads first.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: model, language: "python" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 90_000, navCount: 3 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "def-jump", fromFile: model, toFile: utils, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "find-refs", fromFile: utils, toFile: model, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(20_000), kind: "symbol-search", fromFile: model, toFile: train, msSinceEdit: 0 });
  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: model, charsAdded: 60 + i * 5, charsRemoved: 30 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: model, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: model, errorCount: 0 });

  // Property tests using hypothesis.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: propTest, language: "python" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 60_000, navCount: 2 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: propTest, concept: "hypothesis-strategy", language: "python" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: propTest, concept: "property-test", language: "python" });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: propTest, charsAdded: 320, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: propTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: propTest, charsAdded: 280, charsRemoved: 40 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: propTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: propTest,
    tests: 6,
    passed: 6,
    durationMs: 12_400,
    trigger: "manual",
  });

  // Rare AI use — boilerplate only.
  tl.push({
    type: "chat_turn",
    ts: tl.next(45 * 60_000),
    intent: "request",
    charCount: 220,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.55 });

  // More research-style edits across the day.
  for (let i = 0; i < 10; i++) {
    tl.push({ type: "editor_navigation", ts: tl.next(180_000), kind: i % 2 ? "def-jump" : "symbol-search", fromFile: model, toFile: train, msSinceEdit: 4_000 });
    tl.push({ type: "text_change", ts: tl.next(60_000), file: train, charsAdded: 50 + i * 6, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: train, chars: 140 });
  }

  tl.push({ type: "file_saved", ts: tl.next(20_000), path: train, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(10_000),
    file: propTest,
    tests: 8,
    passed: 8,
    durationMs: 14_000,
    trigger: "manual",
  });

  // Skips AI for the loss function — knows it hallucinates.
  tl.push({
    type: "chat_turn",
    ts: tl.next(30 * 60_000),
    intent: "specific",
    charCount: 380,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: false,
  });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(5_000), file: model });

  // Big batched commit — a week's worth.
  tl.push({
    type: "commit_detected",
    ts: tl.next(2 * 60 * 60_000),
    sha: "7a8b9c0",
    message: "exp: fix attention shape bug, add property tests, retune dropout — all changes from week 14 ablation",
    filesTouched: [model, train, propTest, nb, utils],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: model, linesAdded: 80, linesRemoved: 30, rewrittenFingerprints: [] });
  tl.push({ type: "line_diff", ts: tl.next(100), file: train, linesAdded: 140, linesRemoved: 60, rewrittenFingerprints: [] });
  tl.push({ type: "line_diff", ts: tl.next(100), file: propTest, linesAdded: 280, linesRemoved: 0, rewrittenFingerprints: [] });

  // Day 2 — different ablation. Heavy notebook + utility work.
  const dataNb = "notebooks/data_ablation.ipynb";
  const dataLoader = "models/transformer/dataloader.py";
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: dataNb, language: "python" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 60_000, navCount: 3 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: dataNb, concept: "data-ablation", language: "python" });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: dataNb, toFile: dataLoader, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "find-refs", fromFile: dataLoader, toFile: train, msSinceEdit: 0 });
  for (let i = 0; i < 12; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: dataNb, charsAdded: 120 + i * 8, charsRemoved: 30 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: dataNb, chars: 150 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: dataNb, errorCount: 0 });

  // Diagnostic — distribution shift.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(15_000), file: dataNb, line: 32, severity: "warning", message: "Train/val class distribution mismatch detected" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: dataNb, toFile: dataLoader, msSinceEdit: 1_000 });
  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: dataLoader, charsAdded: 50 + i * 6, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: dataLoader, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: dataLoader, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: dataNb, line: 32, durationMs: 12 * 60_000 });

  // More property tests for the new dataloader.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: propTest, language: "python" });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: propTest, charsAdded: 240, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: propTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(12_000),
    file: propTest,
    tests: 10,
    passed: 10,
    durationMs: 19_400,
    trigger: "manual",
  });

  // Day 3 — more train.py iterations. Refuses AI for the loss reformulation.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: train, language: "python" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 110_000, navCount: 5 });
  for (let i = 0; i < 12; i++) {
    tl.push({ type: "editor_navigation", ts: tl.next(60_000), kind: i % 3 === 0 ? "find-refs" : "def-jump", fromFile: train, toFile: i % 2 === 0 ? model : utils, msSinceEdit: 4_000 });
  }
  tl.push({
    type: "chat_turn",
    ts: tl.next(45_000),
    intent: "specific",
    charCount: 320,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: false,
  });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(10_000), file: train });
  for (let i = 0; i < 14; i++) {
    tl.push({ type: "text_change", ts: tl.next(60_000), file: train, charsAdded: 50 + i * 5, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: train, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: train, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(12_000),
    file: propTest,
    tests: 10,
    passed: 10,
    durationMs: 19_800,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(2 * 60 * 60_000),
    sha: "8b9c0d1",
    message: "exp(week 15): focal loss + class-balanced sampler — ablation table in README, property tests cover sampler invariants",
    filesTouched: [train, dataLoader, dataNb, propTest],
  });

  // Day 4-5 — eval pipeline. Hand-rolled because AI doesn't know domain.
  const evalScript = "models/transformer/eval.py";
  const evalNb = "notebooks/eval_dashboard.ipynb";
  const metricsTest = "tests/test_metrics_properties.py";

  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: evalScript, language: "python" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 100_000, navCount: 4 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: evalScript, concept: "calibration-error", language: "python" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: evalScript, concept: "stratified-sampling", language: "python" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: metricsTest, concept: "property-test", language: "python" });

  for (let i = 0; i < 6; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(30_000),
      kind: i % 2 === 0 ? "def-jump" : "find-refs",
      fromFile: evalScript,
      toFile: [model, dataLoader, train][i % 3],
      msSinceEdit: 5_000,
    });
  }

  // Refuses AI for the eval logic itself.
  tl.push({
    type: "chat_turn",
    ts: tl.next(30_000),
    intent: "specific",
    charCount: 380,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: false,
  });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(15_000), file: evalScript });

  for (let i = 0; i < 14; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: evalScript, charsAdded: 60 + i * 5, charsRemoved: 22 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: evalScript, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: evalScript, errorCount: 0 });

  // Property tests for calibration metrics.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: metricsTest, language: "python" });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: metricsTest, charsAdded: 380, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: metricsTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: metricsTest, charsAdded: 280, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: metricsTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(15_000),
    file: metricsTest,
    tests: 10,
    passed: 10,
    durationMs: 22_400,
    trigger: "manual",
  });

  // Notebook for visualizing eval results.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: evalNb, language: "python" });
  for (let i = 0; i < 12; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: evalNb, charsAdded: 100 + i * 8, charsRemoved: 25 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: evalNb, chars: 160 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: evalNb, errorCount: 0 });

  // Diagnostic — tensor on wrong device.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(15_000), file: evalScript, line: 88, severity: "error", message: "RuntimeError: tensor on cpu, expected cuda" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: evalScript, toFile: evalScript, msSinceEdit: 1_000 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: evalScript, charsAdded: 18, charsRemoved: 6 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: evalScript, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: evalScript, line: 88, durationMs: 90_000 });

  // Boilerplate prompt for shell wrapper — rare AI use.
  tl.push({
    type: "chat_turn",
    ts: tl.next(15 * 60_000),
    intent: "request",
    charCount: 240,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.5 });

  // Big batched commit.
  tl.push({
    type: "commit_detected",
    ts: tl.next(2 * 60 * 60_000),
    sha: "9c0d1e2",
    message: "exp(week 16): eval pipeline — calibration error + stratified slices, 10 property invariants on metric implementation, notebook for slice-level inspection",
    filesTouched: [evalScript, metricsTest, evalNb],
  });

  return tl.events;
}

/* ============================================================
 * Persona 6 — Mobile Mid (mid / mobile / ~705)
 *
 * iOS-primary. Knows protocol conformances + view hierarchy.
 * AI for boilerplate only, validates by running. Snapshot tests.
 * Skips network mocks. Clean atomic commits, includes screenshots.
 * Instruments-driven debug.
 * ============================================================ */
function mobileMidEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const view = "App/Features/Feed/FeedView.swift";
  const vm = "App/Features/Feed/FeedViewModel.swift";
  const model = "App/Features/Feed/FeedItem.swift";
  const test = "AppTests/FeedViewModelTests.swift";
  const snap = "AppTests/SnapshotTests/FeedViewSnapshotTests.swift";

  tl.push({ type: "file_focus_change", ts: tl.next(0), file: view, language: "swift" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 22_000, navCount: 2 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: view, concept: "swiftui-view", language: "swift" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: view, concept: "combine-publisher", language: "swift" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: vm, concept: "async-await", language: "swift" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: view, toFile: vm, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: vm, toFile: view, msSinceEdit: 0 });

  // Boilerplate prompt.
  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "request",
    charCount: 240,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.4 });

  // Hand-crafts the rest.
  for (let i = 0; i < 10; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: view, charsAdded: 60 + i * 8, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: view, chars: 160 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: view, errorCount: 0 });

  // ViewModel work.
  tl.push({ type: "file_focus_change", ts: tl.next(60_000), file: vm, language: "swift" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 50_000, navCount: 3 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: vm, toFile: model, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "find-refs", fromFile: model, toFile: vm, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "symbol-search", fromFile: vm, toFile: vm, msSinceEdit: 2_000 });

  // Diagnostic: warning about retain cycle.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(20_000), file: vm, line: 64, severity: "warning", message: "Capture of 'self' may cause retain cycle" });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: vm, charsAdded: 18, charsRemoved: 5 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: vm, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: vm, line: 64, durationMs: 35_000 });

  for (let i = 0; i < 14; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: vm, charsAdded: 50 + i * 6, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: vm, chars: 150 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: vm, errorCount: 0 });

  // Unit tests.
  tl.push({ type: "file_focus_change", ts: tl.next(30 * 60_000), file: test, language: "swift" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 18_000, navCount: 1 });
  tl.push({ type: "text_change", ts: tl.next(25_000), file: test, charsAdded: 240, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: test, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: test, charsAdded: 280, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: test, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_000),
    file: test,
    tests: 9,
    passed: 9,
    durationMs: 2_800,
    trigger: "save",
  });

  // Snapshot tests.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: snap, language: "swift" });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: snap, concept: "snapshot-test", language: "swift" });
  tl.push({ type: "text_change", ts: tl.next(20_000), file: snap, charsAdded: 180, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: snap, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(6_000),
    file: snap,
    tests: 5,
    passed: 5,
    durationMs: 6_400,
    trigger: "manual",
  });

  // Performance bug — instruments time profiler.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(15 * 60_000), file: vm, line: 110, severity: "warning", message: "main-thread blocking call detected" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: vm, toFile: model, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: model, toFile: vm, msSinceEdit: 0 });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: vm, charsAdded: 40, charsRemoved: 25 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: vm, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: vm, line: 110, durationMs: 60_000 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: test,
    tests: 9,
    passed: 9,
    durationMs: 2_900,
    trigger: "save",
  });

  // Atomic commit with description.
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "8b9c0d1",
    message: "feat(feed): SwiftUI feed view with pagination — VM separates network from render loop",
    filesTouched: [view, vm, model, test, snap],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: view, linesAdded: 140, linesRemoved: 20, rewrittenFingerprints: [] });
  tl.push({ type: "line_diff", ts: tl.next(100), file: vm, linesAdded: 180, linesRemoved: 35, rewrittenFingerprints: [] });

  // Day 2 — more iteration.
  tl.push({ type: "file_focus_change", ts: tl.next(18 * 60 * 60_000), file: view, language: "swift" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 14_000, navCount: 1 });
  for (let i = 0; i < 8; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: view, charsAdded: 40 + i * 5, charsRemoved: 12 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: view, chars: 130 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: view, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(4_000),
    file: snap,
    tests: 6,
    passed: 5,
    durationMs: 7_200,
    trigger: "save",
  });

  // Snapshot updated after intentional UI change.
  tl.push({ type: "text_change", ts: tl.next(30_000), file: snap, charsAdded: 35, charsRemoved: 35 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: snap, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: snap,
    tests: 6,
    passed: 6,
    durationMs: 7_300,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(20 * 60_000),
    sha: "9c0d1e2",
    message: "fix(feed): prevent double-fetch on quick scroll — debounce coalesces page requests",
    filesTouched: [view, vm, snap],
  });

  // Day 3 — feature: comments thread.
  const thread = "App/Features/Comments/CommentsView.swift";
  const threadVM = "App/Features/Comments/CommentsViewModel.swift";
  const threadModel = "App/Features/Comments/Comment.swift";
  const threadTest = "AppTests/CommentsViewModelTests.swift";
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: thread, language: "swift" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 18_000, navCount: 1 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: thread, concept: "diffable-data-source", language: "swift" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: threadVM, concept: "actor-isolation", language: "swift" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: thread, toFile: threadVM, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: threadVM, toFile: threadModel, msSinceEdit: 0 });
  // Boilerplate prompt.
  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "request",
    charCount: 220,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.5 });
  // Hand-craft.
  for (let i = 0; i < 12; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: thread, charsAdded: 60 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: thread, chars: 150 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: thread, errorCount: 0 });

  // ViewModel.
  for (let i = 0; i < 14; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: threadVM, charsAdded: 50 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: threadVM, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: threadVM, errorCount: 0 });

  // Tests.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: threadTest, language: "swift" });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: threadTest, charsAdded: 380, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: threadTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: threadTest, charsAdded: 280, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: threadTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_500),
    file: threadTest,
    tests: 12,
    passed: 12,
    durationMs: 3_400,
    trigger: "save",
  });

  // Diagnostic on actor isolation.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(10 * 60_000), file: threadVM, line: 88, severity: "warning", message: "Reference to var 'state' is not concurrency-safe" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: threadVM, toFile: threadVM, msSinceEdit: 1_000 });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: threadVM, charsAdded: 30, charsRemoved: 12 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: threadVM, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: threadVM, line: 88, durationMs: 50_000 });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "0d1e2f3",
    message: "feat(comments): threaded view with actor-isolated VM — preview snapshots cover collapsed/expanded states",
    filesTouched: [thread, threadVM, threadModel, threadTest],
  });

  // Day 4 — performance pass.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: thread, language: "swift" });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(10_000), file: thread, line: 142, severity: "warning", message: "Layout pass exceeded 16ms budget — reuse cells" });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: thread, toFile: threadVM, msSinceEdit: 0 });
  for (let i = 0; i < 8; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: thread, charsAdded: 35 + i * 4, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: thread, chars: 130 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: thread, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: thread, line: 142, durationMs: 7 * 60_000 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(6_000),
    file: snap,
    tests: 6,
    passed: 6,
    durationMs: 7_200,
    trigger: "save",
  });
  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "1e2f3a4",
    message: "perf(comments): reuse cell views to keep scroll under 16ms — verified with Time Profiler",
    filesTouched: [thread],
  });

  // Day 5 — push-notification routing.
  const router = "App/Features/Notifications/Router.swift";
  const routerTest = "AppTests/NotificationsRouterTests.swift";
  const deeplink = "App/Features/Notifications/DeepLink.swift";
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: router, language: "swift" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 60_000, navCount: 3 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: router, concept: "deep-link", language: "swift" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: router, concept: "push-notification", language: "swift" });
  for (let i = 0; i < 6; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(30_000),
      kind: i % 2 === 0 ? "def-jump" : "find-refs",
      fromFile: router,
      toFile: [deeplink, routerTest, view][i % 3],
      msSinceEdit: 4_000,
    });
  }

  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "request",
    charCount: 240,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.45 });

  for (let i = 0; i < 12; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: router, charsAdded: 50 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: router, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: router, errorCount: 0 });

  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: deeplink, charsAdded: 50 + i * 4, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: deeplink, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: deeplink, errorCount: 0 });

  tl.push({ type: "text_change", ts: tl.next(30_000), file: routerTest, charsAdded: 380, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: routerTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_500),
    file: routerTest,
    tests: 10,
    passed: 10,
    durationMs: 3_400,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "2f3a4b5",
    message: "feat(notifications): typed deep-link router — covers all 6 notification types, falls back to feed on unknown",
    filesTouched: [router, deeplink, routerTest],
  });

  // Day 6 — bugfix from TestFlight.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(20 * 60 * 60_000), file: vm, line: 220, severity: "error", message: "Crash: nil unwrap in fetch result handler" });
  tl.push({ type: "file_focus_change", ts: tl.next(2_000), file: vm, language: "swift" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 50_000, navCount: 2 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: vm, toFile: model, msSinceEdit: 0 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: vm, charsAdded: 22, charsRemoved: 6 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: vm, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: vm, line: 220, durationMs: 4 * 60_000 });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: test, charsAdded: 120, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: test, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(3_000),
    file: test,
    tests: 10,
    passed: 10,
    durationMs: 3_000,
    trigger: "save",
  });
  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "3a4b5c6",
    message: "fix(feed): guard against nil result in fetch handler — TestFlight crash report TF-887",
    filesTouched: [vm, test],
  });

  return tl.events;
}

/* ============================================================
 * Persona 7 — Senior Backend Architect (senior / web / ~841)
 *
 * Distributed systems, payments. Reads module boundary first.
 * Structured AI prompts with tradeoffs. Property + contract tests.
 * Runbooks. PR descriptions explain WHY. Small atomic commits.
 * ============================================================ */
function seniorBackendEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const svc = "services/payments/orchestrator.ts";
  const repo = "services/payments/repository.ts";
  const idem = "services/payments/idempotency.ts";
  const test = "services/payments/__tests__/orchestrator.test.ts";
  const propTest = "services/payments/__tests__/idempotency.property.test.ts";
  const contractTest = "services/payments/__tests__/contract.test.ts";
  const runbook = "docs/runbooks/payments-incident.md";

  // Triage cycle — incident postmortem.
  tl.push({ type: "file_focus_change", ts: tl.next(0), file: svc, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 240_000, navCount: 9 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: svc, concept: "saga-pattern", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: svc, concept: "idempotency-key", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: svc, concept: "outbox-pattern", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: repo, concept: "postgres-isolation", language: "typescript" });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: svc, toFile: idem, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(10_000), kind: "find-refs", fromFile: idem, toFile: svc, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(12_000), kind: "find-refs", fromFile: idem, toFile: repo, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "symbol-search", fromFile: repo, toFile: test, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "file-bounce", fromFile: test, toFile: contractTest, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(20_000), kind: "def-jump", fromFile: contractTest, toFile: svc, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(15_000), kind: "find-refs", fromFile: svc, toFile: idem, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(20_000), kind: "symbol-search", fromFile: idem, toFile: propTest, msSinceEdit: 0 });

  // Long structured AI prompt — alternatives requested.
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "plan",
    charCount: 920,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(45_000), outcome: "iterated", editFraction: 0.6 });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(120_000), file: svc });

  // Reproduce with property test first.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: propTest, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 60_000, navCount: 2 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: propTest, concept: "fast-check", language: "typescript" });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: propTest, charsAdded: 320, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: propTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: propTest, charsAdded: 240, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: propTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: propTest,
    tests: 7,
    passed: 6,
    durationMs: 14_400,
    trigger: "manual",
  });

  // Diagnostic from the failing property — methodical.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(2_000), file: idem, line: 88, severity: "error", message: "duplicate idempotency key allowed under concurrent insert" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: propTest, toFile: idem, msSinceEdit: 1_000 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: idem, toFile: repo, msSinceEdit: 0 });

  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(60_000), file: idem, charsAdded: 50 + i * 8, charsRemoved: 25 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: idem, chars: 150 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: idem, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: idem, line: 88, durationMs: 8 * 60_000 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: propTest,
    tests: 7,
    passed: 7,
    durationMs: 14_800,
    trigger: "save",
  });

  // Update contract test.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: contractTest, language: "typescript" });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: contractTest, charsAdded: 180, charsRemoved: 20 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: contractTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: contractTest,
    tests: 4,
    passed: 4,
    durationMs: 5_200,
    trigger: "save",
  });

  // Atomic commit with rationale.
  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "0d1e2f3",
    message: "fix(payments): tighten idempotency-key uniqueness via partial unique idx — closes race window observed in INC-2042",
    filesTouched: [idem, propTest],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: idem, linesAdded: 45, linesRemoved: 18, rewrittenFingerprints: [] });

  // Updates runbook.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: runbook, language: "markdown" });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: runbook, charsAdded: 480, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: runbook, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: runbook, charsAdded: 220, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: runbook, errorCount: 0 });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "1e2f3a4",
    message: "docs(runbook): payments INC-2042 — postmortem + detection query for partial-unique conflicts",
    filesTouched: [runbook],
  });

  // Refactor pass — second day.
  tl.push({ type: "file_focus_change", ts: tl.next(18 * 60 * 60_000), file: svc, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 110_000, navCount: 5 });
  for (let i = 0; i < 10; i++) {
    tl.push({ type: "editor_navigation", ts: tl.next(60_000), kind: i % 3 === 0 ? "find-refs" : "def-jump", fromFile: svc, toFile: i % 2 ? idem : repo, msSinceEdit: 3_000 });
  }

  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "specific",
    charCount: 640,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.45 });

  for (let i = 0; i < 14; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: svc, charsAdded: 50 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: svc, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: svc, errorCount: 0 });

  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: test, language: "typescript" });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: test, charsAdded: 380, charsRemoved: 40 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: test, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: test,
    tests: 14,
    passed: 14,
    durationMs: 8_400,
    trigger: "save",
  });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_000),
    file: contractTest,
    tests: 4,
    passed: 4,
    durationMs: 5_300,
    trigger: "save",
  });
  tl.push({
    type: "test_run_result",
    ts: tl.next(2_000),
    file: propTest,
    tests: 7,
    passed: 7,
    durationMs: 14_900,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "2f3a4b5",
    message: "refactor(payments): extract retry orchestration into pure module — separates policy from coordination, simplifies fault injection in tests",
    filesTouched: [svc, test],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: svc, linesAdded: 220, linesRemoved: 90, rewrittenFingerprints: [] });

  // Mentor turn — reviews someone's PR (fewer events but high navigation).
  tl.push({
    type: "chat_turn",
    ts: tl.next(60 * 60_000),
    intent: "specific",
    charCount: 540,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.5 });

  // Day 3 — design review for a related service. Heavy nav + design doc.
  const newSvc = "services/payments/refund-orchestrator.ts";
  const newRepo = "services/payments/refund-repository.ts";
  const newTest = "services/payments/__tests__/refund-orchestrator.test.ts";
  const newPropTest = "services/payments/__tests__/refund.property.test.ts";
  const newDesign = "docs/design/refunds-rfc-018.md";

  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: newSvc, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 200_000, navCount: 7 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: newSvc, concept: "compensating-tx", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: newSvc, concept: "saga-pattern", language: "typescript" });
  for (let i = 0; i < 14; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(20_000),
      kind: ["def-jump", "find-refs", "symbol-search", "file-bounce"][i % 4] as "def-jump" | "find-refs" | "symbol-search" | "file-bounce",
      fromFile: newSvc,
      toFile: [newRepo, svc, idem, newTest, newPropTest][i % 5],
      msSinceEdit: 4_000,
    });
  }

  // Structured AI prompt for tradeoff analysis.
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "plan",
    charCount: 1_080,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(45_000), outcome: "iterated", editFraction: 0.55 });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(180_000), file: newSvc });

  // Property test first.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: newPropTest, language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: newPropTest, concept: "fast-check", language: "typescript" });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: newPropTest, charsAdded: 380, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: newPropTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: newPropTest, charsAdded: 280, charsRemoved: 40 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: newPropTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: newPropTest,
    tests: 8,
    passed: 6,
    durationMs: 16_400,
    trigger: "manual",
  });

  // Implement service.
  for (let i = 0; i < 16; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: newSvc, charsAdded: 50 + i * 5, charsRemoved: 22 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: newSvc, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: newSvc, errorCount: 0 });

  for (let i = 0; i < 10; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: newRepo, charsAdded: 40 + i * 4, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: newRepo, chars: 130 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: newRepo, errorCount: 0 });

  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: newPropTest,
    tests: 8,
    passed: 8,
    durationMs: 17_400,
    trigger: "save",
  });

  // Unit + contract tests.
  tl.push({ type: "text_change", ts: tl.next(40_000), file: newTest, charsAdded: 480, charsRemoved: 30 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: newTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(50_000), file: newTest, charsAdded: 320, charsRemoved: 40 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: newTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: newTest,
    tests: 18,
    passed: 18,
    durationMs: 9_400,
    trigger: "save",
  });

  // Design doc — the WHY.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: newDesign, language: "markdown" });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: newDesign, charsAdded: 1_200, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: newDesign, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(120_000), file: newDesign, charsAdded: 920, charsRemoved: 80 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: newDesign, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(90_000), file: newDesign, charsAdded: 720, charsRemoved: 100 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: newDesign, errorCount: 0 });

  // Atomic commits with WHY.
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "3a4b5c6",
    message: "feat(payments): refund orchestrator with compensating-tx saga — explicit failure modes covered by 8 properties",
    filesTouched: [newSvc, newRepo, newPropTest, newTest],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: newSvc, linesAdded: 280, linesRemoved: 40, rewrittenFingerprints: [] });
  tl.push({ type: "line_diff", ts: tl.next(100), file: newRepo, linesAdded: 180, linesRemoved: 0, rewrittenFingerprints: [] });
  tl.push({ type: "line_diff", ts: tl.next(100), file: newPropTest, linesAdded: 380, linesRemoved: 0, rewrittenFingerprints: [] });

  tl.push({
    type: "commit_detected",
    ts: tl.next(20 * 60_000),
    sha: "4b5c6d7",
    message: "docs(payments): RFC-018 — refunds. Saga vs 2PC tradeoff, idempotency reuse, p99 latency budget",
    filesTouched: [newDesign],
  });

  // Day 4 — incident triage. Reads metrics first.
  const incFile = "services/payments/orchestrator.ts";
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: incFile, language: "typescript" });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(5_000), file: incFile, line: 88, severity: "error", message: "p99 latency spike correlated with stripe webhook batch" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 240_000, navCount: 9 });
  for (let i = 0; i < 12; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(25_000),
      kind: i % 2 === 0 ? "find-refs" : "def-jump",
      fromFile: incFile,
      toFile: [idem, repo, newSvc, newRepo][i % 4],
      msSinceEdit: 4_000,
    });
  }
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "debug",
    charCount: 940,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(40_000), outcome: "iterated", editFraction: 0.5 });
  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(60_000), file: incFile, charsAdded: 40 + i * 6, charsRemoved: 25 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: incFile, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: incFile, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: incFile, line: 88, durationMs: 25 * 60_000 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: contractTest,
    tests: 4,
    passed: 4,
    durationMs: 5_400,
    trigger: "save",
  });
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "5c6d7e8",
    message: "perf(payments): batch webhook acks within 200ms window — INC-2061. Maintains at-least-once but smooths p99",
    filesTouched: [incFile],
  });

  // Day 5 — mentorship + small atomic refactors. Multiple commits per session.
  for (let small = 0; small < 4; small++) {
    tl.push({ type: "file_focus_change", ts: tl.next(8 * 60 * 60_000), file: [incFile, idem, repo, newSvc][small], language: "typescript" });
    tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "skim", msToFirstEdit: 25_000, navCount: 2 });
    for (let i = 0; i < 4; i++) {
      tl.push({
        type: "editor_navigation",
        ts: tl.next(30_000),
        kind: i % 2 === 0 ? "find-refs" : "def-jump",
        fromFile: [incFile, idem, repo, newSvc][small],
        toFile: [test, propTest, contractTest, newPropTest][i % 4],
        msSinceEdit: 4_000,
      });
    }
    tl.push({
      type: "chat_turn",
      ts: tl.next(20_000),
      intent: "specific",
      charCount: 380 + small * 30,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      containsQuestionMark: true,
      acceptedAi: true,
    });
    tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.5 });
    for (let i = 0; i < 5; i++) {
      tl.push({ type: "text_change", ts: tl.next(40_000), file: [incFile, idem, repo, newSvc][small], charsAdded: 30 + i * 4, charsRemoved: 18 });
      tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: [incFile, idem, repo, newSvc][small], chars: 130 });
    }
    tl.push({ type: "file_saved", ts: tl.next(5_000), path: [incFile, idem, repo, newSvc][small], errorCount: 0 });
    tl.push({
      type: "test_run_result",
      ts: tl.next(5_000),
      file: [test, propTest, contractTest, newPropTest][small],
      tests: 8 + small,
      passed: 8 + small,
      durationMs: 5_000 + small * 1_500,
      trigger: "save",
    });
    tl.push({
      type: "commit_detected",
      ts: tl.next(10 * 60_000),
      sha: `6d7e8f${small}`,
      message: [
        "refactor(payments): pull rate-limit policy into shared module — orchestrator now testable without a clock",
        "refactor(payments): make idempotency-key TTL explicit at call site — defaults were silently truncating in tests",
        "perf(payments): collapse two redundant schema validations on hot path — saves 8% latency, no behavior change",
        "refactor(refunds): split orchestrator into pure planner + effectful executor — planner is now property-tested",
      ][small],
      filesTouched: [[incFile], [idem], [repo], [newSvc, newRepo]][small],
    });
  }

  return tl.events;
}

/* ============================================================
 * Persona 8 — Senior Security Engineer (senior / sec / ~739)
 *
 * REFUSES AI. Adversarial reading. Negative + fuzz tests. Threat
 * model notes in commits. Methodical bug hunting with proof of
 * exploit. Logs everything.
 * ============================================================ */
function seniorSecurityEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const auth = "src/auth/jwt-validator.ts";
  const middleware = "src/auth/middleware.ts";
  const csrf = "src/auth/csrf.ts";
  const negTest = "src/auth/__tests__/jwt-validator.adversarial.test.ts";
  const fuzzTest = "src/auth/__tests__/jwt-validator.fuzz.test.ts";
  const threatDoc = "docs/threat-models/auth.md";

  // Adversarial code review.
  tl.push({ type: "file_focus_change", ts: tl.next(0), file: auth, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 360_000, navCount: 12 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: auth, concept: "jwt-claims", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: auth, concept: "alg-confusion-attack", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: auth, concept: "trust-boundary", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: csrf, concept: "csrf-token", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: middleware, concept: "input-validation", language: "typescript" });

  // Heavy navigation — mapping every input/output edge.
  for (let i = 0; i < 14; i++) {
    const targets = [auth, middleware, csrf, negTest];
    tl.push({
      type: "editor_navigation",
      ts: tl.next(20_000),
      kind: ["def-jump", "find-refs", "symbol-search", "file-bounce"][i % 4] as "def-jump" | "find-refs" | "symbol-search" | "file-bounce",
      fromFile: auth,
      toFile: targets[i % targets.length],
      msSinceEdit: 5_000,
    });
  }

  // Diagnostic: sees an unsafe code path.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(30_000), file: auth, line: 142, severity: "warning", message: "alg=none accepted under specific input — review trust boundary" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: auth, toFile: auth, msSinceEdit: 2_000 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: auth, toFile: middleware, msSinceEdit: 0 });

  // Writes the negative test FIRST.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: negTest, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 70_000, navCount: 3 });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: negTest, charsAdded: 380, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: negTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: negTest, charsAdded: 320, charsRemoved: 40 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: negTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(4_000),
    file: negTest,
    tests: 12,
    passed: 8,
    durationMs: 4_400,
    trigger: "manual",
  });

  // Fuzz harness.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: fuzzTest, language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: fuzzTest, concept: "fuzz-harness", language: "typescript" });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: fuzzTest, charsAdded: 480, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: fuzzTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: fuzzTest, charsAdded: 280, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: fuzzTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(15_000),
    file: fuzzTest,
    tests: 1,
    passed: 0,
    durationMs: 25_400,
    trigger: "manual",
  });

  // Methodical fix.
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: fuzzTest, toFile: auth, msSinceEdit: 1_000 });
  for (let i = 0; i < 8; i++) {
    tl.push({ type: "text_change", ts: tl.next(60_000), file: auth, charsAdded: 40 + i * 6, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: auth, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: auth, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: auth, line: 142, durationMs: 35 * 60_000 });

  tl.push({
    type: "test_run_result",
    ts: tl.next(4_000),
    file: negTest,
    tests: 12,
    passed: 12,
    durationMs: 4_500,
    trigger: "save",
  });
  tl.push({
    type: "test_run_result",
    ts: tl.next(15_000),
    file: fuzzTest,
    tests: 1,
    passed: 1,
    durationMs: 28_400,
    trigger: "save",
  });

  // Threat-model doc update.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: threatDoc, language: "markdown" });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: threatDoc, charsAdded: 620, charsRemoved: 80 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: threatDoc, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: threatDoc, charsAdded: 380, charsRemoved: 60 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: threatDoc, errorCount: 0 });

  // Meticulous commit with threat-model note. NO chat_turn / paste / ai_accept.
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "3a4b5c6",
    message: "fix(auth): reject alg=none and unknown algs explicitly — closes alg-confusion vector (T-7 in threat model). Adds 12 adversarial tests + fuzz harness. STRIDE: Spoofing.",
    filesTouched: [auth, negTest, fuzzTest, threatDoc],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: auth, linesAdded: 80, linesRemoved: 30, rewrittenFingerprints: [] });
  tl.push({ type: "line_diff", ts: tl.next(100), file: negTest, linesAdded: 320, linesRemoved: 0, rewrittenFingerprints: [] });

  // Day 2 — review someone else's AI-generated code.
  tl.push({ type: "file_focus_change", ts: tl.next(18 * 60 * 60_000), file: middleware, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 200_000, navCount: 7 });
  for (let i = 0; i < 10; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(30_000),
      kind: i % 2 === 0 ? "find-refs" : "def-jump",
      fromFile: middleware,
      toFile: i % 3 === 0 ? csrf : auth,
      msSinceEdit: 3_000,
    });
  }
  tl.push({ type: "diagnostic_appeared", ts: tl.next(15_000), file: middleware, line: 88, severity: "error", message: "TOCTOU: validate then use without lock" });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(2_000), file: middleware, line: 102, severity: "warning", message: "input not normalized before regex" });

  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: middleware, charsAdded: 50 + i * 6, charsRemoved: 25 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: middleware, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: middleware, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: middleware, line: 88, durationMs: 6 * 60_000 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: middleware, line: 102, durationMs: 7 * 60_000 });

  // Add tests for the regex normalization fix.
  tl.push({ type: "text_change", ts: tl.next(30_000), file: negTest, charsAdded: 280, charsRemoved: 0 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: negTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: negTest,
    tests: 18,
    passed: 18,
    durationMs: 5_200,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "4b5c6d7",
    message: "fix(auth/middleware): close TOCTOU + normalize input before regex — STRIDE: Tampering. Tests: 6 adversarial cases, normalization unit tests.",
    filesTouched: [middleware, negTest],
  });

  // Day 3 — threat model session for a new feature: webhook signing.
  const sig = "src/auth/webhook-signing.ts";
  const sigTest = "src/auth/__tests__/webhook-signing.adversarial.test.ts";
  const sigFuzz = "src/auth/__tests__/webhook-signing.fuzz.test.ts";

  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: sig, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 280_000, navCount: 9 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: sig, concept: "hmac-sha256", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: sig, concept: "constant-time-compare", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: sig, concept: "replay-attack", language: "typescript" });

  for (let i = 0; i < 12; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(25_000),
      kind: ["def-jump", "find-refs", "symbol-search"][i % 3] as "def-jump" | "find-refs" | "symbol-search",
      fromFile: sig,
      toFile: [auth, middleware, sigTest, sigFuzz][i % 4],
      msSinceEdit: 5_000,
    });
  }

  // Adversarial tests first — concrete attack scenarios.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: sigTest, language: "typescript" });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: sigTest, charsAdded: 480, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: sigTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: sigTest, charsAdded: 380, charsRemoved: 30 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: sigTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: sigTest, charsAdded: 240, charsRemoved: 60 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: sigTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: sigTest,
    tests: 16,
    passed: 11,
    durationMs: 4_800,
    trigger: "manual",
  });

  // Implement.
  for (let i = 0; i < 12; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: sig, charsAdded: 50 + i * 5, charsRemoved: 22 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: sig, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: sig, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: sigTest,
    tests: 16,
    passed: 16,
    durationMs: 4_900,
    trigger: "save",
  });

  // Fuzz harness.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: sigFuzz, language: "typescript" });
  tl.push({ type: "text_change", ts: tl.next(50_000), file: sigFuzz, charsAdded: 480, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: sigFuzz, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(50_000), file: sigFuzz, charsAdded: 280, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: sigFuzz, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(20_000),
    file: sigFuzz,
    tests: 1,
    passed: 1,
    durationMs: 35_400,
    trigger: "manual",
  });

  // Threat model update.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: threatDoc, language: "markdown" });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: threatDoc, charsAdded: 720, charsRemoved: 60 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: threatDoc, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(80_000), file: threatDoc, charsAdded: 480, charsRemoved: 80 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: threatDoc, errorCount: 0 });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "5c6d7e8",
    message: "feat(auth): hmac-sha256 webhook signing with constant-time-compare + nonce window. STRIDE: Spoofing+Tampering+Repudiation. 16 adversarial + fuzz harness.",
    filesTouched: [sig, sigTest, sigFuzz, threatDoc],
  });

  // Day 4 — review someone else's vibecoded PR.
  const peerFile = "src/api/admin/import.ts";
  const peerTest = "src/api/admin/__tests__/import.test.ts";
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: peerFile, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 240_000, navCount: 8 });
  for (let i = 0; i < 12; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(25_000),
      kind: i % 2 === 0 ? "find-refs" : "def-jump",
      fromFile: peerFile,
      toFile: [middleware, csrf, peerTest, auth][i % 4],
      msSinceEdit: 5_000,
    });
  }
  tl.push({ type: "diagnostic_appeared", ts: tl.next(15_000), file: peerFile, line: 42, severity: "error", message: "SQL string interpolation — injection vector" });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(2_000), file: peerFile, line: 78, severity: "error", message: "Auth check missing on admin endpoint" });
  tl.push({ type: "diagnostic_appeared", ts: tl.next(2_000), file: peerFile, line: 102, severity: "warning", message: "Verbose error message leaks schema" });

  for (let i = 0; i < 8; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: peerFile, charsAdded: 50 + i * 5, charsRemoved: 25 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: peerFile, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: peerFile, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: peerFile, line: 42, durationMs: 12 * 60_000 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: peerFile, line: 78, durationMs: 14 * 60_000 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: peerFile, line: 102, durationMs: 16 * 60_000 });

  // Add tests for each fix.
  tl.push({ type: "text_change", ts: tl.next(40_000), file: peerTest, charsAdded: 380, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: peerTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: peerTest,
    tests: 14,
    passed: 14,
    durationMs: 5_200,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "6d7e8f9",
    message: "fix(admin/import): replace string interpolation with parameterized query, gate endpoint behind admin role, sanitize error response. STRIDE: Tampering+EoP+InfoDisclosure. Tests cover each vector.",
    filesTouched: [peerFile, peerTest],
  });

  // Day 5 — security audit pass on the auth module. Many small adversarial commits.
  for (let pass = 0; pass < 4; pass++) {
    const target = [auth, middleware, csrf, sig][pass];
    const tgtTest = [negTest, negTest, negTest, sigTest][pass];
    tl.push({ type: "file_focus_change", ts: tl.next(6 * 60 * 60_000), file: target, language: "typescript" });
    tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 120_000, navCount: 5 });
    for (let i = 0; i < 8; i++) {
      tl.push({
        type: "editor_navigation",
        ts: tl.next(25_000),
        kind: ["find-refs", "def-jump", "symbol-search", "file-bounce"][i % 4] as "find-refs" | "def-jump" | "symbol-search" | "file-bounce",
        fromFile: target,
        toFile: [auth, middleware, csrf, sig, threatDoc][i % 5],
        msSinceEdit: 5_000,
      });
    }
    tl.push({ type: "diagnostic_appeared", ts: tl.next(15_000), file: target, line: 100 + pass * 10, severity: "warning", message: ["timing-side-channel risk", "log injection vector", "session-fixation possible", "nonce reuse window"][pass] });
    for (let i = 0; i < 5; i++) {
      tl.push({ type: "text_change", ts: tl.next(50_000), file: target, charsAdded: 30 + i * 4, charsRemoved: 20 });
      tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: target, chars: 130 });
    }
    tl.push({ type: "file_saved", ts: tl.next(5_000), path: target, errorCount: 0 });
    tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: target, line: 100 + pass * 10, durationMs: 8 * 60_000 });
    tl.push({ type: "text_change", ts: tl.next(30_000), file: tgtTest, charsAdded: 220 + pass * 30, charsRemoved: 0 });
    tl.push({ type: "file_saved", ts: tl.next(5_000), path: tgtTest, errorCount: 0 });
    tl.push({
      type: "test_run_result",
      ts: tl.next(5_000),
      file: tgtTest,
      tests: 18 + pass * 3,
      passed: 18 + pass * 3,
      durationMs: 5_500 + pass * 500,
      trigger: "save",
    });
    tl.push({
      type: "commit_detected",
      ts: tl.next(10 * 60_000),
      sha: `7e8f9a${pass}`,
      message: [
        "fix(auth): make token compare constant-time across all paths — closes timing-side-channel. STRIDE: InfoDisclosure.",
        "fix(auth/middleware): strip CR/LF from log fields — closes log-injection vector. STRIDE: Tampering.",
        "fix(auth/csrf): rotate token on privilege change — closes session-fixation. STRIDE: ElevationOfPrivilege.",
        "fix(auth/webhook-signing): tighten nonce window from 5m to 30s + LRU — closes replay window. STRIDE: Spoofing.",
      ][pass],
      filesTouched: [target, tgtTest],
    });
  }

  return tl.events;
}

/* ============================================================
 * Persona 9 — Senior DevOps (senior / devOps / ~733)
 *
 * Terraform + k8s. Confident AI user for shell/log analysis.
 * Thin tests. Clean in incidents — debugging + metrics. Decent
 * but sometimes terse commits. Better at runbooks than messages.
 * ============================================================ */
function seniorDevopsEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const tf = "infra/terraform/eks-cluster.tf";
  const tfMod = "infra/terraform/modules/ingress/main.tf";
  const helm = "infra/charts/api/values.yaml";
  const ciYml = ".github/workflows/deploy.yml";
  const dockerfile = "services/api/Dockerfile";
  const runbook = "docs/runbooks/p1-api-degraded.md";
  const intTest = "infra/test/ingress.integration.test.ts";

  tl.push({ type: "file_focus_change", ts: tl.next(0), file: tf, language: "terraform" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 22_000, navCount: 2 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: tf, concept: "terraform-module", language: "terraform" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: tf, concept: "kubernetes-ingress", language: "terraform" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: tfMod, concept: "iam-role", language: "terraform" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: tf, toFile: tfMod, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: tfMod, toFile: tf, msSinceEdit: 0 });

  // AI for boilerplate refactor — confident user.
  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "specific",
    charCount: 480,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.4 });

  for (let i = 0; i < 8; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: tf, charsAdded: 50 + i * 6, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: tf, chars: 150 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: tf, errorCount: 0 });

  // Helm values tweak.
  tl.push({ type: "file_focus_change", ts: tl.next(10 * 60_000), file: helm, language: "yaml" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_000), pattern: "jump-in", msToFirstEdit: 4_000, navCount: 0 });
  tl.push({ type: "text_change", ts: tl.next(20_000), file: helm, charsAdded: 60, charsRemoved: 20 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: helm, errorCount: 0 });

  // CI yaml.
  tl.push({ type: "file_focus_change", ts: tl.next(10 * 60_000), file: ciYml, language: "yaml" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_000), pattern: "skim", msToFirstEdit: 12_000, navCount: 1 });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: ciYml, charsAdded: 120, charsRemoved: 25 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: ciYml, errorCount: 0 });

  // Quick AI for log analysis — pasted log dump.
  tl.push({
    type: "chat_turn",
    ts: tl.next(15 * 60_000),
    intent: "debug",
    charCount: 1_200,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.3 });

  // Dockerfile fix.
  tl.push({ type: "file_focus_change", ts: tl.next(10 * 60_000), file: dockerfile, language: "dockerfile" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_000), pattern: "skim", msToFirstEdit: 9_000, navCount: 1 });
  tl.push({ type: "text_change", ts: tl.next(15_000), file: dockerfile, charsAdded: 35, charsRemoved: 12 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: dockerfile, errorCount: 0 });

  // Diagnostic from terraform plan via diagnostic_appeared.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(8 * 60_000), file: tf, line: 88, severity: "error", message: "Cycle: aws_iam_role.api -> aws_iam_role_policy.api -> aws_iam_role.api" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "find-refs", fromFile: tf, toFile: tfMod, msSinceEdit: 1_000 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "debug",
    charCount: 720,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.5 });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: tf, charsAdded: 60, charsRemoved: 35 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: tf, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: tf, line: 88, durationMs: 4 * 60_000 });

  // Terse commit.
  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "5c6d7e8",
    message: "rollout v2 of the ingress config",
    filesTouched: [tf, tfMod, helm, ciYml, dockerfile],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: tf, linesAdded: 140, linesRemoved: 60, rewrittenFingerprints: [] });

  // Excellent runbook — what they're really good at.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: runbook, language: "markdown" });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: runbook, charsAdded: 920, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: runbook, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(120_000), file: runbook, charsAdded: 720, charsRemoved: 80 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: runbook, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: runbook, charsAdded: 480, charsRemoved: 60 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: runbook, errorCount: 0 });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "6d7e8f9",
    message: "docs: api p1 runbook — sev1 escalation, top 5 dashboards, common pitfalls",
    filesTouched: [runbook],
  });

  // Thin integration test added grudgingly.
  tl.push({ type: "file_focus_change", ts: tl.next(30 * 60_000), file: intTest, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 14_000, navCount: 1 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(30_000),
    intent: "request",
    charCount: 320,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.35 });
  tl.push({ type: "text_change", ts: tl.next(20_000), file: intTest, charsAdded: 180, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: intTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: intTest,
    tests: 2,
    passed: 2,
    durationMs: 12_400,
    trigger: "manual",
  });

  // Day 2 — incident response, lots of nav across services.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(18 * 60 * 60_000), file: helm, line: 22, severity: "error", message: "rollout exceeded surge budget — pods stuck terminating" });
  tl.push({ type: "file_focus_change", ts: tl.next(2_000), file: helm, language: "yaml" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_000), pattern: "skim", msToFirstEdit: 8_000, navCount: 1 });
  for (let i = 0; i < 6; i++) {
    tl.push({ type: "editor_navigation", ts: tl.next(30_000), kind: i % 2 === 0 ? "file-bounce" : "find-refs", fromFile: helm, toFile: i % 3 === 0 ? tf : ciYml, msSinceEdit: 2_000 });
  }
  tl.push({
    type: "chat_turn",
    ts: tl.next(30_000),
    intent: "debug",
    charCount: 1_400,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "iterated", source: "ai-chat-output", chars: 800 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.35 });
  tl.push({ type: "text_change", ts: tl.next(20_000), file: helm, charsAdded: 80, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: helm, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: helm, line: 22, durationMs: 12 * 60_000 });

  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "7e8f9a0",
    message: "fix(api): cap maxSurge so terminating pods drain — INC-2049",
    filesTouched: [helm],
  });

  // Day 3 — multi-cluster Terraform refactor. Heavy AI use for boilerplate.
  const tfMod2 = "infra/terraform/modules/eks-node-pool/main.tf";
  const tfMod3 = "infra/terraform/modules/observability/main.tf";
  const valuesProd = "infra/charts/api/values.production.yaml";
  const valuesStage = "infra/charts/api/values.staging.yaml";
  const monitoring = "infra/charts/monitoring/values.yaml";
  const dashSh = "scripts/restore-dashboards.sh";

  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: tfMod2, language: "terraform" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 25_000, navCount: 2 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: tfMod2, concept: "spot-instance", language: "terraform" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: tfMod3, concept: "prometheus-rule", language: "terraform" });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "def-jump", fromFile: tfMod2, toFile: tf, msSinceEdit: 0 });
  tl.push({ type: "editor_navigation", ts: tl.next(8_000), kind: "find-refs", fromFile: tfMod2, toFile: tfMod, msSinceEdit: 0 });

  // AI for terraform refactor.
  tl.push({
    type: "chat_turn",
    ts: tl.next(40_000),
    intent: "specific",
    charCount: 620,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.4 });

  for (let i = 0; i < 10; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: tfMod2, charsAdded: 50 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: tfMod2, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: tfMod2, errorCount: 0 });

  for (let i = 0; i < 8; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: tfMod3, charsAdded: 60 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: tfMod3, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: tfMod3, errorCount: 0 });

  // Helm values across environments.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: valuesProd, language: "yaml" });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: valuesProd, charsAdded: 220, charsRemoved: 60 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: valuesProd, errorCount: 0 });
  tl.push({ type: "file_focus_change", ts: tl.next(8 * 60_000), file: valuesStage, language: "yaml" });
  tl.push({ type: "text_change", ts: tl.next(20_000), file: valuesStage, charsAdded: 180, charsRemoved: 40 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: valuesStage, errorCount: 0 });
  tl.push({ type: "file_focus_change", ts: tl.next(8 * 60_000), file: monitoring, language: "yaml" });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: monitoring, charsAdded: 280, charsRemoved: 60 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: monitoring, errorCount: 0 });

  // Shell script via AI.
  tl.push({
    type: "chat_turn",
    ts: tl.next(15_000),
    intent: "request",
    charCount: 300,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "iterated", source: "ai-chat-output", chars: 600 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.3 });
  tl.push({ type: "text_change", ts: tl.next(15_000), file: dashSh, charsAdded: 220, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: dashSh, errorCount: 0 });

  // Diagnostic — terraform plan complains about state drift.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(8 * 60_000), file: tfMod2, line: 42, severity: "warning", message: "state-drift: tag 'managed-by' missing on 3 nodes" });
  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "debug",
    charCount: 540,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.4 });
  tl.push({ type: "text_change", ts: tl.next(20_000), file: tfMod2, charsAdded: 30, charsRemoved: 8 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: tfMod2, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: tfMod2, line: 42, durationMs: 5 * 60_000 });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "8f9a0b1",
    message: "infra: spot pool + observability module rollout",
    filesTouched: [tfMod2, tfMod3, valuesProd, valuesStage, monitoring, dashSh],
  });

  // Day 4 — incident again, deeper diagnosis.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(20 * 60 * 60_000), file: monitoring, line: 88, severity: "error", message: "alert: api-error-rate > 5% for 10m" });
  tl.push({ type: "file_focus_change", ts: tl.next(2_000), file: monitoring, language: "yaml" });
  for (let i = 0; i < 8; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(25_000),
      kind: i % 2 === 0 ? "file-bounce" : "find-refs",
      fromFile: monitoring,
      toFile: [tf, tfMod2, valuesProd, helm][i % 4],
      msSinceEdit: 4_000,
    });
  }
  tl.push({
    type: "chat_turn",
    ts: tl.next(40_000),
    intent: "debug",
    charCount: 1_800,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "iterated", source: "ai-chat-output", chars: 1_200 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(25_000), outcome: "iterated", editFraction: 0.4 });

  // Tweak rollout config.
  for (let i = 0; i < 4; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: valuesProd, charsAdded: 30 + i * 4, charsRemoved: 12 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: valuesProd, chars: 130 });
  }
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: valuesProd, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: monitoring, line: 88, durationMs: 18 * 60_000 });

  // Update runbook with the new failure mode.
  tl.push({ type: "file_focus_change", ts: tl.next(10 * 60_000), file: runbook, language: "markdown" });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: runbook, charsAdded: 480, charsRemoved: 30 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: runbook, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: runbook, charsAdded: 280, charsRemoved: 40 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: runbook, errorCount: 0 });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "9a0b1c2",
    message: "fix(monitoring): tighten api error-rate alert window — INC-2061 follow-up",
    filesTouched: [valuesProd, runbook, monitoring],
  });

  // Day 5-6 — multiple small infra changes.
  for (let day = 0; day < 3; day++) {
    const target = [tf, tfMod3, helm][day];
    const lang = ["terraform", "terraform", "yaml"][day];
    tl.push({ type: "file_focus_change", ts: tl.next(8 * 60 * 60_000), file: target, language: lang });
    tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "skim", msToFirstEdit: 18_000, navCount: 1 });
    for (let i = 0; i < 4; i++) {
      tl.push({
        type: "editor_navigation",
        ts: tl.next(30_000),
        kind: i % 2 === 0 ? "find-refs" : "def-jump",
        fromFile: target,
        toFile: [tfMod, valuesProd, monitoring][i % 3],
        msSinceEdit: 3_000,
      });
    }
    // AI assist for shell/log/yaml.
    tl.push({
      type: "chat_turn",
      ts: tl.next(20_000),
      intent: "specific",
      charCount: 480 + day * 50,
      containsStackTraceOrLineRef: day > 0,
      containsConstraintWords: true,
      containsQuestionMark: true,
      acceptedAi: true,
    });
    tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.4 });
    for (let i = 0; i < 5; i++) {
      tl.push({ type: "text_change", ts: tl.next(40_000), file: target, charsAdded: 40 + i * 5, charsRemoved: 18 });
      tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: target, chars: 130 });
    }
    tl.push({ type: "file_saved", ts: tl.next(5_000), path: target, errorCount: 0 });
    tl.push({
      type: "commit_detected",
      ts: tl.next(10 * 60_000),
      sha: `0b1c2d${day}`,
      message: [
        "infra: bump eks version + module pin",
        "alerts: add slo burn-rate panel",
        "rollout: lower minReadySeconds for faster rollbacks",
      ][day],
      filesTouched: [target],
    });
  }

  // Quick second-day incident handling.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(10 * 60 * 60_000), file: ciYml, line: 22, severity: "error", message: "deploy job timed out — image pull rate-limited" });
  tl.push({ type: "file_focus_change", ts: tl.next(2_000), file: ciYml, language: "yaml" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_000), pattern: "skim", msToFirstEdit: 8_000, navCount: 1 });
  tl.push({
    type: "chat_turn",
    ts: tl.next(20_000),
    intent: "debug",
    charCount: 1_200,
    containsStackTraceOrLineRef: true,
    containsConstraintWords: true,
    acceptedAi: true,
  });
  tl.push({ type: "paste_outcome_observed", ts: tl.next(30_000), outcome: "iterated", source: "ai-chat-output", chars: 600 });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.4 });
  tl.push({ type: "text_change", ts: tl.next(20_000), file: ciYml, charsAdded: 60, charsRemoved: 12 });
  tl.push({ type: "file_saved", ts: tl.next(3_000), path: ciYml, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: ciYml, line: 22, durationMs: 7 * 60_000 });
  tl.push({
    type: "commit_detected",
    ts: tl.next(8 * 60_000),
    sha: "1c2d3e4",
    message: "ci: pull from internal mirror to dodge dockerhub rate limit",
    filesTouched: [ciYml],
  });

  return tl.events;
}

/* ============================================================
 * Persona 10 — Polyglot Staff (senior / generalist / ~902)
 *
 * Reads in 3 languages. Surgical AI use as peer review.
 * Pristine commits. Reviews test design across the org. PR
 * descriptions become design docs. Pulls in specialists when
 * needed. Mature multi-language codebase.
 * ============================================================ */
function polyglotStaffEvents(): EchoEvent[] {
  const tl = makeTimeline();
  const rustCore = "services/streaming/core/src/dispatcher.rs";
  const rustFFI = "services/streaming/core/src/ffi.rs";
  const tsBridge = "services/streaming/bridge/src/index.ts";
  const pyTrainer = "ml/trainers/streaming_classifier.py";
  const designDoc = "docs/design/streaming-rfc-014.md";
  const propTest = "services/streaming/core/tests/dispatcher_property_test.rs";
  const tsTest = "services/streaming/bridge/__tests__/index.test.ts";

  // Cross-language morning sweep.
  tl.push({ type: "file_focus_change", ts: tl.next(0), file: rustCore, language: "rust" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 220_000, navCount: 8 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: rustCore, concept: "tokio-runtime", language: "rust" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: rustCore, concept: "lock-free-queue", language: "rust" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: rustFFI, concept: "ffi-boundary", language: "rust" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: tsBridge, concept: "wasm-binding", language: "typescript" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: pyTrainer, concept: "online-learning", language: "python" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: pyTrainer, concept: "feature-store", language: "python" });

  for (let i = 0; i < 12; i++) {
    const targets = [rustFFI, tsBridge, pyTrainer, propTest, designDoc];
    tl.push({
      type: "editor_navigation",
      ts: tl.next(20_000),
      kind: ["def-jump", "find-refs", "symbol-search", "file-bounce"][i % 4] as "def-jump" | "find-refs" | "symbol-search" | "file-bounce",
      fromFile: rustCore,
      toFile: targets[i % targets.length],
      msSinceEdit: 4_000,
    });
  }

  // Surgical AI prompt — peer review style.
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "plan",
    charCount: 850,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(45_000), outcome: "iterated", editFraction: 0.55 });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(60_000), file: rustCore });

  tl.push({
    type: "chat_turn",
    ts: tl.next(120_000),
    intent: "specific",
    charCount: 540,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.6 });

  // Rust core edits.
  for (let i = 0; i < 12; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: rustCore, charsAdded: 50 + i * 6, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: rustCore, chars: 150 });
  }
  tl.push({ type: "file_saved", ts: tl.next(8_000), path: rustCore, errorCount: 0 });

  // Diagnostic from clippy.
  tl.push({ type: "diagnostic_appeared", ts: tl.next(2_000), file: rustCore, line: 142, severity: "warning", message: "potential ABA on the queue head pointer" });
  tl.push({ type: "editor_navigation", ts: tl.next(5_000), kind: "def-jump", fromFile: rustCore, toFile: rustCore, msSinceEdit: 2_000 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: rustCore, charsAdded: 60, charsRemoved: 25 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: rustCore, errorCount: 0 });
  tl.push({ type: "diagnostic_resolved", ts: tl.next(500), file: rustCore, line: 142, durationMs: 70_000 });

  // FFI updates.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: rustFFI, language: "rust" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 60_000, navCount: 3 });
  for (let i = 0; i < 8; i++) {
    tl.push({ type: "editor_navigation", ts: tl.next(25_000), kind: i % 2 === 0 ? "find-refs" : "def-jump", fromFile: rustFFI, toFile: i % 2 === 0 ? rustCore : tsBridge, msSinceEdit: 3_000 });
  }
  for (let i = 0; i < 8; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: rustFFI, charsAdded: 40 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: rustFFI, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: rustFFI, errorCount: 0 });

  // Property test in Rust.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: propTest, language: "rust" });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: propTest, concept: "proptest", language: "rust" });
  tl.push({ type: "text_change", ts: tl.next(45_000), file: propTest, charsAdded: 380, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: propTest, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: propTest, charsAdded: 280, charsRemoved: 40 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: propTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(15_000),
    file: propTest,
    tests: 8,
    passed: 8,
    durationMs: 22_400,
    trigger: "manual",
  });

  // TS bridge.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: tsBridge, language: "typescript" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 75_000, navCount: 4 });
  for (let i = 0; i < 8; i++) {
    tl.push({ type: "editor_navigation", ts: tl.next(25_000), kind: i % 3 === 0 ? "symbol-search" : "find-refs", fromFile: tsBridge, toFile: i % 2 === 0 ? rustFFI : tsTest, msSinceEdit: 4_000 });
  }
  for (let i = 0; i < 10; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: tsBridge, charsAdded: 50 + i * 5, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: tsBridge, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: tsBridge, errorCount: 0 });
  tl.push({ type: "text_change", ts: tl.next(30_000), file: tsTest, charsAdded: 320, charsRemoved: 30 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: tsTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: tsTest,
    tests: 14,
    passed: 14,
    durationMs: 6_400,
    trigger: "save",
  });

  // Python trainer.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: pyTrainer, language: "python" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(1_500), pattern: "deep", msToFirstEdit: 70_000, navCount: 4 });
  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: pyTrainer, charsAdded: 60 + i * 6, charsRemoved: 25 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: pyTrainer, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: pyTrainer, errorCount: 0 });

  // Design doc — PR description as design doc.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: designDoc, language: "markdown" });
  tl.push({ type: "text_change", ts: tl.next(60_000), file: designDoc, charsAdded: 1_200, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: designDoc, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(120_000), file: designDoc, charsAdded: 800, charsRemoved: 60 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: designDoc, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(90_000), file: designDoc, charsAdded: 620, charsRemoved: 80 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: designDoc, errorCount: 0 });

  // Pristine commits — atomic across language boundaries.
  tl.push({
    type: "commit_detected",
    ts: tl.next(10 * 60_000),
    sha: "8f9a0b1",
    message: "feat(streaming/core): MPSC dispatcher with backpressure — 8 property invariants, ABA-safe via hazard pointers (RFC-014)",
    filesTouched: [rustCore, propTest],
  });
  tl.push({ type: "line_diff", ts: tl.next(100), file: rustCore, linesAdded: 280, linesRemoved: 60, rewrittenFingerprints: [] });
  tl.push({ type: "line_diff", ts: tl.next(100), file: propTest, linesAdded: 380, linesRemoved: 0, rewrittenFingerprints: [] });

  tl.push({
    type: "commit_detected",
    ts: tl.next(20 * 60_000),
    sha: "9a0b1c2",
    message: "feat(streaming/bridge): TS bindings exposing dispatcher — typed errors map FFI panics to Result, contract test pins ABI",
    filesTouched: [rustFFI, tsBridge, tsTest],
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(20 * 60_000),
    sha: "0b1c2d3",
    message: "feat(streaming/trainer): online classifier integration — feature store contract honored, batch-vs-stream parity test included",
    filesTouched: [pyTrainer],
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(20 * 60_000),
    sha: "1c2d3e4",
    message: "docs(streaming): RFC-014 — design doc covering dispatch, backpressure, ABI stability, ML loop guarantees",
    filesTouched: [designDoc],
  });

  // Day 2 — review-style cycle: lots of nav, surgical AI, no big edits.
  tl.push({ type: "file_focus_change", ts: tl.next(18 * 60 * 60_000), file: rustCore, language: "rust" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 180_000, navCount: 6 });
  for (let i = 0; i < 14; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(30_000),
      kind: ["find-refs", "def-jump", "symbol-search"][i % 3] as "find-refs" | "def-jump" | "symbol-search",
      fromFile: rustCore,
      toFile: [rustFFI, tsBridge, pyTrainer, propTest][i % 4],
      msSinceEdit: 5_000,
    });
  }
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "specific",
    charCount: 480,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(30_000), outcome: "iterated", editFraction: 0.55 });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(120_000), file: rustCore });

  // Light final cleanup commit.
  for (let i = 0; i < 5; i++) {
    tl.push({ type: "text_change", ts: tl.next(60_000), file: rustCore, charsAdded: 30 + i * 4, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: rustCore, chars: 120 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: rustCore, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(15_000),
    file: propTest,
    tests: 8,
    passed: 8,
    durationMs: 23_100,
    trigger: "save",
  });
  tl.push({
    type: "test_run_result",
    ts: tl.next(5_000),
    file: tsTest,
    tests: 14,
    passed: 14,
    durationMs: 6_500,
    trigger: "save",
  });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "2d3e4f5",
    message: "refactor(streaming/core): collapse two backpressure paths into one policy — preserves invariants, reduces branching at hot loop",
    filesTouched: [rustCore],
  });

  // Day 3 — cross-team mentorship cycle. Reads code in 3 languages.
  const embeddedRs = "firmware/sensor-bridge/src/main.rs";
  const goSvc = "services/api-gateway/handlers/streaming.go";
  const goTest = "services/api-gateway/handlers/streaming_test.go";
  const sharedSchema = "schemas/streaming.proto";
  const adr = "docs/adr/0024-streaming-protocol.md";

  // Reads embedded code.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60 * 60_000), file: embeddedRs, language: "rust" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 200_000, navCount: 7 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: embeddedRs, concept: "no-std-runtime", language: "rust" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: embeddedRs, concept: "interrupt-handler", language: "rust" });
  for (let i = 0; i < 8; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(25_000),
      kind: i % 2 === 0 ? "def-jump" : "symbol-search",
      fromFile: embeddedRs,
      toFile: i % 2 === 0 ? rustCore : sharedSchema,
      msSinceEdit: 5_000,
    });
  }

  // Reads Go.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: goSvc, language: "go" });
  tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 120_000, navCount: 5 });
  tl.push({ type: "concept_encountered", ts: tl.next(1_000), file: goSvc, concept: "grpc-streaming", language: "go" });
  tl.push({ type: "concept_encountered", ts: tl.next(500), file: goSvc, concept: "context-cancellation", language: "go" });
  for (let i = 0; i < 8; i++) {
    tl.push({
      type: "editor_navigation",
      ts: tl.next(25_000),
      kind: i % 3 === 0 ? "find-refs" : "def-jump",
      fromFile: goSvc,
      toFile: i % 2 === 0 ? sharedSchema : goTest,
      msSinceEdit: 5_000,
    });
  }

  // Surgical AI prompt comparing Go vs Rust handling of cancellation across the schema boundary.
  tl.push({
    type: "chat_turn",
    ts: tl.next(60_000),
    intent: "plan",
    charCount: 920,
    containsStackTraceOrLineRef: false,
    containsConstraintWords: true,
    containsQuestionMark: true,
    acceptedAi: true,
  });
  tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(40_000), outcome: "iterated", editFraction: 0.55 });
  tl.push({ type: "ai_suggestion_rejected", ts: tl.next(180_000), file: goSvc });

  // Implements unified protocol changes.
  tl.push({ type: "file_focus_change", ts: tl.next(15 * 60_000), file: sharedSchema, language: "proto" });
  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(40_000), file: sharedSchema, charsAdded: 60 + i * 6, charsRemoved: 18 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: sharedSchema, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: sharedSchema, errorCount: 0 });

  // Update Go side.
  for (let i = 0; i < 12; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: goSvc, charsAdded: 50 + i * 5, charsRemoved: 22 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: goSvc, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: goSvc, errorCount: 0 });
  tl.push({ type: "text_change", ts: tl.next(40_000), file: goTest, charsAdded: 380, charsRemoved: 60 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: goTest, errorCount: 0 });
  tl.push({
    type: "test_run_result",
    ts: tl.next(8_000),
    file: goTest,
    tests: 12,
    passed: 12,
    durationMs: 6_400,
    trigger: "save",
  });

  // Update Rust side.
  for (let i = 0; i < 10; i++) {
    tl.push({ type: "text_change", ts: tl.next(45_000), file: rustCore, charsAdded: 50 + i * 5, charsRemoved: 25 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: rustCore, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: rustCore, errorCount: 0 });

  for (let i = 0; i < 6; i++) {
    tl.push({ type: "text_change", ts: tl.next(50_000), file: embeddedRs, charsAdded: 50 + i * 5, charsRemoved: 20 });
    tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: embeddedRs, chars: 140 });
  }
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: embeddedRs, errorCount: 0 });

  // Reruns property tests.
  tl.push({
    type: "test_run_result",
    ts: tl.next(15_000),
    file: propTest,
    tests: 8,
    passed: 8,
    durationMs: 23_400,
    trigger: "save",
  });

  // ADR write.
  tl.push({ type: "file_focus_change", ts: tl.next(20 * 60_000), file: adr, language: "markdown" });
  tl.push({ type: "text_change", ts: tl.next(120_000), file: adr, charsAdded: 1_400, charsRemoved: 0 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: adr, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(120_000), file: adr, charsAdded: 920, charsRemoved: 80 });
  tl.push({ type: "keystroke_burst", ts: tl.next(8_000), file: adr, chars: 200 });
  tl.push({ type: "text_change", ts: tl.next(80_000), file: adr, charsAdded: 540, charsRemoved: 60 });
  tl.push({ type: "file_saved", ts: tl.next(5_000), path: adr, errorCount: 0 });

  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "3e4f506",
    message: "feat(streaming): unify cancellation semantics across embedded/go/rust — schema is now source of truth, all sides honor deadline propagation",
    filesTouched: [sharedSchema, goSvc, goTest, rustCore, embeddedRs],
  });
  tl.push({
    type: "commit_detected",
    ts: tl.next(15 * 60_000),
    sha: "4f50607",
    message: "docs(adr): ADR-0024 — streaming protocol cancellation. Captures tradeoff vs the per-language ad-hoc approach we had before",
    filesTouched: [adr],
  });

  // Day 4 — review-heavy day. Surgical small commits.
  for (let day4 = 0; day4 < 3; day4++) {
    tl.push({ type: "file_focus_change", ts: tl.next(8 * 60 * 60_000), file: [rustCore, goSvc, pyTrainer][day4], language: ["rust", "go", "python"][day4] });
    tl.push({ type: "read_pattern_observed", ts: tl.next(2_000), pattern: "deep", msToFirstEdit: 90_000, navCount: 4 });
    for (let i = 0; i < 6; i++) {
      tl.push({
        type: "editor_navigation",
        ts: tl.next(30_000),
        kind: i % 2 === 0 ? "find-refs" : "def-jump",
        fromFile: [rustCore, goSvc, pyTrainer][day4],
        toFile: [propTest, goTest, tsTest][day4],
        msSinceEdit: 5_000,
      });
    }
    tl.push({
      type: "chat_turn",
      ts: tl.next(40_000),
      intent: "specific",
      charCount: 380 + day4 * 40,
      containsStackTraceOrLineRef: false,
      containsConstraintWords: true,
      containsQuestionMark: true,
      acceptedAi: true,
    });
    tl.push({ type: "ai_accept_outcome_observed", ts: tl.next(20_000), outcome: "iterated", editFraction: 0.5 });
    for (let i = 0; i < 5; i++) {
      tl.push({ type: "text_change", ts: tl.next(40_000), file: [rustCore, goSvc, pyTrainer][day4], charsAdded: 30 + i * 4, charsRemoved: 18 });
      tl.push({ type: "keystroke_burst", ts: tl.next(5_000), file: [rustCore, goSvc, pyTrainer][day4], chars: 130 });
    }
    tl.push({ type: "file_saved", ts: tl.next(5_000), path: [rustCore, goSvc, pyTrainer][day4], errorCount: 0 });
    tl.push({
      type: "test_run_result",
      ts: tl.next(8_000),
      file: [propTest, goTest, tsTest][day4],
      tests: 8 + day4,
      passed: 8 + day4,
      durationMs: 8_000 + day4 * 2_000,
      trigger: "save",
    });
    tl.push({
      type: "commit_detected",
      ts: tl.next(10 * 60_000),
      sha: `5060708${day4}`,
      message: ["refactor(streaming/core): inline hot path branch — measured 4% throughput improvement, no semantic change",
                "fix(api-gateway): preserve grpc deadline through middleware chain — found via context-leak audit",
                "refactor(ml/trainer): consolidate sampler config — single source of truth for batch+stream paths"][day4],
      filesTouched: [[rustCore], [goSvc, goTest], [pyTrainer]][day4],
    });
  }

  return tl.events;
}

/* ============================================================
 * V2 PERSONAS — author A
 * ============================================================ */

const HEADLINE_RANGE = (target: number): [number, number] => [target - 50, target + 50];

export const V2_PERSONAS: Persona[] = [
  {
    id: "v2A:bootcampGrad",
    description: "Bootcamp grad in month 2 — earnest, AI-leaning, sparse activity",
    field: {
      repoSignals: {
        packageJsonDeps: ["react", "react-dom", "react-router-dom", "axios", "tailwindcss", "vite"],
        fileExtensions: { ".jsx": 30, ".js": 20, ".css": 8, ".html": 4 },
      },
      conceptCounts: { "concept:react-hook": 3, "concept:javascript": 5 },
      selfDeclared: "web" as Iq3FieldId,
    },
    events: bootcampGradEvents,
    expect: {
      rank: "learner",
      dominantField: "web",
      headlineRange: HEADLINE_RANGE(225),
    },
  },
  {
    id: "v2A:earnestJunior",
    description: "Earnest junior, year 2 — paragraphs of context, follow-ups, conventional commits",
    field: {
      repoSignals: {
        packageJsonDeps: ["express", "react", "next", "prisma", "vitest", "zod"],
        fileExtensions: { ".ts": 60, ".tsx": 25, ".css": 6, ".sql": 4 },
      },
      conceptCounts: { "concept:express-route": 4, "concept:postgres-query": 6 },
      selfDeclared: "web" as Iq3FieldId,
    },
    events: earnestJuniorEvents,
    expect: {
      rank: "junior",
      dominantField: "web",
      headlineRange: HEADLINE_RANGE(570),
    },
  },
  {
    id: "v2A:vibecoder",
    description: "Vibecoder — 80% AI output, 'make this work' prompts, mixed-concern PRs, reverts",
    field: {
      repoSignals: {
        packageJsonDeps: ["react", "next", "tailwindcss", "vite", "@tanstack/react-query"],
        fileExtensions: { ".tsx": 35, ".ts": 25, ".css": 6 },
      },
      conceptCounts: { "concept:react-hook": 8 },
      selfDeclared: "web" as Iq3FieldId,
    },
    events: vibecoderEvents,
    expect: {
      rank: "learner",
      dominantField: "web",
      headlineRange: HEADLINE_RANGE(254),
    },
  },
  {
    id: "v2A:pragmaticMid",
    description: "Pragmatic mid — TS/Postgres/AWS, failing-test-first, atomic conventional commits",
    field: {
      repoSignals: {
        packageJsonDeps: ["express", "@nestjs/core", "prisma", "vitest", "supertest", "zod", "aws-sdk"],
        fileExtensions: { ".ts": 90, ".sql": 6, ".yaml": 4 },
      },
      conceptCounts: {
        "concept:postgres-transaction": 5,
        "concept:stripe-webhook": 3,
        "concept:zod-schema": 4,
      },
      selfDeclared: "web" as Iq3FieldId,
    },
    events: pragmaticMidEvents,
    expect: {
      rank: "mid",
      dominantField: "web",
      headlineRange: HEADLINE_RANGE(708),
    },
  },
  {
    id: "v2A:mlResearcher",
    description: "ML researcher — tensor-shape tracing, rare AI use, property tests, batched commits",
    field: {
      repoSignals: {
        requirementsTxt: ["torch", "transformers", "datasets", "numpy", "pandas", "hypothesis", "pytest", "wandb", "matplotlib"],
        fileExtensions: { ".py": 90, ".ipynb": 25, ".yaml": 6 },
      },
      conceptCounts: {
        "concept:self-attention": 4,
        "concept:tensor-reshape": 6,
        "concept:property-test": 3,
        "concept:hypothesis-strategy": 2,
      },
      selfDeclared: "ml" as Iq3FieldId,
    },
    events: mlResearcherEvents,
    expect: {
      rank: "mid",
      dominantField: "ml",
      headlineRange: HEADLINE_RANGE(646),
    },
  },
  {
    id: "v2A:mobileMid",
    description: "Mobile mid — iOS-primary, snapshot tests, AI for boilerplate, atomic commits",
    field: {
      repoSignals: {
        fileExtensions: { ".swift": 120, ".plist": 4, ".storyboard": 2, ".xcconfig": 3 },
      },
      conceptCounts: {
        "concept:swiftui-view": 8,
        "concept:combine-publisher": 4,
        "concept:async-await": 6,
        "concept:snapshot-test": 3,
      },
      selfDeclared: "mobile" as Iq3FieldId,
    },
    events: mobileMidEvents,
    expect: {
      rank: "mid",
      dominantField: "mobile",
      headlineRange: HEADLINE_RANGE(705),
    },
  },
  {
    id: "v2A:seniorBackend",
    description: "Senior backend architect — payments, distributed systems, runbooks, atomic commits with WHY",
    field: {
      repoSignals: {
        packageJsonDeps: ["express", "@nestjs/core", "prisma", "fast-check", "vitest", "pact-foundation", "kafkajs", "ioredis"],
        fileExtensions: { ".ts": 150, ".sql": 12, ".yaml": 8, ".md": 12 },
      },
      conceptCounts: {
        "concept:saga-pattern": 4,
        "concept:idempotency-key": 6,
        "concept:outbox-pattern": 3,
        "concept:postgres-isolation": 5,
        "concept:fast-check": 4,
      },
      selfDeclared: "web" as Iq3FieldId,
    },
    events: seniorBackendEvents,
    expect: {
      rank: "senior",
      uncappedRank: "senior",
      dominantField: "web",
      headlineRange: HEADLINE_RANGE(841),
    },
  },
  {
    id: "v2A:seniorSecurity",
    description: "Senior security engineer — refuses AI, adversarial reading, fuzz + negative tests, threat-model commits",
    field: {
      repoSignals: {
        packageJsonDeps: ["express", "jsonwebtoken", "helmet", "csurf", "argon2", "zod", "vitest"],
        fileExtensions: { ".ts": 120, ".md": 18, ".yaml": 6 },
      },
      conceptCounts: {
        "concept:jwt-claims": 4,
        "concept:alg-confusion-attack": 2,
        "concept:trust-boundary": 5,
        "concept:csrf-token": 3,
        "concept:input-validation": 8,
        "concept:fuzz-harness": 2,
      },
      selfDeclared: "sec" as Iq3FieldId,
    },
    events: seniorSecurityEvents,
    expect: {
      rank: "senior",
      uncappedRank: "senior",
      dominantField: "sec",
      headlineRange: HEADLINE_RANGE(739),
    },
  },
  {
    id: "v2A:seniorDevops",
    description: "Senior devops — Terraform/k8s, AI-confident for shell/log, thin tests, runbooks > commit msgs",
    field: {
      repoSignals: {
        infraFiles: [
          "infra/terraform/eks-cluster.tf",
          "infra/terraform/modules/ingress/main.tf",
          "infra/charts/api/values.yaml",
          ".github/workflows/deploy.yml",
          "services/api/Dockerfile",
          "k8s/manifests/api-deployment.yaml",
        ],
        fileExtensions: { ".tf": 30, ".yaml": 28, ".yml": 12, ".sh": 14, ".md": 10 },
      },
      conceptCounts: {
        "concept:terraform-module": 6,
        "concept:kubernetes-ingress": 4,
        "concept:iam-role": 5,
      },
      selfDeclared: "devOps" as Iq3FieldId,
    },
    events: seniorDevopsEvents,
    expect: {
      rank: "senior",
      uncappedRank: "senior",
      dominantField: "devOps",
      headlineRange: HEADLINE_RANGE(733),
    },
  },
  {
    id: "v2A:polyglotStaff",
    description: "Polyglot staff — 3 languages on a typical day, surgical AI, design-doc PRs, reviews test design",
    field: {
      repoSignals: {
        cargoToml: ["tokio", "crossbeam", "proptest", "serde"],
        packageJsonDeps: ["typescript", "vitest", "wasm-bindgen"],
        requirementsTxt: ["torch", "scikit-learn", "feast", "pytest"],
        fileExtensions: { ".rs": 40, ".ts": 35, ".py": 30, ".md": 16 },
      },
      conceptCounts: {
        "concept:tokio-runtime": 5,
        "concept:lock-free-queue": 3,
        "concept:ffi-boundary": 4,
        "concept:wasm-binding": 3,
        "concept:online-learning": 3,
        "concept:feature-store": 2,
        "concept:proptest": 3,
      },
      selfDeclared: "generalist" as Iq3FieldId,
    },
    events: polyglotStaffEvents,
    expect: {
      rank: "senior",
      uncappedRank: "senior",
      dominantField: "generalist",
      headlineRange: HEADLINE_RANGE(902),
    },
  },
];
