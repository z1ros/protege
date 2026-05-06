/**
 * Confidence interval composer for the headline IQ. For Phase A, no LLM
 * variance to mix in — only HMM posterior width and field-vector entropy
 * affect uncertainty. Panel/Probe variance slots in once those layers
 * exist (Phases B and D respectively).
 */

export interface CiInput {
  /** Per-pillar half-widths from HMM */
  pillarHalfWidths: number[];
  /** Normalized entropy of the field vector ∈ [0, 1] */
  fieldEntropy: number;
}

export interface CiOutput {
  halfWidth: number;
  /** Composite confidence ∈ [0, 1]; reported in UI as percentage */
  confidence: number;
}

export function composeHeadlineCi(input: CiInput): CiOutput {
  // Pillar uncertainty: RMS, scaled by ~0.6 since pillars partially correlate.
  const ms = input.pillarHalfWidths.reduce((s, x) => s + x * x, 0) /
             Math.max(1, input.pillarHalfWidths.length);
  const pillarRms = Math.sqrt(ms);
  const pillarComponent = pillarRms * 0.6;

  // Field entropy widens CI when field is uncertain.
  const fieldComponent = 80 * input.fieldEntropy;

  const halfWidth = Math.round(pillarComponent + fieldComponent);
  // Confidence: tight CI → high confidence. Soft cap at 0.99.
  const confidence = Math.max(0, Math.min(0.99, 1 - halfWidth / 300));
  return { halfWidth, confidence };
}
