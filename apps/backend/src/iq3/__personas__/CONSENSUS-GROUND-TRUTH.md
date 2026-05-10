# Code IQ — Human-Anchored Consensus Ground Truth

This is the final benchmark used to measure system calibration. Built from:

1. **4 independent LLM raters** scored the same 10 personas blind:
   - Rater 1 (Claude, original author)
   - Rater 2 (Claude, blind from signatures only)
   - Rater 3 (Claude, blind from signatures only)
   - Rater 4 (Codex / OpenAI, cross-family validation)
2. **Pairwise Pearson correlation** across all 6 rater pairs ≥ 0.988.
3. **Mean per-rater SD = 18 points** across personas.
4. **Human anchor (Bohdan)** reviewed 3 personas and overrode where needed.

The 4-rater mean is used UNLESS the human anchor overrode it.

## Anchor table

| # | Persona | Rank (consensus) | Headline | Source |
|---|---|---|---|---|
| 1 | Bootcamp Grad in Month Two | Learner | 225 | 4-rater mean |
| 2 | Earnest Junior, Year Two | Junior | **570** | **Human anchor (Codex profile − 20)** |
| 3 | The Vibecoder | Learner¹ | 254 | 4-rater mean |
| 4 | Pragmatic Mid | Mid | 708 | 4-rater mean |
| 5 | ML Researcher Turned Engineer | Mid | 646 | 4-rater mean |
| 6 | Mobile Mid Who Ships | Mid | 705 | 4-rater mean |
| 7 | Senior Backend Architect | Senior | 841 | 4-rater mean (human agreed) |
| 8 | Senior Security Engineer (no AI) | Senior | 739 | 4-rater mean |
| 9 | Senior DevOps (thin tests) | Senior² | 733 | 4-rater mean |
| 10 | Polyglot Staff Engineer | Senior | 902 | 4-rater mean |

¹ Rank ambiguous: 1 rater said Junior, 3 said Learner. Treat as Learner-or-low-Junior.
² Rank ambiguous: 3 raters said Senior, 1 said Mid. Treat as Senior-or-top-Mid.

## Per-pillar consensus

For each persona, the 4-rater mean per pillar (rounded to nearest integer). Where the human anchor overrode, that value is **bold**.

| # | Comp | Exec | Diag | Verif | Stew | AI |
|---|---|---|---|---|---|---|
| 1 | 229 | 293 | 190 | 166 | 205 | **260** |
| 2 | 518 | 513 | 489 | 489 | 528 | 616 |
| 3 | 195 | 463 | 199 | 203 | 224 | 280 |
| 4 | 706 | 685 | 711 | 696 | 698 | 740 |
| 5 | 733 | 637 | 785 | 676 | 564 | 418 |
| 6 | 716 | 738 | 705 | 626 | 720 | 670 |
| 7 | 861 | 795 | 878 | 844 | 869 | 791 |
| 8 | 825 | 700 | 873 | 884 | 824 | 236 |
| 9 | 770 | 779 | 873 | 514 | 671 | 778 |
| 10 | 933 | 855 | 920 | 893 | 921 | 880 |

## Anchor bands for testing

For each persona, `headline ± 30` is the consensus band. System output landing inside = calibration agrees with industry intuition for that archetype. Outside = calibration finding worth investigating.

| # | Persona | Band |
|---|---|---|
| 1 | Bootcamp Grad | 195–255 |
| 2 | Earnest Junior | 540–600 |
| 3 | Vibecoder | 224–284 |
| 4 | Pragmatic Mid | 678–738 |
| 5 | ML Researcher | 616–676 |
| 6 | Mobile Mid | 675–735 |
| 7 | Senior Backend Architect | 811–871 |
| 8 | Senior Security (no AI) | 709–769 |
| 9 | Senior DevOps (thin tests) | 703–763 |
| 10 | Polyglot Staff | 872–932 |

## How to update

If new evidence (real users, additional raters, lived experience) suggests a persona's consensus is wrong, edit this file with the reason and update the bands in `unbiased/index.ts`. Do NOT widen bands silently to make tests pass.

## Provenance

- `ground-truth-unbiased.md` — Rater 1 (full reasoning + per-pillar)
- `ground-truth-rater2.md` — Rater 2 (Claude, blind)
- `ground-truth-rater3.md` — Rater 3 (Claude, blind)
- `personas-blind.md` — the input given to Raters 2–4 (no scores)
- Codex output (Rater 4) — captured in conversation, not persisted as file
