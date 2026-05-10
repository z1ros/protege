# Code IQ Personas — Rater 2 Independent Scoring

Blind scoring based on industry intuition. No prior scores consulted.

---

## Persona 1: The Bootcamp Grad in Month Two

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 220 |
| Execution | 280 |
| Diagnostics | 180 |
| Verification | 160 |
| Stewardship | 200 |
| AI Partnership | 250 |

**Headline:** 215/1000

**Rank:** Learner

**One-line reasoning:** Three months in, overwhelmed by unfamiliar code and pasting whole files into AI without follow-up — solidly in Learner territory across the board.

---

## Persona 2: The Earnest Junior, Year Two

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 480 |
| Execution | 460 |
| Diagnostics | 470 |
| Verification | 440 |
| Stewardship | 520 |
| AI Partnership | 560 |

**Headline:** 490/1000

**Rank:** Junior

**One-line reasoning:** Solid mid-Junior — habits are right (grep callers, isolate repros, validate AI), but experience hasn't filled in concurrency/edge-case intuition yet.

---

## Persona 3: The Vibecoder

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 200 |
| Execution | 380 |
| Diagnostics | 200 |
| Verification | 180 |
| Stewardship | 220 |
| AI Partnership | 280 |

**Headline:** 245/1000

**Rank:** Learner

**One-line reasoning:** Velocity without comprehension — using AI as a black box (no validation, no follow-up, vacuous tests) is a failure mode of AI Partnership, not strength.

---

## Persona 4: The Pragmatic Mid

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 700 |
| Execution | 680 |
| Diagnostics | 720 |
| Verification | 700 |
| Stewardship | 720 |
| AI Partnership | 740 |

**Headline:** 710/1000

**Rank:** Mid

**One-line reasoning:** Textbook mid — fast mental modeling, failing-test-first debugging, multi-option AI prompting; honest about gaps but covers fundamentals cleanly.

---

## Persona 5: The ML Researcher Turned Engineer

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 720 |
| Execution | 620 |
| Diagnostics | 780 |
| Verification | 600 |
| Stewardship | 540 |
| AI Partnership | 380 |

**Headline:** 615/1000

**Rank:** Mid

**One-line reasoning:** Deep domain depth (tensor tracing, property tests, toy-dataset diagnosis) drags up the high pillars, but skeptical-of-AI-without-effective-use plus weekly mega-commits keep him out of senior range.

---

## Persona 6: The Mobile Mid Who Ships

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 700 |
| Execution | 760 |
| Diagnostics | 720 |
| Verification | 600 |
| Stewardship | 740 |
| AI Partnership | 700 |

**Headline:** 705/1000

**Rank:** Mid

**One-line reasoning:** High-velocity domain expert with clean commits and good AI usage; thin network/integration testing ("integration in TestFlight") caps verification.

---

## Persona 7: The Senior Backend Architect

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 870 |
| Execution | 800 |
| Diagnostics | 880 |
| Verification | 850 |
| Stewardship | 880 |
| AI Partnership | 820 |

**Headline:** 850/1000

**Rank:** Senior

**One-line reasoning:** Archetypal senior — module-boundary-first reading, tradeoff-driven AI prompting, contract+property tests calibrated to risk, runbooks and atomic commits across the board.

---

## Persona 8: The Senior Security Engineer Who Won't Touch AI

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 880 |
| Execution | 720 |
| Diagnostics | 870 |
| Verification | 900 |
| Stewardship | 850 |
| AI Partnership | 200 |

**Headline:** 740/1000

**Rank:** Senior

**One-line reasoning:** Top-tier on adversarial reading and verification, but per the rubric, refusing AI is the same failure as pasting blindly — that one pillar pulls the headline down to lower-Senior.

---

## Persona 9: The Senior DevOps with Thin Tests

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 800 |
| Execution | 780 |
| Diagnostics | 880 |
| Verification | 480 |
| Stewardship | 620 |
| AI Partnership | 800 |

**Headline:** 740/1000

**Rank:** Senior

**One-line reasoning:** Production-grade diagnostics and confident effective AI usage are senior-strong, but the "test in prod" stance and terse commits drag verification and stewardship to mid-level.

---

## Persona 10: The Polyglot Staff Engineer

**Per-pillar (0–1000):**

| Pillar | Score |
|--------|-------|
| Comprehension | 950 |
| Execution | 880 |
| Diagnostics | 920 |
| Verification | 880 |
| Stewardship | 930 |
| AI Partnership | 900 |

**Headline:** 910/1000

**Rank:** Senior

**One-line reasoning:** Staff outlier — cross-language fluency, surgical AI use as peer reviewer, pristine commits, coaches others on test design; reserved 1000 ceiling but very high across all six.

---

## Calibration table

| Name | Rank | Headline | Comp | Exec | Diag | Verif | Stew | AI |
|------|------|----------|------|------|------|-------|------|-----|
| 1. Bootcamp Grad in Month Two | Learner | 215 | 220 | 280 | 180 | 160 | 200 | 250 |
| 2. Earnest Junior, Year Two | Junior | 490 | 480 | 460 | 470 | 440 | 520 | 560 |
| 3. Vibecoder | Learner | 245 | 200 | 380 | 200 | 180 | 220 | 280 |
| 4. Pragmatic Mid | Mid | 710 | 700 | 680 | 720 | 700 | 720 | 740 |
| 5. ML Researcher Turned Engineer | Mid | 615 | 720 | 620 | 780 | 600 | 540 | 380 |
| 6. Mobile Mid Who Ships | Mid | 705 | 700 | 760 | 720 | 600 | 740 | 700 |
| 7. Senior Backend Architect | Senior | 850 | 870 | 800 | 880 | 850 | 880 | 820 |
| 8. Senior Security Engineer Who Won't Touch AI | Senior | 740 | 880 | 720 | 870 | 900 | 850 | 200 |
| 9. Senior DevOps with Thin Tests | Senior | 740 | 800 | 780 | 880 | 480 | 620 | 800 |
| 10. Polyglot Staff Engineer | Senior | 910 | 950 | 880 | 920 | 880 | 930 | 900 |
