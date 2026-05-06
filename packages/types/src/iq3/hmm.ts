import type { Iq3FieldVector } from "./fields.js";
import type { Iq3PillarId, Iq3PillarScore } from "./pillars.js";
import type { Iq3Rank } from "./rank.js";
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
