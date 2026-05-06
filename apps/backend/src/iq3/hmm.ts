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
