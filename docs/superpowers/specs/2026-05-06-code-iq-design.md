# Code IQ — Design Spec

**Status:** Draft for review
**Date:** 2026-05-06
**Author:** Brainstormed with Claude
**Replaces:** existing `iqV2.ts` (v2) and IQ-related code paths in `store.ts` (v1)

---

## 1. Goal

A unique per-developer proficiency metric — *Code IQ* — that captures the **shape of coding decisions** rather than the surface of artifacts. It is fair across fields (ML, Web, Cybersecurity, …), honest about uncertainty, and hard to game.

- **Score:** 0–1000+ (no hard ceiling; the upper tail is uncapped to reward continued growth)
- **Ranks:** Learner / Junior / Mid / Senior, as **field-conditional CDF bands** (a "Senior in ML" and a "Senior in Web" are not the same number, but mean the same thing — top ~15% of their field)
- **Field:** a probability distribution over ~10 fields, not a single category
- **Confidence:** the score always ships with an interval ("670 ± 40, 87% confident")
- **Brand alignment:** the IQ is the headline of a written *portrait* — not a leaderboard rank

## 2. Theory of proficiency

A senior differs from a junior not in concept count but in the **shape of micro-decisions**:

- Adds error handling where it matters, not everywhere — judgment, not coverage
- Reads 5–10× more than writes — discipline
- Their AI prompts are surgical — diagnostic posture
- Recovers from breakage in minutes, not hours — isolation skill
- Code aligns with project conventions without being told — context-reading
- Deletes more than adds, late-stage — maturity
- Writes the failing test, then the passing code — TDD instinct

A system that counts concepts/clusters/LOC measures the *surface*. Real proficiency lives in the *shape of decisions*: what you didn't do, what order you did things in, how you recovered, how you used your tools.

Code IQ measures that shape.

## 3. Architecture overview — Narrative Mentor hybrid

Three independent layers with different cadences and costs feed a single composite score. Each layer answers a different question; the headline is the *integration*.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Code IQ Engine                              │
│                                                                     │
│   ┌────────────┐    ┌──────────────┐    ┌──────────┐    ┌────────┐  │
│   │    HMM     │    │ Mentor Panel │    │  Probe   │    │ Biog.  │  │
│   │  realtime  │ ←→ │ per-session  │ ←→ │occasional│ ←→ │ weekly │  │
│   │   spine    │    │   portrait   │    │tie-break │    │portrait│  │
│   └────────────┘    └──────────────┘    └──────────┘    └────────┘  │
│         │                  │                  │             │       │
│         └──────────────────┴──────────────────┴─────────────┘       │
│                                │                                    │
│                       composite per-pillar                          │
│                                │                                    │
│                     field-vector projection                         │
│                                │                                    │
│                    ┌───────────┴───────────┐                        │
│                    │  headline IQ (0-1000+) │                       │
│                    │  rank: Learner..Senior │                       │
│                    │   confidence interval  │                       │
│                    └───────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

| Layer | Cadence | Cost | Source of |
|---|---|---|---|
| **HMM realtime spine** | Per-event | ~0 (no LLM) | Live IQ, confidence intervals |
| **Mentor Panel** | Per-session / per-commit | LLM (~$0.05–$0.20/session) | The interpretive pillar scores; the readable portrait |
| **Adversarial Probe** | Occasional (1–2/session surfaced; many silent) | Mid (LLM only on surfaced answers) | Tie-breaker; anti-gaming evidence |
| **Biography** | Daily / weekly / monthly | LLM (~$3/user/month) | Long-form narrative; brand surface |

A single layer would be brittle. Triangulation is the anti-gaming substrate: a metric that moves only one layer is suspect.

## 4. Pillars (6)

Chosen from what mentors *notice*, not what's countable. AI Partnership is conditional on AI usage (no penalty for AI-skeptics). Velocity is deliberately *not* a pillar — it negatively correlates with mastery in many tasks.

| Pillar | What it captures |
|---|---|
| **Comprehension** | Understands before acting; decomposes well |
| **Execution** | Writes clean, correct, self-authored code |
| **Diagnostics** | Finds root causes when things break |
| **Verification** | Proves the work is correct |
| **Stewardship** | Leaves the codebase better than found |
| **AI Partnership** | Uses AI as peer, not crutch *(conditional)* |

### 4.1 Why these and not the existing v2 set

| v2 pillar | Status in v3 |
|---|---|
| Craft | Absorbed into **Execution** + **Stewardship** (split: clean code = Execution; clean *codebase* = Stewardship) |
| Range | Replaced by the **field vector** (range across fields is the field-mixture model itself) |
| Velocity | **Removed.** Speed often anti-correlates with mastery. Seniors take longer per LOC because they read first. |
| Debug | Renamed **Diagnostics** and broadened (root-cause judgment, not just bug count) |
| Quality | Split into **Verification** (proving work) and **Stewardship** (long-term health) — one signal was overloaded |
| Independence | Renamed **AI Partnership** with positive framing: "how well do you collaborate with AI" rather than "how little do you depend on it" |
| — | New: **Comprehension** (was missing — a senior-defining skill) |

### 4.2 AI Partnership conditionality

AI Partnership scales with sample size:

- If the user has < 5% AI usage in the rolling window: pillar contributes a *neutral* score (500) with low weight (0.5×).
- If 5%–50%: full pillar weight; score reflects observed quality.
- If > 50%: full pillar weight; the scrutiny is heaviest here.

**No penalty for AI-avoidance.** A senior who writes everything themselves should not be docked. A junior who pastes everything from AI without understanding *will* be docked.

## 5. Field model

Field is a probability distribution across ~10 fields, not a category.

```
Web · ML · DataEng · DevOps · Sec · Mobile · Systems · Game · Embedded · Generalist
```

### 5.1 Field detection sources

| Source | Weight | What it reads |
|---|---|---|
| **Repo archaeology** | 40% | `package.json`/`requirements.txt`/`Cargo.toml` deps, file extensions, infra files (Dockerfile, k8s, terraform), framework imports |
| **Concept distribution** | 40% | Which field-tagged concepts you demonstrate (taxonomy concepts get field tags) |
| **Self-declaration** | 20% | Onboarding hint, optional override in settings |

The vector updates continuously as the user works. Transitions are smoothed (exponential moving average, half-life ~30 days) to avoid flapping when working briefly in another field.

### 5.2 Pillar weights are field-conditional

```
weights[pillar][field]   ∈ ℝ⁺,  row-normalized
```

Illustrative weights (final values calibrated empirically):

| Field | Comp | Exec | Diag | Verif | Stew | AI |
|---|---|---|---|---|---|---|
| Web | 1.0 | 1.0 | 1.0 | 0.9 | 1.1 | 1.1 |
| ML | 1.1 | 0.9 | 1.2 | 1.3 | 0.8 | 1.0 |
| DataEng | 1.0 | 0.9 | 1.1 | 1.4 | 1.0 | 0.9 |
| DevOps | 1.1 | 0.9 | 1.3 | 1.0 | 1.1 | 0.8 |
| Sec | 1.2 | 0.9 | 1.4 | 1.2 | 0.8 | 0.9 |
| Mobile | 1.0 | 1.1 | 1.0 | 1.0 | 1.0 | 1.0 |
| Systems | 1.1 | 1.1 | 1.3 | 1.1 | 1.0 | 0.9 |
| Game | 1.0 | 1.2 | 1.0 | 0.8 | 0.9 | 1.0 |
| Embedded | 1.1 | 1.1 | 1.3 | 1.2 | 1.0 | 0.7 |
| Generalist | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |

Rationale shorthand: ML/Sec weight Diagnostics + Verification high (cost of bug). Web weights AI Partnership higher (AI tools dominate the field). Embedded weights AI Partnership low (AI tooling immature for the field).

### 5.3 Headline IQ formula

```
for each field f:
  headline_f = Σ_pillars (P[pillar] · weight[pillar][f])

headline = Σ_fields (P(field=f) · headline_f)
```

The headline is the *expectation* over the user's own field distribution. A 60% web / 40% ML user gets a blend; a pure ML user gets ML weights.

## 6. Rank tiers

Ranks (Learner / Junior / Mid / Senior) are **field-conditional CDF bands**. Cutoffs are percentile-based within each field's user cohort:

| Rank | Cohort percentile (within dominant field) |
|---|---|
| Learner | 0–25% |
| Junior | 25–55% |
| Mid | 55–85% |
| Senior | 85–100% |

A "Senior in ML" and a "Senior in Web" are not the same headline IQ but they share meaning: top 15% of their field cohort.

### 6.1 Pillar floor on rank (anti-lopsidedness)

Rank caps at **Mid** if any single pillar is below its 15th-percentile-within-rank floor. This prevents farming one pillar at the cost of others (e.g. great Execution but no Verification ≠ Senior).

### 6.2 Calibration source

Cohort percentiles + self-rating correlation. Periodic 1–10 self-rating survey (every ~3 months) calibrates the bands relative to industry meaning. Retrospective hire/promo signal (where users opt in to share) provides longer-horizon validity.

**Known risk:** without external anchor profiles, rank meaning may drift relative to industry. The spec accepts this tradeoff for now; see Section 14 for mitigation plan.

## 7. HMM Realtime Spine

Always-on score with confidence intervals. No LLM in the hot path. Updates per event.

### 7.1 Latent traits (~30, 5 per pillar)

| Pillar | Trait IDs |
|---|---|
| Comprehension | `reads-before-writes`, `pauses-before-large-edits`, `summarizes-codebase`, `asks-clarifying-questions`, `navigates-by-symbols` |
| Execution | `compiles-clean-on-save`, `keeps-functions-small`, `authorship-self`, `concept-depth`, `style-matches-codebase` |
| Diagnostics | `error-resolution-fast`, `hypothesis-driven`, `fix-not-band-aid`, `tests-after-error`, `reads-stack-trace` |
| Verification | `runs-tests-often`, `writes-test-files`, `assertion-density`, `edge-case-coverage`, `pre-commit-reads` |
| Stewardship | `meaningful-commit-msgs`, `consistent-naming`, `removes-dead-code`, `refactors-while-touching`, `comments-WHY-not-WHAT` |
| AI Partnership | `specific-prompts`, `iterates-on-AI-output`, `overrides-AI-confidently`, `explains-after-accept`, `agentic-flow-quality` |

Each trait has three states: `low` / `mid` / `high`. The system maintains a posterior distribution per trait per user.

### 7.2 Likelihood tables

For every observable event type and every trait, a hand-authored conditional probability `P(event | trait_state)`. Two examples:

```
trait: reads-before-writes
event: file_opened → 2+ navigations → first text_change after 30s
  P(event | low)  = 0.05
  P(event | mid)  = 0.30
  P(event | high) = 0.70

event: file_opened → text_change within 5s
  P(event | low)  = 0.70
  P(event | mid)  = 0.30
  P(event | high) = 0.05
```

```
trait: authorship-self
event: paste_classified(source=ai, size=120 lines) → no edits → save
  P(event | low)  = 0.70
  P(event | mid)  = 0.20
  P(event | high) = 0.05
```

Likelihoods are versioned. Calibration job re-fits them quarterly from labeled events; manual override path for hand-tuning.

### 7.3 Bayesian update

```
posterior_t(trait_state) ∝ posterior_{t-1}(trait_state) · P(event_t | trait_state)
```

Numerically stable log-domain update. Throttled to ≤ 1 update per second per user (events batched if higher arrival rate).

### 7.4 Pillar projection

```
hmm_pillar[p] = sigmoid_calibrated( Σ_traits w[trait,p] · E[posterior(trait)] ) · 1000
```

`w[trait,p]` is the trait's contribution weight to the pillar (most are 1.0; some traits weight slightly into adjacent pillars).

### 7.5 Confidence intervals

The pillar score is a function of trait posteriors, each of which is a distribution. The pillar's distribution is computed analytically (or via Monte Carlo for the composite) and surfaced as the **central 80% credible interval**:

```
UI: "Diagnostics: 670 ± 40 (87% confident)"
```

Users with little data get wide intervals; mature users get tight ones. The interval is not cosmetic — it affects rank assignment (rank requires the interval to *contain* the rank threshold for ≥ 50% of probability mass).

### 7.6 Observable events

Existing Echo events (kept):
- `keystroke_batch`, `line_diff`, `concept_encountered`, `file_snapshot`, `ai_suggestion_accepted`, `paste_classified`, `session_tick`, `session_boundary`, `commit_detected`

Existing watcher events (kept):
- `file_saved`, `text_change`, `error_appeared`, `error_cleared`, `concept_gained`, etc.

New events for v3:
- `chat_turn` — user sends a message to the AI; carries text + classification (specific/vague, prompt-shape)
- `test_run_result` — file, pass/fail, duration, error count
- `editor_navigation` — definition jump / file bounce / symbol search

## 8. Mentor Panel

The interpretive headline. The number people quote = the headline of a *written portrait* the panel produces.

### 8.1 Trigger

- Session boundary (≥ 30 min activity since last review)
- Commit (≥ 10 changed lines, or any commit on protected branches)
- Merge / PR-shaped event
- Manual `protege.iq.review` palette command

### 8.2 Bundle artifact

The bundle is what each reviewer sees:

- Diff (full, with secret redaction — see §13)
- Chat transcript window (last N turns relevant to changeset)
- Test results timeline (pass/fail with timestamps)
- Error timeline (appeared / cleared with durations)
- AI usage trace (paste sources, accept/override events, prompt texts)
- Watcher trigger log (struggle, flow, build_fail_loop, etc.)
- Inferred task description (extracted from PR/issue/commit msg)
- Concept demonstrations (which taxonomy concepts showed up, with file:line)

### 8.3 Reviewers (6, one per pillar)

Each reviewer is an LLM persona with a distinct prompt + rubric. They run **in parallel**. Output schema:

```jsonc
{
  "score":       0..1000,
  "confidence":  0..1,
  "evidence": [
    { "kind": "diff", "ref": "src/foo.ts:23-31", "note": "..." },
    { "kind": "chat", "ref": "turn-7",          "note": "..." },
    { "kind": "test", "ref": "test-12",         "note": "..." }
  ],
  "suggestions": ["...", "..."],
  "short_writeup": "..."
}
```

Rubric example (Diagnostics):

```
   0–200    Random fixes, no isolation, masks symptoms with try/catch.
            Re-introduces bug. No regression test.
 200–450    Symptom-level fixes. Eventually lands but path was thrashy.
            Doesn't write a test that captures the bug.
 450–750    Hypothesis-driven. Isolates root cause. Writes test that
            captures the bug. Fix is targeted.
 750–1000   Predicts failure modes before they appear. Proposes
            structural fix. Leaves codebase more diagnosable than
            before. Test serves as documentation of the contract.
```

### 8.4 Disagreement handling

- Reviewer variance is computed across the panel.
- If variance is below threshold: panel pillar = inverse-variance-weighted mean.
- If variance is above threshold: a *meta-reviewer* prompt receives all 6 outputs + bundle and adjudicates with rationale. The meta-reviewer's score is final.
- Variance itself is logged — a chronically high-variance pillar means the rubric needs revision.

### 8.5 Portrait writer

A 7th LLM prompt receives all 6 reviewer outputs and writes a 5-paragraph mentor portrait — warm, specific, naming evidence. Stored as markdown in `iq3_panel_reviews.portrait_md`.

The portrait is **what the user reads in the Story tab**. The number is its headline.

### 8.6 Cost

- Default: cheap-model (`gpt-5-nano`) for first pass.
- Escalate to `gpt-5-mini` only when:
  - Reviewer confidence is low (`< 0.5`)
  - User invoked manual review explicitly
  - Stakes are high (PR review, milestone commit)
- Estimated `$0.05–$0.20` per session. Budget-capped per user per day.

## 9. Adversarial Probe

High-signal occasional ground-truth. Two modes: silent (no UI) and surfaced (gentle prompt).

### 9.1 Silent probes

The system detects a natural decision point, records what the user actually did, and scores the response without telling the user they were probed.

Examples:

```
trigger:  function ≥ 50 LOC, calls external API, has no try/catch
record:   did the user later add error handling?
          did the deploy fail?
          did a teammate add it in review?
score:    weight = 0.6 (medium-high signal); category = robustness

trigger:  AI suggestion accepted ≥ 30 LOC after < 5s read time
record:   in the next 30 min, did the user open + read those lines?
          did they modify any of them?
          did they write a test for them?
score:    weight = 0.8 (high signal); category = AI partnership
```

### 9.2 Surfaced probes

Limited (max 1–2 per session, max 5 per week). Phrased as a mentor's question, not a quiz. Skippable.

```
"This try/catch wraps 50 lines — what error are you anticipating?"
"You named this `data` — what kind of data is it?"
"This regex builds a SQL query — what input shape do you expect?"
```

User answers in chat or skips ("not now"). The answer + the user's resolution path are evaluated by an LLM judge.

### 9.3 Probe categories

Each has 50+ templates:

- **Edge case** (null, empty, boundary, overflow)
- **Race condition** (async safety, ordering, cancellation)
- **Performance** (O(n²) vs O(n), unnecessary allocation, hot loop)
- **Security** (SQL/XSS/auth/secret-in-code, weak randomness)
- **Maintainability** (god function, magic number, naming)
- **AI judgment** (accept-without-checking, hallucination acceptance)
- **Architecture** (layer violation, hidden coupling, circular dep)

### 9.4 Trigger detector

- **Static**: regex + AST patterns over the diff (god function, magic constant, SQL concat, naked promise, `as any`, …)
- **Dynamic**: pattern over events (AI accept ≥ 30 LOC after < 5s read; commit while tests fail; large edit during diagnostic_change spike)
- **Cohort anomaly**: user does X far more than peers in same field (cohort percentile lookup)

### 9.5 Anti-fatigue

- Never fire surfaced probes during `flow_detected` trigger.
- Mute a category if the user dismisses 3 in a row.
- Cooldowns per category (default 24h).
- Surfaced probes can be globally disabled in settings; silent probes cannot (they are diagnostic only).

### 9.6 Scoring

- Silent probe: outcome-based score (e.g. fix added → high; production failure → low).
- Surfaced probe: LLM-judged answer quality + observed resolution path.
- Both feed into HMM as evidence (custom likelihoods) and into Mentor Panel as bundle context.

## 10. Biography

Weekly readable narrative. The Biography is what users *read*; the IQ is its headline.

| Cadence | LLM tier | Output | Approx cost |
|---|---|---|---|
| Daily | gpt-5-nano | 200-word story: what user tried, struggled with, learned | $0.005/day |
| Weekly | gpt-5-mini | 500-word arc: themes, growth, plateaus | $0.05/week |
| Monthly | claude-sonnet-4-6 | 1-page formal portrait + IQ trajectory + field shift | $0.30/month |

≈ **$3/user/month**. Tractable.

### 10.1 Pipeline

```
Daily:    cron 05:00 UTC → for each active user yesterday →
          summarize commits + sessions + struggles + wins → iq3_stories.day
Weekly:   cron Sunday 06:00 UTC → read 7 daily stories → write arc → iq3_stories.week
Monthly:  cron 1st of month 06:00 UTC → read 4 arcs + Mentor Panel reviews +
          HMM trajectory → write portrait → iq3_stories.month
```

### 10.2 UI surface

A new "Story" tab in the extension webview. Browsable: today / this week / this month / history. Shows:

- The latest portrait
- IQ trajectory chart (with CI band)
- Field vector evolution
- Highlighted growth moments (linked to commits)

### 10.3 Privacy

The Biography is *only* visible to the user. No public profile in MVP. The user can opt-out per-cadence (e.g. "no monthly portraits").

## 11. Score math (composite)

### 11.1 Per-pillar composite

```
P[pillar] = w_hmm   · hmm_pillar[pillar]
          + w_panel · panel_pillar[pillar]
          + w_probe · probe_pillar[pillar]
```

Weights depend on data sufficiency:

| Maturity | Sessions | w_hmm | w_panel | w_probe |
|---|---|---|---|---|
| Cold | < 5 | 0.70 | 0.20 | 0.10 |
| Warm | 5–30 | 0.40 | 0.50 | 0.10 |
| Mature | > 30 | 0.30 | 0.55 | 0.15 |

### 11.2 Headline

```
for each field f:
  headline_f = Σ_pillar (P[pillar] · weight[pillar][f])

headline = Σ_field (P(field=f) · headline_f)
```

### 11.3 Confidence interval

```
CI(headline) = composition of:
  HMM posterior CI (analytic)
  panel review variance (across reviewers)
  probe sample size (Wilson interval)
```

Composed via Monte Carlo (1000 samples) at each compute. Updates ≤ once per minute.

### 11.4 Rank

```
rank = field_conditional_band(headline, dominant_field, pillar_floor)
```

```python
def field_conditional_band(headline, field, pillar_floor):
    cohort_percentile = lookup(field, headline)
    base_rank         = bands[cohort_percentile]
    # pillar floor: rank caps at Mid if any pillar < floor for that rank
    if any(P[p] < FLOOR[base_rank][p] for p in PILLARS):
        return min(base_rank, "Mid")
    return base_rank
```

## 12. Cold start

| Phase | Trigger | What happens | UI label |
|---|---|---|---|
| **0. First open** | Extension install | 5-question onboarding probe set + self-declared field + optional GitHub repo scan | "Calibrating" |
| **1. First week** | < 5 sessions | HMM accumulates from ambient events | "Settling (low confidence)" |
| **2. First commit** | First commit detected | Mentor Panel runs first review | "Settling (medium confidence)" |
| **3. Steady** | ≥ 5 sessions | Full triangulation | (no badge) |
| **4. Mature** | ≥ 30 sessions | High confidence | "Confident" |

### 12.1 Onboarding probe set (~3 minutes)

- 1× **code-reading judgment** ("which of these has the bug?")
- 1× **decomposition** ("how would you split this work?")
- 1× **AI judgment** ("would you accept this AI suggestion as-is? if not, what would you change?")
- 1× **verification** ("what would you test first?")
- 1× **field check** ("when you code, you mostly write …")

Skippable. Sets meaningful priors so cold-start isn't useless.

### 12.2 Optional GitHub repo scan

If granted, scans last 30 days of commits in user-selected repos. Builds initial behavioral fingerprint. Privacy-sensitive: scoped consent, never reads private code without explicit per-repo opt-in.

## 13. Privacy + data flow

### 13.1 Telemetry policy

All telemetry is opt-in via the existing Echo subsystem (`/echo/events` endpoint, sign-in required). Code IQ inherits Echo's consent model.

### 13.2 What leaves the machine

| Component | Leaves machine? | Form |
|---|---|---|
| HMM events | Yes | Abstract events only ("function-of-50-LOC saved with 0 errors"), never source code |
| Mentor Panel bundle | Yes | Diff + chat, secret-redacted |
| Probe data | Yes | Probe ID + outcome class, no source |
| Biography stories | Yes | LLM-generated prose |
| Trait posteriors | No (optional) | Computed locally, only score syncs |

### 13.3 Secret redaction

Before any LLM call, the bundle is run through a redactor:

- API key shapes (regex: `[A-Za-z0-9_-]{32,}` near `key`/`token`/`secret` keywords)
- Env var values from `.env`-shaped lines
- JWT-shaped strings
- AWS/GCP credential shapes
- User-defined patterns (per-project `.protegeignore`)

### 13.4 Tables (additive on Echo schema, all `iq3_` prefix)

- `iq3_user_state` — trait posteriors, field vector, last update
- `iq3_pillar_history` — per-day per-pillar snapshots (for trajectory charts)
- `iq3_panel_reviews` — Mentor Panel outputs (reviewer responses, portrait, cost)
- `iq3_probes` — probe detections + responses
- `iq3_stories` — daily / weekly / monthly narratives
- `iq3_self_ratings` — periodic 1–10 self-rating survey responses
- `iq3_cohort_stats` — materialized per-field percentile distributions, rebuilt nightly

### 13.5 Right to delete

Cascade across all `iq3_*` tables on user-initiated deletion. Backups age out within 30 days.

## 14. Anti-gaming

Five layered defenses:

1. **Triangulation.** HMM + Panel + Probe must move *in the same direction* for IQ to move. Single-axis exploits don't move all three.
2. **Authorship sieve.** Every authorship-sensitive metric multiplied by per-line authorship weight: `1.0 self / 0.5 ai-assisted / 0.2 ai-copy / 0.1 pasted`.
3. **Decay.** Trait posteriors and pillar scores decay if not exercised (~3% per week toward the prior). Spaced practice required to maintain.
4. **Probe surveillance.** Cohort-relative outliers in any single signal trigger probes. High concept count + low post-accept comprehension = AI-paste-farming detected.
5. **Pillar floor on rank.** Rank capped at Mid if any pillar is below its 15th-percentile-within-rank floor. Prevents one-pillar farming.

**No leaderboards.** No "score-vs-friends" UI in MVP. Score is for self-comparison and portable verification, not status competition.

## 15. Validation

How we know the score is accurate (no anchor profile recruitment in MVP):

| Method | Frequency | What it gives |
|---|---|---|
| **Self-rating correlation** | Every ~3 months: prompt user with "Rate your seniority 1–10" | Ongoing sanity check |
| **Cohort percentile** | Continuous | Rank bands as percentiles within field cohort |
| **Inter-rater agreement** | Weekly: two parallel Mentor Panels on sampled bundles | Reviewer drift detection; rubric revision signal |
| **Retrospective hire/promo signal** | Long-term: opt-in user reports of promotions/job changes | "Did the IQ predict?" |
| **Field consistency** | Continuous: `Senior` should always = top ~15% within field | Cross-field calibration |
| **Likelihood re-fit** | Quarterly | Calibrate HMM trait likelihoods from labeled event archive |

### 15.1 Drift risk (acknowledged)

Without external anchor profiles, ranks may drift relative to industry meaning over time. Mitigations:

- The `concept-mastery` trait references taxonomy difficulty (1–3) as an absolute floor — a `Senior` cannot have low `concept-depth` regardless of cohort percentile.
- Self-rating correlation tracked as a monitored metric. If correlation < 0.5, escalate to anchor recruitment.
- The Story tab shows the *portrait*, not just the number — the qualitative content is harder to drift than a number.

## 16. Migration from existing v1/v2

| Existing | Disposition |
|---|---|
| `apps/backend/src/iqV2.ts` | **Deprecated.** Kept read-only for 1 release cycle. Sigmoid + concept-mastery formulas borrowed by HMM as some likelihoods. |
| IQ-related code in `apps/backend/src/store.ts` | **Removed.** Concept-retrieval/memory code path preserved (it's RAG, not IQ math). |
| `apps/extension/webview/skills-taxonomy.json` (260KB hardcoded) | **Field-tagged + moved to backend.** Served via `GET /iq/taxonomy`, cached in extension. Each concept gains a `fields: ["web", "ml", ...]` array and a `pillar_signals` map. |
| Existing Echo signals | Most map cleanly. New events added: `chat_turn`, `test_run_result`, `editor_navigation`. |
| `iqV2LevelFor` (Curious/Senior/Staff bands) | **Replaced** by `field_conditional_band` returning Learner/Junior/Mid/Senior. |

### 16.1 Breaking changes for consumers

- `webview/SkillConstellation.tsx` — fetches taxonomy from `/iq/taxonomy` instead of importing the JSON directly. Build size drops by ~260KB.
- `webview/ConceptsDashboard.tsx` — pillar names change; column labels need update.
- `webview/ProfilePage.tsx` — gets new "Story" tab; existing IQ tile shows new headline + CI.
- `packages/types` — new `IqV3` namespace; old `IqV2` types kept for 1 release with `@deprecated`.

## 17. Phasing

Sequenced rollout.

### Phase A — Foundation (MVP, target ~4 weeks)

- HMM realtime spine (all 30 traits + likelihoods)
- 6-pillar projection
- Field vector model + repo archaeology + concept tagging
- Rank tier mapping with pillar floor
- New event types (`chat_turn`, `test_run_result`, `editor_navigation`)
- Onboarding probe set (5 questions)
- Self-rating survey trigger
- v1/v2 deprecation
- Extension UI: updated Profile tab with headline, CI, pillar bars, field vector

**Ships:** real-time score with confidence intervals, ranks, and field-fairness.

### Phase B — Mentor Panel (~3 weeks)

- Bundle assembly + secret redaction
- 6 reviewer prompts + rubrics
- Disagreement / meta-reviewer flow
- Portrait writer
- Cost cap + escalation logic
- Storage in `iq3_panel_reviews`
- "Get Reviewed" manual trigger
- Auto-trigger on commit / session boundary

### Phase C — Biography (~3 weeks)

- Daily / weekly / monthly pipeline + cron
- Story tab UI in extension webview
- Trajectory chart + field-vector evolution
- Per-cadence opt-out

### Phase D — Probe (~3 weeks)

- Probe template library (~350 templates across 7 categories)
- Static + dynamic + cohort triggers
- Silent + surfaced probe flows
- Anti-fatigue logic
- LLM-judge for surfaced answers
- Cohort outlier alert pipeline

## 18. Folder layout

```
apps/backend/src/iq3/
  hmm.ts                          Bayesian update, posterior compute
  pillars.ts                      trait → pillar projection
  composite.ts                    HMM + Panel + Probe → composite
  fieldVector.ts                  field detection + projection
  rank.ts                         rank tier mapping with pillar floor
  cohort.ts                       cohort percentile materialization

  panel/
    bundle.ts                     session bundle assembly
    redactor.ts                   secret redaction
    reviewers/
      comprehension.ts
      execution.ts
      diagnostics.ts
      verification.ts
      stewardship.ts
      aiPartnership.ts
    portraitWriter.ts
    metaReviewer.ts

  probes/
    detector.ts                   static + dynamic trigger detection
    judge.ts                      LLM evaluation of surfaced answers
    library/
      edgeCase.json
      raceCondition.json
      performance.json
      security.json
      maintainability.json
      aiJudgment.json
      architecture.json

  biography/
    daily.ts
    weekly.ts
    monthly.ts

  routes/
    iq.ts                         GET /iq/me, GET /iq/portrait, GET /iq/taxonomy
    selfRating.ts                 POST /iq/self-rating

  cron/
    biographyDaily.ts
    biographyWeekly.ts
    biographyMonthly.ts
    cohortRebuild.ts
    likelihoodRefit.ts (quarterly)

apps/extension/src/iq3/
  realtimeBridge.ts               event → batcher → backend
  probeDetector.ts                local static analysis on diff
  probePanel.tsx                  gentle UI prompt for surfaced probes
  iqDashboard.tsx                 webview tab
  storyTab.tsx                    biography UI
  onboardingProbes.tsx            5-question cold-start

packages/types/src/iq3/
  traits.ts                       30 traits + likelihood tables
  pillars.ts                      6 pillars + per-field weight matrix
  fields.ts                       10 fields + detection signals
  events.ts                       extends EchoEvent with iq3-only events
  schemas.ts                      zod schemas for all artifacts
  index.ts                        barrel export
```

## 19. Open questions / risks

1. **Calibration drift.** Without anchor profiles, ranks may drift relative to industry over time. Mitigated by self-rating correlation as a tripwire; if correlation drops below 0.5, escalate to anchor recruitment. Tracked as a first-class monitoring metric.
2. **Reviewer prompt churn.** Mentor Panel quality depends on prompt + rubric quality. Inter-rater agreement metric must be watched; expect prompt revisions every 1–2 months in early days.
3. **Cost at scale.** Biography is $3/user/month. At 10K users, that's $30K/month. Need user-level rate limiting + paid tier gating before scaling beyond a few hundred users.
4. **Field detection bootstrap.** First-day field detection may be wrong (one repo isn't enough signal). Onboarding self-declaration is the safety net but users may decline. Acceptable for cold start; field stabilizes within first week.
5. **Probe ethics.** Surfaced probes are framed as questions, not tests, but users may feel watched. Setting toggle to disable surfaced probes entirely; silent probes cannot be disabled (they are part of the score).
6. **AI-only-developers fairness.** A user who writes nothing themselves and uses AI for everything will score low on Execution but high on AI Partnership. Headline IQ will reflect both. The pillar-floor-on-rank rule prevents this user from being labeled `Senior` regardless of AI Partnership score. This is the design intent.
7. **Likelihood authoring effort.** 30 traits × ~10 events × 3 states = ~900 conditional probabilities. First version is hand-authored; later iterations use labeled event archive to re-fit. Initial authoring is ~2 weeks of focused work.

## 20. Appendix — example IQ outputs

### 20.1 Cold-start user (after onboarding probes only)

```
Headline:    320 ± 180   (62% confident)
Rank:        Junior      (in field: Web)
Field:       Web 70% · Generalist 30%

Pillars:
  Comprehension     420 ± 210
  Execution         280 ± 220
  Diagnostics       310 ± 200
  Verification      250 ± 230
  Stewardship       330 ± 210
  AI Partnership    n/a (insufficient data)

Status: Calibrating
```

### 20.2 Mature user (web specialist, 6 months in)

```
Headline:    685 ± 35    (94% confident)
Rank:        Senior      (in field: Web)
Field:       Web 85% · Generalist 10% · DevOps 5%

Pillars:
  Comprehension     720 ± 30
  Execution         690 ± 35
  Diagnostics       660 ± 40
  Verification      650 ± 45
  Stewardship       740 ± 30
  AI Partnership    680 ± 50

Status: Confident
```

### 20.3 Mature user (multi-field, ML + Web)

```
Headline:    615 ± 50    (89% confident)
Rank:        Mid         (capped: Verification below Senior floor in ML)
Field:       ML 55% · Web 35% · Generalist 10%

Pillars:
  Comprehension     680 ± 45
  Execution         600 ± 55
  Diagnostics       620 ± 50
  Verification      490 ± 70   ← floor violation
  Stewardship       640 ± 50
  AI Partnership    620 ± 55

Status: Confident
Note: Senior rank gated by Verification floor (490 < 580 ML-Senior floor).
      To reach Senior, lift Verification.
```
