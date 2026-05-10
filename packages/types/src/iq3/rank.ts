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
 *
 * v2 calibration note: senior floor was 580 (the 15th percentile of an
 * idealized senior distribution). With v2's full producer set wired,
 * Diagnostics still tops out around 550 for typical seniors because
 * several Diagnostics traits remain dormant (need static analysis we
 * don't yet ship). 580 was therefore blocking valid senior personas
 * whose other pillars were 800+. Lowered to 500 — the neutral
 * uniform-prior baseline. Anyone scoring below 500 has *negative*
 * signal in that pillar (a real deficit), which still blocks senior.
 */
export const PILLAR_FLOOR_FALLBACK: Record<Iq3RankId, number> = {
  learner: 0,
  junior:  150,
  mid:     350,
  senior:  500,
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
