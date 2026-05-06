import type { Iq3FieldId } from "@protege/types";

/** Per-field cumulative distribution as (headline, percentile) breakpoints.
 *  Linear interp between breakpoints. Hand-authored fallback for cold cohorts. */
export type Distribution = Record<Iq3FieldId, Array<[number, number]>>;

/** Industry-shaped fallbacks. Treat these as priors that get displaced as
 *  cohort data accumulates. Each row is (headline_score, cumulative_pct). */
export const FALLBACK_DISTRIBUTION: Distribution = {
  web:        [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
  ml:         [[0, 0], [220, 12], [430, 35], [580, 60], [720, 85], [870, 97], [1000, 100]],
  dataEng:    [[0, 0], [200, 12], [400, 35], [560, 60], [700, 85], [850, 97], [1000, 100]],
  devOps:     [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
  sec:        [[0, 0], [220, 12], [430, 35], [580, 60], [720, 85], [870, 97], [1000, 100]],
  mobile:     [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
  systems:    [[0, 0], [220, 12], [430, 35], [580, 60], [720, 85], [870, 97], [1000, 100]],
  game:       [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
  embedded:   [[0, 0], [220, 12], [430, 35], [580, 60], [720, 85], [870, 97], [1000, 100]],
  generalist: [[0, 0], [200, 12], [400, 35], [550, 60], [700, 85], [850, 97], [1000, 100]],
};

/** Linear interp between breakpoints. Returns 0..100. */
export function percentileForHeadline(
  field: Iq3FieldId,
  headline: number,
  dist: Distribution,
): number {
  const points = dist[field];
  if (!points.length) return 50;
  if (headline <= points[0][0]) return points[0][1];
  if (headline >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (headline >= x1 && headline <= x2) {
      const t = (headline - x1) / (x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  return 50;
}
