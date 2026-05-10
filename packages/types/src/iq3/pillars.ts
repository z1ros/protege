import type { Iq3FieldId } from "./fields.js";

export const PILLAR_IDS = [
  "reading",
  "writing",
  "debugging",
  "testing",
  "maintainability",
  "aiLiteracy",
] as const;

export type Iq3PillarId = (typeof PILLAR_IDS)[number];

export interface Iq3PillarScore {
  /** 0..1000 */
  score: number;
  /** central 80% CI half-width in score units */
  ciHalfWidth: number;
  /** posterior probability mass within central 80% */
  ciCoverage: number;
  /** true when sample insufficient to score (e.g. AI Literacy before AI use) */
  pending: boolean;
}

/** Field-conditional weight matrix. Row-normalized at use site. */
export const PILLAR_WEIGHTS: Record<Iq3FieldId, Record<Iq3PillarId, number>> = {
  web:        { reading: 1.0, writing: 1.0, debugging: 1.0, testing: 0.9, maintainability: 1.1, aiLiteracy: 1.1 },
  ml:         { reading: 1.1, writing: 0.9, debugging: 1.2, testing: 1.3, maintainability: 0.8, aiLiteracy: 1.0 },
  dataEng:    { reading: 1.0, writing: 0.9, debugging: 1.1, testing: 1.4, maintainability: 1.0, aiLiteracy: 0.9 },
  devOps:     { reading: 1.1, writing: 0.9, debugging: 1.3, testing: 1.0, maintainability: 1.1, aiLiteracy: 0.8 },
  sec:        { reading: 1.2, writing: 0.9, debugging: 1.4, testing: 1.2, maintainability: 0.8, aiLiteracy: 0.9 },
  mobile:     { reading: 1.0, writing: 1.1, debugging: 1.0, testing: 1.0, maintainability: 1.0, aiLiteracy: 1.0 },
  systems:    { reading: 1.1, writing: 1.1, debugging: 1.3, testing: 1.1, maintainability: 1.0, aiLiteracy: 0.9 },
  game:       { reading: 1.0, writing: 1.2, debugging: 1.0, testing: 0.8, maintainability: 0.9, aiLiteracy: 1.0 },
  embedded:   { reading: 1.1, writing: 1.1, debugging: 1.3, testing: 1.2, maintainability: 1.0, aiLiteracy: 0.7 },
  generalist: { reading: 1.0, writing: 1.0, debugging: 1.0, testing: 1.0, maintainability: 1.0, aiLiteracy: 1.0 },
};
