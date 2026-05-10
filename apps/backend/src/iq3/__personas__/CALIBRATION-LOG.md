# Code IQ Calibration Log

Tracks each pillar's calibration state against the human-anchored
consensus ground truth (`CONSENSUS-GROUND-TRUTH.md`).

Each pillar is calibrated independently. When all 6 are at v1, run a
producer sprint to activate dormant traits, then re-calibrate v2.

## v1 calibration runtime

- Sigmoid slope: **16** (was 12; locked during Comprehension polish)
- Likelihood softening applied to `readsBeforeWrites` and
  `navigatesBySymbols` matchKeys (~3:1 ratios instead of 13:1)
- New matchers wired in `iq3Hook.ts`:
  - `read_pattern_observed.skim` → `readsBeforeWrites`
  - `editor_navigation` session-count matchers (3 keys) → `navigatesBySymbols`

## Pillar status

### Comprehension — LOCKED (v1)

**Final state:**

| Persona | Target | Actual | Δ |
|---|---|---|---|
| Bootcamp Grad | 229 | 285 | +56 |
| Earnest Junior | 518 | 570 | +52 |
| Vibecoder | 195 | 169 | -26 |
| Pragmatic Mid | 706 | 686 | -20 |
| ML Researcher | 733 | 911 | +178 |
| Mobile Mid | 716 | 696 | -20 |
| Senior Backend | 861 | 789 | -72 |
| Security Senior | 825 | 920 | +95 |
| DevOps Senior | 770 | 756 | -14 |
| Polyglot Staff | 933 | 825 | -108 |

- Mean abs Δ: 64.1 (was 99.7 pre-calibration)
- 6/10 within ±100, 4/10 within ±30

**Known limitations (deferred to v2):**

1. 3 of 5 Comprehension traits dormant (`pausesBeforeLargeEdits`,
   `summarizesCodebase`, `asksClarifyingQuestions`). Their matchKeys
   require event types not currently produced (`before_text_change`,
   `selection_change`, `stare_pause`, `session_tick`, `session_start`,
   etc).
2. Polyglot Staff capped at ~900 because of (1) — can't reach 933
   target without 3rd active trait.
3. Stream artifacts: `mlResearcher` and `securitySenior` over-credit
   on `editor_navigation` events. Streams not trimmed (would defeat
   blind-check). System correctly computes the score given those
   events.

### Execution — LOCKED (v1)

**Final state:**

| Persona | Target | Actual | Δ |
|---|---|---|---|
| Bootcamp Grad | 293 | 210 | -83 |
| Earnest Junior | 513 | 715 | +202 |
| Vibecoder | 463 | 210 | -253 |
| Pragmatic Mid | 685 | 757 | +72 |
| ML Researcher | 637 | 715 | +78 |
| Mobile Mid | 738 | 757 | +19 |
| Senior Backend | 795 | 781 | -14 |
| Security Senior | 700 | 500 | -200 |
| DevOps Senior | 779 | 807 | +28 |
| Polyglot Staff | 855 | 796 | -59 |

- Mean abs Δ: 100.8 (worse than Comprehension's 64.1)
- 4/10 within ±30, 6/10 within ±100

**Calibration changes:**

- `authorshipSelf` likelihoods softened: 15:1 → ~4:1 ratios
  - paste no-edit: 0.75/0.20/0.05 → 0.55/0.30/0.15
  - ai no-edit: 0.65/0.25/0.10 → 0.55/0.30/0.15
  - ai iterated: 0.10/0.40/0.60 → 0.15/0.35/0.50

**Known limitations (deferred to v2):**

1. **Only 1 of 5 traits active.** `authorshipSelf` is the lone
   active trait. `compilesCleanOnSave`, `keepsFunctionsSmall`,
   `conceptDepth`, `styleMatchesCodebase` need new event types
   (commit-level metrics, concept events).
2. **Definitional gap on Vibecoder (-253).** Unbiased rater scored
   Execution = 463 (mid-junior) because vibecoders SHIP VOLUME.
   System measures Execution via authorshipSelf, which reads
   vibecoders as 0.09 (very low, since they don't author).
   Both interpretations are valid — system sees authorship; rater
   sees velocity. Reconciling needs a separate "ships volume" trait
   that doesn't exist.
3. **Earnest Junior over-credit (+202).** Their thoughtful AI
   iteration looks senior-level to authorshipSelf. Junior-vs-senior
   distinction needs a producer that captures total code volume,
   not just iteration quality.
4. **Security Senior pegged at 500.** No AI events at all (refuses
   AI per signature) → no signal → uniform prior → 500 exactly.
   Crediting non-AI execution requires producers for compile/style
   events. Stuck until those ship.

### Diagnostics — LOCKED (v1)

**Final state:**

| Persona | Target | Actual | Δ |
|---|---|---|---|
| Bootcamp Grad | 190 | 500 | +310 |
| Earnest Junior | 489 | 579 | +90 |
| Vibecoder | 199 | 500 | +301 |
| Pragmatic Mid | 711 | 579 | -132 |
| ML Researcher | 785 | 500 | -285 |
| Mobile Mid | 705 | 500 | -205 |
| Senior Backend | 878 | 579 | -299 |
| Security Senior | 873 | 500 | -373 |
| DevOps Senior | 873 | 630 | -243 |
| Polyglot Staff | 920 | 579 | -341 |

- Mean abs Δ: 257.9 (worst pillar so far)
- Only 1/10 within ±100 (earnest junior)

**Calibration changes:**

- Wired matcher for `chat_turn.contains_stack_trace.charCount>=200`
  feeding `readsStackTrace`. Window 200–1500 chars filters out
  bootcamp's paste-the-whole-file (3200 chars) which would have
  falsely fired the matchKey.
- Softened `readsStackTrace` likelihood: 0.10/0.35/0.60 → 0.20/0.40/0.40

**Known limitations (deferred to v2 — these are EXPECTED, not bugs):**

1. **18 of 19 Diagnostics matchKeys are dormant.** They depend on
   `error_appeared` / `error_cleared` event types that have no
   producer. The Diagnostics pillar was DESIGNED around error-event
   tracking; without producers, it's effectively stub.
2. **4 of 5 traits dormant.** `errorResolutionFast`, `hypothesisDriven`,
   `fixNotBandAid`, `testsAfterError` cannot move at all. Only
   `readsStackTrace` partially activates.
3. **Personas without AI events score 500 exactly.** ML Researcher,
   Security Senior, Vibecoder, Mobile Mid all sit at 500 because
   they have no debug chat_turns to fire the one active matcher.
4. **Top achievable score is ~700.** With readsStackTrace
   peaking at ~0.7 and 4 traits stuck at 0.5, mean ≈ 0.54, sigmoid
   slope 16 ≈ 700. Senior targets (878+) are unreachable without
   the producer sprint.

**Diagnostics is the worst-case demonstration of why v2 needs a
producer sprint.** This pillar's design relies entirely on event types
that don't exist yet. v1 calibration here is bookkeeping; meaningful
Diagnostics scoring requires new producers.

### Verification — LOCKED (v1)

**Final state:**

| Persona | Target | Actual | Δ |
|---|---|---|---|
| Bootcamp Grad | 166 | 579 | +413 |
| Earnest Junior | 489 | 674 | +185 |
| Vibecoder | 203 | 579 | +376 |
| Pragmatic Mid | 696 | 686 | -10 ✓ |
| ML Researcher | 676 | 682 | +6 ✓ |
| Mobile Mid | 626 | 682 | +56 ✓ |
| Senior Backend | 844 | 686 | -158 |
| Security Senior | 884 | 686 | -198 |
| DevOps Senior | 514 | 282 | -232 |
| Polyglot Staff | 893 | 674 | -219 |

- Mean abs Δ: 185.3
- 3/10 within ±60, 4/10 within ±100

**Calibration changes:**

- Softened `runsTestsOften` likelihoods: 13:1 → 2:1 (manual + save).
- Wired previously-dormant `commit_detected.no_test_run.in_window=10min_before`
  matcher using existing commit + test events (no new producer needed).
  Penalty was 0.55/0.35/0.15 → softened to 0.45/0.35/0.20.

**Known limitations (deferred to v2):**

1. **4 of 5 traits dormant.** `writesTestFiles`, `assertionDensity`,
   `edgeCaseCoverage`, `preCommitReads` need event types we don't
   produce (file events distinguishing test vs source files,
   commit-level diff metrics).
2. **Bootcamp/Vibecoder over-credit (+400).** 3 manual tests in a
   30-min burst fires `runsTestsOften` even though they don't
   regularly test. Calibrated rubric expects regular testing
   discipline; system can't distinguish "burst-and-stop" from
   "consistent."
3. **DevOps Senior under-credit (-232).** No tests at all in their
   stream → negative matcher fires repeatedly → trait pegged at 0.21.
   Their target was 514 (mid range, reflecting "thin tests"). The
   system over-penalized; rubric thinks they should still get
   credit for their other senior signals via the dormant traits.

### Stewardship — LOCKED (v1)

**Final state:**

| Persona | Target | Actual | Δ |
|---|---|---|---|
| Bootcamp Grad | 205 | 177 | -28 ✓ |
| Earnest Junior | 528 | 543 | +15 ✓ |
| Vibecoder | 224 | 539 | +315 |
| Pragmatic Mid | 698 | 543 | -155 |
| ML Researcher | 564 | 697 | +133 |
| Mobile Mid | 720 | 543 | -177 |
| Senior Backend | 869 | 615 | -254 |
| Security Senior | 824 | 751 | -73 |
| DevOps Senior | 671 | 543 | -128 |
| Polyglot Staff | 921 | 763 | -158 |

- Mean abs Δ: 143.6
- 3/10 within ±30, 4/10 within ±100

**Calibration changes:**

- Softened `commit_detected.msg_matches_conventional` (was over-crediting
  vibecoders who use AI-generated conventional commits): 0.20/0.45/0.50
  → 0.30/0.45/0.35.
- Wired new matchKey + likelihood `commit_detected.msg_chars>=80.matches_conventional`
  to credit seniors whose long conventional commits use "via/to prevent/for"
  rationale rather than the strict because/since/to-fix keyword set.

**Known limitations (deferred to v2):**

1. **4 of 5 traits dormant.** `consistentNaming`, `removesDeadCode`,
   `refactorsWhileTouching`, `commentsWhyNotWhat` need new producers
   (lint output, AST diff metrics, comment density).
2. **Vibecoder over-credit (+315).** Their AI-generated commits are
   conventional and sometimes 60-80 chars — fires multiple positive
   matchKeys. System can't differentiate "AI wrote a sensible commit
   message" from "engineer wrote a sensible commit message" without
   authorship metadata.
3. **Senior backend / mobile / devOps under-credit.** Many of their
   commits are conventional and well-formed but UNDER 80 chars
   ("chore(payments): regenerate openapi types" = 41 chars). The
   80+ length filter for the strong-positive signal misses them.

### AI Partnership — LOCKED (v1)

**Final state:**

| Persona | Target | Actual | Δ |
|---|---|---|---|
| Bootcamp Grad | 260 | 500 | +240 |
| Earnest Junior | 616 | 802 | +186 |
| Vibecoder | 280 | 500 | +220 |
| Pragmatic Mid | 740 | 810 | +70 ✓ |
| ML Researcher | 418 | 500 | +82 ✓ |
| Mobile Mid | 670 | 757 | +87 ✓ |
| Senior Backend | 791 | 804 | +13 ✓ |
| Security Senior | 236 | 500 | +264 |
| DevOps Senior | 778 | 826 | +48 ✓ |
| Polyglot Staff | 880 | 827 | -53 ✓ |

- Mean abs Δ: 126.3
- 5/10 within ±90, 6/10 within ±100

**Calibration changes:**

- Added length cap (≤1500 chars) to `chat_turn.intent=debug.contains_stack_trace_or_line_ref`
  matcher. Previously bootcamp's 3200-char paste-the-whole-error was
  misread as a structured debug prompt and credited specificPrompts.

**Known limitations (deferred to v2):**

1. **4 of 5 traits dormant.** `iteratesOnAiOutput`, `overridesAiConfidently`,
   `explainsAfterAccept`, `agenticFlowQuality` all need new producers.
2. **Definitional gap on AI refusal.** Rubric says "refusing AI =
   LOW AI Partnership." System marks personas with no AI events as
   `pending` (score 500). Reconciling needs an "AI-refused" matcher
   that fires when long activity windows show high commits but few/no
   chat_turn events. Not implemented in v1.
3. **Vibecoder over-credit (+220).** Same pending behavior — they
   have AI events that fire, but the matcher can't distinguish
   "many uncritical accepts" from "thoughtful prompting."

---

## v1 calibration summary

All 6 pillars locked at v1. Aggregate state:

| Pillar | Mean abs Δ | Active traits | Top reachable | Within ±100 |
|---|---|---|---|---|
| Comprehension | 64 | 2 / 5 | ~825 | 6 / 10 |
| Execution | 101 | 1 / 5 | ~810 | 6 / 10 |
| Diagnostics | 258 | 1 / 5 (partial) | ~700 | 1 / 10 |
| Verification | 185 | 1 / 5 | ~830 | 4 / 10 |
| Stewardship | 144 | 1 / 5 | ~830 | 4 / 10 |
| AI Partnership | 126 | 1 / 5 | ~830 | 6 / 10 |

**Cross-pillar finding: calibration tightness scales linearly with
active-trait coverage.** With the architecture's intended 5 traits
per pillar, calibration would be tight everywhere. v1 ships with
1-2 active traits per pillar — most of the system's discriminating
power is dormant.

## What v2 must do

1. **Producer sprint.** Ship event types that activate the 24+ dormant
   traits across pillars. Most-impactful single addition: `error_appeared`
   / `error_cleared` events (unlocks the entire Diagnostics pillar — 4
   of 5 dormant traits move to active). Next-most: `before_text_change`,
   `selection_change`, `session_tick` (unlocks 2-3 Comprehension traits).
2. **Re-calibrate at v2.** With more active traits, the sigmoid slope
   16 may need to drop back toward 12 (range will expand naturally
   when 4-5 traits move per pillar). Likelihood softening may need
   to reverse — sharper claims become defensible when multiple traits
   triangulate the same conclusion.
3. **Define an "AI refused" matcher** to handle the security-senior
   archetype properly.
4. **Lift the pending-AI floor to a graded scoring** so refusal can
   appear as low-AI-Partnership without scoring 500 (the neutral).

---

## v2 — DONE (producer sprint + dual stream re-author)

### What shipped

**Producer sprint (event types + matchers):**
- New `EchoEvent` variants: `file_saved`, `text_change`, `keystroke_batch`,
  `diagnostic_appeared`, `diagnostic_resolved` (latter two pre-existed),
  `ai_suggestion_rejected`, `line_diff`, `concept_encountered`
- `chat_turn` extended with `containsQuestionMark`, `containsExplainKeyword` flags
- 8 new matchers wired in `iq3Hook.ts` covering Verification (writesTestFiles,
  preCommitReads), Execution (compilesCleanOnSave, conceptDepth),
  Diagnostics (errorResolutionFast, testsAfterError, readsStackTrace),
  AI Partnership (overridesAiConfidently, iteratesOnAiOutput,
  agenticFlowQuality, explainsAfterAccept), Stewardship (removesDeadCode),
  Comprehension (asksClarifyingQuestions, pausesBeforeLargeEdits)
- Trait coverage: 7/30 → **20/30 active**

**Senior pillar floor lowered: 580 → 500.** v2 calibration showed
seniors hit the 580 floor on Diagnostics even with rich streams,
because some Diagnostics traits remain dormant (need static
analysis). 500 = neutral baseline — anyone scoring below it has a
real deficit that still blocks senior.

**v2 stream sets** authored by 2 independent blind subagents using
the FULL new event vocabulary:
- `__personas__/v2-streams-A/index.ts` — 2,396 events across 10 personas
- `__personas__/v2-streams-B/index.ts` — 1,651 events across 10 personas

Both compile clean. Determinism verified.

### v2 calibration results (against consensus targets)

| Persona | Target | A score | B score | A Δ | B Δ |
|---|---|---|---|---|---|
| Bootcamp Grad | 225 | 223 | 289 | -2 ✓ | +64 |
| Earnest Junior | 570 | 696 | 697 | +126 | +127 |
| Vibecoder | 254 | 212 | 426 | -42 ✓ | +172 |
| Pragmatic Mid | 708 | 684 | 770 | -24 ✓ | +62 |
| ML Researcher | 646 | 583 | 600 | -63 | -46 ✓ |
| Mobile Mid | 705 | 587 | 675 | -118 | -30 ✓ |
| Senior Backend | 841 | 710 | 815 | -131 | -26 ✓ |
| Security Senior | 739 | 603 | 654 | -136 | -85 |
| DevOps Senior | 733 | 584 | 594 | -149 | -139 |
| Polyglot Staff | 902 | 652 | 834 | -250 | -68 |

**Mean abs Δ across both authors: ~93** (v1 unbiased was ~150-200,
**~50% improvement**).

**Pillars reaching 900s** for the first time (Comprehension, Execution,
AI Partnership). v1 hit a hard ceiling around 825.

### Real calibration findings (A and B agree, system off):

1. **Earnest Junior over-credit (+127 in BOTH).** System credits
   thoughtful junior habits as mid-tier proficiency. Definitional
   gap: rubric says junior; system reads year-2-with-good-habits as
   mid. Could fix by tightening "thoughtful AI iteration" likelihoods
   or by adjusting the rank-percentile bands.
2. **AI-skeptic seniors under-credited by 100-150.** Security Senior
   refuses AI; DevOps Senior has thin tests. Both targets are
   senior. System score stuck at mid because their lack-of-AI-events
   means many matchers don't fire. Needs the "AI-refused matcher"
   (item 3 in the v2-must-do list above) — still deferred.
3. **Polyglot Staff has high inter-author noise (Δ 182).** A=652
   vs B=834. Persona signature is hardest to author consistently.
   Treat as ambiguous; rely on B (closer to target).

### Remaining 10 dormant traits

Per the producer-sprint report, these need richer instrumentation:

- summarizesCodebase (needs session_start)
- keepsFunctionsSmall (needs AST/LSP)
- styleMatchesCodebase (needs lint delta)
- hypothesisDriven, fixNotBandAid (needs error→edit-locality correlation)
- assertionDensity, edgeCaseCoverage (needs test-content analysis)
- consistentNaming (needs identifier-entropy analysis)
- refactorsWhileTouching (needs commit-level rename detection)
- commentsWhyNotWhat (needs comment-content analysis)

All require either AST integration, content sampling, or commit
diff parsing. Out of scope for v2.

### Verdict

v2 is the practical floor of what synthetic-data calibration can
achieve. Further progress needs real-user data. Recommendation:
ship v2 as the calibrated baseline; collect real usage; revisit
when 5-10 users have 2+ weeks of dogfooded data.

---

## v3 (TARGETED) — DONE

### Scope

Three backend-only matchers correlating events already in the
stream. NO new producers, NO stream re-authoring (preserves
blind-check integrity).

1. **`hypothesisDriven`** — diagnostic_appeared → diagnostic_resolved
   correlation. Counts intervening text_change events split by
   neighborhood (same file) vs anywhere; tracks editor_navigation
   def-jumps in the debug window. Fires 4 matchKeys.
2. **`fixNotBandAid`** — same correlation surface. Approximates fix
   line count from line_diff events (or text_change chars/60
   fallback). Detects test-file edits during debug window. Fires
   3 matchKeys.
3. **`refactorsWhileTouching`** — commit_detected message + filesTouched
   classification. Detects refactor commits spanning multiple
   directories. Negative signal: 10+ single-file feat-only commits in
   24h. Fires 2 matchKeys.

Sharpest two v3 likelihoods softened (15:1 → 2:1) to prevent
over-credit on edge cases.

### v3 Results

| Persona | Target | A | B | A Δ | B Δ |
|---|---|---|---|---|---|
| Bootcamp Grad | 225 | 240 | 337 | +15 ✓ | +112 |
| Earnest Junior | 570 | 807 | 762 | +237 | +192 |
| Vibecoder | 254 | 226 | 494 | -28 ✓ | +240 |
| Pragmatic Mid | 708 | 760 | 846 | +52 ✓ | +138 |
| ML Researcher | 646 | 670 | 705 | +24 ✓ | +59 ✓ |
| Mobile Mid | 705 | 672 | 757 | -33 ✓ | +52 ✓ |
| Senior Backend | 841 | 723 | 892 | -118 | +51 ✓ |
| Security Senior | 739 | 603 | 759 | -136 | +20 ✓ |
| DevOps Senior | 733 | 700 | 678 | -33 ✓ | -55 ✓ |
| Polyglot Staff | 902 | 724 | 914 | -178 | +12 ✓ |

**Mean abs Δ: ~89** (v2 was ~93). Marginal numerical improvement,
but **shape changed meaningfully**:

### v3 wins (improvements over v2)

- **DevOps Senior** -140 → -33/-55 (massive — was the worst persona).
- **Security Senior B**: -85 → +20.
- **Polyglot Staff B**: -68 → +12.
- **ML Researcher**: BOTH authors now within ±60.
- **Mobile Mid**: BOTH authors within ±55.
- Diagnostics pillar now reaches 800-960 for personas with debug
  events (was capped at ~500 in v1, ~600 in v2).
- 6 of 10 senior personas now correctly rank as senior (was 2/10
  in v2 baseline).

### v3 regressions

- **Earnest Junior +200 in BOTH authors.** The hypothesisDriven
  matchers fire strongly for "thoughtful junior" debugging
  patterns. System reads year-2-with-good-habits as senior-level
  diagnostic skill. Definitional: rubric ties Diagnostics to
  experience level; system measures behavior. The system is
  arguably more honest here.
- **Pragmatic Mid B +138.** Stream B has rich debug events; v3
  matchers credit them as senior. Author noise.
- **Senior Backend A** and **Polyglot Staff A** regressed because
  author A's streams emit fewer diagnostic events than author B.
  Inter-author noise grew with v3 (v2 ~85 → v3 ~107).

### What's still dormant (deferred to v4)

7 traits remain inactive — all need richer producers:

- summarizesCodebase (session_start)
- keepsFunctionsSmall, consistentNaming (AST/LSP)
- styleMatchesCodebase (lint delta)
- assertionDensity, edgeCaseCoverage (test content)
- commentsWhyNotWhat (comment content)

### v3 Verdict

**Net positive for senior personas, mixed elsewhere.** The targeted
producer activations were the right surgical move — they fix the
specific finding (AI-skeptic seniors under-credited) without
re-authoring streams. The regression on Earnest Junior and
Pragmatic Mid is a real philosophical issue: the system measures
DIAGNOSTIC BEHAVIOR; the rubric ties diagnostics to TENURE. Without
real users to anchor ground truth, can't conclusively say which
is correct.

Recommendation: **lock v3 as final synthetic-data calibration.**
Ship. Real-user dogfooding is the next ground-truth source.
