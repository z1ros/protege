import type {
  Iq3FieldId,
  Iq3FieldVector,
  Iq3Headline,
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
