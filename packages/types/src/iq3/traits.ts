import type { Iq3PillarId } from "./pillars.js";

/** All 30 latent traits. Each maps primarily to one pillar; some have
 *  secondary contributions (handled in pillar-projection weights). */
export const TRAIT_IDS = [
  // Comprehension
  "readsBeforeWrites",
  "pausesBeforeLargeEdits",
  "summarizesCodebase",
  "asksClarifyingQuestions",
  "navigatesBySymbols",
  // Execution
  "compilesCleanOnSave",
  "keepsFunctionsSmall",
  "authorshipSelf",
  "conceptDepth",
  "styleMatchesCodebase",
  // Diagnostics
  "errorResolutionFast",
  "hypothesisDriven",
  "fixNotBandAid",
  "testsAfterError",
  "readsStackTrace",
  // Verification
  "runsTestsOften",
  "writesTestFiles",
  "assertionDensity",
  "edgeCaseCoverage",
  "preCommitReads",
  // Stewardship
  "meaningfulCommitMsgs",
  "consistentNaming",
  "removesDeadCode",
  "refactorsWhileTouching",
  "commentsWhyNotWhat",
  // AI Partnership
  "specificPrompts",
  "iteratesOnAiOutput",
  "overridesAiConfidently",
  "explainsAfterAccept",
  "agenticFlowQuality",
] as const;

export type Iq3TraitId = (typeof TRAIT_IDS)[number];
export type Iq3TraitState = "low" | "mid" | "high";

/** Posterior over the three trait states. Sums to 1.0. */
export type Iq3TraitPosterior = Record<Iq3TraitState, number>;

/** Maps each trait to its primary pillar. */
export const TRAIT_TO_PILLAR: Record<Iq3TraitId, Iq3PillarId> = {
  readsBeforeWrites: "reading",
  pausesBeforeLargeEdits: "reading",
  summarizesCodebase: "reading",
  asksClarifyingQuestions: "reading",
  navigatesBySymbols: "reading",
  compilesCleanOnSave: "writing",
  keepsFunctionsSmall: "writing",
  authorshipSelf: "writing",
  conceptDepth: "writing",
  styleMatchesCodebase: "writing",
  errorResolutionFast: "debugging",
  hypothesisDriven: "debugging",
  fixNotBandAid: "debugging",
  testsAfterError: "debugging",
  readsStackTrace: "debugging",
  runsTestsOften: "testing",
  writesTestFiles: "testing",
  assertionDensity: "testing",
  edgeCaseCoverage: "testing",
  preCommitReads: "testing",
  meaningfulCommitMsgs: "maintainability",
  consistentNaming: "maintainability",
  removesDeadCode: "maintainability",
  refactorsWhileTouching: "maintainability",
  commentsWhyNotWhat: "maintainability",
  specificPrompts: "aiLiteracy",
  iteratesOnAiOutput: "aiLiteracy",
  overridesAiConfidently: "aiLiteracy",
  explainsAfterAccept: "aiLiteracy",
  agenticFlowQuality: "aiLiteracy",
};

/** Likelihood entry shape — P(event | trait_state) for a single event-pattern. */
export interface Iq3LikelihoodEntry {
  /** Discriminator string — must match the matchKey computed by the ingest
   *  layer for that event pattern. */
  matchKey: string;
  trait: Iq3TraitId;
  /** P(matchKey observed | trait state). Each row should be roughly
   *  proportional across states; absolute values get normalized in update. */
  pLow: number;
  pMid: number;
  pHigh: number;
}
