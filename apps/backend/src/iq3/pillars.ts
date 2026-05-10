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

/** Map E[posterior] ∈ [0,1] to score ∈ [0, 1000+] via shifted sigmoid.
 *
 * Calibration note (Comprehension polish, iteration 3): slope was 12.
 * Empirically too gentle given that most pillars have 2-3 truly-active
 * traits while the others sit at uniform-prior 0.5. Effective range
 * of the pillar mean is roughly [0.4, 0.7] — outside that range
 * requires structural changes (new event producers) we can't ship
 * today. A steeper sigmoid (slope 16) better differentiates inside
 * the reachable mean band: 0.4 → ~170, 0.5 → 500, 0.6 → 832, 0.7 → 970.
 */
function calibrate(rawMean: number): number {
  return Math.round(1000 / (1 + Math.exp(-16 * (rawMean - 0.5))));
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
    reading: [],
    writing: [],
    debugging: [],
    testing: [],
    maintainability: [],
    aiLiteracy: [],
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
      pillar === "aiLiteracy" &&
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
