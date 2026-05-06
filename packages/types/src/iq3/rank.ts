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
