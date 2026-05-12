/**
 * v2-streams-B — independent stream-author B's calibration personas.
 *
 * Companion to `v2-streams-A`. Same brief, no peeking. Each persona is
 * authored from the behavioral signature in `personas-blind.md`, using
 * the FULL post-Iq3 event vocabulary (read_pattern_observed,
 * editor_navigation, text_change, keystroke_batch, file_saved,
 * file_focus_change, chat_turn, paste_outcome_observed,
 * ai_accept_outcome_observed, ai_suggestion_rejected,
 * diagnostic_appeared, diagnostic_resolved, test_run_result,
 * commit_detected, line_diff, concept_encountered).
 *
 * Determinism: every events() call is pure — single base timestamp +
 * monotonic counter. Same input → same array.
 */

import type { EchoEvent, Iq3FieldId } from "@protege/types";
import type { Persona } from "../runPersona.js";

const t0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Monotonic timestamp factory used inside each persona's events() builder. */
function makeClock(start: number = t0) {
  let t = start;
  return (deltaMs: number): number => {
    t += deltaMs;
    return t;
  };
}

/** No-op fingerprint factory for line_diff events. We don't need real
 *  fingerprints for stream synthesis — empty array satisfies the schema. */
function noFingerprints(): Array<{
  fingerprint: string;
  roughLine: number;
  contentHash: string;
  sampleContent?: string;
}> {
  return [];
}

// ---------------------------------------------------------------------------
// Persona 1 — Bootcamp Grad (learner / web / ~225)
// Behavior: jump-in reads, vague AI prompts, kept-as-is pastes, "fix" commits,
// missing tests, no methodical debugging.
// ---------------------------------------------------------------------------
function bootcampGradEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/components/UserCard.tsx", language: "typescriptreact" });

  // Opens unfamiliar file → jumps in, no nav
  ev.push({ type: "read_pattern_observed", ts: next(3_500), pattern: "jump-in", msToFirstEdit: 3_500, navCount: 0 });
  ev.push({ type: "text_change", ts: next(500), file: "src/components/UserCard.tsx", charsAdded: 12, charsRemoved: 0 });

  // Gets confused, asks AI to "explain this file" — vague, huge paste
  ev.push({ type: "chat_turn", ts: next(45_000), intent: "vague", charCount: 1850, containsStackTraceOrLineRef: false, containsConstraintWords: false, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(10_000), file: "src/components/UserCard.tsx", source: "ai-chat-output", chars: 620 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 620 });
  ev.push({ type: "ai_suggestion_accepted", ts: next(5_000), file: "src/components/UserCard.tsx", chars: 620, charsAccepted: 620 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "no-edit", editFraction: 0.0 });

  // Save with errors — doesn't notice
  ev.push({ type: "file_saved", ts: next(8_000), path: "src/components/UserCard.tsx", errorCount: 3 });
  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "src/components/UserCard.tsx", line: 22, severity: "error", message: "Cannot find name 'props'." });
  ev.push({ type: "diagnostic_appeared", ts: next(100), file: "src/components/UserCard.tsx", line: 28, severity: "error", message: "JSX expression expected." });

  // Asks AI again — pastes the whole error
  ev.push({ type: "chat_turn", ts: next(120_000), intent: "vague", charCount: 2100, containsStackTraceOrLineRef: true, containsConstraintWords: false, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(15_000), file: "src/components/UserCard.tsx", source: "ai-chat-output", chars: 480 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 480 });
  ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: "src/components/UserCard.tsx", chars: 480, charsAccepted: 480 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "no-edit", editFraction: 0.0 });

  ev.push({ type: "file_saved", ts: next(5_000), path: "src/components/UserCard.tsx", errorCount: 1 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/components/UserCard.tsx", line: 22, durationMs: 145_000 });

  // useEffect file
  ev.push({ type: "file_focus_change", ts: next(60_000), file: "src/hooks/useFetchUser.ts", language: "typescript" });
  ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "jump-in", msToFirstEdit: 4_000, navCount: 0 });
  ev.push({ type: "text_change", ts: next(1_000), file: "src/hooks/useFetchUser.ts", charsAdded: 30, charsRemoved: 5 });
  ev.push({ type: "keystroke_burst", ts: next(2_000), file: "src/hooks/useFetchUser.ts", chars: 60 });

  // useEffect ran twice — confusion → AI
  ev.push({ type: "chat_turn", ts: next(90_000), intent: "vague", charCount: 1600, containsStackTraceOrLineRef: false, containsConstraintWords: false, containsQuestionMark: true, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(10_000), file: "src/hooks/useFetchUser.ts", source: "ai-chat-output", chars: 340 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 340 });

  ev.push({ type: "file_saved", ts: next(5_000), path: "src/hooks/useFetchUser.ts", errorCount: 0 });

  // Test that asserts existence
  ev.push({ type: "file_focus_change", ts: next(120_000), file: "src/hooks/useFetchUser.test.ts", language: "typescript" });
  ev.push({ type: "read_pattern_observed", ts: next(2_000), pattern: "jump-in", msToFirstEdit: 2_000, navCount: 0 });
  ev.push({ type: "chat_turn", ts: next(20_000), intent: "vague", charCount: 800, containsStackTraceOrLineRef: false, containsConstraintWords: false, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(8_000), file: "src/hooks/useFetchUser.test.ts", source: "ai-chat-output", chars: 280 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 280 });
  ev.push({ type: "file_saved", ts: next(5_000), path: "src/hooks/useFetchUser.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(8_000), file: "src/hooks/useFetchUser.test.ts", tests: 1, passed: 1, durationMs: 1200, trigger: "manual" });

  // Concepts encountered (basic web)
  ev.push({ type: "concept_encountered", ts: next(60_000), file: "src/components/UserCard.tsx", concept: "react/useState", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(1_000), file: "src/hooks/useFetchUser.ts", concept: "react/useEffect", language: "typescript" });

  // Commits — sloppy
  ev.push({ type: "line_diff", ts: next(120_000), file: "src/components/UserCard.tsx", linesAdded: 14, linesRemoved: 3, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "b1g1", message: "fix", filesTouched: ["src/components/UserCard.tsx"] });
  ev.push({ type: "line_diff", ts: next(300_000), file: "src/hooks/useFetchUser.ts", linesAdded: 8, linesRemoved: 2, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "b1g2", message: "wip", filesTouched: ["src/hooks/useFetchUser.ts"] });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "b1g3", message: "fix again", filesTouched: ["src/hooks/useFetchUser.ts"] });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "b1g4", message: "actual fix", filesTouched: ["src/hooks/useFetchUser.ts", "src/hooks/useFetchUser.test.ts"] });

  // Day 2 — another small ticket, same pattern
  ev.push({ type: "session_boundary", ts: next(60_000), kind: "end", reason: "idle", activeMs: 1_800_000 });
  ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });

  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/components/ProductList.tsx", language: "typescriptreact" });
  ev.push({ type: "read_pattern_observed", ts: next(2_500), pattern: "jump-in", msToFirstEdit: 2_500, navCount: 0 });
  ev.push({ type: "chat_turn", ts: next(20_000), intent: "vague", charCount: 1700, containsStackTraceOrLineRef: false, containsConstraintWords: false, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(8_000), file: "src/components/ProductList.tsx", source: "ai-chat-output", chars: 720 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 720 });
  ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: "src/components/ProductList.tsx", chars: 720, charsAccepted: 720 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "no-edit", editFraction: 0.0 });
  ev.push({ type: "file_saved", ts: next(3_000), path: "src/components/ProductList.tsx", errorCount: 1 });
  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "src/components/ProductList.tsx", line: 18, severity: "error", message: "Type 'unknown' is not assignable to type 'Product'." });
  ev.push({ type: "chat_turn", ts: next(60_000), intent: "vague", charCount: 1900, containsStackTraceOrLineRef: true, containsConstraintWords: false, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(6_000), file: "src/components/ProductList.tsx", source: "ai-chat-output", chars: 380 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 380 });
  ev.push({ type: "file_saved", ts: next(3_000), path: "src/components/ProductList.tsx", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/components/ProductList.tsx", line: 18, durationMs: 90_000 });

  // Asks teammate after AI fails — no event for that, just pattern continues
  ev.push({ type: "file_focus_change", ts: next(120_000), file: "src/api/fetchProducts.ts", language: "typescript" });
  ev.push({ type: "read_pattern_observed", ts: next(2_000), pattern: "jump-in", msToFirstEdit: 2_000, navCount: 0 });
  ev.push({ type: "text_change", ts: next(15_000), file: "src/api/fetchProducts.ts", charsAdded: 14, charsRemoved: 4 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/api/fetchProducts.ts", errorCount: 0 });

  ev.push({ type: "concept_encountered", ts: next(20_000), file: "src/components/ProductList.tsx", concept: "react/useEffect", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/api/fetchProducts.ts", concept: "fetch/json", language: "typescript" });

  ev.push({ type: "line_diff", ts: next(60_000), file: "src/components/ProductList.tsx", linesAdded: 28, linesRemoved: 4, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "b1g5", message: "fix", filesTouched: ["src/components/ProductList.tsx", "src/api/fetchProducts.ts"] });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "b1g6", message: "wip — squash later", filesTouched: ["src/components/ProductList.tsx"] });

  ev.push({ type: "session_boundary", ts: next(60_000), kind: "end", reason: "idle", activeMs: 1_400_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// Persona 2 — Earnest Junior (junior / web / ~570)
// Behavior: skim+deep reads, def-jumps, paragraph AI prompts, iterates,
// happy-path tests, conventional commits.
// ---------------------------------------------------------------------------
function earnestJuniorEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });

  // Day 1: explore unfamiliar feature
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/server/routes/orders.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: "src/server/routes/orders.ts", toFile: "src/server/routes/orders.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(12_000), kind: "def-jump", fromFile: "src/server/routes/orders.ts", toFile: "src/server/services/orderService.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(6_000), kind: "find-refs", fromFile: "src/server/services/orderService.ts", toFile: "src/server/services/orderService.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "deep", msToFirstEdit: 35_000, navCount: 3 });

  ev.push({ type: "file_focus_change", ts: next(10_000), file: "src/server/services/orderService.test.ts", language: "typescript" });
  ev.push({ type: "read_pattern_observed", ts: next(20_000), pattern: "skim", msToFirstEdit: 18_000, navCount: 1 });

  // Thoughtful AI prompt
  ev.push({ type: "chat_turn", ts: next(90_000), intent: "plan", charCount: 540, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(5_000), file: "src/server/services/orderService.ts", source: "ai-chat-output", chars: 380 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "iterated", source: "ai-chat-output", chars: 380 });
  ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: "src/server/services/orderService.ts", chars: 380, charsAccepted: 380 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.35 });

  // Edits with idle gap (thinking)
  ev.push({ type: "text_change", ts: next(45_000), file: "src/server/services/orderService.ts", charsAdded: 80, charsRemoved: 12 });
  ev.push({ type: "keystroke_burst", ts: next(8_000), file: "src/server/services/orderService.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(20_000), file: "src/server/services/orderService.ts", charsAdded: 40, charsRemoved: 5 });
  ev.push({ type: "file_saved", ts: next(3_000), path: "src/server/services/orderService.ts", errorCount: 1 });

  // Diagnostic appears, junior reads, fixes
  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "src/server/services/orderService.ts", line: 64, severity: "error", message: "Argument of type 'string | undefined'..." });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "def-jump", fromFile: "src/server/services/orderService.ts", toFile: "src/server/types/order.ts", msSinceEdit: 5_000 });
  ev.push({ type: "text_change", ts: next(20_000), file: "src/server/services/orderService.ts", charsAdded: 18, charsRemoved: 6 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/server/services/orderService.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/server/services/orderService.ts", line: 64, durationMs: 38_000 });

  // Tests on save
  ev.push({ type: "file_focus_change", ts: next(20_000), file: "src/server/services/orderService.test.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/server/services/orderService.test.ts", charsAdded: 240, charsRemoved: 30 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "src/server/services/orderService.test.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(40_000), file: "src/server/services/orderService.test.ts", charsAdded: 160, charsRemoved: 8 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/server/services/orderService.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(800), file: "src/server/services/orderService.test.ts", tests: 6, passed: 6, durationMs: 850, trigger: "save" });
  ev.push({ type: "test_run_result", ts: next(120_000), file: "src/server/services/orderService.test.ts", tests: 6, passed: 6, durationMs: 820, trigger: "manual" });

  // A second feature next morning
  ev.push({ type: "session_boundary", ts: next(45_000_000), kind: "end", reason: "idle", activeMs: 7_200_000 });
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "start", reason: "fresh-start" });

  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/web/pages/checkout.tsx", language: "typescriptreact" });
  ev.push({ type: "editor_navigation", ts: next(10_000), kind: "symbol-search", fromFile: "src/web/pages/checkout.tsx", toFile: "src/web/pages/checkout.tsx", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(5_000), kind: "def-jump", fromFile: "src/web/pages/checkout.tsx", toFile: "src/web/components/CartItem.tsx", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(8_000), pattern: "skim", msToFirstEdit: 22_000, navCount: 2 });

  ev.push({ type: "chat_turn", ts: next(60_000), intent: "specific", charCount: 410, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: false });
  ev.push({ type: "ai_suggestion_rejected", ts: next(6_000), file: "src/web/pages/checkout.tsx" });
  ev.push({ type: "chat_turn", ts: next(30_000), intent: "specific", charCount: 480, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: true });
  ev.push({ type: "paste_outcome_observed", ts: next(70_000), outcome: "iterated", source: "ai-chat-output", chars: 320 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.42 });

  ev.push({ type: "text_change", ts: next(40_000), file: "src/web/pages/checkout.tsx", charsAdded: 100, charsRemoved: 30 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "src/web/pages/checkout.tsx", chars: 200 });
  ev.push({ type: "file_saved", ts: next(3_000), path: "src/web/pages/checkout.tsx", errorCount: 0 });

  ev.push({ type: "file_focus_change", ts: next(30_000), file: "src/web/pages/__tests__/checkout.test.tsx", language: "typescriptreact" });
  ev.push({ type: "text_change", ts: next(120_000), file: "src/web/pages/__tests__/checkout.test.tsx", charsAdded: 380, charsRemoved: 0 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "src/web/pages/__tests__/checkout.test.tsx", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/web/pages/__tests__/checkout.test.tsx", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(700), file: "src/web/pages/__tests__/checkout.test.tsx", tests: 4, passed: 4, durationMs: 600, trigger: "save" });

  // Concepts
  ev.push({ type: "concept_encountered", ts: next(30_000), file: "src/server/services/orderService.ts", concept: "express/router", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(1_000), file: "src/server/services/orderService.ts", concept: "zod/schema", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(1_000), file: "src/web/pages/checkout.tsx", concept: "react/useState", language: "typescript" });

  // Commits — conventional
  ev.push({ type: "line_diff", ts: next(60_000), file: "src/server/services/orderService.ts", linesAdded: 32, linesRemoved: 8, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "ej1", message: "feat(orders): validate cart line items before persisting", filesTouched: ["src/server/services/orderService.ts", "src/server/services/orderService.test.ts"] });
  ev.push({ type: "line_diff", ts: next(2_000_000), file: "src/web/pages/checkout.tsx", linesAdded: 48, linesRemoved: 12, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "ej2", message: "feat(checkout): show line totals with tax breakdown", filesTouched: ["src/web/pages/checkout.tsx", "src/web/pages/__tests__/checkout.test.tsx"] });
  ev.push({ type: "commit_detected", ts: next(1_500_000), sha: "ej3", message: "chore: address review — extract formatTaxCents helper", filesTouched: ["src/web/utils/formatTaxCents.ts", "src/web/pages/checkout.tsx"] });

  // Day-3 small bug + repro
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 6_500_000 });
  ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/server/services/orderService.ts", language: "typescript" });
  ev.push({ type: "read_pattern_observed", ts: next(8_000), pattern: "skim", msToFirstEdit: 12_000, navCount: 1 });
  ev.push({ type: "diagnostic_appeared", ts: next(20_000), file: "src/server/services/orderService.ts", line: 102, severity: "warning", message: "'amount' is possibly NaN" });
  ev.push({ type: "chat_turn", ts: next(45_000), intent: "debug", charCount: 380, containsStackTraceOrLineRef: true, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.28 });
  ev.push({ type: "text_change", ts: next(20_000), file: "src/server/services/orderService.ts", charsAdded: 14, charsRemoved: 4 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/server/services/orderService.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/server/services/orderService.ts", line: 102, durationMs: 95_000 });
  ev.push({ type: "test_run_result", ts: next(1_000), file: "src/server/services/orderService.test.ts", tests: 7, passed: 7, durationMs: 920, trigger: "save" });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "ej4", message: "fix(orders): coerce amount to integer cents before sum", filesTouched: ["src/server/services/orderService.ts", "src/server/services/orderService.test.ts"] });

  // Days 4–7 — sustained junior-level cadence: small features, careful tests
  for (let day = 0; day < 4; day++) {
    ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 4_300_000 });
    ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });

    const featFile = `src/server/routes/${["coupons", "shipping", "addresses", "wishlist"][day]}.ts`;
    const testFile = `src/server/routes/${["coupons", "shipping", "addresses", "wishlist"][day]}.test.ts`;

    ev.push({ type: "file_focus_change", ts: next(2_000), file: featFile, language: "typescript" });
    ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: featFile, toFile: featFile, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(6_000), kind: "def-jump", fromFile: featFile, toFile: "src/server/db/schema.ts", msSinceEdit: 0 });
    ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "skim", msToFirstEdit: 26_000, navCount: 2 });

    ev.push({ type: "chat_turn", ts: next(60_000), intent: "specific", charCount: 420 + day * 20, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: true });
    ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.40 });

    ev.push({ type: "text_change", ts: next(45_000), file: featFile, charsAdded: 100, charsRemoved: 18 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: featFile, chars: 200 });
    ev.push({ type: "file_saved", ts: next(2_000), path: featFile, errorCount: day === 1 ? 1 : 0 });

    if (day === 1) {
      ev.push({ type: "diagnostic_appeared", ts: next(500), file: featFile, line: 38, severity: "error", message: "Property 'rate' does not exist on type 'ShippingZone'." });
      ev.push({ type: "editor_navigation", ts: next(15_000), kind: "def-jump", fromFile: featFile, toFile: "src/server/db/schema.ts", msSinceEdit: 5_000 });
      ev.push({ type: "text_change", ts: next(20_000), file: featFile, charsAdded: 14, charsRemoved: 6 });
      ev.push({ type: "file_saved", ts: next(2_000), path: featFile, errorCount: 0 });
      ev.push({ type: "diagnostic_resolved", ts: next(100), file: featFile, line: 38, durationMs: 38_000 });
    }

    ev.push({ type: "text_change", ts: next(80_000), file: testFile, charsAdded: 280, charsRemoved: 0 });
    ev.push({ type: "file_saved", ts: next(2_000), path: testFile, errorCount: 0 });
    ev.push({ type: "test_run_result", ts: next(800), file: testFile, tests: 4 + day, passed: 4 + day, durationMs: 850, trigger: "save" });

    ev.push({ type: "concept_encountered", ts: next(60_000), file: featFile, concept: "express/router", language: "typescript" });
    ev.push({ type: "concept_encountered", ts: next(500), file: featFile, concept: "zod/schema", language: "typescript" });

    ev.push({ type: "line_diff", ts: next(60_000), file: featFile, linesAdded: 28, linesRemoved: 6, rewrittenFingerprints: noFingerprints() });
    ev.push({ type: "commit_detected", ts: next(1_000), sha: `ej${5 + day}`, message: `feat(${["coupons", "shipping", "addresses", "wishlist"][day]}): ${["validate code+expiry+usage cap", "rate lookup by zone with zod input check", "soft-delete addresses keep order history intact", "idempotent add-to-wishlist"][day]}`, filesTouched: [featFile, testFile] });
  }

  ev.push({ type: "session_boundary", ts: next(120_000), kind: "end", reason: "idle", activeMs: 4_300_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// Persona 3 — Vibecoder (learner / web / ~254)
// Behavior: paste-the-whole-file vague prompts, "make this work", ai writes
// tests, kept-as-is, mixed-concern AI commit messages, reverts.
// ---------------------------------------------------------------------------
function vibecoderEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });

  // Opens unfamiliar file → pastes whole thing into AI
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/features/dashboard/Dashboard.tsx", language: "typescriptreact" });
  ev.push({ type: "read_pattern_observed", ts: next(2_500), pattern: "jump-in", msToFirstEdit: 2_500, navCount: 0 });

  // Vague terse prompts
  ev.push({ type: "chat_turn", ts: next(10_000), intent: "vague", charCount: 2400, containsStackTraceOrLineRef: false, containsConstraintWords: false, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(8_000), file: "src/features/dashboard/Dashboard.tsx", source: "ai-chat-output", chars: 1800 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1800 });
  ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: "src/features/dashboard/Dashboard.tsx", chars: 1800, charsAccepted: 1800 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "no-edit", editFraction: 0.0 });
  ev.push({ type: "file_saved", ts: next(3_000), path: "src/features/dashboard/Dashboard.tsx", errorCount: 0 });

  // Make it work — re-prompt cycle
  ev.push({ type: "chat_turn", ts: next(40_000), intent: "vague", charCount: 1800, containsStackTraceOrLineRef: true, containsConstraintWords: false, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(6_000), file: "src/features/dashboard/Dashboard.tsx", source: "ai-chat-output", chars: 1200 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1200 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "no-edit", editFraction: 0.0 });
  ev.push({ type: "file_saved", ts: next(3_000), path: "src/features/dashboard/Dashboard.tsx", errorCount: 2 });
  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "src/features/dashboard/Dashboard.tsx", line: 45, severity: "error", message: "Property 'foo' does not exist." });

  // Re-prompt
  ev.push({ type: "chat_turn", ts: next(20_000), intent: "vague", charCount: 1500, containsStackTraceOrLineRef: true, containsConstraintWords: false, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(7_000), file: "src/features/dashboard/Dashboard.tsx", source: "ai-chat-output", chars: 900 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 900 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "no-edit", editFraction: 0.0 });
  ev.push({ type: "file_saved", ts: next(3_000), path: "src/features/dashboard/Dashboard.tsx", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/features/dashboard/Dashboard.tsx", line: 45, durationMs: 95_000 });

  // AI writes tests too
  ev.push({ type: "file_focus_change", ts: next(30_000), file: "src/features/dashboard/Dashboard.test.tsx", language: "typescriptreact" });
  ev.push({ type: "chat_turn", ts: next(15_000), intent: "vague", charCount: 1100, containsStackTraceOrLineRef: false, containsConstraintWords: false, acceptedAi: true });
  ev.push({ type: "paste_classified", ts: next(5_000), file: "src/features/dashboard/Dashboard.test.tsx", source: "ai-chat-output", chars: 700 });
  ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 700 });
  ev.push({ type: "file_saved", ts: next(3_000), path: "src/features/dashboard/Dashboard.test.tsx", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(900), file: "src/features/dashboard/Dashboard.test.tsx", tests: 3, passed: 3, durationMs: 700, trigger: "manual" });

  // Another feature, same pattern, with nav-less jump-ins
  for (let i = 0; i < 4; i++) {
    const file = `src/features/widgets/Widget${i}.tsx`;
    ev.push({ type: "file_focus_change", ts: next(60_000), file, language: "typescriptreact" });
    ev.push({ type: "read_pattern_observed", ts: next(2_000), pattern: "jump-in", msToFirstEdit: 2_000, navCount: 0 });
    ev.push({ type: "chat_turn", ts: next(15_000), intent: "vague", charCount: 1900, containsStackTraceOrLineRef: false, containsConstraintWords: false, acceptedAi: true });
    ev.push({ type: "paste_classified", ts: next(7_000), file, source: "ai-chat-output", chars: 1100 });
    ev.push({ type: "paste_outcome_observed", ts: next(60_000), outcome: "kept-as-is", source: "ai-chat-output", chars: 1100 });
    ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file, chars: 1100, charsAccepted: 1100 });
    ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "no-edit", editFraction: 0.0 });
    ev.push({ type: "file_saved", ts: next(3_000), path: file, errorCount: 0 });
  }

  // Concepts — surface only
  ev.push({ type: "concept_encountered", ts: next(30_000), file: "src/features/dashboard/Dashboard.tsx", concept: "react/useState", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/features/dashboard/Dashboard.tsx", concept: "react/useEffect", language: "typescript" });

  // Big mixed-concern commits with AI-generated messages, plus a revert
  ev.push({ type: "line_diff", ts: next(60_000), file: "src/features/dashboard/Dashboard.tsx", linesAdded: 220, linesRemoved: 30, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "vc1", message: "chore: improvements and cleanup across dashboard", filesTouched: ["src/features/dashboard/Dashboard.tsx", "src/features/dashboard/Dashboard.test.tsx", "src/features/widgets/Widget0.tsx", "src/features/widgets/Widget1.tsx", "src/features/widgets/Widget2.tsx", "src/features/widgets/Widget3.tsx", "src/styles/dashboard.css", "src/utils/format.ts"] });
  ev.push({ type: "commit_detected", ts: next(120_000), sha: "vc2", message: "feat: add dashboard, widgets, and assorted fixes", filesTouched: ["src/features/dashboard/Dashboard.tsx", "src/features/widgets/Widget0.tsx", "src/features/widgets/Widget3.tsx", "src/api/client.ts", "src/styles/global.css"] });
  ev.push({ type: "commit_detected", ts: next(180_000), sha: "vc3", message: "Revert \"chore: improvements and cleanup across dashboard\"", filesTouched: ["src/features/dashboard/Dashboard.tsx", "src/features/widgets/Widget0.tsx"] });

  ev.push({ type: "session_boundary", ts: next(60_000), kind: "end", reason: "idle", activeMs: 1_900_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// Persona 4 — Pragmatic Mid (mid / web / ~708)
// Behavior: skim+deep mix, structured AI prompts with constraints, failing-
// test-first debug, integration tests, conventional clean commits.
// ---------------------------------------------------------------------------
function pragmaticMidEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });

  // Day 1 — feature in payments service
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/payments/charge.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: "src/payments/charge.ts", toFile: "src/payments/charge.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(6_000), kind: "def-jump", fromFile: "src/payments/charge.ts", toFile: "src/payments/types.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(7_000), kind: "find-refs", fromFile: "src/payments/types.ts", toFile: "src/payments/charge.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(4_000), kind: "def-jump", fromFile: "src/payments/charge.ts", toFile: "src/payments/__tests__/charge.test.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(3_000), pattern: "deep", msToFirstEdit: 95_000, navCount: 4 });

  // Constrained prompt asking for tradeoffs
  ev.push({ type: "chat_turn", ts: next(60_000), intent: "plan", charCount: 720, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: false });
  ev.push({ type: "chat_turn", ts: next(120_000), intent: "specific", charCount: 540, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: "src/payments/charge.ts", chars: 320, charsAccepted: 320 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.55 });
  ev.push({ type: "ai_suggestion_rejected", ts: next(180_000), file: "src/payments/charge.ts" });

  // Failing test first
  ev.push({ type: "file_focus_change", ts: next(20_000), file: "src/payments/__tests__/charge.test.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/payments/__tests__/charge.test.ts", charsAdded: 280, charsRemoved: 4 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "src/payments/__tests__/charge.test.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(30_000), file: "src/payments/__tests__/charge.test.ts", charsAdded: 120, charsRemoved: 6 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/__tests__/charge.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(700), file: "src/payments/__tests__/charge.test.ts", tests: 5, passed: 4, durationMs: 1100, trigger: "save" });

  // Implement with idle-gap thinking
  ev.push({ type: "file_focus_change", ts: next(10_000), file: "src/payments/charge.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(40_000), file: "src/payments/charge.ts", charsAdded: 60, charsRemoved: 8 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "src/payments/charge.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(35_000), file: "src/payments/charge.ts", charsAdded: 90, charsRemoved: 30 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/charge.ts", errorCount: 1 });

  // Diagnostic — methodical resolution with def-jump
  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "src/payments/charge.ts", line: 88, severity: "error", message: "Type 'Decimal' not assignable to 'number'." });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "def-jump", fromFile: "src/payments/charge.ts", toFile: "src/payments/types.ts", msSinceEdit: 5_000 });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "find-refs", fromFile: "src/payments/types.ts", toFile: "src/payments/types.ts", msSinceEdit: 0 });
  ev.push({ type: "text_change", ts: next(25_000), file: "src/payments/charge.ts", charsAdded: 22, charsRemoved: 14 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/charge.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/payments/charge.ts", line: 88, durationMs: 50_000 });

  ev.push({ type: "test_run_result", ts: next(800), file: "src/payments/__tests__/charge.test.ts", tests: 5, passed: 5, durationMs: 1050, trigger: "save" });

  // More tests — edge cases
  ev.push({ type: "text_change", ts: next(45_000), file: "src/payments/__tests__/charge.test.ts", charsAdded: 200, charsRemoved: 10 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "src/payments/__tests__/charge.test.ts", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/__tests__/charge.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(900), file: "src/payments/__tests__/charge.test.ts", tests: 9, passed: 9, durationMs: 1280, trigger: "save" });
  ev.push({ type: "test_run_result", ts: next(120_000), file: "src/payments/__tests__/charge.test.ts", tests: 9, passed: 9, durationMs: 1300, trigger: "manual" });

  // Concepts
  ev.push({ type: "concept_encountered", ts: next(60_000), file: "src/payments/charge.ts", concept: "postgres/transaction", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/payments/charge.ts", concept: "decimal/precision", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/payments/charge.ts", concept: "express/router", language: "typescript" });

  // Atomic commit
  ev.push({ type: "line_diff", ts: next(60_000), file: "src/payments/charge.ts", linesAdded: 38, linesRemoved: 12, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "line_diff", ts: next(1_000), file: "src/payments/__tests__/charge.test.ts", linesAdded: 64, linesRemoved: 6, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "pm1", message: "fix(payments): use Decimal for charge sums to avoid float drift on large baskets", filesTouched: ["src/payments/charge.ts", "src/payments/__tests__/charge.test.ts"] });

  // Day 2 — bug from prod, repro, fix, integration test
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 6_900_000 });
  ev.push({ type: "session_boundary", ts: next(50_000_000), kind: "start", reason: "fresh-start" });

  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/payments/refund.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(6_000), kind: "symbol-search", fromFile: "src/payments/refund.ts", toFile: "src/payments/refund.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(4_000), kind: "def-jump", fromFile: "src/payments/refund.ts", toFile: "src/payments/charge.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(2_000), pattern: "skim", msToFirstEdit: 22_000, navCount: 2 });

  ev.push({ type: "chat_turn", ts: next(45_000), intent: "debug", charCount: 580, containsStackTraceOrLineRef: true, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: false });
  ev.push({ type: "chat_turn", ts: next(60_000), intent: "specific", charCount: 420, containsStackTraceOrLineRef: true, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.65 });

  ev.push({ type: "text_change", ts: next(30_000), file: "src/payments/__tests__/refund.test.ts", charsAdded: 220, charsRemoved: 0 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/__tests__/refund.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(700), file: "src/payments/__tests__/refund.test.ts", tests: 3, passed: 2, durationMs: 1400, trigger: "save" });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/payments/refund.ts", charsAdded: 22, charsRemoved: 10 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/refund.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(700), file: "src/payments/__tests__/refund.test.ts", tests: 3, passed: 3, durationMs: 1320, trigger: "save" });

  ev.push({ type: "commit_detected", ts: next(60_000), sha: "pm2", message: "fix(refund): clamp partial refund to remaining captured amount", filesTouched: ["src/payments/refund.ts", "src/payments/__tests__/refund.test.ts"] });
  ev.push({ type: "commit_detected", ts: next(2_000_000), sha: "pm3", message: "test(refund): add property test for partial refund accounting", filesTouched: ["src/payments/__tests__/refund.test.ts"] });

  // Day 3 — code review fix
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 5_400_000 });
  ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/payments/refund.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(5_000), kind: "find-refs", fromFile: "src/payments/refund.ts", toFile: "src/payments/refund.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(8_000), pattern: "skim", msToFirstEdit: 18_000, navCount: 1 });
  ev.push({ type: "text_change", ts: next(30_000), file: "src/payments/refund.ts", charsAdded: 18, charsRemoved: 22 });
  ev.push({ type: "keystroke_burst", ts: next(3_000), file: "src/payments/refund.ts", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/refund.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(900), file: "src/payments/__tests__/refund.test.ts", tests: 5, passed: 5, durationMs: 1280, trigger: "save" });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "pm4", message: "refactor(refund): extract clampRefundAmount to keep handler thin", filesTouched: ["src/payments/refund.ts", "src/payments/__tests__/refund.test.ts"] });

  // Days 4–9 — sustained mid-level cadence
  for (let day = 0; day < 6; day++) {
    ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 5_400_000 });
    ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });

    const featNames = ["dispute", "subscription", "tax", "invoice", "fee", "settlement"];
    const featFile = `src/payments/${featNames[day]}.ts`;
    const testFile = `src/payments/__tests__/${featNames[day]}.test.ts`;

    ev.push({ type: "file_focus_change", ts: next(2_000), file: featFile, language: "typescript" });
    ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: featFile, toFile: featFile, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(6_000), kind: "def-jump", fromFile: featFile, toFile: "src/payments/types.ts", msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(6_000), kind: "find-refs", fromFile: featFile, toFile: featFile, msSinceEdit: 0 });
    ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "deep", msToFirstEdit: 80_000, navCount: 3 });

    ev.push({ type: "chat_turn", ts: next(60_000), intent: "specific", charCount: 460 + day * 20, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: true });
    ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.50 });

    ev.push({ type: "text_change", ts: next(60_000), file: testFile, charsAdded: 240, charsRemoved: 0 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: testFile, chars: 200 });
    ev.push({ type: "file_saved", ts: next(2_000), path: testFile, errorCount: 0 });
    ev.push({ type: "test_run_result", ts: next(700), file: testFile, tests: 5, passed: 3, durationMs: 1_100, trigger: "save" });

    ev.push({ type: "text_change", ts: next(45_000), file: featFile, charsAdded: 80, charsRemoved: 18 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: featFile, chars: 200 });
    ev.push({ type: "file_saved", ts: next(2_000), path: featFile, errorCount: 1 });

    ev.push({ type: "diagnostic_appeared", ts: next(500), file: featFile, line: 50 + day, severity: "error", message: "Possibly undefined." });
    ev.push({ type: "text_change", ts: next(20_000), file: featFile, charsAdded: 18, charsRemoved: 8 });
    ev.push({ type: "file_saved", ts: next(2_000), path: featFile, errorCount: 0 });
    ev.push({ type: "diagnostic_resolved", ts: next(100), file: featFile, line: 50 + day, durationMs: 22_000 });
    ev.push({ type: "test_run_result", ts: next(700), file: testFile, tests: 5, passed: 5, durationMs: 1_080, trigger: "save" });

    ev.push({ type: "concept_encountered", ts: next(60_000), file: featFile, concept: "postgres/transaction", language: "typescript" });

    ev.push({ type: "line_diff", ts: next(60_000), file: featFile, linesAdded: 38, linesRemoved: 8, rewrittenFingerprints: noFingerprints() });
    const featDescriptions = [
      "dispute reason codes — covers the four codes our PSP returns",
      "subscription proration — covers the partial-period charge math the API contract advertises",
      "tax breakdown by jurisdiction — covers US/EU/CA jurisdictions plus a fallthrough",
      "invoice line item rounding — half-even at the line, sum at the total",
      "fee schedule lookup with effective-date semantics",
      "settlement file reconciliation against ledger entries",
    ];
    ev.push({ type: "commit_detected", ts: next(1_000), sha: `pm${5 + day}`, message: `feat(payments): ${featDescriptions[day]}`, filesTouched: [featFile, testFile] });
  }

  ev.push({ type: "session_boundary", ts: next(120_000), kind: "end", reason: "idle", activeMs: 3_900_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// Persona 5 — ML Researcher (mid / ml / ~646)
// Behavior: deep tensor-shape reads, rare AI use, notebook reproduction,
// property tests for numerical code, batched commits, weak service tests.
// ---------------------------------------------------------------------------
function mlResearcherEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });

  // Reads model file deeply
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/models/transformer_block.py", language: "python" });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "symbol-search", fromFile: "src/models/transformer_block.py", toFile: "src/models/transformer_block.py", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/models/transformer_block.py", toFile: "src/models/attention.py", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(40_000), kind: "def-jump", fromFile: "src/models/attention.py", toFile: "src/models/rope.py", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(30_000), kind: "find-refs", fromFile: "src/models/rope.py", toFile: "src/models/rope.py", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 240_000, navCount: 4 });

  // Notebook repro
  ev.push({ type: "file_focus_change", ts: next(60_000), file: "notebooks/attention_shape_repro.ipynb", language: "jupyter" });
  ev.push({ type: "text_change", ts: next(120_000), file: "notebooks/attention_shape_repro.ipynb", charsAdded: 480, charsRemoved: 0 });
  ev.push({ type: "keystroke_burst", ts: next(8_000), file: "notebooks/attention_shape_repro.ipynb", chars: 200 });
  ev.push({ type: "text_change", ts: next(180_000), file: "notebooks/attention_shape_repro.ipynb", charsAdded: 320, charsRemoved: 60 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "notebooks/attention_shape_repro.ipynb", errorCount: 0 });

  // Implement fix
  ev.push({ type: "file_focus_change", ts: next(60_000), file: "src/models/attention.py", language: "python" });
  ev.push({ type: "text_change", ts: next(80_000), file: "src/models/attention.py", charsAdded: 60, charsRemoved: 40 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "src/models/attention.py", chars: 200 });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/models/attention.py", charsAdded: 30, charsRemoved: 12 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/models/attention.py", errorCount: 0 });

  // Property test for numerical code
  ev.push({ type: "file_focus_change", ts: next(40_000), file: "tests/test_attention_properties.py", language: "python" });
  ev.push({ type: "text_change", ts: next(180_000), file: "tests/test_attention_properties.py", charsAdded: 620, charsRemoved: 0 });
  ev.push({ type: "keystroke_burst", ts: next(6_000), file: "tests/test_attention_properties.py", chars: 200 });
  ev.push({ type: "text_change", ts: next(120_000), file: "tests/test_attention_properties.py", charsAdded: 180, charsRemoved: 20 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "tests/test_attention_properties.py", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(2_500), file: "tests/test_attention_properties.py", tests: 8, passed: 8, durationMs: 4_200, trigger: "manual" });
  ev.push({ type: "test_run_result", ts: next(120_000), file: "tests/test_attention_properties.py", tests: 8, passed: 8, durationMs: 4_180, trigger: "manual" });

  // Rare AI use — boilerplate shell script only
  ev.push({ type: "chat_turn", ts: next(900_000), intent: "specific", charCount: 240, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: "scripts/launch_train.sh", chars: 180, charsAccepted: 180 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.40 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "scripts/launch_train.sh", errorCount: 0 });

  // More deep work — different file, same pattern
  ev.push({ type: "file_focus_change", ts: next(600_000), file: "src/training/trainer.py", language: "python" });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "symbol-search", fromFile: "src/training/trainer.py", toFile: "src/training/trainer.py", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/training/trainer.py", toFile: "src/training/loss.py", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "find-refs", fromFile: "src/training/loss.py", toFile: "src/training/loss.py", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 180_000, navCount: 3 });

  ev.push({ type: "diagnostic_appeared", ts: next(60_000), file: "src/training/trainer.py", line: 142, severity: "warning", message: "Tensor shape mismatch may occur with batch_size=1." });
  ev.push({ type: "text_change", ts: next(120_000), file: "src/training/trainer.py", charsAdded: 80, charsRemoved: 30 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "src/training/trainer.py", chars: 200 });
  ev.push({ type: "text_change", ts: next(80_000), file: "src/training/trainer.py", charsAdded: 30, charsRemoved: 12 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/training/trainer.py", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/training/trainer.py", line: 142, durationMs: 200_000 });

  // Loss test (property-based)
  ev.push({ type: "file_focus_change", ts: next(30_000), file: "tests/test_loss_properties.py", language: "python" });
  ev.push({ type: "text_change", ts: next(120_000), file: "tests/test_loss_properties.py", charsAdded: 380, charsRemoved: 10 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "tests/test_loss_properties.py", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(3_000), file: "tests/test_loss_properties.py", tests: 5, passed: 5, durationMs: 5_400, trigger: "manual" });

  // Concepts ML
  ev.push({ type: "concept_encountered", ts: next(120_000), file: "src/models/attention.py", concept: "torch/multi-head-attention", language: "python" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/models/rope.py", concept: "torch/rotary-embedding", language: "python" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/training/loss.py", concept: "torch/cross-entropy", language: "python" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/training/trainer.py", concept: "torch/autocast", language: "python" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/training/trainer.py", concept: "torch/grad-scaler", language: "python" });

  // Big batched commit (week of experimentation)
  ev.push({ type: "line_diff", ts: next(120_000), file: "src/models/attention.py", linesAdded: 60, linesRemoved: 40, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "line_diff", ts: next(1_000), file: "src/training/trainer.py", linesAdded: 80, linesRemoved: 30, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "line_diff", ts: next(1_000), file: "tests/test_attention_properties.py", linesAdded: 180, linesRemoved: 0, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "ml1", message: "exp(transformer): rope at base 10000, mixed precision, attention shape fix — single-batch eval matches reference within 1e-5", filesTouched: ["src/models/attention.py", "src/models/rope.py", "src/training/trainer.py", "src/training/loss.py", "tests/test_attention_properties.py", "tests/test_loss_properties.py", "notebooks/attention_shape_repro.ipynb", "scripts/launch_train.sh"] });

  // Service test gap — minimal smoke test
  ev.push({ type: "file_focus_change", ts: next(600_000), file: "src/serving/handler.py", language: "python" });
  ev.push({ type: "read_pattern_observed", ts: next(8_000), pattern: "skim", msToFirstEdit: 18_000, navCount: 1 });
  ev.push({ type: "text_change", ts: next(45_000), file: "src/serving/handler.py", charsAdded: 60, charsRemoved: 12 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/serving/handler.py", errorCount: 0 });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "ml2", message: "feat(serving): wire trainer artifact loader through handler", filesTouched: ["src/serving/handler.py"] });

  // Week 2 — sustained research/experimentation cadence
  for (let day = 0; day < 4; day++) {
    ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 8_400_000 });
    ev.push({ type: "session_boundary", ts: next(36_000_000), kind: "start", reason: "fresh-start" });

    const expFile = `src/experiments/exp${day}_${["lr_schedule", "moe_routing", "kv_cache", "speculative_decode"][day]}.py`;
    const propTest = `tests/test_exp${day}_properties.py`;
    const notebook = `notebooks/exp${day}_repro.ipynb`;

    ev.push({ type: "file_focus_change", ts: next(2_000), file: expFile, language: "python" });
    ev.push({ type: "editor_navigation", ts: next(15_000), kind: "symbol-search", fromFile: expFile, toFile: expFile, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(15_000), kind: "def-jump", fromFile: expFile, toFile: `src/models/${["scheduler", "moe", "cache", "decode"][day]}.py`, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(15_000), kind: "find-refs", fromFile: `src/models/${["scheduler", "moe", "cache", "decode"][day]}.py`, toFile: `src/models/${["scheduler", "moe", "cache", "decode"][day]}.py`, msSinceEdit: 0 });
    ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 150_000, navCount: 3 });

    // Notebook repro
    ev.push({ type: "file_focus_change", ts: next(60_000), file: notebook, language: "jupyter" });
    ev.push({ type: "text_change", ts: next(120_000), file: notebook, charsAdded: 380, charsRemoved: 0 });
    ev.push({ type: "keystroke_burst", ts: next(5_000), file: notebook, chars: 200 });
    ev.push({ type: "text_change", ts: next(80_000), file: notebook, charsAdded: 220, charsRemoved: 30 });
    ev.push({ type: "file_saved", ts: next(2_000), path: notebook, errorCount: 0 });

    // Implement
    ev.push({ type: "file_focus_change", ts: next(60_000), file: expFile, language: "python" });
    ev.push({ type: "text_change", ts: next(80_000), file: expFile, charsAdded: 120, charsRemoved: 30 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: expFile, chars: 200 });
    ev.push({ type: "text_change", ts: next(60_000), file: expFile, charsAdded: 80, charsRemoved: 22 });
    ev.push({ type: "file_saved", ts: next(2_000), path: expFile, errorCount: 0 });

    if (day === 1 || day === 2) {
      ev.push({ type: "diagnostic_appeared", ts: next(20_000), file: expFile, line: 60 + day, severity: "warning", message: "Tensor shape mismatch with batch_size=1." });
      ev.push({ type: "text_change", ts: next(80_000), file: expFile, charsAdded: 40, charsRemoved: 14 });
      ev.push({ type: "file_saved", ts: next(2_000), path: expFile, errorCount: 0 });
      ev.push({ type: "diagnostic_resolved", ts: next(100), file: expFile, line: 60 + day, durationMs: 90_000 });
    }

    // Property test
    ev.push({ type: "file_focus_change", ts: next(40_000), file: propTest, language: "python" });
    ev.push({ type: "text_change", ts: next(120_000), file: propTest, charsAdded: 380, charsRemoved: 0 });
    ev.push({ type: "keystroke_burst", ts: next(5_000), file: propTest, chars: 200 });
    ev.push({ type: "file_saved", ts: next(2_000), path: propTest, errorCount: 0 });
    ev.push({ type: "test_run_result", ts: next(3_500), file: propTest, tests: 6 + day, passed: 6 + day, durationMs: 4_400, trigger: "manual" });

    ev.push({ type: "concept_encountered", ts: next(60_000), file: expFile, concept: ["torch/lr-scheduler", "torch/moe", "torch/kv-cache", "torch/speculative"][day], language: "python" });
    ev.push({ type: "concept_encountered", ts: next(500), file: expFile, concept: "torch/autocast", language: "python" });

    ev.push({ type: "line_diff", ts: next(120_000), file: expFile, linesAdded: 80, linesRemoved: 30, rewrittenFingerprints: noFingerprints() });
    ev.push({ type: "commit_detected", ts: next(1_000), sha: `ml${3 + day}`, message: `exp(${["scheduler", "moe", "kv-cache", "speculative-decode"][day]}): ${["cosine→linear+warmup matches paper Table 3 within 0.3 nats", "top-2 routing reproduces paper loss curve through 50k steps", "kv reuse cuts decode latency 38% on 8k context", "spec-decode lambda 0.5 lifts throughput 1.6x with no quality regression"][day]}`, filesTouched: [expFile, propTest, notebook] });
  }

  ev.push({ type: "session_boundary", ts: next(120_000), kind: "end", reason: "idle", activeMs: 9_200_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// Persona 6 — Mobile Mid (mid / mobile / ~705)
// Behavior: protocol/view-hierarchy scans, AI for boilerplate, snapshot+VM
// tests, atomic commits with screenshots-style descriptions.
// ---------------------------------------------------------------------------
function mobileMidEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });

  // SwiftUI view file — scans protocols, view hierarchy
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "App/Features/Profile/ProfileView.swift", language: "swift" });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: "App/Features/Profile/ProfileView.swift", toFile: "App/Features/Profile/ProfileView.swift", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(6_000), kind: "def-jump", fromFile: "App/Features/Profile/ProfileView.swift", toFile: "App/Features/Profile/ProfileViewModel.swift", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(5_000), kind: "find-refs", fromFile: "App/Features/Profile/ProfileViewModel.swift", toFile: "App/Features/Profile/ProfileViewModel.swift", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "deep", msToFirstEdit: 30_000, navCount: 3 });

  // AI for CoreData boilerplate
  ev.push({ type: "chat_turn", ts: next(60_000), intent: "request", charCount: 320, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: "App/Storage/CoreDataStack.swift", chars: 480, charsAccepted: 480 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.30 });
  ev.push({ type: "text_change", ts: next(60_000), file: "App/Storage/CoreDataStack.swift", charsAdded: 50, charsRemoved: 20 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "App/Storage/CoreDataStack.swift", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "App/Storage/CoreDataStack.swift", errorCount: 0 });

  // ViewModel work
  ev.push({ type: "file_focus_change", ts: next(45_000), file: "App/Features/Profile/ProfileViewModel.swift", language: "swift" });
  ev.push({ type: "text_change", ts: next(60_000), file: "App/Features/Profile/ProfileViewModel.swift", charsAdded: 180, charsRemoved: 30 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "App/Features/Profile/ProfileViewModel.swift", chars: 200 });
  ev.push({ type: "text_change", ts: next(40_000), file: "App/Features/Profile/ProfileViewModel.swift", charsAdded: 90, charsRemoved: 12 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "App/Features/Profile/ProfileViewModel.swift", errorCount: 0 });

  // Diagnostic — async/await issue, def-jump
  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "App/Features/Profile/ProfileViewModel.swift", line: 88, severity: "error", message: "Cannot pass non-sendable type across actor boundary." });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "App/Features/Profile/ProfileViewModel.swift", toFile: "App/Features/Profile/ProfileService.swift", msSinceEdit: 5_000 });
  ev.push({ type: "text_change", ts: next(30_000), file: "App/Features/Profile/ProfileViewModel.swift", charsAdded: 22, charsRemoved: 14 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "App/Features/Profile/ProfileViewModel.swift", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "App/Features/Profile/ProfileViewModel.swift", line: 88, durationMs: 52_000 });

  // VM unit tests
  ev.push({ type: "file_focus_change", ts: next(30_000), file: "AppTests/ProfileViewModelTests.swift", language: "swift" });
  ev.push({ type: "text_change", ts: next(120_000), file: "AppTests/ProfileViewModelTests.swift", charsAdded: 360, charsRemoved: 6 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "AppTests/ProfileViewModelTests.swift", chars: 200 });
  ev.push({ type: "text_change", ts: next(60_000), file: "AppTests/ProfileViewModelTests.swift", charsAdded: 120, charsRemoved: 8 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "AppTests/ProfileViewModelTests.swift", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(900), file: "AppTests/ProfileViewModelTests.swift", tests: 7, passed: 7, durationMs: 1_400, trigger: "save" });

  // Snapshot tests
  ev.push({ type: "file_focus_change", ts: next(40_000), file: "AppTests/ProfileViewSnapshotTests.swift", language: "swift" });
  ev.push({ type: "text_change", ts: next(90_000), file: "AppTests/ProfileViewSnapshotTests.swift", charsAdded: 280, charsRemoved: 0 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "AppTests/ProfileViewSnapshotTests.swift", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(2_000), file: "AppTests/ProfileViewSnapshotTests.swift", tests: 4, passed: 4, durationMs: 3_200, trigger: "manual" });

  // Concepts mobile
  ev.push({ type: "concept_encountered", ts: next(60_000), file: "App/Features/Profile/ProfileView.swift", concept: "swiftui/observable", language: "swift" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "App/Features/Profile/ProfileViewModel.swift", concept: "swift/async-await", language: "swift" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "App/Features/Profile/ProfileViewModel.swift", concept: "combine/publisher", language: "swift" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "App/Storage/CoreDataStack.swift", concept: "coredata/persistent-container", language: "swift" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "App/Features/Profile/ProfileView.swift", concept: "uikit/uiviewrepresentable", language: "swift" });

  // Atomic commit
  ev.push({ type: "line_diff", ts: next(60_000), file: "App/Features/Profile/ProfileViewModel.swift", linesAdded: 64, linesRemoved: 18, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "mb1", message: "feat(profile): wire VM to async ProfileService with cancellation; ships VM unit + snapshot tests", filesTouched: ["App/Features/Profile/ProfileView.swift", "App/Features/Profile/ProfileViewModel.swift", "App/Features/Profile/ProfileService.swift", "AppTests/ProfileViewModelTests.swift", "AppTests/ProfileViewSnapshotTests.swift"] });

  // Day 2 — performance issue caught with Instruments
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 7_100_000 });
  ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "App/Features/Feed/FeedView.swift", language: "swift" });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: "App/Features/Feed/FeedView.swift", toFile: "App/Features/Feed/FeedView.swift", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "def-jump", fromFile: "App/Features/Feed/FeedView.swift", toFile: "App/Features/Feed/FeedRow.swift", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 70_000, navCount: 2 });

  ev.push({ type: "diagnostic_appeared", ts: next(60_000), file: "App/Features/Feed/FeedRow.swift", line: 32, severity: "info", message: "Frequent re-render on parent state change." });
  ev.push({ type: "text_change", ts: next(80_000), file: "App/Features/Feed/FeedRow.swift", charsAdded: 40, charsRemoved: 18 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "App/Features/Feed/FeedRow.swift", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "App/Features/Feed/FeedRow.swift", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "App/Features/Feed/FeedRow.swift", line: 32, durationMs: 84_000 });
  ev.push({ type: "test_run_result", ts: next(2_500), file: "AppTests/FeedRowSnapshotTests.swift", tests: 3, passed: 3, durationMs: 2_200, trigger: "manual" });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "mb2", message: "perf(feed): equatable feed row eliminates 4x re-render storm caught in Instruments time profile", filesTouched: ["App/Features/Feed/FeedRow.swift", "AppTests/FeedRowSnapshotTests.swift"] });

  // Days 3–7 — sustained mid-level cadence: settings, search, push notifications, onboarding, sharing
  for (let day = 0; day < 5; day++) {
    ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 6_400_000 });
    ev.push({ type: "session_boundary", ts: next(36_000_000), kind: "start", reason: "fresh-start" });

    const feature = ["Settings", "Search", "Notifications", "Onboarding", "Sharing"][day];
    const viewFile = `App/Features/${feature}/${feature}View.swift`;
    const vmFile = `App/Features/${feature}/${feature}ViewModel.swift`;
    const vmTest = `AppTests/${feature}ViewModelTests.swift`;
    const snapTest = `AppTests/${feature}ViewSnapshotTests.swift`;

    ev.push({ type: "file_focus_change", ts: next(2_000), file: viewFile, language: "swift" });
    ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: viewFile, toFile: viewFile, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(6_000), kind: "def-jump", fromFile: viewFile, toFile: vmFile, msSinceEdit: 0 });
    ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "deep", msToFirstEdit: 35_000, navCount: 2 });

    if (day === 1) {
      ev.push({ type: "chat_turn", ts: next(45_000), intent: "request", charCount: 320, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
      ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: viewFile, chars: 380, charsAccepted: 380 });
      ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.40 });
    }

    ev.push({ type: "text_change", ts: next(60_000), file: vmFile, charsAdded: 180, charsRemoved: 30 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: vmFile, chars: 200 });
    ev.push({ type: "text_change", ts: next(40_000), file: vmFile, charsAdded: 80, charsRemoved: 12 });
    ev.push({ type: "file_saved", ts: next(2_000), path: vmFile, errorCount: day === 0 ? 1 : 0 });

    if (day === 0) {
      ev.push({ type: "diagnostic_appeared", ts: next(500), file: vmFile, line: 60, severity: "error", message: "Cannot pass non-sendable type across actor boundary." });
      ev.push({ type: "editor_navigation", ts: next(15_000), kind: "def-jump", fromFile: vmFile, toFile: `App/Services/${feature}Service.swift`, msSinceEdit: 5_000 });
      ev.push({ type: "text_change", ts: next(20_000), file: vmFile, charsAdded: 22, charsRemoved: 10 });
      ev.push({ type: "file_saved", ts: next(2_000), path: vmFile, errorCount: 0 });
      ev.push({ type: "diagnostic_resolved", ts: next(100), file: vmFile, line: 60, durationMs: 38_000 });
    }

    ev.push({ type: "text_change", ts: next(80_000), file: vmTest, charsAdded: 280, charsRemoved: 0 });
    ev.push({ type: "file_saved", ts: next(2_000), path: vmTest, errorCount: 0 });
    ev.push({ type: "test_run_result", ts: next(900), file: vmTest, tests: 6 + day, passed: 6 + day, durationMs: 1_300, trigger: "save" });

    ev.push({ type: "text_change", ts: next(60_000), file: snapTest, charsAdded: 220, charsRemoved: 0 });
    ev.push({ type: "file_saved", ts: next(2_000), path: snapTest, errorCount: 0 });
    ev.push({ type: "test_run_result", ts: next(2_000), file: snapTest, tests: 4, passed: 4, durationMs: 2_800, trigger: "manual" });

    ev.push({ type: "concept_encountered", ts: next(60_000), file: viewFile, concept: "swiftui/observable", language: "swift" });
    ev.push({ type: "concept_encountered", ts: next(500), file: vmFile, concept: "swift/async-await", language: "swift" });

    const mbDescriptions = [
      "actor-isolated VM with cancellation",
      "debounced search with cached suggestion list",
      "permission flow with deep-link continuation",
      "step-flow VM with skip + resume from background",
      "ShareLink builder with custom transferable representation",
    ];
    ev.push({ type: "commit_detected", ts: next(60_000), sha: `mb${3 + day}`, message: `feat(${feature.toLowerCase()}): ${mbDescriptions[day]}; ships VM unit + snapshot tests`, filesTouched: [viewFile, vmFile, vmTest, snapTest] });
  }

  ev.push({ type: "session_boundary", ts: next(120_000), kind: "end", reason: "idle", activeMs: 4_800_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// Persona 7 — Senior Backend (senior / web / ~841)
// Behavior: module-boundary reads, structured AI prompts, contract+property
// tests, atomic conventional commits with rationale, runbook-mindset.
// ---------------------------------------------------------------------------
function seniorBackendEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });

  // Day 1 — onboarding into a payments subsystem area
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/payments/ledger/index.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "symbol-search", fromFile: "src/payments/ledger/index.ts", toFile: "src/payments/ledger/index.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/payments/ledger/index.ts", toFile: "src/payments/ledger/types.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "find-refs", fromFile: "src/payments/ledger/types.ts", toFile: "src/payments/ledger/types.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/payments/ledger/types.ts", toFile: "src/payments/ledger/__tests__/ledger.contract.test.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 280_000, navCount: 4 });

  // Constrained, multi-option prompt
  ev.push({ type: "chat_turn", ts: next(180_000), intent: "plan", charCount: 980, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: false });
  ev.push({ type: "ai_suggestion_rejected", ts: next(60_000), file: "src/payments/ledger/index.ts" });
  ev.push({ type: "chat_turn", ts: next(120_000), intent: "specific", charCount: 720, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsExplainKeyword: true, acceptedAi: true });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.55 });

  // Failing contract test first
  ev.push({ type: "file_focus_change", ts: next(20_000), file: "src/payments/ledger/__tests__/ledger.contract.test.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(120_000), file: "src/payments/ledger/__tests__/ledger.contract.test.ts", charsAdded: 460, charsRemoved: 12 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "src/payments/ledger/__tests__/ledger.contract.test.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/payments/ledger/__tests__/ledger.contract.test.ts", charsAdded: 220, charsRemoved: 30 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/ledger/__tests__/ledger.contract.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(800), file: "src/payments/ledger/__tests__/ledger.contract.test.ts", tests: 11, passed: 9, durationMs: 1_400, trigger: "save" });

  // Implement
  ev.push({ type: "file_focus_change", ts: next(15_000), file: "src/payments/ledger/index.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/payments/ledger/index.ts", charsAdded: 80, charsRemoved: 12 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "src/payments/ledger/index.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(50_000), file: "src/payments/ledger/index.ts", charsAdded: 50, charsRemoved: 18 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/ledger/index.ts", errorCount: 1 });

  // Diagnostics: read carefully, def-jump, fix, resolve
  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "src/payments/ledger/index.ts", line: 132, severity: "error", message: "Type narrowing fails when LedgerEntry is generic." });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/payments/ledger/index.ts", toFile: "src/payments/ledger/types.ts", msSinceEdit: 5_000 });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "find-refs", fromFile: "src/payments/ledger/types.ts", toFile: "src/payments/ledger/types.ts", msSinceEdit: 0 });
  ev.push({ type: "text_change", ts: next(40_000), file: "src/payments/ledger/types.ts", charsAdded: 30, charsRemoved: 14 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/ledger/types.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/payments/ledger/index.ts", line: 132, durationMs: 82_000 });
  ev.push({ type: "test_run_result", ts: next(800), file: "src/payments/ledger/__tests__/ledger.contract.test.ts", tests: 11, passed: 11, durationMs: 1_320, trigger: "save" });

  // Property test
  ev.push({ type: "file_focus_change", ts: next(30_000), file: "src/payments/ledger/__tests__/ledger.property.test.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(120_000), file: "src/payments/ledger/__tests__/ledger.property.test.ts", charsAdded: 320, charsRemoved: 0 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "src/payments/ledger/__tests__/ledger.property.test.ts", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/ledger/__tests__/ledger.property.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(2_000), file: "src/payments/ledger/__tests__/ledger.property.test.ts", tests: 6, passed: 6, durationMs: 3_200, trigger: "manual" });

  // Concepts
  ev.push({ type: "concept_encountered", ts: next(60_000), file: "src/payments/ledger/index.ts", concept: "postgres/transaction", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/payments/ledger/index.ts", concept: "consistency/serializable", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/payments/ledger/index.ts", concept: "queue/idempotency", language: "typescript" });

  // Atomic commit with rationale
  ev.push({ type: "line_diff", ts: next(60_000), file: "src/payments/ledger/index.ts", linesAdded: 38, linesRemoved: 12, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "line_diff", ts: next(1_000), file: "src/payments/ledger/__tests__/ledger.contract.test.ts", linesAdded: 80, linesRemoved: 12, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "sb1", message: "feat(ledger): serializable post-and-fetch via SELECT FOR UPDATE — prevents lost-update under retry pressure observed in payments-staging incident #4318", filesTouched: ["src/payments/ledger/index.ts", "src/payments/ledger/types.ts", "src/payments/ledger/__tests__/ledger.contract.test.ts", "src/payments/ledger/__tests__/ledger.property.test.ts"] });

  // Day 2 — production incident triage
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 8_100_000 });
  ev.push({ type: "session_boundary", ts: next(36_000_000), kind: "start", reason: "fresh-start" });

  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/payments/webhook/handler.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(10_000), kind: "symbol-search", fromFile: "src/payments/webhook/handler.ts", toFile: "src/payments/webhook/handler.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "find-refs", fromFile: "src/payments/webhook/handler.ts", toFile: "src/payments/webhook/handler.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "def-jump", fromFile: "src/payments/webhook/handler.ts", toFile: "src/payments/webhook/types.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 110_000, navCount: 3 });

  ev.push({ type: "chat_turn", ts: next(120_000), intent: "debug", charCount: 820, containsStackTraceOrLineRef: true, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: false });
  ev.push({ type: "chat_turn", ts: next(180_000), intent: "specific", charCount: 540, containsStackTraceOrLineRef: true, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.62 });

  ev.push({ type: "diagnostic_appeared", ts: next(60_000), file: "src/payments/webhook/handler.ts", line: 88, severity: "warning", message: "Replay window is wider than provider clock skew tolerance." });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/payments/webhook/handler.ts", charsAdded: 80, charsRemoved: 30 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "src/payments/webhook/handler.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/payments/webhook/handler.ts", charsAdded: 22, charsRemoved: 14 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/webhook/handler.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/payments/webhook/handler.ts", line: 88, durationMs: 130_000 });

  ev.push({ type: "text_change", ts: next(120_000), file: "src/payments/webhook/__tests__/handler.contract.test.ts", charsAdded: 320, charsRemoved: 0 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/webhook/__tests__/handler.contract.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(900), file: "src/payments/webhook/__tests__/handler.contract.test.ts", tests: 8, passed: 8, durationMs: 1_400, trigger: "save" });

  ev.push({ type: "commit_detected", ts: next(60_000), sha: "sb2", message: "fix(webhook): tighten replay window to provider's documented 5min skew — prevents duplicate captures observed in incident #4318 retry surge", filesTouched: ["src/payments/webhook/handler.ts", "src/payments/webhook/__tests__/handler.contract.test.ts"] });

  // Day 3 — refactor + runbook-style commit
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 7_400_000 });
  ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/payments/ledger/index.ts", language: "typescript" });
  ev.push({ type: "read_pattern_observed", ts: next(8_000), pattern: "skim", msToFirstEdit: 18_000, navCount: 1 });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/payments/ledger/index.ts", charsAdded: 30, charsRemoved: 60 });
  ev.push({ type: "keystroke_burst", ts: next(3_000), file: "src/payments/ledger/index.ts", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/ledger/index.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(900), file: "src/payments/ledger/__tests__/ledger.contract.test.ts", tests: 11, passed: 11, durationMs: 1_300, trigger: "save" });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "sb3", message: "refactor(ledger): hoist isolation-level into LedgerOptions — lets fee-svc share contract test suite without duplicating the SQL block", filesTouched: ["src/payments/ledger/index.ts", "src/payments/ledger/types.ts"] });

  // Day 4 — review feedback
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 4_500_000 });
  ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/payments/ledger/index.ts", language: "typescript" });
  ev.push({ type: "read_pattern_observed", ts: next(6_000), pattern: "skim", msToFirstEdit: 14_000, navCount: 1 });
  ev.push({ type: "text_change", ts: next(20_000), file: "src/payments/ledger/index.ts", charsAdded: 18, charsRemoved: 14 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/payments/ledger/index.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(900), file: "src/payments/ledger/__tests__/ledger.contract.test.ts", tests: 11, passed: 11, durationMs: 1_290, trigger: "save" });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "sb4", message: "docs(ledger): inline isolation-level rationale per review — link to ADR 0042 added at top of postEntry", filesTouched: ["src/payments/ledger/index.ts"] });

  // Days 5–10 — sustained delivery: small atomic improvements + tests
  for (let day = 0; day < 6; day++) {
    ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 5_400_000 });
    ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });

    const featFile = `src/payments/feature${day}.ts`;
    const testFile = `src/payments/__tests__/feature${day}.contract.test.ts`;
    ev.push({ type: "file_focus_change", ts: next(2_000), file: featFile, language: "typescript" });
    ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: featFile, toFile: featFile, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(6_000), kind: "find-refs", fromFile: featFile, toFile: featFile, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(8_000), kind: "def-jump", fromFile: featFile, toFile: "src/payments/types.ts", msSinceEdit: 0 });
    ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "deep", msToFirstEdit: 90_000, navCount: 3 });

    ev.push({ type: "chat_turn", ts: next(120_000), intent: "specific", charCount: 540 + day * 20, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: true });
    ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.55 });

    // failing test first
    ev.push({ type: "text_change", ts: next(60_000), file: testFile, charsAdded: 280, charsRemoved: 0 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: testFile, chars: 200 });
    ev.push({ type: "file_saved", ts: next(2_000), path: testFile, errorCount: 0 });
    ev.push({ type: "test_run_result", ts: next(800), file: testFile, tests: 6, passed: 4, durationMs: 1_200, trigger: "save" });

    // implement
    ev.push({ type: "text_change", ts: next(45_000), file: featFile, charsAdded: 60, charsRemoved: 12 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: featFile, chars: 200 });
    ev.push({ type: "file_saved", ts: next(2_000), path: featFile, errorCount: 1 });

    ev.push({ type: "diagnostic_appeared", ts: next(500), file: featFile, line: 60 + day, severity: "error", message: "Type narrowing fails on retry path." });
    ev.push({ type: "editor_navigation", ts: next(15_000), kind: "def-jump", fromFile: featFile, toFile: "src/payments/types.ts", msSinceEdit: 5_000 });
    ev.push({ type: "text_change", ts: next(20_000), file: featFile, charsAdded: 22, charsRemoved: 8 });
    ev.push({ type: "file_saved", ts: next(2_000), path: featFile, errorCount: 0 });
    ev.push({ type: "diagnostic_resolved", ts: next(100), file: featFile, line: 60 + day, durationMs: 35_000 });

    ev.push({ type: "test_run_result", ts: next(800), file: testFile, tests: 6, passed: 6, durationMs: 1_180, trigger: "save" });
    ev.push({ type: "test_run_result", ts: next(120_000), file: testFile, tests: 6, passed: 6, durationMs: 1_200, trigger: "manual" });

    ev.push({ type: "concept_encountered", ts: next(60_000), file: featFile, concept: "postgres/transaction", language: "typescript" });
    ev.push({ type: "concept_encountered", ts: next(500), file: featFile, concept: "queue/idempotency", language: "typescript" });

    ev.push({ type: "line_diff", ts: next(60_000), file: featFile, linesAdded: 32, linesRemoved: 8, rewrittenFingerprints: noFingerprints() });
    ev.push({ type: "commit_detected", ts: next(1_000), sha: `sb${5 + day}`, message: `feat(payments): feature${day} with contract test — bounded retry, idempotency-key honored, behavior documented in PR description for downstream callers`, filesTouched: [featFile, testFile] });
  }

  ev.push({ type: "session_boundary", ts: next(120_000), kind: "end", reason: "idle", activeMs: 3_900_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// Persona 8 — Security Senior (senior / sec / ~739)
// Behavior: deep adversarial reads, NO AI events, fuzzing/property tests,
// methodical hypothesis-driven debug, meticulous commits with threat notes.
// ---------------------------------------------------------------------------
function securitySeniorEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });

  // Threat-modeling read of an auth endpoint
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/auth/sessionToken.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "symbol-search", fromFile: "src/auth/sessionToken.ts", toFile: "src/auth/sessionToken.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "find-refs", fromFile: "src/auth/sessionToken.ts", toFile: "src/auth/sessionToken.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/auth/sessionToken.ts", toFile: "src/auth/crypto.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "find-refs", fromFile: "src/auth/crypto.ts", toFile: "src/auth/crypto.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/auth/crypto.ts", toFile: "src/auth/__tests__/sessionToken.fuzz.test.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 320_000, navCount: 5 });

  // Notes a hypothesis — proof of exploit test
  ev.push({ type: "file_focus_change", ts: next(60_000), file: "src/auth/__tests__/sessionToken.fuzz.test.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(180_000), file: "src/auth/__tests__/sessionToken.fuzz.test.ts", charsAdded: 580, charsRemoved: 0 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "src/auth/__tests__/sessionToken.fuzz.test.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(120_000), file: "src/auth/__tests__/sessionToken.fuzz.test.ts", charsAdded: 240, charsRemoved: 30 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/auth/__tests__/sessionToken.fuzz.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(3_500), file: "src/auth/__tests__/sessionToken.fuzz.test.ts", tests: 12, passed: 11, durationMs: 5_400, trigger: "manual" });

  // Diagnostic appears — confirms exploit
  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "src/auth/sessionToken.ts", line: 64, severity: "error", message: "Timing leak: token compare is non-constant-time." });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/auth/sessionToken.ts", toFile: "src/auth/crypto.ts", msSinceEdit: 5_000 });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/auth/sessionToken.ts", charsAdded: 30, charsRemoved: 22 });
  ev.push({ type: "keystroke_burst", ts: next(3_000), file: "src/auth/sessionToken.ts", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/auth/sessionToken.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/auth/sessionToken.ts", line: 64, durationMs: 95_000 });

  ev.push({ type: "test_run_result", ts: next(3_500), file: "src/auth/__tests__/sessionToken.fuzz.test.ts", tests: 12, passed: 12, durationMs: 5_300, trigger: "manual" });

  // Negative tests — adversarial inputs
  ev.push({ type: "file_focus_change", ts: next(60_000), file: "src/auth/__tests__/sessionToken.negative.test.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(180_000), file: "src/auth/__tests__/sessionToken.negative.test.ts", charsAdded: 720, charsRemoved: 0 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "src/auth/__tests__/sessionToken.negative.test.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(60_000), file: "src/auth/__tests__/sessionToken.negative.test.ts", charsAdded: 220, charsRemoved: 20 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/auth/__tests__/sessionToken.negative.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(2_000), file: "src/auth/__tests__/sessionToken.negative.test.ts", tests: 18, passed: 18, durationMs: 3_200, trigger: "manual" });

  // Concepts security
  ev.push({ type: "concept_encountered", ts: next(60_000), file: "src/auth/sessionToken.ts", concept: "crypto/timing-safe-equal", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/auth/sessionToken.ts", concept: "auth/jwt", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/auth/crypto.ts", concept: "crypto/hmac", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "src/auth/sessionToken.ts", concept: "owasp/a02-cryptographic-failures", language: "typescript" });

  ev.push({ type: "line_diff", ts: next(120_000), file: "src/auth/sessionToken.ts", linesAdded: 24, linesRemoved: 18, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "ss1", message: "fix(auth): timingSafeEqual for session-token compare — closes timing oracle that leaks ~1 byte per 2^16 attempts (threat-model: T-AUTH-009, see ADR-0091); fuzz + negative test added", filesTouched: ["src/auth/sessionToken.ts", "src/auth/__tests__/sessionToken.fuzz.test.ts", "src/auth/__tests__/sessionToken.negative.test.ts"] });

  // Day 2 — input-validation review of an endpoint
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 7_400_000 });
  ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });

  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/api/uploads/handler.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "symbol-search", fromFile: "src/api/uploads/handler.ts", toFile: "src/api/uploads/handler.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "find-refs", fromFile: "src/api/uploads/handler.ts", toFile: "src/api/uploads/handler.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/api/uploads/handler.ts", toFile: "src/api/uploads/contentTypeAllowlist.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 220_000, navCount: 3 });

  ev.push({ type: "diagnostic_appeared", ts: next(60_000), file: "src/api/uploads/handler.ts", line: 42, severity: "warning", message: "Filename trusted in path join — path traversal risk." });
  ev.push({ type: "text_change", ts: next(120_000), file: "src/api/uploads/handler.ts", charsAdded: 60, charsRemoved: 40 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "src/api/uploads/handler.ts", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/api/uploads/handler.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/api/uploads/handler.ts", line: 42, durationMs: 220_000 });

  // Fuzz the new validation
  ev.push({ type: "text_change", ts: next(120_000), file: "src/api/uploads/__tests__/handler.fuzz.test.ts", charsAdded: 540, charsRemoved: 0 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/api/uploads/__tests__/handler.fuzz.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(4_000), file: "src/api/uploads/__tests__/handler.fuzz.test.ts", tests: 22, passed: 22, durationMs: 6_800, trigger: "manual" });

  ev.push({ type: "commit_detected", ts: next(60_000), sha: "ss2", message: "fix(uploads): reject path-traversal filenames at the boundary; add allowlist-based content-type guard — threat-model T-FILE-003 closed; 22-case fuzz suite covers normalized + decoded + double-encoded forms", filesTouched: ["src/api/uploads/handler.ts", "src/api/uploads/contentTypeAllowlist.ts", "src/api/uploads/__tests__/handler.fuzz.test.ts"] });

  // Day 3 — review of teammate's AI-generated PR (no AI use here, just review fix)
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 7_900_000 });
  ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "src/api/admin/userImpersonation.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "find-refs", fromFile: "src/api/admin/userImpersonation.ts", toFile: "src/api/admin/userImpersonation.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: "src/api/admin/userImpersonation.ts", toFile: "src/auth/permissions.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 90_000, navCount: 2 });
  ev.push({ type: "diagnostic_appeared", ts: next(30_000), file: "src/api/admin/userImpersonation.ts", line: 22, severity: "error", message: "Audit log not emitted before privilege elevation." });
  ev.push({ type: "text_change", ts: next(45_000), file: "src/api/admin/userImpersonation.ts", charsAdded: 40, charsRemoved: 6 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "src/api/admin/userImpersonation.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "src/api/admin/userImpersonation.ts", line: 22, durationMs: 47_000 });
  ev.push({ type: "test_run_result", ts: next(2_000), file: "src/api/admin/__tests__/userImpersonation.test.ts", tests: 9, passed: 9, durationMs: 2_400, trigger: "manual" });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "ss3", message: "fix(admin): audit-log impersonation pre-elevation, fail-closed if logger unavailable — caught in review of PR #5102 where the AI-generated path emitted the log AFTER the role swap", filesTouched: ["src/api/admin/userImpersonation.ts", "src/api/admin/__tests__/userImpersonation.test.ts", "src/auth/permissions.ts"] });

  // Days 4–8 — sustained adversarial review + hardening (NO chat_turn, NO paste, NO ai_*).
  for (let day = 0; day < 5; day++) {
    ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 6_400_000 });
    ev.push({ type: "session_boundary", ts: next(40_000_000), kind: "start", reason: "fresh-start" });

    const ssAreas = ["billing", "exports", "webhooks", "search", "tenancy"];
    const target = `src/api/${ssAreas[day]}/handler.ts`;
    const fuzzTest = `src/api/${ssAreas[day]}/__tests__/handler.fuzz.test.ts`;
    const negTest = `src/api/${ssAreas[day]}/__tests__/handler.negative.test.ts`;

    ev.push({ type: "file_focus_change", ts: next(2_000), file: target, language: "typescript" });
    ev.push({ type: "editor_navigation", ts: next(15_000), kind: "symbol-search", fromFile: target, toFile: target, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(15_000), kind: "find-refs", fromFile: target, toFile: target, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(20_000), kind: "def-jump", fromFile: target, toFile: "src/auth/permissions.ts", msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(15_000), kind: "find-refs", fromFile: "src/auth/permissions.ts", toFile: "src/auth/permissions.ts", msSinceEdit: 0 });
    ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 200_000, navCount: 4 });

    const sinks = ["sql", "fs", "exec", "dns", "rls"];
    ev.push({ type: "diagnostic_appeared", ts: next(60_000), file: target, line: 40 + day, severity: "warning", message: `Trust boundary issue: input flows to ${sinks[day]} sink without normalization.` });
    ev.push({ type: "text_change", ts: next(120_000), file: target, charsAdded: 80, charsRemoved: 30 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: target, chars: 200 });
    ev.push({ type: "text_change", ts: next(40_000), file: target, charsAdded: 30, charsRemoved: 10 });
    ev.push({ type: "file_saved", ts: next(2_000), path: target, errorCount: 0 });
    ev.push({ type: "diagnostic_resolved", ts: next(100), file: target, line: 40 + day, durationMs: 165_000 });

    // Fuzz test
    ev.push({ type: "text_change", ts: next(150_000), file: fuzzTest, charsAdded: 540, charsRemoved: 0 });
    ev.push({ type: "keystroke_burst", ts: next(5_000), file: fuzzTest, chars: 200 });
    ev.push({ type: "text_change", ts: next(60_000), file: fuzzTest, charsAdded: 180, charsRemoved: 12 });
    ev.push({ type: "file_saved", ts: next(2_000), path: fuzzTest, errorCount: 0 });
    ev.push({ type: "test_run_result", ts: next(4_000), file: fuzzTest, tests: 18 + day, passed: 18 + day, durationMs: 5_400, trigger: "manual" });

    // Negative test
    ev.push({ type: "text_change", ts: next(120_000), file: negTest, charsAdded: 380, charsRemoved: 0 });
    ev.push({ type: "file_saved", ts: next(2_000), path: negTest, errorCount: 0 });
    ev.push({ type: "test_run_result", ts: next(2_000), file: negTest, tests: 12, passed: 12, durationMs: 2_400, trigger: "manual" });

    const concepts = ["sql/parameterized", "path/normalize", "shell/no-exec", "dns/no-resolve", "auth/row-level-security"];
    const vulnClasses = ["sql-injection", "path-traversal", "shell-injection", "dns-rebinding", "tenant-bleed"];
    ev.push({ type: "concept_encountered", ts: next(60_000), file: target, concept: concepts[day], language: "typescript" });
    ev.push({ type: "concept_encountered", ts: next(500), file: target, concept: "owasp/a03-injection", language: "typescript" });

    ev.push({ type: "line_diff", ts: next(60_000), file: target, linesAdded: 40, linesRemoved: 18, rewrittenFingerprints: noFingerprints() });
    ev.push({ type: "commit_detected", ts: next(1_000), sha: `ss${4 + day}`, message: `fix(${ssAreas[day]}): close ${vulnClasses[day]} class — threat-model T-IO-00${day + 4}; fuzz + negative suites added; audit log bumped to capture rejection cause for SOC2 evidence`, filesTouched: [target, fuzzTest, negTest, "docs/threat-model/auth.md"] });
  }

  ev.push({ type: "session_boundary", ts: next(120_000), kind: "end", reason: "idle", activeMs: 4_700_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// Persona 9 — DevOps Senior (senior / devOps / ~733)
// Behavior: failure-mode reads, confident AI for shell/terraform, thin tests,
// terse commit messages, log/metric correlation.
// ---------------------------------------------------------------------------
function devopsSeniorEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });

  // Terraform refactor
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "infra/terraform/modules/eks/main.tf", language: "terraform" });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: "infra/terraform/modules/eks/main.tf", toFile: "infra/terraform/modules/eks/main.tf", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "find-refs", fromFile: "infra/terraform/modules/eks/main.tf", toFile: "infra/terraform/modules/eks/main.tf", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(6_000), kind: "def-jump", fromFile: "infra/terraform/modules/eks/main.tf", toFile: "infra/terraform/modules/eks/variables.tf", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "deep", msToFirstEdit: 90_000, navCount: 3 });

  // Confident AI use for shell/tf
  ev.push({ type: "chat_turn", ts: next(60_000), intent: "request", charCount: 380, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: "infra/terraform/modules/eks/main.tf", chars: 420, charsAccepted: 420 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.45 });
  ev.push({ type: "text_change", ts: next(60_000), file: "infra/terraform/modules/eks/main.tf", charsAdded: 80, charsRemoved: 40 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "infra/terraform/modules/eks/main.tf", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "infra/terraform/modules/eks/main.tf", errorCount: 0 });

  // Shell script for log analysis
  ev.push({ type: "file_focus_change", ts: next(60_000), file: "scripts/audit-401s.sh", language: "shellscript" });
  ev.push({ type: "chat_turn", ts: next(20_000), intent: "request", charCount: 280, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: "scripts/audit-401s.sh", chars: 340, charsAccepted: 340 });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.30 });
  ev.push({ type: "text_change", ts: next(20_000), file: "scripts/audit-401s.sh", charsAdded: 30, charsRemoved: 12 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "scripts/audit-401s.sh", errorCount: 0 });

  // K8s ingress config tweak
  ev.push({ type: "file_focus_change", ts: next(60_000), file: "infra/k8s/ingress.yaml", language: "yaml" });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: "infra/k8s/ingress.yaml", toFile: "infra/k8s/ingress.yaml", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "skim", msToFirstEdit: 22_000, navCount: 1 });
  ev.push({ type: "text_change", ts: next(40_000), file: "infra/k8s/ingress.yaml", charsAdded: 60, charsRemoved: 20 });
  ev.push({ type: "keystroke_burst", ts: next(3_000), file: "infra/k8s/ingress.yaml", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "infra/k8s/ingress.yaml", errorCount: 0 });

  // Diagnostic — caught by terraform plan validation
  ev.push({ type: "diagnostic_appeared", ts: next(20_000), file: "infra/terraform/modules/eks/main.tf", line: 42, severity: "warning", message: "Cluster autoscaler IAM trust policy missing OIDC condition." });
  ev.push({ type: "text_change", ts: next(60_000), file: "infra/terraform/modules/eks/main.tf", charsAdded: 40, charsRemoved: 20 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "infra/terraform/modules/eks/main.tf", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "infra/terraform/modules/eks/main.tf", line: 42, durationMs: 62_000 });

  // Thin test — one integration smoke
  ev.push({ type: "file_focus_change", ts: next(30_000), file: "test/smoke/eks_module_test.go", language: "go" });
  ev.push({ type: "text_change", ts: next(60_000), file: "test/smoke/eks_module_test.go", charsAdded: 180, charsRemoved: 6 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "test/smoke/eks_module_test.go", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(8_000), file: "test/smoke/eks_module_test.go", tests: 1, passed: 1, durationMs: 22_000, trigger: "manual" });

  // Concepts devops
  ev.push({ type: "concept_encountered", ts: next(60_000), file: "infra/terraform/modules/eks/main.tf", concept: "aws/iam-irsa", language: "terraform" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "infra/k8s/ingress.yaml", concept: "k8s/ingress-nginx", language: "yaml" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "infra/k8s/ingress.yaml", concept: "k8s/cert-manager", language: "yaml" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "infra/terraform/modules/eks/main.tf", concept: "aws/eks", language: "terraform" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "infra/terraform/modules/eks/main.tf", concept: "terraform/module", language: "terraform" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "scripts/audit-401s.sh", concept: "observability/loki", language: "shellscript" });

  // Terse commit
  ev.push({ type: "line_diff", ts: next(60_000), file: "infra/terraform/modules/eks/main.tf", linesAdded: 60, linesRemoved: 30, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "do1", message: "rollout v2 of the ingress config", filesTouched: ["infra/terraform/modules/eks/main.tf", "infra/terraform/modules/eks/variables.tf", "infra/k8s/ingress.yaml", "scripts/audit-401s.sh", "test/smoke/eks_module_test.go"] });

  // Day 2 — incident: prod p99 latency
  ev.push({ type: "session_boundary", ts: next(15_000_000), kind: "end", reason: "idle", activeMs: 5_900_000 });
  ev.push({ type: "session_boundary", ts: next(30_000_000), kind: "start", reason: "fresh-start" });

  // Read failure-mode first — observability config
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "infra/observability/prometheus/rules.yaml", language: "yaml" });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: "infra/observability/prometheus/rules.yaml", toFile: "infra/observability/prometheus/rules.yaml", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "skim", msToFirstEdit: 18_000, navCount: 1 });

  ev.push({ type: "chat_turn", ts: next(60_000), intent: "debug", charCount: 540, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.50 });
  ev.push({ type: "text_change", ts: next(45_000), file: "infra/observability/prometheus/rules.yaml", charsAdded: 60, charsRemoved: 18 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "infra/observability/prometheus/rules.yaml", errorCount: 0 });

  // Hotfix on a service config
  ev.push({ type: "file_focus_change", ts: next(60_000), file: "infra/k8s/api-deployment.yaml", language: "yaml" });
  ev.push({ type: "text_change", ts: next(20_000), file: "infra/k8s/api-deployment.yaml", charsAdded: 40, charsRemoved: 16 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "infra/k8s/api-deployment.yaml", errorCount: 0 });
  ev.push({ type: "diagnostic_appeared", ts: next(30_000), file: "infra/k8s/api-deployment.yaml", line: 28, severity: "warning", message: "readiness probe timeout shorter than typical p99 startup." });
  ev.push({ type: "text_change", ts: next(20_000), file: "infra/k8s/api-deployment.yaml", charsAdded: 20, charsRemoved: 6 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "infra/k8s/api-deployment.yaml", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "infra/k8s/api-deployment.yaml", line: 28, durationMs: 22_000 });

  ev.push({ type: "commit_detected", ts: next(60_000), sha: "do2", message: "bump api readiness probe", filesTouched: ["infra/k8s/api-deployment.yaml", "infra/observability/prometheus/rules.yaml"] });

  // Day 3 — runbook + small TF change
  ev.push({ type: "session_boundary", ts: next(15_000_000), kind: "end", reason: "idle", activeMs: 4_200_000 });
  ev.push({ type: "session_boundary", ts: next(30_000_000), kind: "start", reason: "fresh-start" });
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "docs/runbooks/eks-node-pressure.md", language: "markdown" });
  ev.push({ type: "text_change", ts: next(180_000), file: "docs/runbooks/eks-node-pressure.md", charsAdded: 540, charsRemoved: 30 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "docs/runbooks/eks-node-pressure.md", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "docs/runbooks/eks-node-pressure.md", errorCount: 0 });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "do3", message: "runbook for eks node pressure", filesTouched: ["docs/runbooks/eks-node-pressure.md"] });

  // Days 4–8 — sustained ops cadence: TF/k8s/observability tweaks, terse commits
  for (let day = 0; day < 5; day++) {
    ev.push({ type: "session_boundary", ts: next(15_000_000), kind: "end", reason: "idle", activeMs: 4_800_000 });
    ev.push({ type: "session_boundary", ts: next(36_000_000), kind: "start", reason: "fresh-start" });

    const doTfNames = ["rds", "alb", "vpc", "ecr", "kms"];
    const doYamlNames = ["api", "worker", "scheduler", "ingestor", "exporter"];
    const doShNames = ["audit-rds-iops", "drain-asg", "rotate-creds", "tail-loki", "audit-kms-grants"];
    const tfFile = `infra/terraform/modules/${doTfNames[day]}/main.tf`;
    const yamlFile = `infra/k8s/${doYamlNames[day]}-deployment.yaml`;
    const shFile = `scripts/${doShNames[day]}.sh`;

    ev.push({ type: "file_focus_change", ts: next(2_000), file: tfFile, language: "terraform" });
    ev.push({ type: "editor_navigation", ts: next(8_000), kind: "symbol-search", fromFile: tfFile, toFile: tfFile, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(6_000), kind: "find-refs", fromFile: tfFile, toFile: tfFile, msSinceEdit: 0 });
    ev.push({ type: "read_pattern_observed", ts: next(4_000), pattern: "skim", msToFirstEdit: 30_000, navCount: 2 });

    ev.push({ type: "chat_turn", ts: next(45_000), intent: "request", charCount: 320 + day * 20, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
    ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: tfFile, chars: 380, charsAccepted: 380 });
    ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.40 });
    ev.push({ type: "text_change", ts: next(40_000), file: tfFile, charsAdded: 60, charsRemoved: 20 });
    ev.push({ type: "keystroke_burst", ts: next(3_000), file: tfFile, chars: 200 });
    ev.push({ type: "file_saved", ts: next(2_000), path: tfFile, errorCount: 0 });

    ev.push({ type: "file_focus_change", ts: next(60_000), file: yamlFile, language: "yaml" });
    ev.push({ type: "text_change", ts: next(30_000), file: yamlFile, charsAdded: 40, charsRemoved: 18 });
    ev.push({ type: "file_saved", ts: next(2_000), path: yamlFile, errorCount: 0 });

    ev.push({ type: "file_focus_change", ts: next(60_000), file: shFile, language: "shellscript" });
    ev.push({ type: "chat_turn", ts: next(20_000), intent: "request", charCount: 240, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
    ev.push({ type: "ai_suggestion_accepted", ts: next(2_000), file: shFile, chars: 320, charsAccepted: 320 });
    ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.35 });
    ev.push({ type: "text_change", ts: next(20_000), file: shFile, charsAdded: 30, charsRemoved: 10 });
    ev.push({ type: "file_saved", ts: next(2_000), path: shFile, errorCount: 0 });

    if (day === 1 || day === 3 || day === 4) {
      const policyIssues = ["over-broad", "missing-condition", "over-broad", "missing-condition", "duplicate-grant"];
      ev.push({ type: "diagnostic_appeared", ts: next(20_000), file: tfFile, line: 30 + day, severity: "warning", message: `IAM policy ${policyIssues[day]}.` });
      ev.push({ type: "text_change", ts: next(40_000), file: tfFile, charsAdded: 30, charsRemoved: 12 });
      ev.push({ type: "file_saved", ts: next(2_000), path: tfFile, errorCount: 0 });
      ev.push({ type: "diagnostic_resolved", ts: next(100), file: tfFile, line: 30 + day, durationMs: 42_000 });
    }

    ev.push({ type: "test_run_result", ts: next(8_000), file: `test/smoke/${doTfNames[day]}_module_test.go`, tests: 1, passed: 1, durationMs: 22_000, trigger: "manual" });

    const doConcepts = ["aws/rds", "aws/alb", "aws/vpc", "aws/ecr", "aws/kms"];
    ev.push({ type: "concept_encountered", ts: next(60_000), file: tfFile, concept: doConcepts[day], language: "terraform" });
    ev.push({ type: "concept_encountered", ts: next(500), file: yamlFile, concept: "k8s/deployment", language: "yaml" });

    const doCommitMsgs = ["bump rds iops", "alb idle timeout fix", "vpc cidr expand", "ecr lifecycle rule", "kms key rotation"];
    ev.push({ type: "commit_detected", ts: next(60_000), sha: `do${4 + day}`, message: doCommitMsgs[day], filesTouched: [tfFile, yamlFile, shFile] });
  }

  ev.push({ type: "session_boundary", ts: next(120_000), kind: "end", reason: "idle", activeMs: 3_400_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// Persona 10 — Polyglot Staff (senior / generalist / ~902)
// Behavior: 5-min mental-model reads in any language, surgical AI as peer
// reviewer, broad test coverage, pristine commits, multi-language work.
// ---------------------------------------------------------------------------
function polyglotStaffEvents(): EchoEvent[] {
  const next = makeClock();
  const ev: EchoEvent[] = [];

  ev.push({ type: "session_boundary", ts: next(0), kind: "start", reason: "fresh-start" });

  // Day 1 — cross-team architectural fix: TS gateway + Python worker + Rust hotpath
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "services/gateway/src/router.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "symbol-search", fromFile: "services/gateway/src/router.ts", toFile: "services/gateway/src/router.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "find-refs", fromFile: "services/gateway/src/router.ts", toFile: "services/gateway/src/router.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(10_000), kind: "def-jump", fromFile: "services/gateway/src/router.ts", toFile: "services/gateway/src/clients/worker.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 220_000, navCount: 3 });

  ev.push({ type: "file_focus_change", ts: next(30_000), file: "services/worker/src/dispatcher.py", language: "python" });
  ev.push({ type: "editor_navigation", ts: next(10_000), kind: "symbol-search", fromFile: "services/worker/src/dispatcher.py", toFile: "services/worker/src/dispatcher.py", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "def-jump", fromFile: "services/worker/src/dispatcher.py", toFile: "services/worker/src/queue.py", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 90_000, navCount: 2 });

  ev.push({ type: "file_focus_change", ts: next(30_000), file: "services/hotpath/src/lib.rs", language: "rust" });
  ev.push({ type: "editor_navigation", ts: next(10_000), kind: "symbol-search", fromFile: "services/hotpath/src/lib.rs", toFile: "services/hotpath/src/lib.rs", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(10_000), kind: "find-refs", fromFile: "services/hotpath/src/lib.rs", toFile: "services/hotpath/src/lib.rs", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 80_000, navCount: 2 });

  // Surgical AI — peer reviewer
  ev.push({ type: "chat_turn", ts: next(60_000), intent: "plan", charCount: 880, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsQuestionMark: true, containsExplainKeyword: true, acceptedAi: false });
  ev.push({ type: "chat_turn", ts: next(120_000), intent: "specific", charCount: 620, containsStackTraceOrLineRef: false, containsConstraintWords: true, acceptedAi: true });
  ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.50 });
  ev.push({ type: "ai_suggestion_rejected", ts: next(180_000), file: "services/gateway/src/router.ts" });

  // Implement gateway changes
  ev.push({ type: "file_focus_change", ts: next(20_000), file: "services/gateway/src/router.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(60_000), file: "services/gateway/src/router.ts", charsAdded: 120, charsRemoved: 40 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "services/gateway/src/router.ts", chars: 200 });
  ev.push({ type: "text_change", ts: next(40_000), file: "services/gateway/src/router.ts", charsAdded: 60, charsRemoved: 20 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "services/gateway/src/router.ts", errorCount: 0 });

  // Diagnostic in TS
  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "services/gateway/src/router.ts", line: 102, severity: "error", message: "RpcEnvelope generic does not align with worker schema." });
  ev.push({ type: "editor_navigation", ts: next(15_000), kind: "def-jump", fromFile: "services/gateway/src/router.ts", toFile: "packages/proto/src/envelope.ts", msSinceEdit: 5_000 });
  ev.push({ type: "text_change", ts: next(40_000), file: "packages/proto/src/envelope.ts", charsAdded: 30, charsRemoved: 8 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "packages/proto/src/envelope.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "services/gateway/src/router.ts", line: 102, durationMs: 60_000 });

  // Python worker changes
  ev.push({ type: "file_focus_change", ts: next(30_000), file: "services/worker/src/dispatcher.py", language: "python" });
  ev.push({ type: "text_change", ts: next(80_000), file: "services/worker/src/dispatcher.py", charsAdded: 140, charsRemoved: 40 });
  ev.push({ type: "keystroke_burst", ts: next(5_000), file: "services/worker/src/dispatcher.py", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "services/worker/src/dispatcher.py", errorCount: 0 });

  // Rust hotpath
  ev.push({ type: "file_focus_change", ts: next(30_000), file: "services/hotpath/src/lib.rs", language: "rust" });
  ev.push({ type: "text_change", ts: next(60_000), file: "services/hotpath/src/lib.rs", charsAdded: 80, charsRemoved: 30 });
  ev.push({ type: "keystroke_burst", ts: next(4_000), file: "services/hotpath/src/lib.rs", chars: 200 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "services/hotpath/src/lib.rs", errorCount: 0 });

  ev.push({ type: "diagnostic_appeared", ts: next(500), file: "services/hotpath/src/lib.rs", line: 88, severity: "warning", message: "lifetime elision ambiguous on RpcEnvelope<'a>" });
  ev.push({ type: "text_change", ts: next(60_000), file: "services/hotpath/src/lib.rs", charsAdded: 22, charsRemoved: 8 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "services/hotpath/src/lib.rs", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "services/hotpath/src/lib.rs", line: 88, durationMs: 65_000 });

  // Tests across all three languages
  ev.push({ type: "file_focus_change", ts: next(30_000), file: "services/gateway/src/__tests__/router.test.ts", language: "typescript" });
  ev.push({ type: "text_change", ts: next(120_000), file: "services/gateway/src/__tests__/router.test.ts", charsAdded: 380, charsRemoved: 12 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "services/gateway/src/__tests__/router.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(900), file: "services/gateway/src/__tests__/router.test.ts", tests: 14, passed: 14, durationMs: 1_400, trigger: "save" });

  ev.push({ type: "file_focus_change", ts: next(30_000), file: "services/worker/tests/test_dispatcher.py", language: "python" });
  ev.push({ type: "text_change", ts: next(120_000), file: "services/worker/tests/test_dispatcher.py", charsAdded: 320, charsRemoved: 8 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "services/worker/tests/test_dispatcher.py", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(2_500), file: "services/worker/tests/test_dispatcher.py", tests: 10, passed: 10, durationMs: 3_400, trigger: "manual" });

  ev.push({ type: "file_focus_change", ts: next(30_000), file: "services/hotpath/src/lib.rs", language: "rust" });
  ev.push({ type: "text_change", ts: next(80_000), file: "services/hotpath/src/lib.rs", charsAdded: 220, charsRemoved: 0 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "services/hotpath/src/lib.rs", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(3_000), file: "services/hotpath/src/lib.rs", tests: 8, passed: 8, durationMs: 4_200, trigger: "manual" });

  // Concepts polyglot
  ev.push({ type: "concept_encountered", ts: next(60_000), file: "services/gateway/src/router.ts", concept: "rpc/envelope", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "services/gateway/src/router.ts", concept: "express/router", language: "typescript" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "services/worker/src/dispatcher.py", concept: "asyncio/event-loop", language: "python" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "services/worker/src/queue.py", concept: "queue/idempotency", language: "python" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "services/hotpath/src/lib.rs", concept: "rust/lifetime", language: "rust" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "services/hotpath/src/lib.rs", concept: "rust/zero-copy", language: "rust" });
  ev.push({ type: "concept_encountered", ts: next(500), file: "packages/proto/src/envelope.ts", concept: "proto/codegen", language: "typescript" });

  // Pristine commit — design-doc-quality message
  ev.push({ type: "line_diff", ts: next(60_000), file: "services/gateway/src/router.ts", linesAdded: 80, linesRemoved: 30, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "line_diff", ts: next(1_000), file: "services/worker/src/dispatcher.py", linesAdded: 100, linesRemoved: 30, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "line_diff", ts: next(1_000), file: "services/hotpath/src/lib.rs", linesAdded: 60, linesRemoved: 22, rewrittenFingerprints: noFingerprints() });
  ev.push({ type: "commit_detected", ts: next(1_000), sha: "ps1", message: "feat(rpc): unify RpcEnvelope across gateway/worker/hotpath with versioned schema — eliminates the parallel-evolution drift that produced incident #4421; gateway re-enables strict generics, worker keeps its msgpack fallback for v1 callers, hotpath drops its custom decoder", filesTouched: ["services/gateway/src/router.ts", "services/gateway/src/clients/worker.ts", "services/gateway/src/__tests__/router.test.ts", "services/worker/src/dispatcher.py", "services/worker/src/queue.py", "services/worker/tests/test_dispatcher.py", "services/hotpath/src/lib.rs", "packages/proto/src/envelope.ts"] });

  // Day 2 — coaching review of teammate's design
  ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 8_400_000 });
  ev.push({ type: "session_boundary", ts: next(36_000_000), kind: "start", reason: "fresh-start" });
  ev.push({ type: "file_focus_change", ts: next(2_000), file: "services/billing/src/invoiceJob.ts", language: "typescript" });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "find-refs", fromFile: "services/billing/src/invoiceJob.ts", toFile: "services/billing/src/invoiceJob.ts", msSinceEdit: 0 });
  ev.push({ type: "editor_navigation", ts: next(8_000), kind: "def-jump", fromFile: "services/billing/src/invoiceJob.ts", toFile: "services/billing/src/__tests__/invoiceJob.test.ts", msSinceEdit: 0 });
  ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 120_000, navCount: 2 });
  ev.push({ type: "diagnostic_appeared", ts: next(30_000), file: "services/billing/src/invoiceJob.ts", line: 88, severity: "warning", message: "Missing idempotency key on retry path." });
  ev.push({ type: "text_change", ts: next(60_000), file: "services/billing/src/invoiceJob.ts", charsAdded: 60, charsRemoved: 20 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "services/billing/src/invoiceJob.ts", errorCount: 0 });
  ev.push({ type: "diagnostic_resolved", ts: next(100), file: "services/billing/src/invoiceJob.ts", line: 88, durationMs: 62_000 });
  ev.push({ type: "text_change", ts: next(80_000), file: "services/billing/src/__tests__/invoiceJob.test.ts", charsAdded: 280, charsRemoved: 8 });
  ev.push({ type: "file_saved", ts: next(2_000), path: "services/billing/src/__tests__/invoiceJob.test.ts", errorCount: 0 });
  ev.push({ type: "test_run_result", ts: next(900), file: "services/billing/src/__tests__/invoiceJob.test.ts", tests: 12, passed: 12, durationMs: 1_300, trigger: "save" });
  ev.push({ type: "commit_detected", ts: next(60_000), sha: "ps2", message: "fix(billing): idempotency-key on invoice retry path — closes the duplicate-charge class of bug for the whole billing service; pattern documented in services/billing/README.md so the next handler doesn't repeat the omission", filesTouched: ["services/billing/src/invoiceJob.ts", "services/billing/src/__tests__/invoiceJob.test.ts", "services/billing/README.md"] });

  // Days 3–7 — sustained cross-team output: TS frontend, ML serving, Rust hotpath, Go broker, C embedded
  for (let day = 0; day < 5; day++) {
    ev.push({ type: "session_boundary", ts: next(20_000_000), kind: "end", reason: "idle", activeMs: 7_400_000 });
    ev.push({ type: "session_boundary", ts: next(36_000_000), kind: "start", reason: "fresh-start" });

    const langs: Array<{ ext: string; lang: string; concept: string; service: string }> = [
      { ext: "ts", lang: "typescript", concept: "rpc/envelope", service: "frontend" },
      { ext: "py", lang: "python", concept: "torch/cross-entropy", service: "serving" },
      { ext: "rs", lang: "rust", concept: "rust/zero-copy", service: "hotpath" },
      { ext: "go", lang: "go", concept: "queue/idempotency", service: "broker" },
      { ext: "c", lang: "c", concept: "embedded/dma-ring", service: "firmware" },
    ];
    const cfg = langs[day];
    const featFile = `services/${cfg.service}/src/feature${day}.${cfg.ext}`;
    const testFile = cfg.ext === "py" ? `services/${cfg.service}/tests/test_feature${day}.py` : cfg.ext === "rs" ? `services/${cfg.service}/src/feature${day}.${cfg.ext}` : cfg.ext === "go" ? `services/${cfg.service}/feature${day}_test.go` : `services/${cfg.service}/src/__tests__/feature${day}.test.ts`;

    ev.push({ type: "file_focus_change", ts: next(2_000), file: featFile, language: cfg.lang });
    const typesFile = cfg.ext === "py" ? `services/${cfg.service}/src/types.py` : cfg.ext === "c" ? `services/${cfg.service}/src/types.h` : cfg.ext === "go" ? `services/${cfg.service}/types.go` : `services/${cfg.service}/src/types.${cfg.ext}`;
    ev.push({ type: "editor_navigation", ts: next(15_000), kind: "symbol-search", fromFile: featFile, toFile: featFile, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(8_000), kind: "find-refs", fromFile: featFile, toFile: featFile, msSinceEdit: 0 });
    ev.push({ type: "editor_navigation", ts: next(10_000), kind: "def-jump", fromFile: featFile, toFile: typesFile, msSinceEdit: 0 });
    ev.push({ type: "read_pattern_observed", ts: next(5_000), pattern: "deep", msToFirstEdit: 130_000, navCount: 3 });

    ev.push({ type: "chat_turn", ts: next(60_000), intent: "specific", charCount: 540 + day * 20, containsStackTraceOrLineRef: false, containsConstraintWords: true, containsQuestionMark: true, acceptedAi: true });
    ev.push({ type: "ai_accept_outcome_observed", ts: next(30_000), outcome: "iterated", editFraction: 0.55 });

    ev.push({ type: "text_change", ts: next(60_000), file: featFile, charsAdded: 100, charsRemoved: 30 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: featFile, chars: 200 });
    ev.push({ type: "text_change", ts: next(40_000), file: featFile, charsAdded: 60, charsRemoved: 20 });
    ev.push({ type: "file_saved", ts: next(2_000), path: featFile, errorCount: 1 });

    const psBoundaries = ["nullable", "shape", "lifetime", "context", "alignment"];
    ev.push({ type: "diagnostic_appeared", ts: next(500), file: featFile, line: 60 + day, severity: "warning", message: `Boundary check needed for ${psBoundaries[day]}.` });
    ev.push({ type: "text_change", ts: next(30_000), file: featFile, charsAdded: 22, charsRemoved: 8 });
    ev.push({ type: "file_saved", ts: next(2_000), path: featFile, errorCount: 0 });
    ev.push({ type: "diagnostic_resolved", ts: next(100), file: featFile, line: 60 + day, durationMs: 32_000 });

    ev.push({ type: "text_change", ts: next(60_000), file: testFile, charsAdded: 320, charsRemoved: 0 });
    ev.push({ type: "keystroke_burst", ts: next(4_000), file: testFile, chars: 200 });
    ev.push({ type: "file_saved", ts: next(2_000), path: testFile, errorCount: 0 });
    ev.push({ type: "test_run_result", ts: next(2_500), file: testFile, tests: 8 + day, passed: 8 + day, durationMs: 1_400 + day * 200, trigger: "manual" });

    ev.push({ type: "concept_encountered", ts: next(60_000), file: featFile, concept: cfg.concept, language: cfg.lang });

    ev.push({ type: "line_diff", ts: next(60_000), file: featFile, linesAdded: 60, linesRemoved: 22, rewrittenFingerprints: noFingerprints() });
    ev.push({ type: "commit_detected", ts: next(1_000), sha: `ps${3 + day}`, message: `feat(${cfg.service}): cross-cutting feature${day} — landed via the ${cfg.lang} surface so callers in other services can adopt incrementally; PR description includes the migration steps that ops will need on rollout day`, filesTouched: [featFile, testFile, `services/${cfg.service}/README.md`] });
  }

  ev.push({ type: "session_boundary", ts: next(120_000), kind: "end", reason: "idle", activeMs: 5_400_000 });
  return ev;
}

// ---------------------------------------------------------------------------
// V2_PERSONAS export
// ---------------------------------------------------------------------------

const FIELD_WEB: Iq3FieldId = "web";
const FIELD_ML: Iq3FieldId = "ml";
const FIELD_MOBILE: Iq3FieldId = "mobile";
const FIELD_SEC: Iq3FieldId = "sec";
const FIELD_DEVOPS: Iq3FieldId = "devOps";
const FIELD_GENERALIST: Iq3FieldId = "generalist";

export const V2_PERSONAS: Persona[] = [
  {
    id: "v2B:bootcampGrad",
    description: "Bootcamp grad, 3 months in — learner / web. Vague AI prompts, jump-in reads, fix/wip commits.",
    field: {
      repoSignals: {
        packageJsonDeps: ["react", "react-dom", "next", "tailwindcss", "vite"],
        fileExtensions: { ".tsx": 28, ".ts": 12, ".css": 6 },
      },
      conceptCounts: {
        "react/useState": 8,
        "react/useEffect": 6,
      },
      selfDeclared: FIELD_WEB,
    },
    events: bootcampGradEvents,
    expect: {
      rank: "learner",
      dominantField: FIELD_WEB,
      headlineRange: [175, 275],
    },
  },
  {
    id: "v2B:earnestJunior",
    description: "Earnest junior, year two — junior / web. Conventional commits, paragraph AI prompts, happy-path tests.",
    field: {
      repoSignals: {
        packageJsonDeps: ["react", "next", "express", "zod", "prisma", "tailwindcss", "vitest"],
        fileExtensions: { ".tsx": 40, ".ts": 70, ".test.ts": 20 },
      },
      conceptCounts: {
        "express/router": 12,
        "zod/schema": 8,
        "react/useState": 10,
      },
      selfDeclared: FIELD_WEB,
    },
    events: earnestJuniorEvents,
    expect: {
      rank: "junior",
      dominantField: FIELD_WEB,
      headlineRange: [520, 620],
    },
  },
  {
    id: "v2B:vibecoder",
    description: "Vibecoder, 1.5y — learner / web. Pastes whole files, mixed-concern AI commits, reverts.",
    field: {
      repoSignals: {
        packageJsonDeps: ["react", "next", "tailwindcss", "@tanstack/react-query"],
        fileExtensions: { ".tsx": 50, ".ts": 18, ".css": 10 },
      },
      conceptCounts: {
        "react/useState": 14,
        "react/useEffect": 12,
      },
      selfDeclared: FIELD_WEB,
    },
    events: vibecoderEvents,
    expect: {
      rank: "learner",
      dominantField: FIELD_WEB,
      headlineRange: [204, 304],
    },
  },
  {
    id: "v2B:pragmaticMid",
    description: "Pragmatic mid, 4y — mid / web. Failing-test-first, structured prompts, atomic commits.",
    field: {
      repoSignals: {
        packageJsonDeps: ["express", "@nestjs/core", "prisma", "zod", "vitest", "supertest", "fast-check"],
        fileExtensions: { ".ts": 130, ".tsx": 40, ".test.ts": 50, ".sql": 10 },
      },
      conceptCounts: {
        "postgres/transaction": 10,
        "express/router": 14,
        "decimal/precision": 4,
      },
      selfDeclared: FIELD_WEB,
    },
    events: pragmaticMidEvents,
    expect: {
      rank: "mid",
      dominantField: FIELD_WEB,
      headlineRange: [658, 758],
    },
  },
  {
    id: "v2B:mlResearcher",
    description: "ML researcher turned engineer, 5y — mid / ml. Deep tensor-shape reads, property tests, batched commits.",
    field: {
      repoSignals: {
        requirementsTxt: ["torch", "transformers", "datasets", "accelerate", "lightning", "numpy", "pandas", "hypothesis"],
        fileExtensions: { ".py": 110, ".ipynb": 22, ".sh": 6 },
      },
      conceptCounts: {
        "torch/multi-head-attention": 6,
        "torch/rotary-embedding": 3,
        "torch/cross-entropy": 5,
        "torch/autocast": 4,
        "torch/grad-scaler": 3,
      },
      selfDeclared: FIELD_ML,
    },
    events: mlResearcherEvents,
    expect: {
      rank: "mid",
      dominantField: FIELD_ML,
      headlineRange: [596, 696],
    },
  },
  {
    id: "v2B:mobileMid",
    description: "Mobile mid, 6y iOS — mid / mobile. SwiftUI/Combine fluent, snapshot+VM tests, AI for boilerplate.",
    field: {
      repoSignals: {
        fileExtensions: { ".swift": 180, ".m": 8, ".storyboard": 4, ".xcconfig": 6 },
      },
      conceptCounts: {
        "swiftui/observable": 12,
        "swift/async-await": 14,
        "combine/publisher": 8,
        "coredata/persistent-container": 4,
        "uikit/uiviewrepresentable": 3,
      },
      selfDeclared: FIELD_MOBILE,
    },
    events: mobileMidEvents,
    expect: {
      rank: "mid",
      dominantField: FIELD_MOBILE,
      headlineRange: [655, 755],
    },
  },
  {
    id: "v2B:seniorBackend",
    description: "Senior backend architect, 11y fintech — senior / web. Module-boundary reads, contract tests, runbook commits.",
    field: {
      repoSignals: {
        packageJsonDeps: ["express", "@nestjs/core", "fastify", "prisma", "drizzle-orm", "pg", "vitest", "fast-check", "supertest", "pino"],
        fileExtensions: { ".ts": 320, ".sql": 28, ".test.ts": 110 },
        infraFiles: ["docker-compose.yml", ".github/workflows/ci.yml"],
      },
      conceptCounts: {
        "postgres/transaction": 18,
        "consistency/serializable": 6,
        "queue/idempotency": 8,
        "express/router": 22,
      },
      selfDeclared: FIELD_WEB,
    },
    events: seniorBackendEvents,
    expect: {
      rank: "senior",
      uncappedRank: "senior",
      dominantField: FIELD_WEB,
      headlineRange: [791, 891],
    },
  },
  {
    id: "v2B:securitySenior",
    description: "Security senior, 12y appsec — senior / sec. NO AI, deep adversarial reads, fuzz/negative tests, threat-model commits.",
    field: {
      repoSignals: {
        packageJsonDeps: ["fastify", "express", "jsonwebtoken", "argon2", "zod", "vitest", "fast-check", "@types/node"],
        fileExtensions: { ".ts": 240, ".test.ts": 90, ".md": 18 },
        infraFiles: ["SECURITY.md", "docs/threat-model/auth.md"],
      },
      conceptCounts: {
        "crypto/timing-safe-equal": 4,
        "crypto/hmac": 6,
        "auth/jwt": 8,
        "owasp/a02-cryptographic-failures": 3,
      },
      selfDeclared: FIELD_SEC,
    },
    events: securitySeniorEvents,
    expect: {
      rank: "senior",
      uncappedRank: "senior",
      dominantField: FIELD_SEC,
      headlineRange: [689, 789],
    },
  },
  {
    id: "v2B:devopsSenior",
    description: "DevOps senior, 9y SRE — senior / devOps. Terraform/K8s/observability, thin tests, terse commits.",
    field: {
      repoSignals: {
        goMod: ["github.com/gruntwork-io/terratest"],
        fileExtensions: { ".tf": 90, ".yaml": 70, ".sh": 24, ".go": 18, ".md": 14 },
        infraFiles: [
          "infra/terraform/modules/eks/main.tf",
          "infra/k8s/ingress.yaml",
          "infra/observability/prometheus/rules.yaml",
          "Dockerfile",
          ".github/workflows/deploy.yml",
        ],
      },
      conceptCounts: {
        "aws/eks": 8,
        "aws/iam-irsa": 4,
        "k8s/ingress-nginx": 6,
        "k8s/cert-manager": 3,
        "terraform/module": 10,
        "observability/loki": 4,
      },
      selfDeclared: FIELD_DEVOPS,
    },
    events: devopsSeniorEvents,
    expect: {
      rank: "senior",
      uncappedRank: "senior",
      dominantField: FIELD_DEVOPS,
      headlineRange: [683, 783],
    },
  },
  {
    id: "v2B:polyglotStaff",
    description: "Polyglot staff engineer, 14y — senior / generalist. TS+Python+Rust, surgical AI use, design-doc commits.",
    field: {
      repoSignals: {
        packageJsonDeps: ["express", "fastify", "vitest", "fast-check", "zod"],
        requirementsTxt: ["fastapi", "pydantic", "pytest", "hypothesis", "torch", "numpy"],
        cargoToml: ["tokio", "serde", "anyhow", "rmp-serde", "criterion"],
        goMod: ["github.com/grpc-ecosystem/grpc-gateway"],
        fileExtensions: { ".ts": 180, ".py": 140, ".rs": 90, ".go": 22, ".md": 30 },
      },
      conceptCounts: {
        "rpc/envelope": 6,
        "express/router": 8,
        "asyncio/event-loop": 6,
        "queue/idempotency": 8,
        "rust/lifetime": 4,
        "rust/zero-copy": 3,
        "proto/codegen": 4,
        "torch/cross-entropy": 2,
      },
      selfDeclared: FIELD_GENERALIST,
    },
    events: polyglotStaffEvents,
    expect: {
      rank: "senior",
      uncappedRank: "senior",
      dominantField: FIELD_GENERALIST,
      headlineRange: [852, 952],
    },
  },
];
