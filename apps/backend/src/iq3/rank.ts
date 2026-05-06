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
import type { Distribution } from "./cohort.js";
import { percentileForHeadline } from "./cohort.js";

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
