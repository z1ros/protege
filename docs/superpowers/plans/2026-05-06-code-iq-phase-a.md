# Code IQ — Phase A (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-06-code-iq-design.md`

**Goal:** Build the Code IQ realtime spine — Bayesian HMM over 30 latent traits → 6 mentor-shaped pillars → field-vector projection → Learner/Junior/Mid/Senior ranks with confidence intervals, plus the extension surface (Profile tab + onboarding probes) and v1/v2 deprecation.

**Architecture:** Per-event Bayesian update over latent traits (no LLM in hot path). Posteriors project to 6 pillars. Pillar weights are field-conditional. Headline IQ is the expectation over the user's field distribution. Ranks are field-conditional CDF bands with a pillar-floor anti-lopsidedness rule. Phase A ships with HMM-only composite (`w_hmm = 1.0`); Phases B/C/D add Mentor Panel, Biography, Probe layers later.

**Tech Stack:** TypeScript (strict), Hono (backend), Zod (validation), pnpm workspaces, Supabase Postgres, Vitest (tests), React (extension webview), VS Code Extension API.

**Constraints carried from spec:**
- Score is `0–1000+` (no hard ceiling). Headline always shipped with central 80% CI.
- Ranks: Learner / Junior / Mid / Senior, field-conditional cohort percentiles.
- Pillar floor: rank caps at Mid if any pillar < 15th-pct-within-rank floor.
- AI Partnership pillar is *conditional* — neutral 500 + half weight when AI usage < 5%.
- All telemetry opt-in via existing Echo subsystem (`/echo/events`).
- Source code never leaves the machine; only abstract events.

---

## File structure

### New files

```
packages/types/src/iq3/
  index.ts                   barrel export
  events.ts                  new event union (chat_turn, test_run_result, editor_navigation) + EchoEvent extension
  traits.ts                  30 trait IDs + likelihood-table types
  pillars.ts                 6 pillars + field-conditional weight matrix
  fields.ts                  10 field IDs + detection signal types
  schemas.ts                 zod schemas for all artifacts
  rank.ts                    rank tier types + threshold types
  hmm.ts                     UserHmmState type, posterior shape

apps/backend/src/iq3/
  index.ts                   barrel
  hmm.ts                     Bayesian update, posterior compute
  likelihoods.ts             trait likelihood tables (data-only, exported const)
  pillars.ts                 trait → pillar projection + sigmoid calibration
  ci.ts                      confidence interval composer (Monte Carlo)
  fieldVector.ts             repo archaeology + concept tally → P(field)
  rank.ts                    field-conditional band + pillar floor
  composite.ts               HMM-only composite for Phase A (w_panel/w_probe = 0)
  cohort.ts                  cohort percentile materialized table reader
  taxonomyService.ts         backend-served, field-tagged taxonomy
  routes/
    iq.ts                    GET /iq/me, GET /iq/taxonomy
    selfRating.ts            POST /iq/self-rating
  ingest/
    iq3Hook.ts               called from /echo/events handler; routes events into HMM update
  cron/
    cohortRebuild.ts         nightly P(field)-conditional percentile rebuild

apps/backend/src/iq3/__tests__/
  hmm.test.ts
  pillars.test.ts
  fieldVector.test.ts
  rank.test.ts
  composite.test.ts
  ci.test.ts
  taxonomyService.test.ts

apps/extension/src/iq3/
  index.ts                   barrel
  realtimeBridge.ts          IQ score subscription + forwarding to webview
  eventProducers/
    chatTurn.ts              chat_turn event producer
    testRunResult.ts         test_run_result producer (parses VS Code Test API events)
    editorNavigation.ts      editor_navigation producer (def-jump / file-bounce)

apps/extension/webview/iq3/
  IqDashboard.tsx            new Profile tab content: headline + CI + 6 pillar bars + field vector
  PillarBar.tsx              single pillar visualization with score + CI + floor marker
  FieldVector.tsx            stacked horizontal bar of field probabilities
  HeadlineCard.tsx           big number + rank label + CI
  OnboardingProbes.tsx       5-question cold-start flow
  SelfRatingPrompt.tsx       periodic 1–10 self-rate survey

Architecture/
  migration-006-iq3-tables.sql       new tables: iq3_user_state, iq3_pillar_history, iq3_self_ratings, iq3_cohort_stats

apps/extension/webview/skills-taxonomy.field-tags.json
                              field-tag overlay (additive, mapped to existing concept IDs)
```

### Modified files

```
apps/backend/src/index.ts                       mount iq3 routes
apps/backend/src/routes/echoEvents.ts           call iq3Hook on event ingest (or wherever current handler lives)
apps/backend/src/iqV2.ts                        add @deprecated header + log warn on first call per process
apps/backend/src/store.ts                       remove IQ math (concept-mastery scoring), preserve RAG
apps/extension/src/extension.ts                 register iq3 services + event producers
apps/extension/webview/App.tsx                  swap Profile tab to IqDashboard
packages/types/src/index.ts                     export iq3 namespace
packages/types/src/concepts.ts                  mark iqV2LevelFor + IQ_V2_LEVELS as @deprecated
```

---

## Naming conventions

| Concept | Identifier |
|---|---|
| Pillar IDs | `comprehension`, `execution`, `diagnostics`, `verification`, `stewardship`, `aiPartnership` |
| Field IDs | `web`, `ml`, `dataEng`, `devOps`, `sec`, `mobile`, `systems`, `game`, `embedded`, `generalist` |
| Rank IDs | `learner`, `junior`, `mid`, `senior` |
| Trait state | `low`, `mid`, `high` |
| Table prefix | `iq3_` |
| Type namespace | `Iq3*` (e.g. `Iq3Pillar`, `Iq3UserState`, `Iq3Headline`) |

---

## Section 1 — Foundations (types + schema + DB)

### Task 1: iq3 types package skeleton

**Files:**
- Create: `packages/types/src/iq3/index.ts`
- Create: `packages/types/src/iq3/fields.ts`
- Create: `packages/types/src/iq3/pillars.ts`
- Create: `packages/types/src/iq3/rank.ts`
- Modify: `packages/types/src/index.ts` (add export)

- [ ] **Step 1: Create `packages/types/src/iq3/fields.ts`**

```typescript
/** Field IDs — fields the developer might be specializing in. */
export const FIELD_IDS = [
  "web",
  "ml",
  "dataEng",
  "devOps",
  "sec",
  "mobile",
  "systems",
  "game",
  "embedded",
  "generalist",
] as const;

export type Iq3FieldId = (typeof FIELD_IDS)[number];

/** Probability vector over fields. Sums to 1.0. */
export type Iq3FieldVector = Record<Iq3FieldId, number>;

/** Default uniform prior used at cold start before any signals. */
export function uniformFieldPrior(): Iq3FieldVector {
  const p = 1 / FIELD_IDS.length;
  return Object.fromEntries(FIELD_IDS.map((f) => [f, p])) as Iq3FieldVector;
}
```

- [ ] **Step 2: Create `packages/types/src/iq3/pillars.ts`**

```typescript
import type { Iq3FieldId } from "./fields.js";

export const PILLAR_IDS = [
  "comprehension",
  "execution",
  "diagnostics",
  "verification",
  "stewardship",
  "aiPartnership",
] as const;

export type Iq3PillarId = (typeof PILLAR_IDS)[number];

export interface Iq3PillarScore {
  /** 0..1000 */
  score: number;
  /** central 80% CI half-width in score units */
  ciHalfWidth: number;
  /** posterior probability mass within central 80% */
  ciCoverage: number;
  /** true when sample insufficient to score (e.g. AI Partnership before AI use) */
  pending: boolean;
}

/** Field-conditional weight matrix. Row-normalized at use site. */
export const PILLAR_WEIGHTS: Record<Iq3FieldId, Record<Iq3PillarId, number>> = {
  web:        { comprehension: 1.0, execution: 1.0, diagnostics: 1.0, verification: 0.9, stewardship: 1.1, aiPartnership: 1.1 },
  ml:         { comprehension: 1.1, execution: 0.9, diagnostics: 1.2, verification: 1.3, stewardship: 0.8, aiPartnership: 1.0 },
  dataEng:    { comprehension: 1.0, execution: 0.9, diagnostics: 1.1, verification: 1.4, stewardship: 1.0, aiPartnership: 0.9 },
  devOps:     { comprehension: 1.1, execution: 0.9, diagnostics: 1.3, verification: 1.0, stewardship: 1.1, aiPartnership: 0.8 },
  sec:        { comprehension: 1.2, execution: 0.9, diagnostics: 1.4, verification: 1.2, stewardship: 0.8, aiPartnership: 0.9 },
  mobile:     { comprehension: 1.0, execution: 1.1, diagnostics: 1.0, verification: 1.0, stewardship: 1.0, aiPartnership: 1.0 },
  systems:    { comprehension: 1.1, execution: 1.1, diagnostics: 1.3, verification: 1.1, stewardship: 1.0, aiPartnership: 0.9 },
  game:       { comprehension: 1.0, execution: 1.2, diagnostics: 1.0, verification: 0.8, stewardship: 0.9, aiPartnership: 1.0 },
  embedded:   { comprehension: 1.1, execution: 1.1, diagnostics: 1.3, verification: 1.2, stewardship: 1.0, aiPartnership: 0.7 },
  generalist: { comprehension: 1.0, execution: 1.0, diagnostics: 1.0, verification: 1.0, stewardship: 1.0, aiPartnership: 1.0 },
};
```

- [ ] **Step 3: Create `packages/types/src/iq3/rank.ts`**

```typescript
import type { Iq3PillarId } from "./pillars.js";
import type { Iq3FieldId } from "./fields.js";

export const RANK_IDS = ["learner", "junior", "mid", "senior"] as const;
export type Iq3RankId = (typeof RANK_IDS)[number];

/** Cohort-percentile band cutoffs (within dominant field). */
export const RANK_PERCENTILE_BANDS: Record<Iq3RankId, [number, number]> = {
  learner: [0, 25],
  junior:  [25, 55],
  mid:     [55, 85],
  senior:  [85, 100],
};

/**
 * Pillar floor: rank caps at Mid if any pillar < this floor for the rank.
 * Floor is expressed as the 15th percentile within the rank's expected
 * pillar score distribution. For Phase A, until cohort data exists, use
 * the static fallbacks below.
 */
export const PILLAR_FLOOR_FALLBACK: Record<Iq3RankId, number> = {
  learner: 0,
  junior:  150,
  mid:     350,
  senior:  580,
};

export interface Iq3Rank {
  rank: Iq3RankId;
  /** the rank that would have been assigned without the pillar floor */
  uncappedRank: Iq3RankId;
  /** which pillar caused the floor cap, if any */
  floorViolation: { pillar: Iq3PillarId; score: number; floor: number } | null;
  /** dominant field used for percentile lookup */
  dominantField: Iq3FieldId;
}
```

- [ ] **Step 4: Create `packages/types/src/iq3/index.ts`**

```typescript
export * from "./fields.js";
export * from "./pillars.js";
export * from "./rank.js";
```

- [ ] **Step 5: Edit `packages/types/src/index.ts` to re-export**

Append at the bottom:
```typescript
export * from "./iq3/index.js";
```

- [ ] **Step 6: Run typecheck**

```bash
pnpm --filter @protege/types build
```
Expected: clean build, no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/iq3 packages/types/src/index.ts
git commit -m "feat(iq3-types): field/pillar/rank base types"
```

---

### Task 2: iq3 trait + HMM types

**Files:**
- Create: `packages/types/src/iq3/traits.ts`
- Create: `packages/types/src/iq3/hmm.ts`
- Create: `packages/types/src/iq3/schemas.ts`
- Modify: `packages/types/src/iq3/index.ts`

- [ ] **Step 1: Create `packages/types/src/iq3/traits.ts`**

```typescript
import type { Iq3PillarId } from "./pillars.js";

/** All 30 latent traits. Each maps primarily to one pillar; some have
 *  secondary contributions (handled in pillar-projection weights). */
export const TRAIT_IDS = [
  // Comprehension
  "readsBeforeWrites",
  "pausesBeforeLargeEdits",
  "summarizesCodebase",
  "asksClarifyingQuestions",
  "navigatesBySymbols",
  // Execution
  "compilesCleanOnSave",
  "keepsFunctionsSmall",
  "authorshipSelf",
  "conceptDepth",
  "styleMatchesCodebase",
  // Diagnostics
  "errorResolutionFast",
  "hypothesisDriven",
  "fixNotBandAid",
  "testsAfterError",
  "readsStackTrace",
  // Verification
  "runsTestsOften",
  "writesTestFiles",
  "assertionDensity",
  "edgeCaseCoverage",
  "preCommitReads",
  // Stewardship
  "meaningfulCommitMsgs",
  "consistentNaming",
  "removesDeadCode",
  "refactorsWhileTouching",
  "commentsWhyNotWhat",
  // AI Partnership
  "specificPrompts",
  "iteratesOnAiOutput",
  "overridesAiConfidently",
  "explainsAfterAccept",
  "agenticFlowQuality",
] as const;

export type Iq3TraitId = (typeof TRAIT_IDS)[number];
export type Iq3TraitState = "low" | "mid" | "high";

/** Posterior over the three trait states. Sums to 1.0. */
export type Iq3TraitPosterior = Record<Iq3TraitState, number>;

/** Maps each trait to its primary pillar. */
export const TRAIT_TO_PILLAR: Record<Iq3TraitId, Iq3PillarId> = {
  readsBeforeWrites: "comprehension",
  pausesBeforeLargeEdits: "comprehension",
  summarizesCodebase: "comprehension",
  asksClarifyingQuestions: "comprehension",
  navigatesBySymbols: "comprehension",
  compilesCleanOnSave: "execution",
  keepsFunctionsSmall: "execution",
  authorshipSelf: "execution",
  conceptDepth: "execution",
  styleMatchesCodebase: "execution",
  errorResolutionFast: "diagnostics",
  hypothesisDriven: "diagnostics",
  fixNotBandAid: "diagnostics",
  testsAfterError: "diagnostics",
  readsStackTrace: "diagnostics",
  runsTestsOften: "verification",
  writesTestFiles: "verification",
  assertionDensity: "verification",
  edgeCaseCoverage: "verification",
  preCommitReads: "verification",
  meaningfulCommitMsgs: "stewardship",
  consistentNaming: "stewardship",
  removesDeadCode: "stewardship",
  refactorsWhileTouching: "stewardship",
  commentsWhyNotWhat: "stewardship",
  specificPrompts: "aiPartnership",
  iteratesOnAiOutput: "aiPartnership",
  overridesAiConfidently: "aiPartnership",
  explainsAfterAccept: "aiPartnership",
  agenticFlowQuality: "aiPartnership",
};

/** Likelihood entry shape — P(event | trait_state) for a single event-pattern. */
export interface Iq3LikelihoodEntry {
  /** Discriminator string — must match the matchKey computed by the ingest
   *  layer for that event pattern. */
  matchKey: string;
  trait: Iq3TraitId;
  /** P(matchKey observed | trait state). Each row should be roughly
   *  proportional across states; absolute values get normalized in update. */
  pLow: number;
  pMid: number;
  pHigh: number;
}
```

- [ ] **Step 2: Create `packages/types/src/iq3/hmm.ts`**

```typescript
import type { Iq3FieldVector } from "./fields.js";
import type { Iq3PillarId } from "./pillars.js";
import type { Iq3PillarScore } from "./pillars.js";
import type { Iq3RankId, Iq3Rank } from "./rank.js";
import type { Iq3TraitId, Iq3TraitPosterior } from "./traits.js";

/** Persisted HMM state for one user. */
export interface Iq3UserState {
  userId: string;
  /** trait → posterior over { low, mid, high } */
  traits: Record<Iq3TraitId, Iq3TraitPosterior>;
  /** field probability vector */
  field: Iq3FieldVector;
  /** total events processed (sample size for AI Partnership conditionality) */
  eventCount: number;
  /** events involving AI use */
  aiEventCount: number;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** schema version for future migrations */
  schemaVersion: 1;
}

export interface Iq3Headline {
  /** 0..1000+ */
  score: number;
  /** central 80% CI half-width */
  ciHalfWidth: number;
  /** sample-size-aware confidence */
  confidence: number;
  rank: Iq3Rank;
  pillars: Record<Iq3PillarId, Iq3PillarScore>;
  field: Iq3FieldVector;
  /** maturity bucket — drives composite weights once Panel/Probe land */
  maturity: "cold" | "warm" | "mature";
  computedAt: string;
}
```

- [ ] **Step 3: Create `packages/types/src/iq3/schemas.ts`**

```typescript
import { z } from "zod";
import { FIELD_IDS } from "./fields.js";
import { PILLAR_IDS } from "./pillars.js";
import { RANK_IDS } from "./rank.js";
import { TRAIT_IDS } from "./traits.js";

export const Iq3FieldIdSchema = z.enum(FIELD_IDS);
export const Iq3PillarIdSchema = z.enum(PILLAR_IDS);
export const Iq3RankIdSchema = z.enum(RANK_IDS);
export const Iq3TraitIdSchema = z.enum(TRAIT_IDS);
export const Iq3TraitStateSchema = z.enum(["low", "mid", "high"]);

export const Iq3TraitPosteriorSchema = z.object({
  low: z.number().min(0).max(1),
  mid: z.number().min(0).max(1),
  high: z.number().min(0).max(1),
});

export const Iq3FieldVectorSchema = z.object(
  Object.fromEntries(FIELD_IDS.map((f) => [f, z.number().min(0).max(1)])),
) as unknown as z.ZodObject<Record<typeof FIELD_IDS[number], z.ZodNumber>>;

export const SelfRatingSchema = z.object({
  userId: z.string().min(1),
  /** 1–10 self-reported seniority */
  rating: z.number().int().min(1).max(10),
  ratedAt: z.string().datetime(),
  /** optional free-text */
  note: z.string().max(500).optional(),
});

export type SelfRating = z.infer<typeof SelfRatingSchema>;
```

- [ ] **Step 4: Update `packages/types/src/iq3/index.ts`**

```typescript
export * from "./fields.js";
export * from "./pillars.js";
export * from "./rank.js";
export * from "./traits.js";
export * from "./hmm.js";
export * from "./schemas.js";
```

- [ ] **Step 5: Run typecheck**

```bash
pnpm --filter @protege/types build
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/iq3
git commit -m "feat(iq3-types): traits, HMM state, zod schemas"
```

---

### Task 3: New event types extending EchoEvent

**Files:**
- Create: `packages/types/src/iq3/events.ts`
- Modify: `packages/types/src/iq3/index.ts`

**Note:** `EchoEvent` is a discriminated union in `packages/types/src/echo.ts` (or wherever it lives in the existing echo types module — find with `grep -rn "type EchoEvent" packages/types/src`). We add three new variants.

- [ ] **Step 1: Locate the existing EchoEvent declaration**

```bash
grep -rn "EchoEvent" packages/types/src --include="*.ts" | head -10
```

Note the file path and the union shape. The new event types need to be additive (no breaking changes to existing variants).

- [ ] **Step 2: Create `packages/types/src/iq3/events.ts`**

```typescript
/**
 * IQ3 introduces three new event variants. They compose into the existing
 * EchoEvent union via module augmentation (see end of file).
 *
 * - chat_turn: user sends a message to the AI; lets HMM see prompt quality
 * - test_run_result: VS Code test API run finished; verifies "runsTestsOften"
 * - editor_navigation: def jump / file bounce / symbol search; signals reading style
 */

export interface Iq3ChatTurnEvent {
  type: "chat_turn";
  ts: number;
  /** the prompt text the user sent (PII-redacted at backend secret pass) */
  text: string;
  /** classifier output set by the producer; {specific, vague, request, debug, plan} */
  intent: "specific" | "vague" | "request" | "debug" | "plan";
  /** length of the prompt in characters (cheap proxy) */
  charCount: number;
  /** whether this turn produced an "accept" downstream (set after the fact) */
  acceptedAi: boolean;
}

export interface Iq3TestRunResultEvent {
  type: "test_run_result";
  ts: number;
  file: string;
  /** number of tests run */
  tests: number;
  /** number that passed */
  passed: number;
  /** total duration in ms */
  durationMs: number;
  /** trigger source: 'manual', 'save', 'ci-watch' */
  trigger: "manual" | "save" | "ci-watch";
}

export interface Iq3EditorNavigationEvent {
  type: "editor_navigation";
  ts: number;
  /** kind of navigation */
  kind: "def-jump" | "file-bounce" | "symbol-search" | "find-refs";
  /** source file (PII-redacted to relative path only) */
  fromFile: string;
  toFile: string;
  /** ms since the last text edit in the source file */
  msSinceEdit: number;
}

/** Discriminated union of new IQ3 events. */
export type Iq3NewEvent =
  | Iq3ChatTurnEvent
  | Iq3TestRunResultEvent
  | Iq3EditorNavigationEvent;
```

- [ ] **Step 3: Extend the canonical EchoEvent union**

Locate the file containing `export type EchoEvent = ...`. Append `| Iq3NewEvent`:

```typescript
import type { Iq3NewEvent } from "./iq3/events.js";

// ... existing EchoEvent variants ...

export type EchoEvent =
  | KeystrokeBatchEvent
  | LineDiffEvent
  | ConceptEncounteredEvent
  | FileSnapshotEvent
  | AiSuggestionAcceptedEvent
  | PasteClassifiedEvent
  | SessionTickEvent
  | SessionBoundaryEvent
  | CommitDetectedEvent
  | Iq3NewEvent;
```

- [ ] **Step 4: Update `packages/types/src/iq3/index.ts`**

```typescript
export * from "./events.js";
```

- [ ] **Step 5: Build types**

```bash
pnpm --filter @protege/types build
```
Expected: clean. If the EchoEvent file lives elsewhere and import path differs, fix the relative path.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src
git commit -m "feat(iq3-types): chat_turn, test_run_result, editor_navigation event variants"
```

---

### Task 4: Postgres migration — iq3 tables

**Files:**
- Create: `Architecture/migration-006-iq3-tables.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- migration-006-iq3-tables.sql
-- Code IQ v3 storage. All tables prefixed iq3_*. Additive on echo schema.

-- HMM state per user. One row per user.
create table if not exists iq3_user_state (
  user_id        text primary key,
  traits         jsonb not null,                       -- Record<TraitId, {low,mid,high}>
  field_vector   jsonb not null,                       -- Record<FieldId, number>
  event_count    integer not null default 0,
  ai_event_count integer not null default 0,
  schema_version smallint not null default 1,
  updated_at     timestamptz not null default now()
);

create index if not exists iq3_user_state_updated_at_idx
  on iq3_user_state (updated_at);

-- Per-day snapshot of pillar scores. One row per user per day.
-- Used for trajectory charts in the Story tab (Phase C); harvested in Phase A
-- so the data is already there when Phase C ships.
create table if not exists iq3_pillar_history (
  user_id        text not null,
  snapshot_date  date not null,
  headline       integer not null,                     -- 0..1000+
  ci_half_width  integer not null,
  pillars        jsonb not null,                       -- Record<PillarId, {score, ciHalfWidth, ciCoverage, pending}>
  rank           text not null,                        -- learner|junior|mid|senior
  dominant_field text not null,                        -- field id
  primary key (user_id, snapshot_date)
);

create index if not exists iq3_pillar_history_user_idx
  on iq3_pillar_history (user_id, snapshot_date desc);

-- Periodic self-rating survey responses.
create table if not exists iq3_self_ratings (
  id        uuid primary key default gen_random_uuid(),
  user_id   text not null,
  rating    smallint not null check (rating between 1 and 10),
  rated_at  timestamptz not null default now(),
  note      text
);

create index if not exists iq3_self_ratings_user_idx
  on iq3_self_ratings (user_id, rated_at desc);

-- Materialized cohort percentiles per (field, headline). Rebuilt nightly.
create table if not exists iq3_cohort_stats (
  field            text not null,
  -- Bucketed headline (rounded to nearest 25); cumulative percentile within field
  headline_bucket  integer not null,
  percentile       numeric(5,2) not null,
  computed_at      timestamptz not null default now(),
  primary key (field, headline_bucket)
);

-- Optional row-level security: enable later when auth lands.
-- alter table iq3_user_state     enable row level security;
-- alter table iq3_pillar_history enable row level security;
-- alter table iq3_self_ratings   enable row level security;
```

- [ ] **Step 2: Note migration in README or migration-tracker**

Inspect `Architecture/` for an existing migration index file. If one exists, append a row. If none, leave the timestamp + filename as the only record (consistent with migration-005 pattern).

- [ ] **Step 3: Apply locally to dev Supabase**

The project's existing migration mechanism is referenced in commit `a50753c` (`migration-005`). Replicate that procedure — typically `psql $DATABASE_URL -f Architecture/migration-006-iq3-tables.sql` or the project's wrapper script.

```bash
psql "$SUPABASE_DB_URL" -f Architecture/migration-006-iq3-tables.sql
```

Expected: `CREATE TABLE` × 4, `CREATE INDEX` × 3, no errors.

- [ ] **Step 4: Verify tables exist**

```bash
psql "$SUPABASE_DB_URL" -c "\d+ iq3_user_state"
psql "$SUPABASE_DB_URL" -c "\d+ iq3_pillar_history"
psql "$SUPABASE_DB_URL" -c "\d+ iq3_self_ratings"
psql "$SUPABASE_DB_URL" -c "\d+ iq3_cohort_stats"
```

- [ ] **Step 5: Commit**

```bash
git add Architecture/migration-006-iq3-tables.sql
git commit -m "feat(iq3-db): migration 006 — iq3 user state, pillar history, self ratings, cohort stats"
```

---

## Section 2 — HMM Core

### Task 5: Likelihood tables (template + 6 fully-worked examples)

**Files:**
- Create: `apps/backend/src/iq3/likelihoods.ts`

The full 30-trait table is large. This task delivers the **mechanism** plus 6 fully-authored traits — one per pillar. Task 6's tests use these. Task 8 follows up by filling in the remaining 24 traits to the same pattern.

The matchKey is computed by the ingest layer (Task 18) as a deterministic discriminator over event shape (e.g. `paste_classified:source=ai:size=large` or `file_saved:err=0:durSinceOpen<5s`). The ingest layer maps a raw event to a set of zero-or-more matchKeys.

- [ ] **Step 1: Create `apps/backend/src/iq3/likelihoods.ts`**

```typescript
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
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @protege/backend typecheck
```
Expected: clean. (If the backend's typecheck script differs, use whatever runs `tsc --noEmit`.)

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/iq3/likelihoods.ts
git commit -m "feat(iq3-hmm): trait likelihood tables (6 fully-authored)"
```

---

### Task 6: Bayesian update + posterior maintenance

**Files:**
- Create: `apps/backend/src/iq3/hmm.ts`
- Create: `apps/backend/src/iq3/__tests__/hmm.test.ts`

- [ ] **Step 1: Write the failing test — `apps/backend/src/iq3/__tests__/hmm.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { initialUserState, applyMatchKeys } from "../hmm.js";
import type { Iq3UserState } from "@protege/types";

describe("Iq3 HMM Bayesian update", () => {
  it("starts from a uniform-ish prior", () => {
    const s = initialUserState("u1");
    const t = s.traits.readsBeforeWrites;
    expect(t.low).toBeCloseTo(1 / 3, 5);
    expect(t.mid).toBeCloseTo(1 / 3, 5);
    expect(t.high).toBeCloseTo(1 / 3, 5);
  });

  it("shifts toward 'high' on a strong positive match", () => {
    const s = initialUserState("u1");
    const after = applyMatchKeys(s, [
      "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
    ]);
    expect(after.traits.readsBeforeWrites.high).toBeGreaterThan(0.5);
    expect(after.traits.readsBeforeWrites.low).toBeLessThan(0.15);
  });

  it("shifts toward 'low' on a strong negative match", () => {
    const s = initialUserState("u1");
    const after = applyMatchKeys(s, [
      "file_opened.then.first_text_change.withinMs<5s",
    ]);
    expect(after.traits.readsBeforeWrites.low).toBeGreaterThan(0.55);
  });

  it("is monotonic across consecutive same-direction matches", () => {
    let s = initialUserState("u1");
    let prevHigh = s.traits.readsBeforeWrites.high;
    for (let i = 0; i < 5; i++) {
      s = applyMatchKeys(s, [
        "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
      ]);
      expect(s.traits.readsBeforeWrites.high).toBeGreaterThanOrEqual(prevHigh);
      prevHigh = s.traits.readsBeforeWrites.high;
    }
  });

  it("posteriors always sum to 1 within float tolerance", () => {
    let s = initialUserState("u1");
    s = applyMatchKeys(s, [
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
      "commit_detected.msg_chars<20",
    ]);
    for (const t of Object.values(s.traits)) {
      const sum = t.low + t.mid + t.high;
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it("eventCount and aiEventCount track correctly", () => {
    let s = initialUserState("u1");
    s = applyMatchKeys(s, ["chat_turn.intent=specific.charCount>=120"], {
      isAiEvent: true,
    });
    expect(s.eventCount).toBe(1);
    expect(s.aiEventCount).toBe(1);
  });

  it("ignores unknown matchKeys without throwing", () => {
    const s = initialUserState("u1");
    const after = applyMatchKeys(s, ["bogus.matchKey.never.declared"]);
    // posteriors unchanged (uniform), eventCount still increments
    expect(after.traits.readsBeforeWrites.low).toBeCloseTo(1 / 3, 5);
    expect(after.eventCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/hmm.test.ts
```
Expected: FAIL — `Cannot find module '../hmm.js'`.

- [ ] **Step 3: Implement `apps/backend/src/iq3/hmm.ts`**

```typescript
import type {
  Iq3UserState,
  Iq3TraitId,
  Iq3TraitPosterior,
} from "@protege/types";
import { TRAIT_IDS, FIELD_IDS } from "@protege/types";
import { LIKELIHOODS, MATCHKEY_TO_TRAITS } from "./likelihoods.js";

const UNIFORM_PRIOR: Iq3TraitPosterior = { low: 1 / 3, mid: 1 / 3, high: 1 / 3 };

/** Build the day-zero user state. */
export function initialUserState(userId: string): Iq3UserState {
  const traits = Object.fromEntries(
    TRAIT_IDS.map((t) => [t, { ...UNIFORM_PRIOR }]),
  ) as Record<Iq3TraitId, Iq3TraitPosterior>;
  const field = Object.fromEntries(
    FIELD_IDS.map((f) => [f, 1 / FIELD_IDS.length]),
  ) as Iq3UserState["field"];
  return {
    userId,
    traits,
    field,
    eventCount: 0,
    aiEventCount: 0,
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
  };
}

interface ApplyOptions {
  /** Mark this batch as AI-related (drives AI Partnership conditionality). */
  isAiEvent?: boolean;
}

/**
 * Apply a set of matchKeys to an existing state. Each matchKey may carry
 * 0+ likelihood entries. For each entry we do a single-step Bayesian
 * update on its trait's posterior:
 *
 *     posterior'(state) ∝ posterior(state) · P(matchKey | state)
 *
 * The update is numerically stable: we work in log domain and renormalize.
 */
export function applyMatchKeys(
  state: Iq3UserState,
  matchKeys: string[],
  opts: ApplyOptions = {},
): Iq3UserState {
  // Group entries by trait so we apply each trait's update once even if
  // multiple matches hit it.
  const updatesByTrait = new Map<
    Iq3TraitId,
    { logLow: number; logMid: number; logHigh: number }
  >();

  for (const key of matchKeys) {
    const traits = MATCHKEY_TO_TRAITS.get(key) ?? [];
    for (const trait of traits) {
      const entry = LIKELIHOODS.find(
        (e) => e.matchKey === key && e.trait === trait,
      )!;
      const acc = updatesByTrait.get(trait) ?? { logLow: 0, logMid: 0, logHigh: 0 };
      acc.logLow  += Math.log(entry.pLow  + 1e-12);
      acc.logMid  += Math.log(entry.pMid  + 1e-12);
      acc.logHigh += Math.log(entry.pHigh + 1e-12);
      updatesByTrait.set(trait, acc);
    }
  }

  const newTraits: Record<Iq3TraitId, Iq3TraitPosterior> = { ...state.traits };
  for (const [trait, log] of updatesByTrait) {
    const prior = state.traits[trait];
    const lL = Math.log(prior.low  + 1e-12) + log.logLow;
    const lM = Math.log(prior.mid  + 1e-12) + log.logMid;
    const lH = Math.log(prior.high + 1e-12) + log.logHigh;
    const max = Math.max(lL, lM, lH);
    const eL = Math.exp(lL - max);
    const eM = Math.exp(lM - max);
    const eH = Math.exp(lH - max);
    const z = eL + eM + eH;
    newTraits[trait] = { low: eL / z, mid: eM / z, high: eH / z };
  }

  return {
    ...state,
    traits: newTraits,
    eventCount: state.eventCount + 1,
    aiEventCount: state.aiEventCount + (opts.isAiEvent ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/hmm.test.ts
```
Expected: PASS — all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/iq3/hmm.ts apps/backend/src/iq3/__tests__/hmm.test.ts
git commit -m "feat(iq3-hmm): Bayesian posterior update with stable log-domain math"
```

---

### Task 7: Pillar projection + sigmoid calibration

**Files:**
- Create: `apps/backend/src/iq3/pillars.ts`
- Create: `apps/backend/src/iq3/__tests__/pillars.test.ts`

The projection: each trait posterior contributes `E[trait] = 0·P(low) + 0.5·P(mid) + 1·P(high)` ∈ [0, 1]. Pillar raw = mean of `E[trait]` for that pillar's traits, ∈ [0, 1]. Calibration: a sigmoid centered at 0.5 mapping to [0, 1000].

- [ ] **Step 1: Write the failing test**

`apps/backend/src/iq3/__tests__/pillars.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { initialUserState, applyMatchKeys } from "../hmm.js";
import { computePillars } from "../pillars.js";

describe("Iq3 pillar projection", () => {
  it("returns 6 pillars from any state", () => {
    const s = initialUserState("u1");
    const p = computePillars(s);
    expect(Object.keys(p)).toEqual([
      "comprehension",
      "execution",
      "diagnostics",
      "verification",
      "stewardship",
      "aiPartnership",
    ]);
  });

  it("uniform prior maps to ~500 calibrated pillar score (with low confidence)", () => {
    const s = initialUserState("u1");
    const p = computePillars(s);
    expect(p.comprehension.score).toBeGreaterThan(450);
    expect(p.comprehension.score).toBeLessThan(550);
  });

  it("strong positive evidence raises pillar score above 700", () => {
    let s = initialUserState("u1");
    for (let i = 0; i < 8; i++) {
      s = applyMatchKeys(s, [
        "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
      ]);
    }
    const p = computePillars(s);
    expect(p.comprehension.score).toBeGreaterThan(700);
  });

  it("AI Partnership is pending when ai_event_count is 0", () => {
    const s = initialUserState("u1");
    const p = computePillars(s);
    expect(p.aiPartnership.pending).toBe(true);
    expect(p.aiPartnership.score).toBe(500);
  });

  it("AI Partnership is non-pending after enough AI events", () => {
    let s = initialUserState("u1");
    for (let i = 0; i < 10; i++) {
      s = applyMatchKeys(s, ["chat_turn.intent=specific.charCount>=120"], {
        isAiEvent: true,
      });
    }
    const p = computePillars(s);
    expect(p.aiPartnership.pending).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/pillars.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/backend/src/iq3/pillars.ts`**

```typescript
import type {
  Iq3UserState,
  Iq3PillarId,
  Iq3PillarScore,
  Iq3TraitId,
} from "@protege/types";
import { PILLAR_IDS, TRAIT_TO_PILLAR } from "@protege/types";

/** AI Partnership conditionality threshold — minimum ai event proportion to score. */
const AI_THRESHOLD_PROPORTION = 0.05;
const AI_THRESHOLD_MIN_COUNT = 5;

/** Map E[posterior] ∈ [0,1] to score ∈ [0, 1000+] via shifted sigmoid. */
function calibrate(rawMean: number): number {
  // Centered at 0.5, slope tuned so 0.7 → ~700, 0.9 → ~900.
  // f(x) = 1000 / (1 + exp(-12 * (x - 0.5)))
  return Math.round(1000 / (1 + Math.exp(-12 * (rawMean - 0.5))));
}

/** E[trait_state] using midpoint encoding 0 / 0.5 / 1. */
function expectedFromPosterior(p: { low: number; mid: number; high: number }): number {
  return 0 * p.low + 0.5 * p.mid + 1.0 * p.high;
}

export function computePillars(
  state: Iq3UserState,
): Record<Iq3PillarId, Iq3PillarScore> {
  // Group traits by pillar.
  const pillarTraits: Record<Iq3PillarId, Iq3TraitId[]> = {
    comprehension: [],
    execution: [],
    diagnostics: [],
    verification: [],
    stewardship: [],
    aiPartnership: [],
  };
  for (const [trait, pillar] of Object.entries(TRAIT_TO_PILLAR)) {
    pillarTraits[pillar as Iq3PillarId].push(trait as Iq3TraitId);
  }

  const result = {} as Record<Iq3PillarId, Iq3PillarScore>;
  for (const pillar of PILLAR_IDS) {
    const traits = pillarTraits[pillar];
    const means = traits.map((t) => expectedFromPosterior(state.traits[t]));
    const meanOfMeans = means.reduce((s, x) => s + x, 0) / means.length;

    // Confidence = how concentrated each posterior is (1 - normalized entropy).
    const concentrations = traits.map((t) => {
      const p = state.traits[t];
      const h = -[p.low, p.mid, p.high]
        .map((x) => (x > 0 ? x * Math.log(x) : 0))
        .reduce((s, x) => s + x, 0);
      const hMax = Math.log(3);
      return 1 - h / hMax;
    });
    const meanConfidence = concentrations.reduce((s, x) => s + x, 0) / concentrations.length;
    const ciHalfWidth = Math.round(200 * (1 - meanConfidence));

    // AI Partnership conditionality: pending if insufficient AI sample.
    const aiProportion =
      state.eventCount > 0 ? state.aiEventCount / state.eventCount : 0;
    const isAiPending =
      pillar === "aiPartnership" &&
      (state.aiEventCount < AI_THRESHOLD_MIN_COUNT ||
        aiProportion < AI_THRESHOLD_PROPORTION);

    if (isAiPending) {
      result[pillar] = {
        score: 500,
        ciHalfWidth: 250,
        ciCoverage: 0.0,
        pending: true,
      };
      continue;
    }

    result[pillar] = {
      score: calibrate(meanOfMeans),
      ciHalfWidth,
      ciCoverage: 0.8,
      pending: false,
    };
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/pillars.test.ts
```
Expected: PASS — all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/iq3/pillars.ts apps/backend/src/iq3/__tests__/pillars.test.ts
git commit -m "feat(iq3-pillars): trait→pillar projection with sigmoid calibration + AI conditionality"
```

---

### Task 8: Author remaining 24 trait likelihood tables

**Files:**
- Modify: `apps/backend/src/iq3/likelihoods.ts`

This task is purely data authoring. Use the **same shape** as the 6 examples in Task 5 — every entry is `{ matchKey, trait, pLow, pMid, pHigh }`. Aim for 4–6 entries per trait. The 24 traits to author:

```
Comprehension:    pausesBeforeLargeEdits, summarizesCodebase,
                  asksClarifyingQuestions, navigatesBySymbols
Execution:        compilesCleanOnSave, keepsFunctionsSmall,
                  conceptDepth, styleMatchesCodebase
Diagnostics:      errorResolutionFast, fixNotBandAid,
                  testsAfterError, readsStackTrace
Verification:     writesTestFiles, assertionDensity,
                  edgeCaseCoverage, preCommitReads
Stewardship:      consistentNaming, removesDeadCode,
                  refactorsWhileTouching, commentsWhyNotWhat
AI Partnership:   iteratesOnAiOutput, overridesAiConfidently,
                  explainsAfterAccept, agenticFlowQuality
```

Authoring convention reminder (from Task 5):

- 4–6 matchKeys per trait
- pLow + pMid + pHigh need not sum to 1 (HMM normalizes)
- Single match should not move posterior more than ~3:1
- matchKey strings are deterministic discriminators that the ingest layer (Task 18) computes from raw events

- [ ] **Step 1: Author all 24 trait tables**

Append to the existing `LIKELIHOODS` array. Example entries for one trait:

```typescript
// Comprehension :: pausesBeforeLargeEdits
{ matchKey: "before_text_change.size>=50chars.idle_duration>=20s",
  trait: "pausesBeforeLargeEdits", pLow: 0.10, pMid: 0.35, pHigh: 0.60 },
{ matchKey: "before_text_change.size>=50chars.idle_duration<=2s",
  trait: "pausesBeforeLargeEdits", pLow: 0.65, pMid: 0.30, pHigh: 0.10 },
{ matchKey: "selection_change.size>=20lines.before_edit",
  trait: "pausesBeforeLargeEdits", pLow: 0.20, pMid: 0.45, pHigh: 0.50 },
{ matchKey: "stare_pause.duration>=15s.no_edit_after",
  trait: "pausesBeforeLargeEdits", pLow: 0.10, pMid: 0.40, pHigh: 0.60 },
```

Repeat for the remaining 23 traits. Keep matchKeys consistent with existing watcher trigger names where overlap exists (e.g. `error_persists`, `flow_detected`, `stare_pause`).

- [ ] **Step 2: Run typecheck + existing tests still pass**

```bash
pnpm --filter @protege/backend typecheck
pnpm --filter @protege/backend test
```
Expected: clean + green.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/iq3/likelihoods.ts
git commit -m "feat(iq3-hmm): author remaining 24 trait likelihood tables"
```

---

## Section 3 — Field model + rank

### Task 9: Repo archaeology — field detection from deps + file types

**Files:**
- Create: `apps/backend/src/iq3/fieldVector.ts`
- Create: `apps/backend/src/iq3/__tests__/fieldVector.test.ts`

The field detector reads three signal sources (per spec §5.1) and merges into a probability vector. Phase A implements **repo archaeology** (40%) and **self-declaration** (20%); concept-distribution (40%) is implemented in Task 11.

- [ ] **Step 1: Write the failing test**

`apps/backend/src/iq3/__tests__/fieldVector.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectFieldFromRepo } from "../fieldVector.js";

describe("repo archaeology", () => {
  it("flags 'web' for a typical React repo", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: ["react", "next", "tailwindcss"],
      fileExtensions: { ".tsx": 12, ".ts": 5, ".css": 4 },
      infraFiles: [],
    });
    expect(result.web).toBeGreaterThan(0.4);
    expect(result.web).toBeGreaterThan(result.ml);
  });

  it("flags 'ml' for a typical PyTorch repo", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: [],
      requirementsTxt: ["torch", "numpy", "pandas"],
      fileExtensions: { ".py": 30, ".ipynb": 8 },
      infraFiles: [],
    });
    expect(result.ml).toBeGreaterThan(0.4);
  });

  it("flags 'devOps' for an infra-heavy repo", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: [],
      fileExtensions: { ".yaml": 20, ".tf": 10, ".sh": 5 },
      infraFiles: ["Dockerfile", "k8s/deployment.yaml", "main.tf"],
    });
    expect(result.devOps).toBeGreaterThan(0.35);
  });

  it("returns a uniform-ish vector for empty signals", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: [],
      fileExtensions: {},
      infraFiles: [],
    });
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    // generalist gets the largest share when there's no signal
    expect(result.generalist).toBeGreaterThan(0.15);
  });

  it("vector always sums to 1.0", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: ["react", "torch"],
      fileExtensions: { ".tsx": 5, ".py": 10 },
      infraFiles: ["Dockerfile"],
    });
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/fieldVector.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/backend/src/iq3/fieldVector.ts`**

```typescript
import type { Iq3FieldId, Iq3FieldVector } from "@protege/types";
import { FIELD_IDS, uniformFieldPrior } from "@protege/types";

/** Lightweight signature of a workspace, computed extension-side. */
export interface RepoSignals {
  /** package.json `dependencies` + `devDependencies` keys */
  packageJsonDeps?: string[];
  /** Python requirements.txt or pyproject.toml dependencies */
  requirementsTxt?: string[];
  /** Cargo.toml deps */
  cargoToml?: string[];
  /** go.mod requires */
  goMod?: string[];
  /** count of files per extension */
  fileExtensions?: Record<string, number>;
  /** infra-shaped files in the workspace */
  infraFiles?: string[];
}

/** Per-(field, signal) match table. Each match adds 'weight' to that field's
 *  raw score, then we Laplace-smooth + normalize. */
const DEP_HINTS: Array<{ field: Iq3FieldId; matches: RegExp[]; weight: number }> = [
  { field: "web", weight: 3, matches: [
    /^react$/i, /^next$/i, /^vue$/i, /^svelte$/i, /^tailwindcss$/i,
    /^@angular\//i, /^astro$/i, /^vite$/i, /^webpack$/i,
  ]},
  { field: "ml", weight: 3, matches: [
    /^torch$/i, /^pytorch$/i, /^tensorflow$/i, /^scikit-learn$/i, /^numpy$/i,
    /^pandas$/i, /^transformers$/i, /^datasets$/i,
  ]},
  { field: "dataEng", weight: 3, matches: [
    /^apache-airflow$/i, /^dbt-core$/i, /^pyspark$/i, /^kafka-python$/i,
    /^prefect$/i, /^dagster$/i,
  ]},
  { field: "devOps", weight: 2, matches: [
    /^terraform$/i, /^pulumi$/i, /^ansible$/i, /^kubernetes-client$/i,
  ]},
  { field: "sec", weight: 3, matches: [
    /^cryptography$/i, /^pwntools$/i, /^scapy$/i, /^pycryptodome$/i, /^impacket$/i,
  ]},
  { field: "mobile", weight: 3, matches: [
    /^react-native$/i, /^expo$/i, /^@ionic\//i, /^flutter$/i,
  ]},
  { field: "systems", weight: 2, matches: [/^libc$/i, /^tokio$/i] },
  { field: "game", weight: 3, matches: [/^pixi\.js$/i, /^phaser$/i, /^three$/i, /^pygame$/i] },
  { field: "embedded", weight: 3, matches: [/^mbed/i, /^arduino/i, /^esp-idf/i] },
];

const EXT_HINTS: Record<string, { field: Iq3FieldId; weight: number }[]> = {
  ".tsx":   [{ field: "web", weight: 2 }],
  ".jsx":   [{ field: "web", weight: 2 }],
  ".vue":   [{ field: "web", weight: 2 }],
  ".svelte":[{ field: "web", weight: 2 }],
  ".css":   [{ field: "web", weight: 1 }],
  ".py":    [{ field: "ml", weight: 1 }, { field: "dataEng", weight: 1 }, { field: "generalist", weight: 1 }],
  ".ipynb": [{ field: "ml", weight: 3 }],
  ".tf":    [{ field: "devOps", weight: 3 }],
  ".yaml":  [{ field: "devOps", weight: 1 }],
  ".yml":   [{ field: "devOps", weight: 1 }],
  ".dockerfile": [{ field: "devOps", weight: 2 }],
  ".swift": [{ field: "mobile", weight: 3 }],
  ".kt":    [{ field: "mobile", weight: 2 }],
  ".rs":    [{ field: "systems", weight: 2 }],
  ".c":     [{ field: "systems", weight: 2 }, { field: "embedded", weight: 1 }],
  ".cpp":   [{ field: "systems", weight: 1 }, { field: "game", weight: 1 }, { field: "embedded", weight: 1 }],
  ".h":     [{ field: "systems", weight: 1 }, { field: "embedded", weight: 1 }],
  ".ino":   [{ field: "embedded", weight: 4 }],
  ".sol":   [{ field: "sec", weight: 1 }],
  ".sh":    [{ field: "devOps", weight: 1 }],
};

const INFRA_HINTS: Array<{ pattern: RegExp; field: Iq3FieldId; weight: number }> = [
  { pattern: /^Dockerfile$/, field: "devOps", weight: 3 },
  { pattern: /docker-compose\.ya?ml$/, field: "devOps", weight: 2 },
  { pattern: /^k8s\//, field: "devOps", weight: 2 },
  { pattern: /\.(tf|tfvars)$/, field: "devOps", weight: 2 },
  { pattern: /^\.github\/workflows\//, field: "devOps", weight: 1 },
];

/** Compute P(field) from a single repo's signals using additive evidence + smoothing. */
export function detectFieldFromRepo(signals: RepoSignals): Iq3FieldVector {
  const raw = Object.fromEntries(FIELD_IDS.map((f) => [f, 1])) as Record<Iq3FieldId, number>; // Laplace +1

  const allDeps = [
    ...(signals.packageJsonDeps ?? []),
    ...(signals.requirementsTxt ?? []),
    ...(signals.cargoToml ?? []),
    ...(signals.goMod ?? []),
  ];
  for (const dep of allDeps) {
    for (const hint of DEP_HINTS) {
      if (hint.matches.some((rx) => rx.test(dep))) {
        raw[hint.field] += hint.weight;
      }
    }
  }

  if (signals.fileExtensions) {
    for (const [ext, count] of Object.entries(signals.fileExtensions)) {
      const hits = EXT_HINTS[ext.toLowerCase()];
      if (!hits) continue;
      for (const hit of hits) {
        // log scale to prevent giant repos from dominating
        raw[hit.field] += hit.weight * Math.log2(count + 1);
      }
    }
  }

  for (const file of signals.infraFiles ?? []) {
    for (const hint of INFRA_HINTS) {
      if (hint.pattern.test(file)) raw[hint.field] += hint.weight;
    }
  }

  // generalist gets a small floor so it's the default with no signal
  raw.generalist += 2;

  const total = Object.values(raw).reduce((s, x) => s + x, 0);
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v / total]),
  ) as Iq3FieldVector;
}

/** Merge a fresh detection with the user's existing field vector via EMA. */
export function emaMergeField(
  prior: Iq3FieldVector,
  fresh: Iq3FieldVector,
  halfLifeDays = 30,
  daysSinceLastUpdate = 1,
): Iq3FieldVector {
  const alpha = 1 - Math.pow(0.5, daysSinceLastUpdate / halfLifeDays);
  const result = {} as Iq3FieldVector;
  for (const f of FIELD_IDS) {
    result[f] = (1 - alpha) * prior[f] + alpha * fresh[f];
  }
  // re-normalize for float drift
  const total = Object.values(result).reduce((s, x) => s + x, 0);
  for (const f of FIELD_IDS) result[f] /= total;
  return result;
}

/** Mix in a self-declared field at low weight. */
export function applySelfDeclaration(
  prior: Iq3FieldVector,
  declared: Iq3FieldId,
  weight = 0.2,
): Iq3FieldVector {
  const result = {} as Iq3FieldVector;
  for (const f of FIELD_IDS) {
    result[f] = (1 - weight) * prior[f];
  }
  result[declared] += weight;
  return result;
}

/** Find the dominant field. */
export function dominantField(v: Iq3FieldVector): Iq3FieldId {
  let best: Iq3FieldId = "generalist";
  let bestP = -1;
  for (const f of FIELD_IDS) {
    if (v[f] > bestP) {
      best = f;
      bestP = v[f];
    }
  }
  return best;
}
```

- [ ] **Step 4: Run test**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/fieldVector.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/iq3/fieldVector.ts apps/backend/src/iq3/__tests__/fieldVector.test.ts
git commit -m "feat(iq3-field): repo archaeology + EMA merge + self-declaration mix"
```

---

### Task 10: Concept-distribution field signal — taxonomy field tags

**Files:**
- Create: `apps/extension/webview/skills-taxonomy.field-tags.json`
- Create: `apps/backend/src/iq3/taxonomyService.ts`
- Create: `apps/backend/src/iq3/__tests__/taxonomyService.test.ts`

The existing taxonomy at `apps/extension/webview/skills-taxonomy.json` (260 KB) has no field tags. Rather than rewrite a quarter-megabyte file, we add a sidecar overlay file mapping concept IDs to field tags, and a backend service that joins them.

- [ ] **Step 1: Create `apps/extension/webview/skills-taxonomy.field-tags.json`**

```json
{
  "version": 1,
  "generated": "2026-05-06",
  "tags": {
    "js-variables":          ["web", "generalist"],
    "js-closures":           ["web", "generalist"],
    "js-async-await":        ["web"],
    "js-promise-all":        ["web"],
    "react-hooks":           ["web"],
    "react-context":         ["web"],
    "py-numpy":              ["ml", "dataEng"],
    "py-pandas":             ["ml", "dataEng"],
    "py-pytorch":            ["ml"],
    "py-transformers":       ["ml"],
    "py-asyncio":            ["dataEng", "generalist"],
    "sql-window-functions":  ["dataEng"],
    "sql-cte":               ["dataEng"],
    "k8s-deployment":        ["devOps"],
    "terraform-modules":     ["devOps"],
    "docker-multistage":     ["devOps"],
    "auth-jwt":              ["web", "sec"],
    "auth-oauth2":           ["web", "sec"],
    "crypto-aes":            ["sec"],
    "buffer-overflow":       ["sec", "embedded"],
    "ios-swift-ui":          ["mobile"],
    "android-kotlin":        ["mobile"],
    "rust-ownership":        ["systems", "embedded"],
    "c-malloc-free":         ["systems", "embedded"],
    "game-physics":          ["game"],
    "gpu-shaders":           ["game"],
    "rtos-tasks":            ["embedded"]
  }
}
```

This is a starter set. Coverage will grow as the taxonomy gets audited. Concepts not in the map default to `["generalist"]`.

- [ ] **Step 2: Write the test**

`apps/backend/src/iq3/__tests__/taxonomyService.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  fieldsForConcept,
  fieldVectorFromConceptCounts,
} from "../taxonomyService.js";

describe("taxonomyService", () => {
  it("returns tags for a known concept", () => {
    expect(fieldsForConcept("py-pytorch")).toContain("ml");
  });

  it("falls back to generalist for unknown concepts", () => {
    expect(fieldsForConcept("not-a-real-concept-xyz")).toEqual(["generalist"]);
  });

  it("computes a field vector from concept demonstration counts", () => {
    const counts = { "py-pytorch": 3, "py-numpy": 2, "react-hooks": 1 };
    const v = fieldVectorFromConceptCounts(counts);
    expect(v.ml).toBeGreaterThan(v.web);
    expect(Object.values(v).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 5);
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/taxonomyService.test.ts
```
Expected: FAIL.

- [ ] **Step 4: Implement `apps/backend/src/iq3/taxonomyService.ts`**

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Iq3FieldId, Iq3FieldVector } from "@protege/types";
import { FIELD_IDS } from "@protege/types";

interface FieldTagsFile {
  version: number;
  generated: string;
  tags: Record<string, Iq3FieldId[]>;
}

let cache: FieldTagsFile | null = null;

function loadTags(): FieldTagsFile {
  if (cache) return cache;
  // Path resolution: backend reads the file shipped with the extension
  // webview. In dev, the file is in the workspace tree; in production,
  // ship a server copy via a build step (TODO once deploy pipeline is
  // formalized — for Phase A, dev path is sufficient).
  const path = resolve(
    process.cwd(),
    "../extension/webview/skills-taxonomy.field-tags.json",
  );
  cache = JSON.parse(readFileSync(path, "utf-8"));
  return cache!;
}

/** Return the field tags for a concept ID; default ["generalist"]. */
export function fieldsForConcept(conceptId: string): Iq3FieldId[] {
  const tags = loadTags().tags;
  return tags[conceptId] ?? ["generalist"];
}

/** Build a field vector by tallying field tags across concept counts. */
export function fieldVectorFromConceptCounts(
  counts: Record<string, number>,
): Iq3FieldVector {
  const raw = Object.fromEntries(FIELD_IDS.map((f) => [f, 1])) as Record<Iq3FieldId, number>; // Laplace
  for (const [concept, count] of Object.entries(counts)) {
    const fields = fieldsForConcept(concept);
    // Count gets split across multi-tagged concepts so a single concept
    // doesn't inflate multiple fields beyond unit weight.
    const share = count / fields.length;
    for (const f of fields) raw[f] += share;
  }
  const total = Object.values(raw).reduce((s, x) => s + x, 0);
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v / total]),
  ) as Iq3FieldVector;
}

/** Cache reset (test helper). */
export function _resetTagsCache() {
  cache = null;
}
```

- [ ] **Step 5: Run test to verify pass**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/taxonomyService.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/webview/skills-taxonomy.field-tags.json apps/backend/src/iq3/taxonomyService.ts apps/backend/src/iq3/__tests__/taxonomyService.test.ts
git commit -m "feat(iq3-field): concept→field tag overlay + taxonomy service"
```

---

### Task 11: Combined field vector update flow

**Files:**
- Modify: `apps/backend/src/iq3/fieldVector.ts`
- Modify: `apps/backend/src/iq3/__tests__/fieldVector.test.ts`

Combines the three sources per the spec weighting (40% repo / 40% concepts / 20% self-declared).

- [ ] **Step 1: Add the combiner function to `fieldVector.ts`**

```typescript
import { fieldVectorFromConceptCounts } from "./taxonomyService.js";

export interface FieldUpdateInput {
  prior: Iq3FieldVector;
  repoSignals?: RepoSignals;
  conceptCounts?: Record<string, number>;
  selfDeclared?: Iq3FieldId;
  daysSinceLastUpdate?: number;
}

/**
 * One-shot field vector update applying all three sources at the spec's
 * weights: 40% repo / 40% concepts / 20% self-declared.
 */
export function updateFieldVector(input: FieldUpdateInput): Iq3FieldVector {
  const repo  = input.repoSignals    ? detectFieldFromRepo(input.repoSignals) : null;
  const conc  = input.conceptCounts  ? fieldVectorFromConceptCounts(input.conceptCounts) : null;

  const fresh = mixFreshSources(repo, conc, input.selfDeclared);
  return emaMergeField(input.prior, fresh, 30, input.daysSinceLastUpdate ?? 1);
}

function mixFreshSources(
  repo: Iq3FieldVector | null,
  conc: Iq3FieldVector | null,
  selfDeclared: Iq3FieldId | undefined,
): Iq3FieldVector {
  const baseline = uniformFieldPrior();
  const w_repo = repo ? 0.4 : 0;
  const w_conc = conc ? 0.4 : 0;
  const w_self = selfDeclared ? 0.2 : 0;
  const w_baseline = 1 - (w_repo + w_conc + w_self);
  const result = {} as Iq3FieldVector;
  for (const f of FIELD_IDS) {
    result[f] =
      w_baseline * baseline[f] +
      w_repo * (repo ? repo[f] : 0) +
      w_conc * (conc ? conc[f] : 0) +
      w_self * (selfDeclared === f ? 1 : 0);
  }
  return result;
}
```

- [ ] **Step 2: Add a test for the combiner**

Append to `__tests__/fieldVector.test.ts`:

```typescript
import { updateFieldVector } from "../fieldVector.js";

describe("combined field vector update", () => {
  it("blends repo + concepts + self-declared with spec weights", () => {
    const v = updateFieldVector({
      prior: uniformFieldPrior(),
      repoSignals: { packageJsonDeps: ["react"], fileExtensions: { ".tsx": 5 }, infraFiles: [] },
      conceptCounts: { "py-pytorch": 3 },
      selfDeclared: "ml",
      daysSinceLastUpdate: 1,
    });
    // ML should be the dominant field (weight from concepts + self-decl)
    const dom = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
    expect(["ml", "web"]).toContain(dom);
    expect(Object.values(v).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 5);
  });
});
```

The test imports `uniformFieldPrior` from `@protege/types`; make sure that import is at the top of the test file.

- [ ] **Step 3: Run all field tests**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/fieldVector.test.ts
```
Expected: PASS for new test + existing.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/iq3/fieldVector.ts apps/backend/src/iq3/__tests__/fieldVector.test.ts
git commit -m "feat(iq3-field): combined three-source field vector update"
```

---

### Task 12: Cohort percentile materialization (nightly job)

**Files:**
- Create: `apps/backend/src/iq3/cohort.ts`
- Create: `apps/backend/src/iq3/cron/cohortRebuild.ts`
- Create: `apps/backend/src/iq3/__tests__/cohort.test.ts` (logic-level test, no DB)

For Phase A, while user data is sparse, we ship a hardcoded fallback distribution so ranks work from day one. The cron job is wired but its output is only consumed once cohort size exceeds a threshold.

- [ ] **Step 1: Write a test of the lookup logic**

`apps/backend/src/iq3/__tests__/cohort.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { percentileForHeadline, FALLBACK_DISTRIBUTION } from "../cohort.js";

describe("cohort percentile lookup", () => {
  it("returns ~0 for a very low score in any field", () => {
    expect(percentileForHeadline("web", 50, FALLBACK_DISTRIBUTION)).toBeLessThan(10);
  });
  it("returns ~99 for a very high score", () => {
    expect(percentileForHeadline("web", 950, FALLBACK_DISTRIBUTION)).toBeGreaterThan(95);
  });
  it("monotonic in headline", () => {
    const a = percentileForHeadline("web", 200, FALLBACK_DISTRIBUTION);
    const b = percentileForHeadline("web", 500, FALLBACK_DISTRIBUTION);
    const c = percentileForHeadline("web", 800, FALLBACK_DISTRIBUTION);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/cohort.test.ts
```

- [ ] **Step 3: Implement `apps/backend/src/iq3/cohort.ts`**

```typescript
import type { Iq3FieldId } from "@protege/types";

/** Per-field cumulative distribution as (headline, percentile) breakpoints.
 *  Linear interp between breakpoints. Hand-authored fallback for cold cohorts. */
export type Distribution = Record<Iq3FieldId, Array<[number, number]>>;

/** Industry-shaped fallbacks. Treat these as priors that get displaced as
 *  cohort data accumulates. Each row is (headline_score, cumulative_pct). */
export const FALLBACK_DISTRIBUTION: Distribution = {
  web:        [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
  ml:         [[0, 0], [220, 12], [430, 35], [580, 60], [720, 85], [870, 97], [1000, 100]],
  dataEng:    [[0, 0], [200, 12], [400, 35], [560, 60], [700, 85], [850, 97], [1000, 100]],
  devOps:     [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
  sec:        [[0, 0], [220, 12], [430, 35], [580, 60], [720, 85], [870, 97], [1000, 100]],
  mobile:     [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
  systems:    [[0, 0], [220, 12], [430, 35], [580, 60], [720, 85], [870, 97], [1000, 100]],
  game:       [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
  embedded:   [[0, 0], [220, 12], [430, 35], [580, 60], [720, 85], [870, 97], [1000, 100]],
  generalist: [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
};

/** Linear interp between breakpoints. Returns 0..100. */
export function percentileForHeadline(
  field: Iq3FieldId,
  headline: number,
  dist: Distribution,
): number {
  const points = dist[field];
  if (!points.length) return 50;
  if (headline <= points[0][0]) return points[0][1];
  if (headline >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (headline >= x1 && headline <= x2) {
      const t = (headline - x1) / (x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  return 50;
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/cohort.test.ts
```
Expected: PASS.

- [ ] **Step 5: Implement the cron stub `apps/backend/src/iq3/cron/cohortRebuild.ts`**

```typescript
/**
 * Nightly job: rebuilds iq3_cohort_stats from current iq3_pillar_history.
 * For Phase A, run only when cohort is large enough to be meaningful;
 * otherwise the FALLBACK_DISTRIBUTION continues to be used.
 *
 * Wiring: add to whatever cron runner the backend uses. If none exists,
 * trigger via Railway scheduled tasks or Hono route + external cron.
 */

import type { Iq3FieldId } from "@protege/types";
import { FIELD_IDS } from "@protege/types";

const MIN_COHORT_SIZE_TO_OVERRIDE = 200; // per field

export interface CohortRebuildResult {
  perField: Record<Iq3FieldId, { sampled: number; replaced: boolean }>;
  ranAt: string;
}

/**
 * Implementation contract:
 *   for each field f:
 *     1. select latest headline per user where dominant_field = f
 *     2. if count >= MIN_COHORT_SIZE_TO_OVERRIDE, write 7 percentile
 *        breakpoints (5, 25, 50, 75, 90, 97, 99) to iq3_cohort_stats
 *     3. else: write nothing (fallback continues)
 *
 * Phase A leaves the SQL implementation in a follow-up task once the
 * data shape stabilizes. The function below is a stub so the cron is
 * wireable today; it always reports replaced=false.
 */
export async function rebuildCohortStats(): Promise<CohortRebuildResult> {
  const perField = Object.fromEntries(
    FIELD_IDS.map((f) => [f, { sampled: 0, replaced: false }]),
  ) as CohortRebuildResult["perField"];
  return { perField, ranAt: new Date().toISOString() };
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/iq3/cohort.ts apps/backend/src/iq3/cron apps/backend/src/iq3/__tests__/cohort.test.ts
git commit -m "feat(iq3-cohort): fallback distribution + percentile lookup + rebuild stub"
```

---

### Task 13: Rank tier mapping with pillar floor

**Files:**
- Create: `apps/backend/src/iq3/rank.ts`
- Create: `apps/backend/src/iq3/__tests__/rank.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/backend/src/iq3/__tests__/rank.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeRank } from "../rank.js";
import { FALLBACK_DISTRIBUTION } from "../cohort.js";

describe("rank tier mapping", () => {
  it("a low headline with no floor violation returns Learner", () => {
    const r = computeRank({
      headline: 80,
      dominantField: "web",
      pillars: {
        comprehension:  { score: 100, ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        execution:      { score: 90,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        diagnostics:    { score: 80,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        verification:   { score: 70,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        stewardship:    { score: 60,  ciHalfWidth: 100, ciCoverage: 0.8, pending: false },
        aiPartnership:  { score: 500, ciHalfWidth: 250, ciCoverage: 0.0, pending: true },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.rank).toBe("learner");
    expect(r.floorViolation).toBeNull();
  });

  it("high headline + all pillars high → Senior", () => {
    const r = computeRank({
      headline: 880,
      dominantField: "web",
      pillars: {
        comprehension:  { score: 720, ciHalfWidth: 30, ciCoverage: 0.8, pending: false },
        execution:      { score: 690, ciHalfWidth: 35, ciCoverage: 0.8, pending: false },
        diagnostics:    { score: 660, ciHalfWidth: 40, ciCoverage: 0.8, pending: false },
        verification:   { score: 650, ciHalfWidth: 45, ciCoverage: 0.8, pending: false },
        stewardship:    { score: 740, ciHalfWidth: 30, ciCoverage: 0.8, pending: false },
        aiPartnership:  { score: 680, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.rank).toBe("senior");
  });

  it("would-be-Senior with verification floor violation caps at Mid", () => {
    const r = computeRank({
      headline: 880,
      dominantField: "ml",
      pillars: {
        comprehension:  { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        execution:      { score: 680, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        diagnostics:    { score: 690, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        verification:   { score: 480, ciHalfWidth: 70, ciCoverage: 0.8, pending: false },
        stewardship:    { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        aiPartnership:  { score: 680, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.rank).toBe("mid");
    expect(r.uncappedRank).toBe("senior");
    expect(r.floorViolation?.pillar).toBe("verification");
  });

  it("pending pillars do not trigger floor violation", () => {
    const r = computeRank({
      headline: 700,
      dominantField: "web",
      pillars: {
        comprehension:  { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        execution:      { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        diagnostics:    { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        verification:   { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        stewardship:    { score: 700, ciHalfWidth: 50, ciCoverage: 0.8, pending: false },
        aiPartnership:  { score: 500, ciHalfWidth: 250, ciCoverage: 0.0, pending: true },
      },
      distribution: FALLBACK_DISTRIBUTION,
    });
    expect(r.floorViolation).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/rank.test.ts
```

- [ ] **Step 3: Implement `apps/backend/src/iq3/rank.ts`**

```typescript
import type {
  Iq3FieldId,
  Iq3PillarId,
  Iq3PillarScore,
  Iq3Rank,
  Iq3RankId,
} from "@protege/types";
import {
  PILLAR_FLOOR_FALLBACK,
  PILLAR_IDS,
  RANK_PERCENTILE_BANDS,
} from "@protege/types";
import { Distribution, percentileForHeadline } from "./cohort.js";

const RANK_ORDER: Iq3RankId[] = ["learner", "junior", "mid", "senior"];

export interface ComputeRankInput {
  headline: number;
  dominantField: Iq3FieldId;
  pillars: Record<Iq3PillarId, Iq3PillarScore>;
  distribution: Distribution;
}

export function computeRank(input: ComputeRankInput): Iq3Rank {
  const pct = percentileForHeadline(
    input.dominantField,
    input.headline,
    input.distribution,
  );

  const uncapped: Iq3RankId = (() => {
    for (const r of RANK_ORDER) {
      const [lo, hi] = RANK_PERCENTILE_BANDS[r];
      if (pct >= lo && pct < hi) return r;
    }
    return "senior";
  })();

  // Pillar floor: rank caps at Mid if any non-pending pillar is below
  // the rank's pillar floor.
  let floorViolation: Iq3Rank["floorViolation"] = null;
  const floor = PILLAR_FLOOR_FALLBACK[uncapped];
  for (const p of PILLAR_IDS) {
    const ps = input.pillars[p];
    if (ps.pending) continue;
    if (ps.score < floor) {
      floorViolation = { pillar: p, score: ps.score, floor };
      break;
    }
  }

  const finalRank: Iq3RankId =
    floorViolation && uncapped === "senior" ? "mid" : uncapped;

  return {
    rank: finalRank,
    uncappedRank: uncapped,
    floorViolation,
    dominantField: input.dominantField,
  };
}
```

- [ ] **Step 4: Run tests pass**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/rank.test.ts
```
Expected: PASS — all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/iq3/rank.ts apps/backend/src/iq3/__tests__/rank.test.ts
git commit -m "feat(iq3-rank): field-conditional band + pillar-floor anti-lopsidedness"
```

---

## Section 4 — Composite + Routes

### Task 14: Composite headline (HMM-only at Phase A)

**Files:**
- Create: `apps/backend/src/iq3/ci.ts`
- Create: `apps/backend/src/iq3/composite.ts`
- Create: `apps/backend/src/iq3/__tests__/composite.test.ts`
- Create: `apps/backend/src/iq3/__tests__/ci.test.ts`

Phase A composite is `w_hmm = 1.0`; Panel and Probe slots are present but always 0. The headline math still goes through the field-vector projection.

- [ ] **Step 1: Test for `ci.ts`**

`apps/backend/src/iq3/__tests__/ci.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { composeHeadlineCi } from "../ci.js";

describe("CI composer", () => {
  it("returns wider CI when pillar uncertainties are large", () => {
    const a = composeHeadlineCi({
      pillarHalfWidths: [50, 50, 50, 50, 50, 50],
      fieldEntropy: 0.3,
    });
    const b = composeHeadlineCi({
      pillarHalfWidths: [10, 10, 10, 10, 10, 10],
      fieldEntropy: 0.3,
    });
    expect(a.halfWidth).toBeGreaterThan(b.halfWidth);
  });

  it("returns wider CI when field entropy is high", () => {
    const a = composeHeadlineCi({
      pillarHalfWidths: [30, 30, 30, 30, 30, 30],
      fieldEntropy: 0.9,
    });
    const b = composeHeadlineCi({
      pillarHalfWidths: [30, 30, 30, 30, 30, 30],
      fieldEntropy: 0.1,
    });
    expect(a.halfWidth).toBeGreaterThan(b.halfWidth);
  });
});
```

- [ ] **Step 2: Implement `apps/backend/src/iq3/ci.ts`**

```typescript
/**
 * Confidence interval composer for the headline IQ. For Phase A, no LLM
 * variance to mix in — only HMM posterior width and field-vector entropy
 * affect uncertainty. Panel/Probe variance slots in once those layers
 * exist (Phases B and D respectively).
 */

export interface CiInput {
  /** Per-pillar half-widths from HMM */
  pillarHalfWidths: number[];
  /** Normalized entropy of the field vector ∈ [0, 1] */
  fieldEntropy: number;
}

export interface CiOutput {
  halfWidth: number;
  /** Composite confidence ∈ [0, 1]; reported in UI as percentage */
  confidence: number;
}

export function composeHeadlineCi(input: CiInput): CiOutput {
  // Pillar uncertainty: RMS, scaled by ~0.4 since pillars partially correlate.
  const ms = input.pillarHalfWidths.reduce((s, x) => s + x * x, 0) /
             Math.max(1, input.pillarHalfWidths.length);
  const pillarRms = Math.sqrt(ms);
  const pillarComponent = pillarRms * 0.6;

  // Field entropy widens CI when field is uncertain.
  const fieldComponent = 80 * input.fieldEntropy;

  const halfWidth = Math.round(pillarComponent + fieldComponent);
  // Confidence: tight CI → high confidence. Soft cap at 0.99.
  const confidence = Math.max(0, Math.min(0.99, 1 - halfWidth / 300));
  return { halfWidth, confidence };
}
```

- [ ] **Step 3: Run failing test then verify pass**

```bash
pnpm --filter @protege/backend test apps/backend/src/iq3/__tests__/ci.test.ts
```

- [ ] **Step 4: Test for composite**

`apps/backend/src/iq3/__tests__/composite.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { initialUserState, applyMatchKeys } from "../hmm.js";
import { computeHeadline } from "../composite.js";
import { FALLBACK_DISTRIBUTION } from "../cohort.js";

describe("composite headline", () => {
  it("returns a complete headline shape from a fresh user state", () => {
    const s = initialUserState("u1");
    const h = computeHeadline(s, FALLBACK_DISTRIBUTION);
    expect(h.score).toBeGreaterThan(0);
    expect(h.score).toBeLessThan(1100);
    expect(h.rank.rank).toBeDefined();
    expect(h.maturity).toBe("cold");
    expect(h.pillars.aiPartnership.pending).toBe(true);
  });

  it("score grows with positive evidence accumulation", () => {
    let s = initialUserState("u1");
    const before = computeHeadline(s, FALLBACK_DISTRIBUTION).score;
    for (let i = 0; i < 30; i++) {
      s = applyMatchKeys(s, [
        "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
        "test_run_result.trigger=manual.session_count>=3",
      ]);
    }
    const after = computeHeadline(s, FALLBACK_DISTRIBUTION).score;
    expect(after).toBeGreaterThan(before + 50);
  });
});
```

- [ ] **Step 5: Implement `apps/backend/src/iq3/composite.ts`**

```typescript
import type {
  Iq3FieldId,
  Iq3FieldVector,
  Iq3Headline,
  Iq3PillarId,
  Iq3UserState,
} from "@protege/types";
import { FIELD_IDS, PILLAR_IDS, PILLAR_WEIGHTS } from "@protege/types";
import { computePillars } from "./pillars.js";
import { dominantField } from "./fieldVector.js";
import { computeRank } from "./rank.js";
import { composeHeadlineCi } from "./ci.js";
import type { Distribution } from "./cohort.js";

function fieldEntropy(v: Iq3FieldVector): number {
  let h = 0;
  for (const f of FIELD_IDS) {
    const p = v[f];
    if (p > 0) h += -p * Math.log(p);
  }
  return h / Math.log(FIELD_IDS.length);
}

function maturityBucket(eventCount: number): "cold" | "warm" | "mature" {
  // Sessions are roughly 60+ events at minimum (a session_tick fires
  // every 60s in active work). Rough buckets:
  if (eventCount < 300) return "cold";
  if (eventCount < 1800) return "warm";
  return "mature";
}

export function computeHeadline(
  state: Iq3UserState,
  distribution: Distribution,
): Iq3Headline {
  const pillars = computePillars(state);

  // Per-field headline = Σ pillar.score · weight[pillar][field]
  const headlinePerField = {} as Record<Iq3FieldId, number>;
  for (const f of FIELD_IDS) {
    let total = 0;
    let weightSum = 0;
    for (const p of PILLAR_IDS) {
      // Skip pending pillars to avoid pulling toward the neutral 500.
      if (pillars[p].pending) continue;
      const w = PILLAR_WEIGHTS[f][p];
      total += pillars[p].score * w;
      weightSum += w;
    }
    headlinePerField[f] = weightSum > 0 ? total / weightSum : 0;
  }

  // Headline = Σ_field P(field) * headline_f
  let score = 0;
  for (const f of FIELD_IDS) {
    score += state.field[f] * headlinePerField[f];
  }
  score = Math.round(score);

  const dominant = dominantField(state.field);
  const rank = computeRank({
    headline: score,
    dominantField: dominant,
    pillars,
    distribution,
  });

  const ci = composeHeadlineCi({
    pillarHalfWidths: PILLAR_IDS.map((p) => pillars[p].ciHalfWidth),
    fieldEntropy: fieldEntropy(state.field),
  });

  return {
    score,
    ciHalfWidth: ci.halfWidth,
    confidence: ci.confidence,
    rank,
    pillars,
    field: state.field,
    maturity: maturityBucket(state.eventCount),
    computedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 6: Run all backend tests**

```bash
pnpm --filter @protege/backend test
```
Expected: ALL GREEN.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/iq3/composite.ts apps/backend/src/iq3/ci.ts apps/backend/src/iq3/__tests__
git commit -m "feat(iq3-composite): headline computation with field-vector projection + CI"
```

---

### Task 15: GET /iq/me + GET /iq/taxonomy routes

**Files:**
- Create: `apps/backend/src/iq3/routes/iq.ts`
- Modify: `apps/backend/src/index.ts` (mount router)

The user-state persistence layer needs to be wired. Phase A uses Supabase; if the project also keeps the local-JSON fallback (`.protege-store.json`), wire both behind a `loadUserState`/`saveUserState` interface.

- [ ] **Step 1: Implement the route handler**

`apps/backend/src/iq3/routes/iq.ts`:

```typescript
import { Hono } from "hono";
import type { Iq3UserState } from "@protege/types";
import { computeHeadline } from "../composite.js";
import { initialUserState } from "../hmm.js";
import { FALLBACK_DISTRIBUTION } from "../cohort.js";
import { fieldsForConcept } from "../taxonomyService.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// === Persistence shim — replace with project's existing store layer ===
// For Phase A, keep a thin wrapper here. Long-term it lives in store.ts
// alongside the rest of user state.

interface UserStateRepo {
  load(userId: string): Promise<Iq3UserState | null>;
  save(state: Iq3UserState): Promise<void>;
}

let _repo: UserStateRepo | null = null;
export function setIq3UserStateRepo(repo: UserStateRepo) {
  _repo = repo;
}
function repo(): UserStateRepo {
  if (!_repo) throw new Error("iq3 user-state repo not initialized");
  return _repo;
}

// === Router ===

const app = new Hono();

app.get("/me", async (c) => {
  const userId = c.req.header("x-user-id") ?? c.req.query("userId");
  if (!userId) return c.json({ error: "missing userId" }, 400);
  const existing = await repo().load(userId);
  const state = existing ?? initialUserState(userId);
  if (!existing) await repo().save(state);
  const headline = computeHeadline(state, FALLBACK_DISTRIBUTION);
  return c.json({ headline });
});

app.get("/taxonomy", async (c) => {
  // Backend-served taxonomy = the existing JSON + the field-tags overlay.
  // Cached in memory on first request.
  const taxonomyPath = resolve(
    process.cwd(),
    "../extension/webview/skills-taxonomy.json",
  );
  const tagsPath = resolve(
    process.cwd(),
    "../extension/webview/skills-taxonomy.field-tags.json",
  );
  const taxonomy = JSON.parse(readFileSync(taxonomyPath, "utf-8"));
  const tags = JSON.parse(readFileSync(tagsPath, "utf-8"));
  return c.json({ taxonomy, tags });
});

export default app;
```

- [ ] **Step 2: Mount the router in `apps/backend/src/index.ts`**

Find where existing routers are mounted (e.g. `app.route("/echo", echoRouter)`). Add:

```typescript
import iqRouter from "./iq3/routes/iq.js";
import selfRatingRouter from "./iq3/routes/selfRating.js"; // implemented in Task 17

app.route("/iq", iqRouter);
app.route("/iq/self-rating", selfRatingRouter); // path matches the route file
```

- [ ] **Step 3: Smoke test the route**

```bash
pnpm dev:backend &
sleep 3
curl -s "http://localhost:8787/iq/me?userId=test-user-1" | jq .
```
Expected: JSON with `headline.score`, `headline.rank.rank`, etc.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/iq3/routes apps/backend/src/index.ts
git commit -m "feat(iq3-routes): GET /iq/me + GET /iq/taxonomy"
```

---

### Task 16: User-state persistence (Supabase + local JSON fallback)

**Files:**
- Create: `apps/backend/src/iq3/persistence.ts`
- Modify: `apps/backend/src/index.ts`

The repo interface from Task 15 needs an implementation. Mirror whatever the project's other Supabase access patterns look like (look at `routes/walk.ts`, `routes/chat.ts` for examples).

- [ ] **Step 1: Implement `apps/backend/src/iq3/persistence.ts`**

```typescript
import type { Iq3UserState } from "@protege/types";
import { initialUserState } from "./hmm.js";

/** Repo abstraction matching the Task 15 interface. */
export interface Iq3UserStateRepo {
  load(userId: string): Promise<Iq3UserState | null>;
  save(state: Iq3UserState): Promise<void>;
}

/* ----- Local JSON repo (dev fallback) ----- */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export function localJsonRepo(filePath: string): Iq3UserStateRepo {
  function readAll(): Record<string, Iq3UserState> {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }
  function writeAll(map: Record<string, Iq3UserState>) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(map, null, 2));
  }
  return {
    async load(userId) {
      return readAll()[userId] ?? null;
    },
    async save(state) {
      const all = readAll();
      all[state.userId] = state;
      writeAll(all);
    },
  };
}

/* ----- Supabase repo ----- */

export interface SupabaseClientLike {
  from(table: string): {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        single: () => Promise<{ data: any; error: any }>;
      };
    };
    upsert: (row: any) => Promise<{ error: any }>;
  };
}

export function supabaseRepo(client: SupabaseClientLike): Iq3UserStateRepo {
  return {
    async load(userId) {
      const { data, error } = await client
        .from("iq3_user_state")
        .select("*")
        .eq("user_id", userId)
        .single();
      if (error || !data) return null;
      return {
        userId: data.user_id,
        traits: data.traits,
        field: data.field_vector,
        eventCount: data.event_count,
        aiEventCount: data.ai_event_count,
        schemaVersion: data.schema_version,
        updatedAt: data.updated_at,
      };
    },
    async save(state) {
      const { error } = await client.from("iq3_user_state").upsert({
        user_id: state.userId,
        traits: state.traits,
        field_vector: state.field,
        event_count: state.eventCount,
        ai_event_count: state.aiEventCount,
        schema_version: state.schemaVersion,
        updated_at: state.updatedAt,
      });
      if (error) throw new Error(`iq3_user_state upsert failed: ${error.message}`);
    },
  };
}

/** Auto-pick: Supabase if env present, else local JSON. */
export function autoRepo(): Iq3UserStateRepo {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    // Lazy import to avoid hard dep when running locally without supabase
    const { createClient } = require("@supabase/supabase-js");
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    return supabaseRepo(client);
  }
  return localJsonRepo("./.protege-store-iq3.json");
}
```

- [ ] **Step 2: Wire the repo in `apps/backend/src/index.ts`**

Add near the top (after other initialization):

```typescript
import { autoRepo } from "./iq3/persistence.js";
import { setIq3UserStateRepo } from "./iq3/routes/iq.js";

setIq3UserStateRepo(autoRepo());
```

- [ ] **Step 3: Verify route works against persistence**

```bash
pnpm dev:backend &
sleep 3
curl -s "http://localhost:8787/iq/me?userId=test-user-1" > /dev/null
ls -la .protege-store-iq3.json
cat .protege-store-iq3.json | jq '.["test-user-1"].userId'
```
Expected: file exists, jq prints `"test-user-1"`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/iq3/persistence.ts apps/backend/src/index.ts
git commit -m "feat(iq3-persist): Supabase + local JSON fallback for user state"
```

---

### Task 17: POST /iq/self-rating

**Files:**
- Create: `apps/backend/src/iq3/routes/selfRating.ts`

- [ ] **Step 1: Implement the route**

```typescript
import { Hono } from "hono";
import { SelfRatingSchema } from "@protege/types";
import { autoRepo } from "../persistence.js";

const app = new Hono();

app.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = SelfRatingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid", details: parsed.error.flatten() }, 400);
  }
  // For Phase A, persist via the user state repo as a side annotation.
  // Schema-level: insert into iq3_self_ratings. The autoRepo helper
  // doesn't have a self_ratings method; add one or use direct SQL.
  // Lightweight implementation:
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = require("@supabase/supabase-js");
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await client.from("iq3_self_ratings").insert({
      user_id: parsed.data.userId,
      rating:  parsed.data.rating,
      rated_at: parsed.data.ratedAt,
      note: parsed.data.note,
    });
    if (error) return c.json({ error: error.message }, 500);
  } else {
    // Local fallback: append to a JSON file.
    const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
    const path = "./.protege-store-iq3-self-ratings.json";
    const arr = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : [];
    arr.push(parsed.data);
    writeFileSync(path, JSON.stringify(arr, null, 2));
  }
  return c.json({ ok: true });
});

export default app;
```

- [ ] **Step 2: Smoke-test**

```bash
curl -X POST http://localhost:8787/iq/self-rating \
  -H "content-type: application/json" \
  -d '{"userId":"test-user-1","rating":7,"ratedAt":"2026-05-06T12:00:00.000Z"}'
```
Expected: `{"ok":true}`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/iq3/routes/selfRating.ts
git commit -m "feat(iq3-routes): POST /iq/self-rating"
```

---

### Task 18: Backend ingestion — route new events into HMM

**Files:**
- Create: `apps/backend/src/iq3/ingest/iq3Hook.ts`
- Modify: the existing `/echo/events` route handler (find it: `grep -rn '/echo/events' apps/backend/src`)

The ingest layer is what turns raw events into matchKeys. Each handler is a small function: `(event, context) => string[]`. The full set of handlers lives in `iq3Hook.ts`.

- [ ] **Step 1: Implement `apps/backend/src/iq3/ingest/iq3Hook.ts`**

```typescript
import type { EchoEvent, Iq3UserState } from "@protege/types";
import { applyMatchKeys, initialUserState } from "../hmm.js";
import { autoRepo } from "../persistence.js";

const repo = autoRepo();

interface IngestContext {
  /** rolling window of recent events for the same user (last 4000) */
  recent: EchoEvent[];
}

/** Producer: raw event → matchKey strings. */
type Matcher = (e: EchoEvent, ctx: IngestContext) => string[];

const MATCHERS: Matcher[] = [
  // file_opened then no edit for >30s w/ navigations → reads-before-writes
  (e, ctx) => {
    if (e.type !== "text_change") return [];
    const sameFile = ctx.recent
      .filter((r) => "path" in r && r.path === e.path)
      .slice(-20);
    const lastOpen = [...sameFile].reverse().find((r) => r.type === "file_opened");
    if (!lastOpen) return [];
    const elapsed = e.ts - lastOpen.ts;
    const navsBetween = sameFile.filter(
      (r) =>
        r.type === "editor_navigation" &&
        r.ts > lastOpen.ts &&
        r.ts < e.ts,
    );
    if (elapsed >= 30000 && navsBetween.length >= 2) {
      return ["file_opened.then.navigations>=2.then.first_text_change.afterMs>30s"];
    }
    if (elapsed < 5000) {
      return ["file_opened.then.first_text_change.withinMs<5s"];
    }
    return [];
  },

  // paste classified as AI source, large, unmodified within 60s
  (e, ctx) => {
    if (e.type !== "paste_classified") return [];
    const isLarge = e.size >= 80;
    if (e.source !== "ai" || !isLarge) return [];
    const since = e.ts;
    const followups = ctx.recent.filter((r) => r.ts > since && r.ts < since + 60000);
    const hasEdit = followups.some((r) => r.type === "text_change");
    if (!hasEdit) return ["paste_classified.source=ai.size>=80lines.no_edit_within_60s"];
    return [];
  },

  // ai_suggestion_accepted with edit within 30s
  (e, ctx) => {
    if (e.type !== "ai_suggestion_accepted") return [];
    const within = ctx.recent.filter(
      (r) => r.type === "text_change" && r.ts > e.ts && r.ts < e.ts + 30000,
    );
    if (within.length === 0) {
      return ["ai_suggestion_accepted.afterMs<2000.withoutEdit"];
    }
    return ["ai_suggestion_accepted.thenEditWithin30s.editFraction>=0.3"];
  },

  // commit detected — message-quality matchers
  (e) => {
    if (e.type !== "commit_detected") return [];
    const out: string[] = [];
    if (e.msgChars >= 80 && /\b(because|since|to fix|due to|so that)\b/i.test(e.msg)) {
      out.push("commit_detected.msg_chars>=80.contains_why_keyword");
    }
    if (e.msgChars < 20) out.push("commit_detected.msg_chars<20");
    if (/^[a-z]+(\(.+?\))?:\s/.test(e.msg)) {
      out.push("commit_detected.msg_matches_conventional");
    }
    if (/^(wip|fix|update)$/i.test(e.msg.trim())) {
      out.push("commit_detected.msg_matches_wip_or_fix_only");
    }
    return out;
  },

  // chat_turn — prompt-quality matchers
  (e) => {
    if (e.type !== "chat_turn") return [];
    const out: string[] = [];
    if (e.intent === "specific" && e.charCount >= 120) {
      out.push("chat_turn.intent=specific.charCount>=120");
    }
    if (e.intent === "vague" && e.charCount < 40) {
      out.push("chat_turn.intent=vague.charCount<40");
    }
    if (e.intent === "debug" && /\b(line|stack|error|undefined|null|exception)\b/i.test(e.text)) {
      out.push("chat_turn.intent=debug.contains_stack_trace_or_line_ref");
    }
    if (e.intent === "plan" && /\b(must|should|cannot|requires|constraint)\b/i.test(e.text)) {
      out.push("chat_turn.intent=plan.includes_constraints");
    }
    return out;
  },

  // test_run_result — runs-tests-often
  (e, ctx) => {
    if (e.type !== "test_run_result") return [];
    const since = e.ts - 30 * 60 * 1000;
    const recentTests = ctx.recent.filter(
      (r) => r.type === "test_run_result" && r.ts >= since,
    );
    const out: string[] = [];
    if (e.trigger === "manual" && recentTests.length >= 3) {
      out.push("test_run_result.trigger=manual.session_count>=3");
    }
    if (e.trigger === "save" && recentTests.length >= 3) {
      out.push("test_run_result.trigger=save.session_count>=3");
    }
    return out;
  },
];

const AI_RELATED = new Set(["chat_turn", "ai_suggestion_accepted", "paste_classified"]);

const userContexts = new Map<string, IngestContext>();
function getCtx(userId: string): IngestContext {
  let c = userContexts.get(userId);
  if (!c) {
    c = { recent: [] };
    userContexts.set(userId, c);
  }
  return c;
}

/**
 * Process a batch of events for a single user. Loads state, applies all
 * matchers, saves state. Side-effect-only.
 */
export async function ingestForUser(
  userId: string,
  events: EchoEvent[],
): Promise<void> {
  const ctx = getCtx(userId);
  let state =
    (await repo.load(userId)) ?? initialUserState(userId);

  for (const e of events) {
    ctx.recent.push(e);
    if (ctx.recent.length > 4000) ctx.recent.splice(0, ctx.recent.length - 4000);
    const allKeys: string[] = [];
    for (const m of MATCHERS) allKeys.push(...m(e, ctx));
    if (allKeys.length === 0 && !AI_RELATED.has(e.type as string)) continue;
    state = applyMatchKeys(state, allKeys, {
      isAiEvent: AI_RELATED.has(e.type as string),
    });
  }
  await repo.save(state);
}
```

- [ ] **Step 2: Wire the hook into the existing `/echo/events` handler**

Find the handler (likely in `apps/backend/src/routes/echoEvents.ts` or similar). After the existing event-storage logic completes, add:

```typescript
import { ingestForUser } from "../iq3/ingest/iq3Hook.js";

// inside the handler, after events are stored:
await ingestForUser(userId, events).catch((err) => {
  console.warn("[iq3] ingest failed (non-fatal):", err.message);
});
```

The ingest is wrapped in a non-fatal catch so a bug in iq3 can't break the existing event pipeline.

- [ ] **Step 3: End-to-end smoke test**

Run dev backend + curl a synthetic event batch:

```bash
curl -X POST http://localhost:8787/echo/events \
  -H "content-type: application/json" \
  -H "x-user-id: test-user-1" \
  -d '{
    "events": [
      {"type":"chat_turn","ts":1714989600000,"text":"What does this useEffect leak when component unmounts?","intent":"specific","charCount":62,"acceptedAi":false}
    ]
  }'

# then re-fetch headline:
curl -s "http://localhost:8787/iq/me?userId=test-user-1" | jq '.headline.pillars.aiPartnership'
```

Expected: AI Partnership pillar's `aiEventCount` is now > 0 in user state.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/iq3/ingest apps/backend/src/routes/<echo-events-handler-file>
git commit -m "feat(iq3-ingest): hook iq3 HMM update into /echo/events handler"
```

---

## Section 5 — Extension event producers + realtime bridge

### Task 19: chat_turn event producer

**Files:**
- Create: `apps/extension/src/iq3/eventProducers/chatTurn.ts`

The chat_turn event fires whenever the user sends a prompt to the AI (chat tab, voice mode). Intent classification is rule-based for Phase A; can be replaced with a tiny LLM later.

- [ ] **Step 1: Implement `apps/extension/src/iq3/eventProducers/chatTurn.ts`**

```typescript
import type { Iq3ChatTurnEvent } from "@protege/types";

/** Lightweight rule-based intent classifier. */
function classifyIntent(text: string): Iq3ChatTurnEvent["intent"] {
  const t = text.toLowerCase().trim();
  if (t.length < 20 && /^(fix|why|help|broken|ok|do)/.test(t)) return "vague";
  if (/\b(line\s+\d|stack\s+trace|error|exception|crash|why does)\b/.test(t)) return "debug";
  if (/\b(plan|design|architecture|approach|how should i|trade.?off)\b/.test(t)) return "plan";
  if (t.length >= 80 && /[?:]/.test(t)) return "specific";
  if (t.length >= 80) return "request";
  return "vague";
}

/**
 * Build a chat_turn event from an outgoing user message. Intended to be
 * called from wherever the chat panel currently dispatches the user
 * turn (search webviewHost.ts for `chat/append`).
 */
export function buildChatTurnEvent(text: string, ts = Date.now()): Iq3ChatTurnEvent {
  return {
    type: "chat_turn",
    ts,
    text,
    intent: classifyIntent(text),
    charCount: text.length,
    acceptedAi: false,
  };
}
```

- [ ] **Step 2: Wire into the chat dispatch site**

Find the chat send path (likely `webviewHost.ts` handling `chat/append`). Inside the user-message branch, push the event to the Echo batcher:

```typescript
import { getBatcher } from "./echo/batcher.js";
import { buildChatTurnEvent } from "./iq3/eventProducers/chatTurn.js";

// after the user-message arrives:
const batcher = getBatcher();
batcher?.push(buildChatTurnEvent(userMessage));
```

- [ ] **Step 3: Quick test in extension dev host**

Press F5, open chat, type a long specific question. Open the "Protege Echo Events" output channel — confirm a `chat_turn` event with `intent: "specific"` appears.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/src/iq3/eventProducers/chatTurn.ts apps/extension/src/webviewHost.ts
git commit -m "feat(iq3-events): chat_turn producer with rule-based intent classifier"
```

---

### Task 20: test_run_result event producer

**Files:**
- Create: `apps/extension/src/iq3/eventProducers/testRunResult.ts`

VS Code exposes the Test API; subscribing to test runs gives us the data shape directly.

- [ ] **Step 1: Implement `apps/extension/src/iq3/eventProducers/testRunResult.ts`**

```typescript
import * as vscode from "vscode";
import type { Iq3TestRunResultEvent } from "@protege/types";
import { getBatcher } from "../../echo/batcher.js";

/**
 * Subscribe to VS Code's Test API. We can't directly hook RUN events
 * from extensions that don't own the test profiles, so Phase A uses a
 * coarser signal: the `vscode.tests.onDidChangeTestResults` event fires
 * when any test extension publishes results.
 */
export function startTestRunProducer(ctx: vscode.ExtensionContext) {
  const sub = vscode.tests.onDidChangeTestResults(() => {
    const results = vscode.tests.testResults;
    if (results.length === 0) return;
    const latest = results[0];
    let tests = 0;
    let passed = 0;
    let durationMs = 0;
    let file = "<unknown>";
    walk(latest.results, (item) => {
      tests++;
      if (item.taskStates?.some((s) => s.state === vscode.TestResultState.Passed)) passed++;
      if (item.duration) durationMs += item.duration;
      if (item.uri) file = vscode.workspace.asRelativePath(item.uri);
    });
    const event: Iq3TestRunResultEvent = {
      type: "test_run_result",
      ts: Date.now(),
      file,
      tests,
      passed,
      durationMs,
      trigger: "manual",
    };
    getBatcher()?.push(event);
  });
  ctx.subscriptions.push(sub);
}

function walk(items: readonly vscode.TestResultSnapshot[], fn: (i: vscode.TestResultSnapshot) => void) {
  for (const i of items) {
    fn(i);
    if (i.children) walk(i.children, fn);
  }
}
```

- [ ] **Step 2: Register the producer in `apps/extension/src/extension.ts`**

In the activation hub, add:

```typescript
import { startTestRunProducer } from "./iq3/eventProducers/testRunResult.js";

// inside activate():
startTestRunProducer(context);
```

- [ ] **Step 3: Verify in dev host**

Run a test in the dev host (any vitest/jest test in the workspace). Confirm a `test_run_result` event in the Echo Events output channel.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/src/iq3/eventProducers/testRunResult.ts apps/extension/src/extension.ts
git commit -m "feat(iq3-events): test_run_result producer via VS Code Test API"
```

---

### Task 21: editor_navigation event producer

**Files:**
- Create: `apps/extension/src/iq3/eventProducers/editorNavigation.ts`

- [ ] **Step 1: Implement**

```typescript
import * as vscode from "vscode";
import type { Iq3EditorNavigationEvent } from "@protege/types";
import { getBatcher } from "../../echo/batcher.js";

/** Hook def-jump and file-bounce navigation. */
export function startEditorNavigationProducer(ctx: vscode.ExtensionContext) {
  const lastEditByFile = new Map<string, number>();

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      lastEditByFile.set(e.document.uri.toString(), Date.now());
    }),
  );

  let lastFile: vscode.Uri | null = null;
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const cur = editor.document.uri;
      if (lastFile && lastFile.toString() !== cur.toString()) {
        const event: Iq3EditorNavigationEvent = {
          type: "editor_navigation",
          ts: Date.now(),
          kind: "file-bounce",
          fromFile: vscode.workspace.asRelativePath(lastFile),
          toFile: vscode.workspace.asRelativePath(cur),
          msSinceEdit: lastEditByFile.has(lastFile.toString())
            ? Date.now() - lastEditByFile.get(lastFile.toString())!
            : Number.MAX_SAFE_INTEGER,
        };
        getBatcher()?.push(event);
      }
      lastFile = cur;
    }),
  );

  // Def-jump detection via the "editor.action.revealDefinition" command.
  // We intercept by listening to onDidChangeTextEditorSelection just after
  // a definition jump command is run. VS Code doesn't expose a clean API
  // for command interception, so Phase A uses heuristic: rapid tab change
  // + cursor at non-trivial depth in a different file is treated as a
  // def-jump. Refinement is post-Phase A.
  // Skipping; covered by file-bounce above for Phase A.
}
```

- [ ] **Step 2: Register in `extension.ts`**

```typescript
import { startEditorNavigationProducer } from "./iq3/eventProducers/editorNavigation.js";

// inside activate():
startEditorNavigationProducer(context);
```

- [ ] **Step 3: Smoke test — switch editors, see events**

Open two files in dev host, switch between them. Confirm `editor_navigation` events fire.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/src/iq3/eventProducers/editorNavigation.ts apps/extension/src/extension.ts
git commit -m "feat(iq3-events): editor_navigation producer (file-bounce)"
```

---

### Task 22: Realtime bridge — pull headline into webview

**Files:**
- Create: `apps/extension/src/iq3/realtimeBridge.ts`
- Modify: `apps/extension/src/extension.ts`
- Modify: `apps/extension/src/webviewHost.ts` (add `iq/headline` channel)

The webview needs to display the live headline. We poll `/iq/me` every ~30 seconds (cheap; backend computation is in-memory).

- [ ] **Step 1: Implement `apps/extension/src/iq3/realtimeBridge.ts`**

```typescript
import * as vscode from "vscode";
import type { Iq3Headline } from "@protege/types";
import { BACKEND_URL, currentUserIdOrNull } from "../user/protegeClient.js";
import { authHeaders } from "../user/auth.js";

const POLL_INTERVAL_MS = 30 * 1000;

interface BridgeHandle {
  dispose: () => void;
  /** Subscribe to headline updates. */
  onHeadline: (cb: (h: Iq3Headline) => void) => () => void;
  /** Request an immediate refresh. */
  refresh: () => Promise<void>;
}

export function startIq3Bridge(ctx: vscode.ExtensionContext): BridgeHandle {
  const subs = new Set<(h: Iq3Headline) => void>();

  async function fetchHeadline(): Promise<Iq3Headline | null> {
    const userId = currentUserIdOrNull();
    if (!userId) return null;
    try {
      const res = await fetch(`${BACKEND_URL}/iq/me?userId=${encodeURIComponent(userId)}`, {
        headers: { ...(await authHeaders()) },
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json.headline as Iq3Headline;
    } catch {
      return null;
    }
  }

  async function refresh() {
    const h = await fetchHeadline();
    if (h) for (const cb of subs) cb(h);
  }

  const interval = setInterval(refresh, POLL_INTERVAL_MS);
  refresh();

  return {
    dispose: () => clearInterval(interval),
    onHeadline: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    refresh,
  };
}
```

- [ ] **Step 2: Add `iq/headline` channel to `webviewHost.ts`**

In whatever message-routing function pushes events to the webview, register a forwarder:

```typescript
import { startIq3Bridge } from "./iq3/realtimeBridge.js";

// inside the host setup function:
const iq3 = startIq3Bridge(context);
const off = iq3.onHeadline((h) => {
  panel.webview.postMessage({ channel: "iq/headline", payload: h });
});
context.subscriptions.push({ dispose: () => { off(); iq3.dispose(); } });
```

- [ ] **Step 3: Commit**

```bash
git add apps/extension/src/iq3/realtimeBridge.ts apps/extension/src/extension.ts apps/extension/src/webviewHost.ts
git commit -m "feat(iq3-bridge): poll /iq/me and forward headline to webview"
```

---

## Section 6 — Extension UI

### Task 23: Headline card + pillar bars + field vector

**Files:**
- Create: `apps/extension/webview/iq3/HeadlineCard.tsx`
- Create: `apps/extension/webview/iq3/PillarBar.tsx`
- Create: `apps/extension/webview/iq3/FieldVector.tsx`
- Create: `apps/extension/webview/iq3/IqDashboard.tsx`

- [ ] **Step 1: Implement `HeadlineCard.tsx`**

```tsx
import React from "react";
import type { Iq3Headline } from "@protege/types";

const RANK_LABEL: Record<string, string> = {
  learner: "Learner",
  junior:  "Junior",
  mid:     "Mid",
  senior:  "Senior",
};

export function HeadlineCard({ h }: { h: Iq3Headline }) {
  const rank = RANK_LABEL[h.rank.rank];
  const cap = h.rank.floorViolation
    ? ` (capped: ${h.rank.floorViolation.pillar} below floor)`
    : "";
  return (
    <div className="iq3-headline-card">
      <div className="iq3-headline-score">
        {h.score}
        <span className="iq3-ci">± {h.ciHalfWidth}</span>
      </div>
      <div className="iq3-rank">{rank}{cap}</div>
      <div className="iq3-confidence">
        {Math.round(h.confidence * 100)}% confident · {h.maturity}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `PillarBar.tsx`**

```tsx
import React from "react";
import type { Iq3PillarScore } from "@protege/types";

const PILLAR_LABEL: Record<string, string> = {
  comprehension: "Comprehension",
  execution:     "Execution",
  diagnostics:   "Diagnostics",
  verification:  "Verification",
  stewardship:   "Stewardship",
  aiPartnership: "AI Partnership",
};

export function PillarBar({
  pillar,
  data,
  floorMark,
}: {
  pillar: string;
  data: Iq3PillarScore;
  floorMark?: number;
}) {
  const label = PILLAR_LABEL[pillar] ?? pillar;
  if (data.pending) {
    return (
      <div className="iq3-pillar iq3-pillar--pending">
        <div className="iq3-pillar-label">{label}</div>
        <div className="iq3-pillar-pending">awaiting evidence</div>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, (data.score / 1000) * 100));
  return (
    <div className="iq3-pillar">
      <div className="iq3-pillar-label">
        {label} <span>{data.score} ± {data.ciHalfWidth}</span>
      </div>
      <div className="iq3-pillar-track">
        <div className="iq3-pillar-fill" style={{ width: `${pct}%` }} />
        {floorMark !== undefined ? (
          <div className="iq3-pillar-floor" style={{ left: `${(floorMark / 1000) * 100}%` }} />
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement `FieldVector.tsx`**

```tsx
import React from "react";
import type { Iq3FieldVector } from "@protege/types";

const FIELD_COLORS: Record<string, string> = {
  web: "#3b82f6", ml: "#a855f7", dataEng: "#06b6d4", devOps: "#f97316",
  sec: "#dc2626", mobile: "#84cc16", systems: "#64748b", game: "#ec4899",
  embedded: "#737373", generalist: "#9ca3af",
};

export function FieldVector({ v }: { v: Iq3FieldVector }) {
  const entries = Object.entries(v).sort((a, b) => b[1] - a[1]);
  return (
    <div className="iq3-field-vector">
      <div className="iq3-field-bar">
        {entries.map(([f, p]) => (
          <div
            key={f}
            className="iq3-field-segment"
            style={{ width: `${p * 100}%`, background: FIELD_COLORS[f] }}
            title={`${f}: ${(p * 100).toFixed(0)}%`}
          />
        ))}
      </div>
      <div className="iq3-field-legend">
        {entries.slice(0, 3).map(([f, p]) => (
          <span key={f}>
            <span style={{ background: FIELD_COLORS[f] }} className="iq3-field-swatch" />
            {f} {(p * 100).toFixed(0)}%
          </span>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `IqDashboard.tsx`**

```tsx
import React, { useEffect, useState } from "react";
import type { Iq3Headline } from "@protege/types";
import { HeadlineCard } from "./HeadlineCard.js";
import { PillarBar } from "./PillarBar.js";
import { FieldVector } from "./FieldVector.js";
import { PILLAR_FLOOR_FALLBACK, PILLAR_IDS } from "@protege/types";

interface Props {
  /** Provided by the parent App's webviewHost message subscription. */
  postMessage?: (msg: any) => void;
}

declare const acquireVsCodeApi: () => { postMessage(msg: any): void };

export function IqDashboard(_p: Props) {
  const [headline, setHeadline] = useState<Iq3Headline | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.channel === "iq/headline") {
        setHeadline(msg.payload as Iq3Headline);
      }
    };
    window.addEventListener("message", handler);
    // request initial
    try { acquireVsCodeApi().postMessage({ channel: "iq/refresh" }); } catch {}
    return () => window.removeEventListener("message", handler);
  }, []);

  if (!headline) {
    return <div className="iq3-dashboard-empty">Loading IQ…</div>;
  }
  const floor = PILLAR_FLOOR_FALLBACK[headline.rank.uncappedRank];
  return (
    <div className="iq3-dashboard">
      <HeadlineCard h={headline} />
      <FieldVector v={headline.field} />
      <div className="iq3-pillars">
        {PILLAR_IDS.map((p) => (
          <PillarBar
            key={p}
            pillar={p}
            data={headline.pillars[p]}
            floorMark={floor}
          />
        ))}
      </div>
      {headline.rank.floorViolation ? (
        <div className="iq3-floor-note">
          {`Senior gated by ${headline.rank.floorViolation.pillar} floor (${
            headline.rank.floorViolation.score
          } < ${headline.rank.floorViolation.floor}). Lift it to advance.`}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Wire into App.tsx**

Find the existing Profile tab and replace the body with `<IqDashboard />`:

```tsx
import { IqDashboard } from "./iq3/IqDashboard.js";

// ... in the Profile tab:
<IqDashboard />
```

Make the host respond to `iq/refresh` from the webview by calling `iq3.refresh()` (Task 22).

- [ ] **Step 6: Style hooks (CSS)**

Add minimal styles to whatever stylesheet the webview already loads (e.g. `apps/extension/webview/styles.css`). Class hooks: `.iq3-headline-card`, `.iq3-pillar`, `.iq3-field-bar`, etc. Match existing dashboard typography.

- [ ] **Step 7: Smoke test in dev host**

F5 → dev host → Profile tab → confirm dashboard renders with headline, pillar bars, field vector. Should update every 30s automatically.

- [ ] **Step 8: Commit**

```bash
git add apps/extension/webview/iq3 apps/extension/webview/App.tsx apps/extension/webview/styles.css
git commit -m "feat(iq3-ui): IQ dashboard — headline + pillars + field vector"
```

---

### Task 24: Onboarding probes (5 questions)

**Files:**
- Create: `apps/extension/webview/iq3/OnboardingProbes.tsx`
- Modify: `apps/extension/webview/iq3/IqDashboard.tsx` (show probes when `state.eventCount === 0`)

- [ ] **Step 1: Implement `OnboardingProbes.tsx`**

```tsx
import React, { useState } from "react";
import type { Iq3FieldId } from "@protege/types";

interface Probe {
  id: string;
  prompt: string;
  options: { id: string; text: string }[];
  /** Map option id → matchKey added to the user's HMM. */
  matchKeys: Record<string, string[]>;
}

const PROBES: Probe[] = [
  {
    id: "p1-reading",
    prompt: "Which of these has a bug?",
    options: [
      { id: "a", text: "const sum = arr.reduce((a,b)=>a+b, 0);" },
      { id: "b", text: "const sum = arr.reduce((a,b)=>a+b);" },
      { id: "c", text: "Both work the same way." },
    ],
    matchKeys: {
      a: ["onboarding.reading=correct"],
      b: ["onboarding.reading=correct"], // (b) IS the bug — selecting it as buggy is correct
      c: ["onboarding.reading=incorrect"],
    },
  },
  {
    id: "p2-decomposition",
    prompt: "You need to add CSV import. How would you split it?",
    options: [
      { id: "a", text: "One function: parse + validate + insert." },
      { id: "b", text: "Two: parse-and-validate, insert." },
      { id: "c", text: "Three+: parse, validate, transform, insert." },
      { id: "d", text: "Use a CSV library and add validation around it." },
    ],
    matchKeys: {
      a: ["onboarding.decomp=monolithic"],
      b: ["onboarding.decomp=ok"],
      c: ["onboarding.decomp=structured"],
      d: ["onboarding.decomp=pragmatic"],
    },
  },
  {
    id: "p3-ai-judgment",
    prompt:
      "AI suggests:\n  try { return (await fetch(url).then(r=>r.json())).results[0].name; }\n  catch (e) { return null; }\nWould you accept as-is?",
    options: [
      { id: "a", text: "Yes, looks fine." },
      { id: "b", text: "No — silent catch swallows errors; at least log." },
      { id: "c", text: "No — .results[0] could be undefined; need to check." },
      { id: "d", text: "No — both: defensive checking + meaningful error handling." },
    ],
    matchKeys: {
      a: ["onboarding.ai=accept_unsafe"],
      b: ["onboarding.ai=catches_logging"],
      c: ["onboarding.ai=catches_undefined"],
      d: ["onboarding.ai=catches_both"],
    },
  },
  {
    id: "p4-verification",
    prompt: "You wrote `removeDuplicates(arr)`. What do you test first?",
    options: [
      { id: "a", text: "Happy path: [1,2,2,3]." },
      { id: "b", text: "Edge cases: empty, all-dup, no-dup, mixed types." },
      { id: "c", text: "Performance: 1M items." },
      { id: "d", text: "Edges first, then happy path, perf last." },
    ],
    matchKeys: {
      a: ["onboarding.verif=happy_only"],
      b: ["onboarding.verif=edges_first"],
      c: ["onboarding.verif=perf_first"],
      d: ["onboarding.verif=edges_then_rest"],
    },
  },
  {
    id: "p5-field",
    prompt: "When you code, you mostly write…",
    options: [
      { id: "web", text: "Frontend / web pages." },
      { id: "ml", text: "Data / ML / notebooks." },
      { id: "sec", text: "Security / pentest." },
      { id: "devOps", text: "Infra / deploy / monitoring." },
      { id: "mobile", text: "Mobile (iOS/Android)." },
      { id: "systems", text: "Systems / low-level." },
      { id: "embedded", text: "Embedded / firmware." },
      { id: "game", text: "Games / graphics." },
      { id: "generalist", text: "A mix of several." },
    ],
    matchKeys: Object.fromEntries(
      ["web","ml","sec","devOps","mobile","systems","embedded","game","generalist"].map(
        (f) => [f, [`onboarding.field=${f}`]],
      ),
    ),
  },
];

export function OnboardingProbes({
  onComplete,
}: {
  onComplete: (selfDeclaredField: Iq3FieldId, matchKeys: string[]) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [collected, setCollected] = useState<string[]>([]);
  const [field, setField] = useState<Iq3FieldId>("generalist");

  if (idx >= PROBES.length) {
    return null;
  }
  const probe = PROBES[idx];
  return (
    <div className="iq3-onboarding">
      <div className="iq3-onboarding-step">{idx + 1} / {PROBES.length}</div>
      <div className="iq3-onboarding-prompt">{probe.prompt}</div>
      <div className="iq3-onboarding-options">
        {probe.options.map((opt) => (
          <button
            key={opt.id}
            className="iq3-onboarding-opt"
            onClick={() => {
              const next = [...collected, ...probe.matchKeys[opt.id]];
              setCollected(next);
              if (probe.id === "p5-field") {
                setField(opt.id as Iq3FieldId);
              }
              if (idx + 1 >= PROBES.length) {
                onComplete(probe.id === "p5-field" ? (opt.id as Iq3FieldId) : field, next);
              } else {
                setIdx(idx + 1);
              }
            }}
          >
            {opt.text}
          </button>
        ))}
      </div>
      <button className="iq3-onboarding-skip" onClick={() => onComplete(field, collected)}>
        Skip
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Show probes in IqDashboard when state is fresh**

In `IqDashboard.tsx`, detect cold state and show probes instead of the dashboard:

```tsx
const [doneOnboarding, setDoneOnboarding] = useState(false);
const isCold = headline && headline.maturity === "cold" && !doneOnboarding && headline.confidence < 0.2;

if (isCold) {
  return (
    <OnboardingProbes
      onComplete={(field, matchKeys) => {
        // Send back to host to ingest as match keys + self-declared field.
        acquireVsCodeApi().postMessage({
          channel: "iq/onboardingComplete",
          payload: { field, matchKeys },
        });
        setDoneOnboarding(true);
      }}
    />
  );
}
```

- [ ] **Step 3: Backend route to accept onboarding result**

Add to `apps/backend/src/iq3/routes/iq.ts`:

```typescript
app.post("/onboarding", async (c) => {
  const userId = c.req.header("x-user-id") ?? c.req.query("userId");
  if (!userId) return c.json({ error: "missing userId" }, 400);
  const body = await c.req.json();
  const matchKeys: string[] = body.matchKeys ?? [];
  const field = body.field;

  let state = (await repo().load(userId)) ?? initialUserState(userId);
  state = applyMatchKeys(state, matchKeys, { isAiEvent: false });
  // Apply self-declared field at 0.2 weight.
  state.field = applySelfDeclaration(state.field, field, 0.2);
  await repo().save(state);
  return c.json({ ok: true });
});
```

(Add the `applySelfDeclaration` import.)

- [ ] **Step 4: Wire host-side message handler**

In webviewHost.ts, on receiving `iq/onboardingComplete`, POST to `/iq/onboarding` then refresh.

- [ ] **Step 5: Smoke test**

Fresh user → dashboard → probes appear → answer through → return to dashboard → headline updated.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/webview/iq3/OnboardingProbes.tsx apps/extension/webview/iq3/IqDashboard.tsx apps/backend/src/iq3/routes/iq.ts apps/extension/src/webviewHost.ts
git commit -m "feat(iq3-ui): 5-question onboarding probes + backend ingest route"
```

---

### Task 25: Periodic self-rating prompt

**Files:**
- Create: `apps/extension/webview/iq3/SelfRatingPrompt.tsx`
- Modify: `apps/extension/webview/iq3/IqDashboard.tsx`

- [ ] **Step 1: Implement the prompt**

```tsx
import React, { useState } from "react";

const STORAGE_KEY = "iq3.selfRating.lastShownAt";
const COOLDOWN_DAYS = 90;

export function SelfRatingPrompt({
  onSubmit,
  onSkip,
}: {
  onSubmit: (rating: number, note?: string) => void;
  onSkip: () => void;
}) {
  const [rating, setRating] = useState<number>(5);
  const [note, setNote] = useState("");
  return (
    <div className="iq3-selfrate">
      <div className="iq3-selfrate-prompt">
        Rate your seniority on this codebase (1 = beginner, 10 = senior).
      </div>
      <div className="iq3-selfrate-buttons">
        {[1,2,3,4,5,6,7,8,9,10].map((n) => (
          <button
            key={n}
            className={`iq3-selfrate-btn ${rating === n ? "iq3-selfrate-btn--sel" : ""}`}
            onClick={() => setRating(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <textarea
        className="iq3-selfrate-note"
        placeholder="(optional) one sentence on why"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="iq3-selfrate-actions">
        <button onClick={() => onSubmit(rating, note || undefined)}>Submit</button>
        <button onClick={onSkip}>Skip</button>
      </div>
    </div>
  );
}

/** Returns true if we should show the prompt now. */
export function shouldShowSelfRating(): boolean {
  const last = Number(localStorage.getItem(STORAGE_KEY) ?? 0);
  const days = (Date.now() - last) / (1000 * 60 * 60 * 24);
  return days >= COOLDOWN_DAYS;
}

export function markSelfRatingShown() {
  localStorage.setItem(STORAGE_KEY, String(Date.now()));
}
```

- [ ] **Step 2: Conditionally render in IqDashboard**

```tsx
import { SelfRatingPrompt, shouldShowSelfRating, markSelfRatingShown } from "./SelfRatingPrompt.js";

// ... inside IqDashboard:
const [showRating, setShowRating] = useState(() => shouldShowSelfRating());

// in JSX:
{showRating && headline?.maturity !== "cold" ? (
  <SelfRatingPrompt
    onSubmit={(rating, note) => {
      acquireVsCodeApi().postMessage({
        channel: "iq/selfRating",
        payload: { rating, note },
      });
      markSelfRatingShown();
      setShowRating(false);
    }}
    onSkip={() => {
      markSelfRatingShown();
      setShowRating(false);
    }}
  />
) : null}
```

- [ ] **Step 3: Host posts to `/iq/self-rating`**

In webviewHost.ts, on receiving `iq/selfRating`, POST to backend.

- [ ] **Step 4: Smoke test**

Manually clear `localStorage.iq3.selfRating.lastShownAt` → reload webview → prompt appears → submit → backend receives.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/webview/iq3/SelfRatingPrompt.tsx apps/extension/webview/iq3/IqDashboard.tsx apps/extension/src/webviewHost.ts
git commit -m "feat(iq3-ui): periodic self-rating prompt with 90-day cooldown"
```

---

## Section 7 — v1/v2 Deprecation

### Task 26: Mark iqV2 deprecated; rip IQ math from store.ts

**Files:**
- Modify: `apps/backend/src/iqV2.ts`
- Modify: `apps/backend/src/store.ts`
- Modify: `packages/types/src/concepts.ts`

- [ ] **Step 1: Add `@deprecated` JSDoc + console.warn to iqV2**

At the top of `apps/backend/src/iqV2.ts`:

```typescript
/**
 * @deprecated Code IQ v2 — superseded by `iq3/` (see docs/superpowers/specs/2026-05-06-code-iq-design.md).
 *
 * Kept for one release cycle so existing webview code can read v2-shaped
 * pillars while migration completes. New code MUST use `apps/backend/src/iq3/`.
 */

let _warned = false;
function warnDeprecated() {
  if (_warned) return;
  _warned = true;
  console.warn(
    "[iqV2] DEPRECATED — migrate callers to iq3. " +
    "v2 will be removed in the next release.",
  );
}

// In the exported computeIqV2:
export function computeIqV2(input: IqV2Input): IqV2 {
  warnDeprecated();
  // ... existing body unchanged ...
}
```

- [ ] **Step 2: Mark `iqV2LevelFor` as deprecated in `concepts.ts`**

```typescript
/** @deprecated Use iq3 rank.computeRank instead. */
export function iqV2LevelFor(iq: number): IqV2LevelBand { /* ... */ }

/** @deprecated Use iq3 RANK_PERCENTILE_BANDS. */
export const IQ_V2_LEVELS = [ /* ... */ ];
```

- [ ] **Step 3: Identify IQ math in store.ts**

```bash
grep -n "computeIq\|IQ_CEILING\|IQ_K\|pillarSnapshot\|iqBreakdown" apps/backend/src/store.ts | head -40
```

Note the line ranges of IQ-specific code paths. Functions to remove:
- The IQ score computation called from `computeIqV2` callsites that mutate user state with score deltas
- `IQ_CEILING`, `IQ_K` constants if they're not referenced from RAG code
- `pillarSnapshots` field maintenance

Functions to **preserve**:
- `findRelevantConcepts`, `recall`, hybrid score (semantic + decay + recency) — this is RAG, not IQ
- `recordConcept`, `setConceptAuthoredFlag` — concept tracking is preserved (still used by Phase B/C)

- [ ] **Step 4: Remove IQ-specific code paths**

Carefully delete or guard with `if (false)` only the IQ math; leave concept retrieval intact. Verify by running existing backend tests:

```bash
pnpm --filter @protege/backend test
```
Expected: still green except potentially some v2-IQ-specific tests, which should be removed alongside the math.

- [ ] **Step 5: Update store.ts header comment**

```typescript
/**
 * User store — concepts, memory (RAG), session metadata.
 *
 * IQ math removed in 2026-05; see iq3/ for the new engine. The RAG path
 * (concept retrieval with hybrid semantic + recency + type score) is the
 * primary remaining responsibility.
 */
```

- [ ] **Step 6: Run all backend tests**

```bash
pnpm --filter @protege/backend test
```
Expected: green (or only v1/v2-specific tests skipped/removed).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/iqV2.ts apps/backend/src/store.ts packages/types/src/concepts.ts
git commit -m "chore(iq): mark iqV2 deprecated; rip IQ math from store.ts (preserve RAG)"
```

---

## Section 8 — Wiring + smoke test

### Task 27: Final integration smoke test

- [ ] **Step 1: Restart everything fresh**

```bash
pnpm install
pnpm --filter @protege/types build
pnpm --filter @protege/backend test
pnpm --filter @protege/extension typecheck
pnpm --filter @protege/extension build
```
Expected: all green.

- [ ] **Step 2: End-to-end dev-host pass**

```bash
pnpm dev:backend &
sleep 5
# F5 in VS Code → dev host
```

In dev host:

1. Sign in (existing flow). New user → onboarding probes appear → complete.
2. Dashboard shows headline with CI; rank shown; pillar bars rendered; field vector visible.
3. Edit any file → save → wait 30s → headline refreshes (pillar deltas).
4. Run a test (any test in workspace) → wait 30s → Verification pillar updates.
5. Send a long specific chat message → wait 30s → AI Partnership pillar moves off pending.
6. Open the legacy Concepts tab → confirm it still loads (v2 data path still alive but @deprecated).

- [ ] **Step 3: Verify nothing else regressed**

```bash
pnpm --filter @protege/backend test
pnpm --filter @protege/extension test
pnpm --filter @protege/extension typecheck
```
Expected: all green.

- [ ] **Step 4: Manual UI sanity**

- The IQ dashboard does not crash with no data
- Pillar bars handle pending state gracefully
- Field vector renders even for 100% generalist
- Floor violation note appears for the staged worked example (manually inject a state to verify; or skip if covered by tests)

- [ ] **Step 5: Final commit (if any housekeeping changes)**

```bash
git status
# if anything new appeared:
git add -A
git commit -m "chore(iq3): final integration tweaks for Phase A MVP"
```

- [ ] **Step 6: Tag the milestone**

```bash
git tag -a iq3-phase-a-mvp -m "Code IQ Phase A MVP — HMM realtime spine + pillars + field + ranks"
```

---

## Verification checklist (Phase A done definition)

Before marking Phase A complete, every item must be true:

- [ ] All backend tests pass: `pnpm --filter @protege/backend test`
- [ ] Extension typechecks: `pnpm --filter @protege/extension typecheck`
- [ ] Types build: `pnpm --filter @protege/types build`
- [ ] Migration `006-iq3-tables.sql` applied to Supabase dev
- [ ] `GET /iq/me` returns a complete `Iq3Headline` for any userId
- [ ] `GET /iq/taxonomy` returns concepts + field tags
- [ ] `POST /iq/self-rating` accepts and persists a rating
- [ ] `POST /iq/onboarding` ingests onboarding probe match keys
- [ ] Echo events trigger HMM updates (verify by re-fetching `/iq/me` after a synthetic batch)
- [ ] Profile tab in extension renders headline + pillar bars + field vector + CI
- [ ] Onboarding probes appear for fresh users; complete-flow updates state
- [ ] Periodic self-rating prompt appears after maturity; respects 90-day cooldown
- [ ] iqV2 is `@deprecated` and emits a warn on first call
- [ ] store.ts has no IQ score math; RAG path intact
- [ ] No leaderboard / public-profile UI exists (per spec privacy)
- [ ] Fresh-user score is in [200, 600] with wide CI; one-week active user CI tightens

## Self-review notes

After implementing this plan:

1. **Spec coverage check** — every section of `docs/superpowers/specs/2026-05-06-code-iq-design.md` Phase A scope (§17 row "A. Foundation") should map to one of Tasks 1–27. Missing? Add a task.
2. **Type consistency** — TraitId, PillarId, FieldId, RankId names appear identically in types, backend, and webview. If any name drifted, fix.
3. **Placeholder scan** — search the implementation for `TODO:`, `FIXME:`, `// stub`. The only acceptable remaining stubs are:
   - `cohortRebuild.ts` body (intentionally a stub until Phase B sees real data)
   - `editorNavigation.ts` def-jump heuristic (intentional Phase A scope cut)
4. **Confidence signals** — verify the dashboard never displays a number without its CI half-width.

Phases B (Mentor Panel), C (Biography), D (Probe) are tracked in separate plans, each starting from this Phase A foundation.
