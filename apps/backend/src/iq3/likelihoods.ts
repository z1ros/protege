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
  //
  // Calibration note (Comprehension polish, iteration 2): original
  // likelihoods were 3:1 sharp (0.05/0.30/0.70 for deep), which made
  // the Bayesian update saturate after 2-3 events. A persona with
  // even a handful of deep reads ended up at trait posterior 0.92+
  // (senior-level), which over-credited mid-tier streams.
  //
  // Softened to ~3.3:1 (0.15/0.35/0.50). Same direction of evidence,
  // gentler slope, takes more events to saturate. Plus a NEW skim
  // matchKey provides a "moderate, no strong signal" anchor so a
  // mid-tier reader (mostly skim, occasional deep) lands near 0.6
  // instead of pegging high.
  // -----------------------------------------------------------------
  {
    matchKey: "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
    trait: "readsBeforeWrites", pLow: 0.15, pMid: 0.35, pHigh: 0.50,
  },
  {
    matchKey: "file_opened.then.first_text_change.withinMs<5s",
    trait: "readsBeforeWrites", pLow: 0.50, pMid: 0.35, pHigh: 0.15,
  },
  // NEW: skim pattern. Moderate reading style — some scroll, one
  // navigation, edit within 5–30s. Anchor is "mid" reading, NOT
  // strong evidence either way. The 0.55 mid weight is what pulls
  // mid-tier readers toward the middle posterior.
  {
    matchKey: "file_opened.then.skim.first_text_change.afterMs>5s.afterMs<30s",
    trait: "readsBeforeWrites", pLow: 0.25, pMid: 0.55, pHigh: 0.20,
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
  //
  // Calibration note (Execution polish): original ratios were 15:1
  // (0.75/0.20/0.05 for paste-no-edit) and 6:1 (0.10/0.40/0.60 for
  // iterated). With Execution having only 1 active trait of 5
  // (others dormant — need commit/lint/concept producers), these
  // sharp likelihoods saturated authorshipSelf at 0.03 (vibecoder)
  // or 0.83 (earnest junior) after a few events. The pillar score
  // then over- or under-shot the consensus targets by 200+ points.
  //
  // Softened to ~3:1 ratios — same direction of evidence, gentler
  // slope, posterior lands closer to mid for typical streams.
  // -----------------------------------------------------------------
  {
    matchKey: "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
    trait: "authorshipSelf", pLow: 0.55, pMid: 0.30, pHigh: 0.15,
  },
  {
    matchKey: "ai_suggestion_accepted.afterMs<2000.withoutEdit",
    trait: "authorshipSelf", pLow: 0.55, pMid: 0.30, pHigh: 0.15,
  },
  {
    matchKey: "ai_suggestion_accepted.thenEditWithin30s.editFraction>=0.3",
    trait: "authorshipSelf", pLow: 0.15, pMid: 0.35, pHigh: 0.50,
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
    trait: "hypothesisDriven", pLow: 0.20, pMid: 0.40, pHigh: 0.40,
  },

  // -----------------------------------------------------------------
  // Verification :: runsTestsOften
  //
  // Calibration note: original likelihoods were 13:1 sharp (0.05/0.30/0.65)
  // for manual session>=3. A bootcamp grad with one 3-test burst landed
  // at 0.80 posterior — saturating "runs tests often" on a single event.
  // Softened to ~2:1, complemented by the dormant negative matcher
  // `commit_detected.no_test_run.in_window=10min_before` being wired
  // (uses existing commit + test events, no new producer needed).
  // -----------------------------------------------------------------
  {
    matchKey: "test_run_result.trigger=manual.session_count>=3",
    trait: "runsTestsOften", pLow: 0.20, pMid: 0.40, pHigh: 0.40,
  },
  {
    matchKey: "test_run_result.trigger=save.session_count>=3",
    trait: "runsTestsOften", pLow: 0.20, pMid: 0.40, pHigh: 0.40,
  },
  {
    matchKey: "session_boundary.no_test_run.duration>=60min",
    trait: "runsTestsOften", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.no_test_run.in_window=10min_before",
    trait: "runsTestsOften", pLow: 0.45, pMid: 0.35, pHigh: 0.20,
  },

  // -----------------------------------------------------------------
  // Stewardship :: meaningfulCommitMsgs
  // -----------------------------------------------------------------
  {
    matchKey: "commit_detected.msg_chars>=80.contains_why_keyword",
    trait: "meaningfulCommitMsgs", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  // Long conventional commits without an explicit "because/since"
  // keyword are still strong evidence of meaningful messages — most
  // senior commits frame the rationale via "via X", "to prevent Y",
  // "for Z" patterns rather than the exact keywords. This catches
  // them. Slightly weaker than the keyword-explicit signal above.
  {
    matchKey: "commit_detected.msg_chars>=80.matches_conventional",
    trait: "meaningfulCommitMsgs", pLow: 0.10, pMid: 0.35, pHigh: 0.55,
  },
  {
    matchKey: "commit_detected.msg_chars<20",
    trait: "meaningfulCommitMsgs", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    // Conventional commit format alone is ALMOST neutral — AI-generated
    // commit messages frequently use the convention without carrying
    // any rationale. The strong "thoughtful commit" signal is
    // `msg_chars>=80.contains_why_keyword`. Lowered the high weight
    // from 0.50 → 0.35 so vibecoder-style "feat: short" doesn't
    // saturate this pillar.
    matchKey: "commit_detected.msg_matches_conventional",
    trait: "meaningfulCommitMsgs", pLow: 0.30, pMid: 0.45, pHigh: 0.35,
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

  // -----------------------------------------------------------------
  // Comprehension :: pausesBeforeLargeEdits
  // -----------------------------------------------------------------
  {
    matchKey: "before_text_change.size>=50chars.idle_duration>=20s",
    trait: "pausesBeforeLargeEdits", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "before_text_change.size>=50chars.idle_duration<=2s",
    trait: "pausesBeforeLargeEdits", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "selection_change.size>=20lines.before_edit",
    trait: "pausesBeforeLargeEdits", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "stare_pause.duration>=15s.no_edit_after",
    trait: "pausesBeforeLargeEdits", pLow: 0.20, pMid: 0.45, pHigh: 0.50,
  },

  // -----------------------------------------------------------------
  // Comprehension :: summarizesCodebase
  // -----------------------------------------------------------------
  {
    matchKey: "session_start.file_opened_count>=5.before_first_edit",
    trait: "summarizesCodebase", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "session_start.file_opened_count<=1.before_first_edit",
    trait: "summarizesCodebase", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "editor_navigation.kind=symbol-search.before_edit",
    trait: "summarizesCodebase", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "text_change.size>=10chars.no_prior_file_open_in_5min",
    trait: "summarizesCodebase", pLow: 0.60, pMid: 0.30, pHigh: 0.10,
  },

  // -----------------------------------------------------------------
  // Comprehension :: asksClarifyingQuestions
  // -----------------------------------------------------------------
  {
    matchKey: "chat_turn.intent=plan.before_first_edit",
    trait: "asksClarifyingQuestions", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "chat_turn.contains_question_mark.charCount>=60",
    trait: "asksClarifyingQuestions", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "chat_turn.intent=request.no_prior_question",
    trait: "asksClarifyingQuestions", pLow: 0.60, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "session_start.no_chat_turn.first_edit_within_2min",
    trait: "asksClarifyingQuestions", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },

  // -----------------------------------------------------------------
  // Comprehension :: navigatesBySymbols
  // -----------------------------------------------------------------
  // Calibration note: original likelihoods were 0.05/0.30/0.65 (sharp
  // 13:1 ratio). Combined with the readsBeforeWrites matchKeys also
  // saturating on the same personas, navigatesBySymbols compounded the
  // over-credit for mid-tier streams. Softened to ~3:1 to give the
  // navigation signal a meaningful but not dominating contribution.
  {
    matchKey: "editor_navigation.kind=def-jump.session_count>=3",
    trait: "navigatesBySymbols", pLow: 0.20, pMid: 0.35, pHigh: 0.45,
  },
  {
    matchKey: "editor_navigation.kind=symbol-search.session_count>=2",
    trait: "navigatesBySymbols", pLow: 0.20, pMid: 0.40, pHigh: 0.40,
  },
  {
    matchKey: "editor_navigation.kind=file-bounce.session_count>=10.no_def-jump",
    trait: "navigatesBySymbols", pLow: 0.45, pMid: 0.35, pHigh: 0.20,
  },
  {
    matchKey: "session_tick.no_navigation.duration>=15min",
    trait: "navigatesBySymbols", pLow: 0.60, pMid: 0.35, pHigh: 0.10,
  },

  // -----------------------------------------------------------------
  // Execution :: compilesCleanOnSave
  // -----------------------------------------------------------------
  {
    matchKey: "file_saved.errorCount=0.session_proportion>=0.8",
    trait: "compilesCleanOnSave", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "file_saved.errorCount>=3.session_proportion>=0.4",
    trait: "compilesCleanOnSave", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "file_saved.errorCount=0",
    trait: "compilesCleanOnSave", pLow: 0.20, pMid: 0.45, pHigh: 0.50,
  },
  {
    matchKey: "file_saved.errorCount>=5",
    trait: "compilesCleanOnSave", pLow: 0.70, pMid: 0.25, pHigh: 0.05,
  },

  // -----------------------------------------------------------------
  // Execution :: keepsFunctionsSmall
  // -----------------------------------------------------------------
  {
    matchKey: "commit_detected.avg_function_lines<=20",
    trait: "keepsFunctionsSmall", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "commit_detected.avg_function_lines>=80",
    trait: "keepsFunctionsSmall", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.max_function_lines<=40",
    trait: "keepsFunctionsSmall", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "commit_detected.max_function_lines>=200",
    trait: "keepsFunctionsSmall", pLow: 0.75, pMid: 0.20, pHigh: 0.05,
  },

  // -----------------------------------------------------------------
  // Execution :: conceptDepth
  // -----------------------------------------------------------------
  {
    matchKey: "concept_encountered.distinct_difficulty3_count>=5.in_30days",
    trait: "conceptDepth", pLow: 0.05, pMid: 0.20, pHigh: 0.75,
  },
  {
    matchKey: "concept_encountered.only_difficulty1.in_30days",
    trait: "conceptDepth", pLow: 0.70, pMid: 0.25, pHigh: 0.05,
  },
  {
    matchKey: "concept_encountered.distinct_count>=20.in_30days",
    trait: "conceptDepth", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "concept_encountered.distinct_count<=3.in_30days",
    trait: "conceptDepth", pLow: 0.65, pMid: 0.30, pHigh: 0.05,
  },

  // -----------------------------------------------------------------
  // Execution :: styleMatchesCodebase
  // -----------------------------------------------------------------
  {
    matchKey: "line_diff.style_match_score>=0.85",
    trait: "styleMatchesCodebase", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "line_diff.style_match_score<=0.3",
    trait: "styleMatchesCodebase", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.lint_warnings_added>=5",
    trait: "styleMatchesCodebase", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.lint_warnings_added=0",
    trait: "styleMatchesCodebase", pLow: 0.10, pMid: 0.40, pHigh: 0.55,
  },

  // -----------------------------------------------------------------
  // Diagnostics :: errorResolutionFast
  // -----------------------------------------------------------------
  {
    matchKey: "error_cleared.duration_since_appeared<=120s",
    trait: "errorResolutionFast", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "error_cleared.duration_since_appeared>=900s",
    trait: "errorResolutionFast", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "error_cleared.duration_since_appeared<=60s.error_severity=high",
    trait: "errorResolutionFast", pLow: 0.05, pMid: 0.20, pHigh: 0.75,
  },
  {
    matchKey: "error_persists.duration>=600s",
    trait: "errorResolutionFast", pLow: 0.70, pMid: 0.25, pHigh: 0.05,
  },

  // -----------------------------------------------------------------
  // Diagnostics :: fixNotBandAid
  // -----------------------------------------------------------------
  {
    matchKey: "error_cleared.with_test_added.in_window=10min",
    trait: "fixNotBandAid", pLow: 0.20, pMid: 0.35, pHigh: 0.45,
  },
  {
    matchKey: "error_cleared.with_try_catch_added.no_logging",
    trait: "fixNotBandAid", pLow: 0.70, pMid: 0.25, pHigh: 0.05,
  },
  {
    matchKey: "error_cleared.targeted_edit.line_count<=5",
    trait: "fixNotBandAid", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "error_cleared.broad_edit.line_count>=30",
    trait: "fixNotBandAid", pLow: 0.25, pMid: 0.45, pHigh: 0.30,
  },

  // -----------------------------------------------------------------
  // Diagnostics :: testsAfterError
  // -----------------------------------------------------------------
  {
    matchKey: "error_cleared.then.test_run_result.in_window=15min",
    trait: "testsAfterError", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "error_cleared.then.commit_detected.no_test_change.in_window=15min",
    trait: "testsAfterError", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "error_cleared.then.writesTestFile.in_window=20min",
    trait: "testsAfterError", pLow: 0.05, pMid: 0.20, pHigh: 0.75,
  },
  {
    matchKey: "error_cleared.no_test_change.session",
    trait: "testsAfterError", pLow: 0.60, pMid: 0.30, pHigh: 0.10,
  },

  // -----------------------------------------------------------------
  // Diagnostics :: readsStackTrace
  // -----------------------------------------------------------------
  {
    matchKey: "chat_turn.contains_stack_trace.charCount>=200",
    trait: "readsStackTrace", pLow: 0.20, pMid: 0.40, pHigh: 0.40,
  },
  {
    matchKey: "error_appeared.then.editor_navigation.kind=def-jump.matches_stack_frame",
    trait: "readsStackTrace", pLow: 0.05, pMid: 0.20, pHigh: 0.75,
  },
  {
    matchKey: "error_appeared.no_navigation.duration>=120s",
    trait: "readsStackTrace", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },

  // -----------------------------------------------------------------
  // Verification :: writesTestFiles
  // -----------------------------------------------------------------
  {
    matchKey: "commit_detected.test_file_changes>=2.session_count>=3",
    trait: "writesTestFiles", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "commit_detected.no_test_changes.session_count>=10",
    trait: "writesTestFiles", pLow: 0.70, pMid: 0.25, pHigh: 0.05,
  },
  {
    matchKey: "file_saved.path_matches_test_pattern",
    trait: "writesTestFiles", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "commit_detected.test_to_src_ratio>=0.5",
    trait: "writesTestFiles", pLow: 0.05, pMid: 0.25, pHigh: 0.70,
  },

  // -----------------------------------------------------------------
  // Verification :: assertionDensity
  // -----------------------------------------------------------------
  {
    matchKey: "line_diff.assertions_added>=3.lines_added>=20",
    trait: "assertionDensity", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  // Milder positive — fires on smaller test-file edits (e.g. one
  // it() block with a couple expects). Weaker likelihood ratio than
  // the 20-line variant since single-save assertion counts are noisy.
  {
    matchKey: "line_diff.assertions_added>=2.lines_added>=8",
    trait: "assertionDensity", pLow: 0.15, pMid: 0.40, pHigh: 0.45,
  },
  {
    matchKey: "line_diff.assertions_added=0.lines_added>=50",
    trait: "assertionDensity", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.assertions_per_loc>=0.05",
    trait: "assertionDensity", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "commit_detected.assertions_per_loc<=0.005",
    trait: "assertionDensity", pLow: 0.70, pMid: 0.25, pHigh: 0.05,
  },

  // -----------------------------------------------------------------
  // Verification :: edgeCaseCoverage
  // -----------------------------------------------------------------
  {
    matchKey: "commit_detected.test_contains_null_or_empty.test_added>=1",
    trait: "edgeCaseCoverage", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "commit_detected.test_contains_boundary_value.test_added>=1",
    trait: "edgeCaseCoverage", pLow: 0.05, pMid: 0.25, pHigh: 0.70,
  },
  {
    matchKey: "commit_detected.test_added>=1.no_edge_case_keyword",
    trait: "edgeCaseCoverage", pLow: 0.55, pMid: 0.35, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.test_added.assertion_count>=5",
    trait: "edgeCaseCoverage", pLow: 0.25, pMid: 0.45, pHigh: 0.30,
  },

  // -----------------------------------------------------------------
  // Verification :: preCommitReads
  // -----------------------------------------------------------------
  {
    matchKey: "commit_detected.recent_file_opens>=3.in_window=10min_before",
    trait: "preCommitReads", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "commit_detected.no_file_opens.in_window=10min_before",
    trait: "preCommitReads", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.recent_scroll>=5.in_window=10min_before",
    trait: "preCommitReads", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },

  // -----------------------------------------------------------------
  // Stewardship :: consistentNaming
  // -----------------------------------------------------------------
  {
    matchKey: "line_diff.naming_consistency_score>=0.85",
    trait: "consistentNaming", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "line_diff.naming_consistency_score<=0.3",
    trait: "consistentNaming", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.identifier_entropy<=0.4",
    trait: "consistentNaming", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "commit_detected.identifier_entropy>=0.8",
    trait: "consistentNaming", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },

  // -----------------------------------------------------------------
  // Stewardship :: removesDeadCode
  // -----------------------------------------------------------------
  {
    matchKey: "commit_detected.lines_deleted>=lines_added.session_count>=2",
    trait: "removesDeadCode", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "commit_detected.lines_deleted=0.session_count>=10",
    trait: "removesDeadCode", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "line_diff.unused_import_removed>=1",
    trait: "removesDeadCode", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "commit_detected.commented_out_code_added>=3",
    trait: "removesDeadCode", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },

  // -----------------------------------------------------------------
  // Stewardship :: refactorsWhileTouching
  // -----------------------------------------------------------------
  {
    matchKey: "commit_detected.touches_unrelated_files.with_classification=refactor",
    trait: "refactorsWhileTouching", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "commit_detected.single_file.feature_only.session_count>=10",
    trait: "refactorsWhileTouching", pLow: 0.25, pMid: 0.45, pHigh: 0.30,
  },
  {
    matchKey: "commit_detected.contains_renames.feature_change_present",
    trait: "refactorsWhileTouching", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },

  // -----------------------------------------------------------------
  // Stewardship :: commentsWhyNotWhat
  // -----------------------------------------------------------------
  {
    matchKey: "line_diff.comments_added.contains_why_keyword>=1",
    trait: "commentsWhyNotWhat", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "line_diff.comments_added.is_what_describing>=3",
    trait: "commentsWhyNotWhat", pLow: 0.60, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "commit_detected.comment_density>=0.3",
    trait: "commentsWhyNotWhat", pLow: 0.55, pMid: 0.35, pHigh: 0.15,
  },
  {
    matchKey: "commit_detected.comment_density<=0.05.with_comments",
    trait: "commentsWhyNotWhat", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },

  // -----------------------------------------------------------------
  // AI Partnership :: iteratesOnAiOutput
  // -----------------------------------------------------------------
  {
    matchKey: "ai_suggestion_accepted.then.text_change.editFraction>=0.3.in_window=5min",
    trait: "iteratesOnAiOutput", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
  {
    matchKey: "ai_suggestion_accepted.no_edit.in_window=30min",
    trait: "iteratesOnAiOutput", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "ai_suggestion_accepted.then.test_run_result.in_window=10min",
    trait: "iteratesOnAiOutput", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "ai_suggestion_accepted.then.error_appeared.no_iteration",
    trait: "iteratesOnAiOutput", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },

  // -----------------------------------------------------------------
  // AI Partnership :: overridesAiConfidently
  // -----------------------------------------------------------------
  {
    matchKey: "ai_suggestion_rejected.session_count>=3",
    trait: "overridesAiConfidently", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "ai_suggestion_rejected.then.text_change.contains_alternative_logic",
    trait: "overridesAiConfidently", pLow: 0.05, pMid: 0.25, pHigh: 0.70,
  },
  {
    matchKey: "ai_suggestion_accepted.session_count>=20.no_rejections",
    trait: "overridesAiConfidently", pLow: 0.70, pMid: 0.25, pHigh: 0.05,
  },

  // -----------------------------------------------------------------
  // AI Partnership :: explainsAfterAccept
  // -----------------------------------------------------------------
  {
    matchKey: "ai_suggestion_accepted.then.chat_turn.intent=debug.in_window=15min",
    trait: "explainsAfterAccept", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "ai_suggestion_accepted.then.chat_turn.contains_explain_keyword.in_window=15min",
    trait: "explainsAfterAccept", pLow: 0.05, pMid: 0.25, pHigh: 0.70,
  },
  {
    matchKey: "ai_suggestion_accepted.no_chat_turn.in_window=60min",
    trait: "explainsAfterAccept", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },

  // -----------------------------------------------------------------
  // AI Partnership :: agenticFlowQuality
  // -----------------------------------------------------------------
  {
    matchKey: "chat_turn.intent=plan.then.commit_detected.in_window=2hour",
    trait: "agenticFlowQuality", pLow: 0.10, pMid: 0.35, pHigh: 0.60,
  },
  {
    matchKey: "chat_turn.intent=plan.then.error_persists.in_window=4hour",
    trait: "agenticFlowQuality", pLow: 0.65, pMid: 0.30, pHigh: 0.10,
  },
  {
    matchKey: "chat_turn.intent=request.then.test_run_result.passed=tests",
    trait: "agenticFlowQuality", pLow: 0.05, pMid: 0.30, pHigh: 0.65,
  },
];

/** Convenience: which trait owns a given matchKey (for ingest fast-path). */
export const MATCHKEY_TO_TRAITS = new Map<string, Iq3TraitId[]>();
for (const e of LIKELIHOODS) {
  const list = MATCHKEY_TO_TRAITS.get(e.matchKey) ?? [];
  list.push(e.trait);
  MATCHKEY_TO_TRAITS.set(e.matchKey, list);
}

/** O(1) lookup table for `applyMatchKeys` — keyed by `${matchKey}::${trait}`.
 *  Replaces a per-event `LIKELIHOODS.find()` linear scan over ~119 entries,
 *  which was the dominant CPU cost in `iq3Hook` ingest at scale. */
export const LIKELIHOOD_INDEX = new Map<string, Iq3LikelihoodEntry>();
for (const e of LIKELIHOODS) {
  LIKELIHOOD_INDEX.set(`${e.matchKey}::${e.trait}`, e);
}
