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
