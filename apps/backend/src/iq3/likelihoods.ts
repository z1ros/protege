import type { Iq3LikelihoodEntry, Iq3TraitId } from "@protege/types";

/**
 * Per-trait likelihood tables. P(event_pattern | trait_state).
 *
 * Authoring rules:
 *   1. Every entry is one (matchKey, trait) pair with three values that
 *      reflect *relative* probability of seeing that match given the trait
 *      is in low/mid/high state. Absolute scale doesn't matter — the HMM
 *      update normalizes on each step.
 *   2. Aim for 5–10 matchKeys per trait. More than 15 is overfitting.
 *   3. Likelihood ratios should be conservative: a single match should
 *      shift posterior by no more than ~3:1. Strong claims need many
 *      consistent matches.
 *   4. matchKeys are documented inline so the ingest layer can be
 *      audited.
 *
 * Phase A ships 6 fully-authored traits (one per pillar). Task 8 extends
 * to all 30. Until then, unauthored traits keep a uniform prior and do
 * not update — pillar projection accounts for this via 'pending'.
 */

export const LIKELIHOODS: Iq3LikelihoodEntry[] = [
  // -----------------------------------------------------------------
  // Comprehension :: readsBeforeWrites
  // -----------------------------------------------------------------
  {
    matchKey: "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
    trait: "readsBeforeWrites", pLow: 0.05, pMid: 0.30, pHigh: 0.70,
  },
  {
    matchKey: "file_opened.then.first_text_change.withinMs<5s",
    trait: "readsBeforeWrites", pLow: 0.70, pMid: 0.30, pHigh: 0.05,
  },
  {
    matchKey: "file_opened.then.scroll_then_no_edit.duration>60s",
    trait: "readsBeforeWrites", pLow: 0.10, pMid: 0.30, pHigh: 0.55,
  },
  {
    matchKey: "session_tick.read_to_write_ratio>5",
    trait: "readsBeforeWrites", pLow: 0.10, pMid: 0.40, pHigh: 0.65,
  },
  {
    matchKey: "session_tick.read_to_write_ratio<1",
    trait: "readsBeforeWrites", pLow: 0.65, pMid: 0.30, pHigh: 0.05,
  },

  // -----------------------------------------------------------------
  // Execution :: authorshipSelf
  // -----------------------------------------------------------------
  {
    matchKey: "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    trait: "authorshipSelf", pLow: 0.75, pMid: 0.20, pHigh: 0.05,
  },
  {
    matchKey: "ai_suggestion_accepted.afterMs<2000.withoutEdit",
    trait: "authorshipSelf", pLow: 0.65, pMid: 0.25, pHigh: 0.10,
  },
  {
    matchKey: "ai_suggestion_accepted.thenEditWithin30s.editFraction>=0.3",
    trait: "authorshipSelf", pLow: 0.10, pMid: 0.40, pHigh: 0.60,
  },
  {
    matchKey: "keystroke_batch.size>=200.during10minWindow",
    trait: "authorshipSelf", pLow: 0.10, pMid: 0.35, pHigh: 0.65,
  },
  {
    matchKey: "line_diff.authorship=human.proportion>0.7",
    trait: "authorshipSelf", pLow: 0.05, pMid: 0.30, pHigh: 0.75,
  },

  // -----------------------------------------------------------------
  // Diagnostics :: hypothesisDriven
  // -----------------------------------------------------------------
  {
    matchKey: "error_appeared.then.edits_in_error_neighborhood.count<=3.then.error_cleared",
    trait: "hypothesisDriven", pLow: 0.10, pMid: 0.40, pHigh: 0.65,
  },
  {
    matchKey: "error_appeared.then.edits_anywhere.count>=8.then.error_cleared",
    trait: "hypothesisDriven", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "error_appeared.then.no_edit.duration>30s",
    trait: "hypothesisDriven", pLow: 0.10, pMid: 0.30, pHigh: 0.55,
  },
  {
    matchKey: "error_appeared.then.editor_navigation.kind=def-jump.before_edit",
    trait: "hypothesisDriven", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },

  // -----------------------------------------------------------------
  // Verification :: runsTestsOften
  // -----------------------------------------------------------------
  {
    matchKey: "test_run_result.trigger=manual.session_count>=3",
    trait: "runsTestsOften", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "test_run_result.trigger=save.session_count>=3",
    trait: "runsTestsOften", pLow: 0.10, pMid: 0.40, pHigh: 0.55,
  },
  {
    matchKey: "session_boundary.no_test_run.duration>=60min",
    trait: "runsTestsOften", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.no_test_run.in_window=10min_before",
    trait: "runsTestsOften", pLow: 0.55, pMid: 0.35, pHigh: 0.15,
  },

  // -----------------------------------------------------------------
  // Stewardship :: meaningfulCommitMsgs
  // -----------------------------------------------------------------
  {
    matchKey: "commit_detected.msg_chars>=80.contains_why_keyword",
    trait: "meaningfulCommitMsgs", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "commit_detected.msg_chars<20",
    trait: "meaningfulCommitMsgs", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.msg_matches_conventional",
    trait: "meaningfulCommitMsgs", pLow: 0.20, pMid: 0.45, pHigh: 0.50,
  },
  {
    matchKey: "commit_detected.msg_matches_wip_or_fix_only",
    trait: "meaningfulCommitMsgs", pLow: 0.55, pMid: 0.35, pHigh: 0.15,
  },

  // -----------------------------------------------------------------
  // AI Partnership :: specificPrompts
  // -----------------------------------------------------------------
  {
    matchKey: "chat_turn.intent=specific.charCount>=120",
    trait: "specificPrompts", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "chat_turn.intent=vague.charCount<40",
    trait: "specificPrompts", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "chat_turn.intent=debug.contains_stack_trace_or_line_ref",
    trait: "specificPrompts", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "chat_turn.intent=plan.includes_constraints",
    trait: "specificPrompts", pLow: 0.10, pMid: 0.40, pHigh: 0.55,
  },
];

/** Convenience: which trait owns a given matchKey (for ingest fast-path). */
export const MATCHKEY_TO_TRAITS = new Map<string, Iq3TraitId[]>();
for (const e of LIKELIHOODS) {
  const list = MATCHKEY_TO_TRAITS.get(e.matchKey) ?? [];
  list.push(e.trait);
  MATCHKEY_TO_TRAITS.set(e.matchKey, list);
}
