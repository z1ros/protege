/**
 * Persona harness — behavioral testing for the Iq3 pipeline.
 *
 * Why this exists: 243 unit tests verify mechanical correctness (the
 * math of the HMM, the rank bands, the field projection). They do NOT
 * answer the only question that matters for a proficiency metric:
 *
 *     "Does a person who behaves like a Senior Web Developer
 *      actually score Senior?"
 *
 * Personas encode the team's intuition of what each archetype LOOKS
 * like in event-stream form. The runner pumps that stream through the
 * full pipeline (matchers → HMM → field vector → pillars → rank →
 * composite headline) with no I/O, no persistence, no time. Every
 * persona has an `expect` block declaring the rank/field/score range
 * the team agrees with. CI fails on drift.
 *
 * This is the gold-standard testing approach for stochastic
 * Bayesian systems — deterministic given seed → outcome reproducible
 * → snapshot-testable.
 */

import type {
  EchoEvent,
  Iq3FieldId,
  Iq3Headline,
  Iq3PillarId,
  Iq3RankId,
  Iq3UserState,
} from "@protege/types";
import { initialUserState } from "../hmm.js";
import { applyEventsToState } from "../ingest/iq3Hook.js";
import {
  type RepoSignals,
  updateFieldVector,
} from "../fieldVector.js";
import { computeHeadline } from "../composite.js";
import { FALLBACK_DISTRIBUTION } from "../cohort.js";

/**
 * What a synthetic developer LOOKS like to the Iq3 pipeline.
 *
 * `field` seeds the initial field vector — this would normally come
 * from repo archaeology + concept tagging + onboarding declaration.
 *
 * `events()` returns the deterministic event stream representing the
 * persona's behavior over a stretch of activity. Same call returns the
 * same stream every time, so test outcomes are reproducible.
 *
 * `expect` is the team's ground-truth claim about how this archetype
 * SHOULD score after the pipeline runs. Mismatches break the build.
 */
export interface Persona {
  /** Stable id used as the user_id in the synthetic state. */
  id: string;
  /** Human-readable archetype label. Shown in test output on failure. */
  description: string;
  /** Field signal seed — repo archaeology + concepts + self-declaration. */
  field: {
    repoSignals?: RepoSignals;
    conceptCounts?: Record<string, number>;
    selfDeclared?: Iq3FieldId;
  };
  /** Event-stream generator. Must be deterministic. */
  events: () => EchoEvent[];
  /** Ground-truth expectation. Mismatches FAIL the build. */
  expect: {
    /**
     * Exact final rank match (after floor checks). Use this when the
     * persona's expected rank is reachable given current matcher
     * coverage.
     */
    rank?: Iq3RankId;
    /**
     * Pre-floor rank match. Use this for senior personas while the
     * Diagnostics-trait matchers are not yet wired (currently no
     * producer emits `error_appeared` / `error_cleared`, so the
     * Diagnostics pillar is pegged at 500 → senior is gated by floor
     * for everyone). Once those producers ship, switch back to `rank`.
     */
    uncappedRank?: Iq3RankId;
    /** Highest-probability field after the stream. Optional — leave
     *  unset for cold/sparse personas where field signal is genuinely
     *  ambiguous (uniform vector → tie-break by FIELD_IDS order). */
    dominantField?: Iq3FieldId;
    /** Composite headline must land inside this inclusive range. */
    headlineRange: [number, number];
    /** Optional minimum confidence floor (0..1). */
    confidenceMin?: number;
    /** Optional maturity check — cold/warm/mature. */
    maturity?: "cold" | "warm" | "mature";
    /** Optional per-pillar score bounds — only listed pillars are checked. */
    pillarRanges?: Partial<Record<Iq3PillarId, [number, number]>>;
  };
}

/**
 * Run one persona end-to-end. Pure function — no time, no I/O. Returns
 * the final state plus the headline computed from it. Tests inspect
 * both: the headline carries the user-facing assertions, the state is
 * left available for ad-hoc debugging on failure.
 */
export function runPersona(p: Persona): {
  state: Iq3UserState;
  headline: Iq3Headline;
} {
  // 1. Day-zero state with uniform priors over traits + fields.
  let state = initialUserState(p.id);

  // 2. One-shot field vector update — simulates ~1 year of stable
  //    field signal (the persona has been on the platform long enough
  //    that EMA has fully converged on the fresh detection). Using
  //    `daysSinceLastUpdate: 365` collapses the EMA blend to ≈100%
  //    fresh, mimicking a settled user. Without this the EMA would
  //    barely move (alpha ≈ 0.023 with the default 30-day half-life
  //    and 1-day update step) and every persona's field vector would
  //    sit close to uniform, making field-discrimination untestable.
  state = {
    ...state,
    field: updateFieldVector({
      prior: state.field,
      repoSignals: p.field.repoSignals,
      conceptCounts: p.field.conceptCounts,
      selfDeclared: p.field.selfDeclared,
      daysSinceLastUpdate: 365,
    }),
  };

  // 3. Pump events through the matcher → HMM update path. Same code
  //    path as `ingestForUser` in production, minus the persistence.
  const events = p.events();
  state = applyEventsToState(state, events);

  // 4. Compose the headline against the fallback cohort distribution
  //    so personas don't depend on real cohort data shifting under us.
  const headline = computeHeadline(state, FALLBACK_DISTRIBUTION);

  return { state, headline };
}
