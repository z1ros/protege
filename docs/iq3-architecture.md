# Code IQ (iq3) — Developer Reference

This document describes the iq3 system as it exists today, end-to-end.
It is for engineers who need to read, debug, or extend the code. It is
not user-facing. The motivating design lives in
[`docs/superpowers/specs/2026-05-06-code-iq-design.md`](superpowers/specs/2026-05-06-code-iq-design.md);
this doc is a *map of the implementation*.

> **TL;DR.** Every coding action a user takes inside the extension is
> classified into a small set of **events**. Events are turned into
> **matchKeys** which Bayesian-update a per-trait posterior in a
> **Hidden Markov Model**. Traits roll up into 6 **pillars**. Pillars
> are weighted by a probabilistic **field vector** to compute a single
> **headline IQ** (0–1000) and a **rank**. Confidence intervals come
> along for the ride. There is no LLM in the scoring loop — it is pure
> Bayesian inference over hand-authored likelihood tables.

---

## 1. Architecture at a glance

```
                                (extension)
   ┌─────────────────────────────────────────────────────────┐
   │  user does X in editor                                   │
   │     │                                                    │
   │     ▼                                                    │
   │  Producer (rollups.ts, chatTurn.ts, editorNavigation.ts) │
   │     │   classifies/aggregates/redacts → emits Iq3 event  │
   │     ▼                                                    │
   │  echo event stream  ──────────►  POST /echo/events       │
   └─────────────────────────────────────────────────────────┘
                                │
                                ▼ (backend)
   ┌─────────────────────────────────────────────────────────┐
   │  routes/echo.ts                                          │
   │     │  authed (githubAuth)                               │
   │     ▼                                                    │
   │  iq3/ingest/iq3Hook.ts :: ingestForUser                  │
   │     │  per-user serialization (withUserIngestLock)       │
   │     ▼                                                    │
   │  MATCHERS  (event → matchKey strings)                    │
   │     │                                                    │
   │     ▼                                                    │
   │  iq3/hmm.ts :: applyMatchKeys                            │
   │     │  for each matchKey → trait Bayesian update         │
   │     ▼                                                    │
   │  iq3/repo.ts :: getIq3UserStateRepo().save               │
   │     │  Supabase or local JSON                            │
   │     ▼                                                    │
   │  Iq3UserState persisted                                  │
   └─────────────────────────────────────────────────────────┘

                          (read path)
   GET /iq/me ─► routes/iq.ts ─► load state ─► composite.ts
                                                  │
                                                  ▼
                                ┌────────────┐  pillars + field
                                │ pillars.ts │  + rank + CI
                                │ rank.ts    │   = Iq3Headline
                                │ ci.ts      │
                                └────────────┘
                                                  │
                                                  ▼
   extension /iq/me poll (realtimeBridge.ts) ─► IqDashboard
```

### Two persistence backends

- **Supabase** (`apps/backend/src/iq3/persistence.ts:63` — `supabaseRepo`).
  Used in production / when `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are set.
  Schema in `Architecture/migration-006-iq3-tables.sql`.
- **Local JSON fallback** (`persistence.ts:23` — `localJsonRepo`).
  Writes `apps/backend/.protege-store-iq3.json`. Dev-only.

`autoRepo()` picks one at boot. The chosen instance is shared via a
module-level singleton (`apps/backend/src/iq3/repo.ts`) so both the read
path (`routes/iq.ts`) and the ingest path (`ingest/iq3Hook.ts`) operate
on the same repo — without that, the local JSON fallback would split
state across two file handles.

---

## 2. The persisted state

`Iq3UserState` (defined at `packages/types/src/iq3/hmm.ts:7`):

```ts
{
  userId: string,
  traits: Record<TraitId, { low: number, mid: number, high: number }>,
  field:  Record<FieldId, number>,    // probability vector, sums to 1
  eventCount: number,                 // total events seen
  aiEventCount: number,               // events with AI provenance
  updatedAt: ISO8601 string,
  schemaVersion: 1,
}
```

That's the entire derivable surface. Everything else (pillar scores,
CI, rank, headline) is **computed on read** in `composite.ts`. There is
no precomputed pillar table to keep in sync.

Cold-start state (`hmm.ts:initialUserState`):

- 30 traits × uniform `{1/3, 1/3, 1/3}` posteriors
- 10 fields × `1/10` uniform field prior
- `eventCount: 0`, `aiEventCount: 0`

---

## 3. Events — what the extension observes

Events are the only input. There are two camps:

### 3.1 Pre-existing echo events (already-shipping types)

The `EchoEvent` union has been around since iq2. iq3 reuses these where
possible — e.g. `text_change` flows in from the keystroke pipeline.

### 3.2 New iq3 events

Defined in `packages/types/src/iq3/events.ts`. These are emitted by
new producers in the extension specifically for iq3.

| Event type | Purpose | Producer | Privacy notes |
|---|---|---|---|
| `chat_turn` | User sent a message to the AI chat. Captures prompt *quality* (intent classifier + boolean flags), never raw text. | `eventProducers/chatTurn.ts` | **Raw prompt text is never sent.** Only intent enum + char count + boolean classifier flags. |
| `test_run_result` | A VS Code test run completed. | (currently unwired — see §10) | File path only; no test names. |
| `editor_navigation` | def-jump, file-bounce, symbol-search, find-refs. | `eventProducers/editorNavigation.ts` | File paths PII-redacted to relative path. |
| `read_pattern_observed` | Rollup: open → nav → first-edit pattern over a file. | `eventProducers/rollups.ts` | No file paths; counts + classifier output only. |
| `paste_outcome_observed` | Rollup: large AI-shaped paste, did the user edit it within 60 s? | `eventProducers/rollups.ts` | No paste content; outcome enum + `chars` count. |
| `ai_accept_outcome_observed` | Rollup: did user edit/undo AI inline-accept within 30 s? | `eventProducers/rollups.ts` | No accepted content; `editFraction` ∈ [0, 1]. |

Every iq3 event is a discriminated-union member of `Iq3NewEvent` and is
augmented into the `EchoEvent` union (`packages/types/src/iq3/events.ts:end`).

### 3.3 What "AI-related" means

The backend ingest hook treats this set as AI-related, bumping
`aiEventCount` (`apps/backend/src/iq3/ingest/iq3Hook.ts:736`):

```
ai_suggestion_accepted
ai_suggestion_rejected
paste_classified
paste_outcome_observed
ai_accept_outcome_observed
```

`chat_turn` is **not** in this set — the chat producer hardcodes
`acceptedAi: false` because the chat turn itself doesn't observe an
accept; that's a separate downstream event.

---

## 4. Producers — extension side

A producer is a TS module that subscribes to VS Code events, classifies
them, and emits an iq3 event into the same `/echo/events` stream the
rest of the system uses.

### 4.1 `chatTurn.ts`

When the user sends a message in the Protege chat panel, `buildChatTurnEvent(text)`:

- Runs a rule-based intent classifier (`vague` / `specific` / `request` /
  `debug` / `plan`). Patterns at the top of the file.
- Sets `containsStackTraceOrLineRef`, `containsConstraintWords`,
  `containsQuestionMark` from regex flags.
- Returns the event. The raw text is **discarded** at this point.

### 4.2 `editorNavigation.ts`

Wires `onDidChangeTextEditorSelection`, `executeCommand("editor.action.revealDefinition")`,
file-bounce detection (window changes), symbol search hooks. Each
navigation emits an `editor_navigation` event with `kind`, `fromFile`,
`toFile`, `msSinceEdit`.

### 4.3 `rollups.ts` (the busy one)

The rollup producer runs three sliding-window state machines:

| Rollup | Window | Trigger | Emits |
|---|---|---|---|
| **Open → first edit** | until first `text_change` after `file_opened` | open + nav + first edit | `read_pattern_observed { pattern: deep \| skim \| jump-in }` |
| **AI paste** | 60 s after a `paste_classified` from an `ai-*` source | paste + edit timer | `paste_outcome_observed { outcome }` |
| **AI inline accept** | 30 s after `ai_suggestion_accepted` | accept + edit timer | `ai_accept_outcome_observed { editFraction }` |

The rollups exist because the *original* matchers tried to look forward
in time at ingest. That's structurally broken — by the time a backend
sees a paste, future edits haven't happened yet. So the extension waits
the window, observes the verdict, and ships a single rollup with a
classifier label baked in.

Bounded memory: `MAX_PENDING_OPENS = 100`, `MAX_PENDING_PASTES = 50`,
`MAX_PENDING_ACCEPTS = 50`. Eviction is `dropOldest*` for `opens`; the
paste/accept sets self-clear when their windows expire.

### 4.4 `realtimeBridge.ts`

Not a producer — a consumer. Polls `GET /iq/me` every 30 s, broadcasts
new headlines into the webview. Has `dispose()` for the launcher to
register on the extension context.

---

## 5. Matchers — backend side

`apps/backend/src/iq3/ingest/iq3Hook.ts:15` — the `MATCHERS: Matcher[]`
array. Each matcher is `(event, ctx) => string[]`. Output strings are
**matchKeys** — opaque string IDs that key into the likelihood table.

A matchKey looks like:
```
file_opened.then.navigations>=2.then.first_text_change.afterMs>30s
chat_turn.intent=plan.includes_constraints
paste_classified.source=ai.size>=80lines.no_edit_within_60s
test_run_result.trigger=manual.session_count>=3
```

The format is a structured discriminator; the system treats them as
opaque keys but the convention helps humans grep them. **MatchKeys are
the single source of truth that connects the producer pipeline to the
HMM** — change a matchKey string in one place without the other and
you silently break a trait.

`ctx.recent` is a rolling 4 000-event ring buffer per user. Some matchers
look back into it (e.g. *was there a stack-trace chat turn 30 min before
the failed test run?*).

The matcher loop unconditionally calls `applyMatchKeys` even when the
matcher set is empty — this is what bumps `eventCount` (and
`aiEventCount` for AI-related event types) for every event, regardless
of whether any trait fired. Earlier versions returned early on empty
match sets, which froze users in cold-start forever.

---

## 6. The HMM update

File: `apps/backend/src/iq3/hmm.ts`.

The "HMM" name is slightly aspirational — there is no transition model
yet. What we *do* have is a **per-trait independent Bayesian posterior**
over three states `low | mid | high`. Each event update is a single-step
Bayes:

```
posterior'(s | matchKey) ∝ posterior(s) · P(matchKey | s)
```

The likelihoods `P(matchKey | s)` are hand-authored in
`apps/backend/src/iq3/likelihoods.ts`. ~118 entries today, covering all
30 traits at varying coverage depth.

```ts
// Concrete entry:
{
  matchKey: "test_run_result.trigger=manual.session_count>=3",
  trait: "runsTestsOften",
  pLow:  0.05,
  pMid:  0.30,
  pHigh: 0.65,
}
```

Reading: "if the trait is `high`, observing this matchKey is 13× more
likely than if the trait is `low`." So observing it shifts the posterior
mass toward `high`.

The update is in log-domain to stay numerically stable
(`hmm.ts:applyMatchKeys` body) and renormalizes after every update.

The `eventCount` and `aiEventCount` are bumped on every call regardless
of whether any matcher fired — they're the denominators for AI Partnership
conditionality, not the HMM update path itself.

---

## 7. Traits — the 30 latent variables

`packages/types/src/iq3/traits.ts:5`. Five traits per pillar.

### Comprehension
| Trait | What it captures |
|---|---|
| `readsBeforeWrites` | Opens files and reads them before editing |
| `pausesBeforeLargeEdits` | Doesn't immediately type after opening unfamiliar code |
| `summarizesCodebase` | Runs explore tools / asks for codebase summaries |
| `asksClarifyingQuestions` | Substantive `?`-bearing chat turns |
| `navigatesBySymbols` | Uses go-to-symbol / find-refs over scrolling |

### Execution
| Trait | What it captures |
|---|---|
| `compilesCleanOnSave` | Save-time errors don't pile up |
| `keepsFunctionsSmall` | (planned — needs static analyzer) |
| `authorshipSelf` | Code that lands is hand-typed, not pasted |
| `conceptDepth` | Uses domain concepts at appropriate difficulty (taxonomy-anchored) |
| `styleMatchesCodebase` | (planned — needs static analyzer) |

### Diagnostics
| Trait | What it captures |
|---|---|
| `errorResolutionFast` | Time-to-fix on observed errors is short |
| `hypothesisDriven` | Debug-intent chat turns articulate a hypothesis |
| `fixNotBandAid` | Fix touches root, not just the symptom (planned — needs diff analysis) |
| `testsAfterError` | A new test follows an error fix |
| `readsStackTrace` | Pastes / references stack traces in chat |

### Verification
| Trait | What it captures |
|---|---|
| `runsTestsOften` | Multiple test runs per session |
| `writesTestFiles` | Creates `*.test.*` files |
| `assertionDensity` | (planned — needs static analyzer) |
| `edgeCaseCoverage` | (planned — needs test-content analysis) |
| `preCommitReads` | Reads diffs before commit |

### Stewardship
| Trait | What it captures |
|---|---|
| `meaningfulCommitMsgs` | Commit messages above template-line length and not "fix" / "wip" |
| `consistentNaming` | (planned — needs static analyzer) |
| `removesDeadCode` | Diff signal: net-negative LOC on touched files |
| `refactorsWhileTouching` | Renames + extracts during functional changes |
| `commentsWhyNotWhat` | Comment-add patterns that don't restate code |

### AI Partnership
| Trait | What it captures |
|---|---|
| `specificPrompts` | Long, constraint-bearing chat turns |
| `iteratesOnAiOutput` | Edits AI-accepted code within the 60 s / 30 s windows |
| `overridesAiConfidently` | Rejects (`undo`) AI suggestions when reasonable |
| `explainsAfterAccept` | "Walk me through this" follow-up after an accept |
| `agenticFlowQuality` | (planned — needs agent-trace integration) |

The "planned" traits have empty likelihood tables today and will sit at
uniform prior until their producers ship.

`TRAIT_TO_PILLAR` (`packages/types/src/iq3/traits.ts:42`) maps each trait
to its primary pillar.

---

## 8. Pillars — the 6 dimensions

`packages/types/src/iq3/pillars.ts:3`. Each pillar's score is computed from
its 5 child traits (`apps/backend/src/iq3/pillars.ts:computePillars`):

```
pillar.score = calibrate( mean over child traits of E[trait posterior] )
```

where `E[posterior] = 0·P(low) + 0.5·P(mid) + 1·P(high)` and `calibrate`
is a shifted sigmoid:

```ts
score = round(1000 / (1 + exp(-16 · (mean - 0.5))))
```

So a uniform prior (mean = 0.5) → score = 500. The slope (16) was tuned
empirically — most pillars realistically land in `mean ∈ [0.4, 0.7]`
because several traits sit dormant; the steeper sigmoid spreads the
reachable band: `0.4 → 170, 0.5 → 500, 0.6 → 832, 0.7 → 970`.

Pillar `ciHalfWidth` is computed from trait posterior **concentration**
(1 − normalized entropy of each posterior). Higher concentration =
narrower CI.

### 8.1 The AI Partnership conditionality gate

`pillars.ts:69–72`. A pillar can mark itself **pending** when the sample
is too small to score honestly. Currently only `aiPartnership` does
this:

```
pending = (aiEventCount < 5) OR (aiEventCount / eventCount < 0.05)
```

When pending: the pillar emits `score: 500, ciHalfWidth: 250, pending: true`.
The headline composer downscales pending contributions to `0.5×` weight
(spec §4.2). The dashboard hides the bar and shows "awaiting evidence".

This prevents penalizing AI-avoidant developers and prevents farming AI
Partnership before the user has actually used AI long enough to score.

---

## 9. Field vector — probabilistic specialization

`packages/types/src/iq3/fields.ts`. 10 fields:

```
web · ml · dataEng · devOps · sec · mobile · systems · game · embedded · generalist
```

The user is not assigned to one field — they hold a **probability
distribution** across all 10. This handles full-stack / polyglot
developers gracefully: someone doing 60 % web + 30 % ml + 10 % devops
gets pillar weights that reflect that mix.

### Where the field vector signal comes from

`apps/backend/src/iq3/fieldVector.ts:mixFreshSources` blends three
sources via EMA:

| Source | Weight | What it reads |
|---|---|---|
| **Repo archaeology** | `w_repo` (0.5) | `package.json`/`requirements.txt`/`Cargo.toml`/`go.mod` deps + file extensions + infra files |
| **Concept usage** | `w_concept` (0.3) | Concepts the user has been observed using, mapped through `skills-taxonomy.field-tags.json` |
| **Self-declaration** | `w_self` (0.2) | The onboarding `field` answer |

Decay/smoothing happens via `emaMergeField`. The dominant field
(`fieldVector.ts:dominantField`) is what the rank percentile lookup
uses.

`PILLAR_WEIGHTS[field][pillar]` (`packages/types/src/iq3/pillars.ts:23`)
is the matrix of how much each pillar matters per field — e.g. ML
weights Verification 1.3× and Stewardship 0.8×, while Web weights AI
Partnership 1.1× and Verification 0.9×.

---

## 10. Headline IQ composition

`apps/backend/src/iq3/composite.ts:computeHeadline`. The exact formula:

```
for each field f:
    headline_f = Σ_p (effective_score(p) · effective_weight(p, f))
                 ───────────────────────────────────────────────
                          Σ_p effective_weight(p, f)

    where for pending pillars:
        effective_score(p)  = 500
        effective_weight(p) = 0.5 · PILLAR_WEIGHTS[f][p]

    and for active pillars:
        effective_score(p)  = pillar.score
        effective_weight(p) = PILLAR_WEIGHTS[f][p]

headline = Σ_f (P(field=f) · headline_f)
```

So the headline is a **weighted average across pillars**, then a
**probability-weighted average across fields**. Always finite, always
in `[0, ~1000]`.

---

## 11. Confidence interval

`apps/backend/src/iq3/ci.ts:composeHeadlineCi`. Two components:

```
pillarComponent = 0.6 · sqrt( mean(pillarHalfWidth²) )
fieldComponent  = 80 · normalized_field_entropy
halfWidth       = round(pillarComponent + fieldComponent)
confidence      = clamp(1 - halfWidth/300, 0, 0.99)
```

So:
- **Tight pillars + concentrated field** → narrow CI, high confidence
- **Uniform priors + uniform field** → ~200 half-width, ~30 % confidence
- The 0.6 scalar reflects partial correlation across pillars (they share
  underlying skill); RMS without scaling would over-state combined
  variance.

The spec specifies Monte Carlo composition for the CI; we ship analytic
RMS for now. Phase B/D may swap if needed.

---

## 12. Rank

`apps/backend/src/iq3/rank.ts:computeRank`. Two inputs:

1. **Cohort percentile** within the dominant field — looked up via
   `cohort.ts:percentileForHeadline` against the `Distribution` table.
   Falls back to hand-authored `FALLBACK_DISTRIBUTION` until enough
   cohort data accumulates.
2. **Pillar floor** anti-lopsidedness check.

The bands (`packages/types/src/iq3/rank.ts:8`):

```
learner: percentile ∈ [0,  25)
junior:  percentile ∈ [25, 55)
mid:     percentile ∈ [55, 85)
senior:  percentile ∈ [85, 100]
```

The pillar floor is a Senior-only gate: if any non-pending pillar is
below `PILLAR_FLOOR_FALLBACK[uncapped_rank]` (Senior = 500), the rank
caps at Mid. This is the spec's `min(base_rank, "Mid")` rule — preventing
single-pillar farming into Senior. Junior/Mid floors exist in the table
but the spec only demotes Senior; floor checks for those tiers don't
demote (no rank lower than the violation tier in the rule).

---

## 13. Onboarding

When a user opens the Protege panel for the first time and has no iq3
state yet, the dashboard renders `OnboardingProbes.tsx` instead of the
score view. The user answers 5 multiple-choice probes; on submit the
webview posts `iq/onboardingComplete` to the host, which forwards a
sanitized payload to `POST /iq/onboarding`:

```
{
  matchKeys: string[],     // whitelisted, ≤50, each must exist in MATCHKEY_TO_TRAITS
  field?: FieldId          // optional self-declaration
}
```

Each accepted matchKey runs through `applyMatchKeys` exactly once
(non-AI), giving the user a head start on the HMM. `field` is mixed
into the field vector with weight 0.2.

Probes are designed to set ~5 traits with one Bayesian step each — not
enough to score Senior, just enough to leave cold-start.

---

## 14. Self-rating

A second light-touch input: a quarterly 1–10 self-rating prompt. UI
component `SelfRatingPrompt.tsx`, posts to `POST /iq/self-rating`.
Scope is currently store-only; spec §6.2 plans to use it as a
calibration anchor for cohort percentiles ("does our rank match what
people actually think they are?").

---

## 15. Anti-gaming

Currently in place:

1. **Triangulation across event types.** Every trait is fed by multiple
   independent matchKeys from different producers — single-axis exploits
   (e.g. spamming test-runs) shift only one trait, and the pillar
   averages over five traits.
2. **Authorship sieve.** Authorship-sensitive traits use the
   `paste_outcome_observed` / `ai_accept_outcome_observed` outcome to
   label evidence. Pasting a 1000-line block from AI registers as
   `kept-as-is` (low authorshipSelf), not as evidence of typing skill.
3. **AI Partnership conditionality.** Forces a sample of real AI use
   before the pillar can score; you can't "look senior" by avoiding AI.
4. **Pillar floor on rank.** Stops one-pillar farming into Senior.

Spec §14 lists two more that are **not yet implemented**:

5. **Decay** (planned). Trait posteriors should decay ~3 %/week toward
   the prior. There is no `applyDecay` function in the codebase yet.
   Without it, scores never recede during inactivity. Phase B target.
6. **Probe surveillance** (planned). Cohort-relative outliers in any
   single trait should trigger Panel/Probe checks. Phase B + D target.

---

## 16. Cohort calibration & cron

`apps/backend/src/iq3/cron/cohortRebuild.ts` is a pure function for
rebuilding the per-field `Distribution` from accumulated user data.
**Not currently wired to a trigger** — the comment in the file
acknowledges this. Phase B will mount it under a cron route guarded by a
secret header.

Until then, every percentile lookup uses `FALLBACK_DISTRIBUTION` from
`cohort.ts:9` — hand-authored sigmoid-shaped curves, one per field.

---

## 17. Confidence labels

The maturity bucket reported in `Iq3Headline.maturity`:

```
cold:   eventCount <  300
warm:   eventCount <  1800
mature: eventCount >= 1800
```

The current dashboard surfaces this indirectly ("we're still learning
your style"). Future composite tweaks may reweight pillars by maturity.

---

## 18. File map

### Types — `packages/types/src/iq3/`
| File | Contents |
|---|---|
| `index.ts` | re-exports |
| `pillars.ts` | `PILLAR_IDS`, `Iq3PillarScore`, `PILLAR_WEIGHTS` matrix |
| `traits.ts` | `TRAIT_IDS`, `TRAIT_TO_PILLAR`, `Iq3LikelihoodEntry` |
| `fields.ts` | `FIELD_IDS`, `Iq3FieldVector`, `uniformFieldPrior` |
| `rank.ts` | bands + floor table + `Iq3Rank` |
| `events.ts` | the 6 new event types |
| `hmm.ts` | `Iq3UserState`, `Iq3Headline` |
| `schemas.ts` | zod validators |

### Backend — `apps/backend/src/iq3/`
| File | Role |
|---|---|
| `repo.ts` | singleton `Iq3UserStateRepo` |
| `persistence.ts` | `localJsonRepo`, `supabaseRepo`, `autoRepo` |
| `hmm.ts` | `initialUserState`, `applyMatchKeys` (Bayesian update) |
| `likelihoods.ts` | hand-authored `Iq3LikelihoodEntry[]`, builds `MATCHKEY_TO_TRAITS` |
| `pillars.ts` | `computePillars`, AI conditionality gate, sigmoid calibrate |
| `fieldVector.ts` | repo archaeology + EMA + self-declaration mixing |
| `taxonomyService.ts` | concept→field overlay; `fieldVectorFromConceptCounts` |
| `composite.ts` | `computeHeadline` (the exact formula in §10) |
| `ci.ts` | `composeHeadlineCi` |
| `rank.ts` | `computeRank` |
| `cohort.ts` | percentile lookup + fallback distribution |
| `cron/cohortRebuild.ts` | (unwired) cohort distribution rebuild |
| `ingest/iq3Hook.ts` | `MATCHERS[]` array, `ingestForUser`, per-user lock, `AI_RELATED` set |
| `routes/iq.ts` | `GET /iq/me`, `POST /iq/onboarding`, `GET /iq/taxonomy` |
| `routes/selfRating.ts` | `POST /iq/self-rating` |

### Extension — `apps/extension/src/iq3/`
| File | Role |
|---|---|
| `eventProducers/chatTurn.ts` | `buildChatTurnEvent` |
| `eventProducers/editorNavigation.ts` | nav event subscriber |
| `eventProducers/rollups.ts` | open→edit / paste / accept rollups |
| `eventProducers/rollupClassifier.ts` | helper classifier |
| `realtimeBridge.ts` | `/iq/me` poll + dispose handle |

### Webview — `apps/extension/webview/iq3/`
| File | Role |
|---|---|
| `IqDashboard.tsx` | top-level: cold-branch vs score view |
| `HeadlineCard.tsx` | the big number + rank label |
| `PillarBar.tsx` | one row per pillar |
| `FieldVector.tsx` | "we're still learning your style" / dominant field |
| `OnboardingProbes.tsx` | the 5-question probe flow |
| `SelfRatingPrompt.tsx` | quarterly 1–10 prompt |

---

## 19. Testing & dogfood

### Unit tests
```
cd apps/backend
pnpm vitest run src/iq3/
```

`__personas__/v2.test.ts` is the persona archetype regression — runs
synthetic event streams for ~12 archetype users (juniorWeb, seniorML,
vibecoder, etc.) and asserts each lands in the expected rank band. This
is the canary for calibration regressions when likelihoods are tweaked.

`__field-fixtures__/` holds repo signals snapshots from real-world repos
the field-vector code is calibrated against.

### Local dogfood

See `DEV_SETUP.md`. In short:
1. `apps/backend/.env` → set `NODE_ENV=development`,
   `PROTEGE_AUTH_REQUIRED=false`, `PROTEGE_ALLOW_DEV_USER=true` to skip
   GitHub OAuth.
2. `pnpm dev` in `apps/backend/` and `apps/extension/`.
3. F5 in VS Code/Cursor → Extension Development Host.
4. Watch state evolve via:
   ```
   curl -s 'http://localhost:8787/iq/me?userId=local-dev' \
     -H 'x-user-id: local-dev' | jq
   ```

### Resetting your own state

Production: scoped DELETE in Supabase on `iq3_user_state` `WHERE user_id = '<your-github-id>'`.
Local fallback: `rm apps/backend/.protege-store-iq3.json`.

---

## 20. Currently shipping vs planned

| Feature | Status | File / spec ref |
|---|---|---|
| 6 pillars × 30 traits | shipped | `traits.ts`, `pillars.ts` |
| 10-field probability vector | shipped | `fieldVector.ts` |
| HMM Bayesian update | shipped (no transitions yet) | `hmm.ts` |
| 118 hand-authored likelihoods | shipped | `likelihoods.ts` |
| Pillar floor on rank | shipped (Senior→Mid only) | `rank.ts:60` |
| AI Partnership conditionality | shipped (with 0.5× pending weight) | `composite.ts:42`, `pillars.ts:69` |
| Cohort percentile lookup | shipped (fallback distribution only) | `cohort.ts:9` |
| Onboarding probes | shipped | `OnboardingProbes.tsx`, `routes/iq.ts:53` |
| Self-rating | shipped (store-only, no calibration loop yet) | `routes/selfRating.ts` |
| Read-pattern / paste-outcome / AI-accept-outcome rollups | shipped | `rollups.ts` |
| Test-run producer | **deferred** (testObserver proposed-API blocker) | commit `536213c` |
| `chat_turn.acceptedAi` flip | **always false** today; needs accept-correlation in producer | `chatTurn.ts:31` |
| 3 %/week trait decay | **planned** | spec §14 |
| Cohort rebuild cron | **planned** (function exists, no trigger) | `cron/cohortRebuild.ts` |
| Panel reviewers | **Phase B** | spec §10 |
| Surfaced probes | **Phase D** | spec §9.2 |
| Static-analyzer-backed traits (`keepsFunctionsSmall`, `assertionDensity`, `consistentNaming`, `styleMatchesCodebase`, `agenticFlowQuality`) | **Phase B+** — likelihood tables empty, traits idle at uniform prior | `likelihoods.ts` |

---

## 21. Worked example

A junior web developer signs in fresh:

1. **Onboarding.** Picks `web`, answers 5 probes. Backend writes 5
   matchKeys non-AI. Field gets `+0.2` toward web. Some traits move off
   uniform.
2. **First real session.** They open a React component, scroll twice,
   wait 45 s, then start typing. `read_pattern_observed { pattern: deep }`
   fires → matchKey
   `file_opened.then.navigations>=2.then.first_text_change.afterMs>30s`
   → `readsBeforeWrites` posterior shifts toward `mid`/`high`. Total
   +1 to `eventCount`.
3. **They paste 1200 chars from Cursor chat, never edit.** 60 s later
   `paste_outcome_observed { outcome: kept-as-is, source: ai-chat-output, chars: 1200 }`
   fires. matchKey doesn't trip because the threshold is `>=80lines` (~6000
   chars). No state change beyond the AI counter incrementing.
4. **They keep coding for 25 min.** Several `text_change` events,
   another deep read pattern, no test runs. `eventCount` ≈ 200,
   `aiEventCount` ≈ 1.
5. **`/iq/me` returns:**
   - Comprehension ~620 (off baseline thanks to two `readsBeforeWrites` updates)
   - Execution ~510 (slight uplift from `compilesCleanOnSave` trickling in via save events)
   - Other pillars at 500 ± 200
   - AI Partnership pending (only 1 AI event, well under 5)
   - Field vector ~ `web 0.45, generalist 0.30, others split`
   - Headline ≈ 530 ± 180, confidence ~40 %, rank `junior`, maturity `cold`

Takes ~5 sessions of similar mix to hit `warm` (300–1800 events) and
start showing real differentiation across pillars.

---

## 22. Glossary

- **Event** — A typed record emitted by the extension, e.g.
  `{ type: "test_run_result", … }`.
- **Producer** — Extension-side module that turns raw VS Code activity
  into events.
- **Matcher** — Backend function that turns an event into 0+ matchKeys.
- **MatchKey** — Opaque string ID that keys into the likelihood table.
- **Trait** — One of 30 latent skills, with a `low`/`mid`/`high`
  posterior.
- **Pillar** — One of 6 dimensions, scored as the calibrated mean of its
  child traits.
- **Field** — One of 10 specialization buckets; users hold a probability
  vector across them.
- **Headline IQ** — The single 0–1000 number, weighted by field.
- **Rank** — `learner` / `junior` / `mid` / `senior`, derived from
  cohort percentile in the dominant field, with a Senior-floor gate.
- **Pending pillar** — Pillar lacking enough sample to score; currently
  only `aiPartnership`. Contributes neutral 500 at half weight.
- **Maturity** — `cold` / `warm` / `mature`, derived from `eventCount`.
- **Cohort distribution** — Per-field cumulative `headline → percentile`
  curve. Fallback today; rebuild planned.
