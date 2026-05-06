/**
 * Nightly job: rebuilds iq3_cohort_stats from current iq3_pillar_history.
 * For Phase A, run only when cohort is large enough to be meaningful;
 * otherwise the FALLBACK_DISTRIBUTION continues to be used.
 *
 * Wiring: add to whatever cron runner the backend uses. If none exists,
 * trigger via Railway scheduled tasks or Hono route + external cron.
 */

import type { Iq3FieldId } from "@protege/types";
import { FIELD_IDS } from "@protege/types";

const MIN_COHORT_SIZE_TO_OVERRIDE = 200; // per field

export interface CohortRebuildResult {
  perField: Record<Iq3FieldId, { sampled: number; replaced: boolean }>;
  ranAt: string;
}

/**
 * Implementation contract:
 *   for each field f:
 *     1. select latest headline per user where dominant_field = f
 *     2. if count >= MIN_COHORT_SIZE_TO_OVERRIDE, write 7 percentile
 *        breakpoints (5, 25, 50, 75, 90, 97, 99) to iq3_cohort_stats
 *     3. else: write nothing (fallback continues)
 *
 * Phase A leaves the SQL implementation in a follow-up task once the
 * data shape stabilizes. The function below is a stub so the cron is
 * wireable today; it always reports replaced=false.
 */
export async function rebuildCohortStats(): Promise<CohortRebuildResult> {
  const perField = Object.fromEntries(
    FIELD_IDS.map((f) => [f, { sampled: 0, replaced: false }]),
  ) as CohortRebuildResult["perField"];
  return { perField, ranAt: new Date().toISOString() };
}
