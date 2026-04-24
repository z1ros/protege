import type { FileAuthorshipCounterRow } from "../../../src/store.js";
import type { Rng } from "../random.js";
import { FILES_BY_LANGUAGE, LANGUAGES } from "../fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Options {
  userId: string;
  nowMs: number;
  rng: Rng;
}

/**
 * 12 file authorship counter rows, mixed ratios so W1 Hero's Manual %
 * aggregate lands around 60-70% human. Three regimes:
 *   - 5 files 90-97% human ("your code")
 *   - 4 files 50-70% human
 *   - 3 files 15-30% human ("AI did most")
 */
export function generateFileAuthorship(
  opts: Options
): FileAuthorshipCounterRow[] {
  const { userId, nowMs, rng } = opts;
  const allFiles = rng.shuffle(LANGUAGES.flatMap((l) => FILES_BY_LANGUAGE[l]));
  const rows: FileAuthorshipCounterRow[] = [];

  const regimes: Array<{ count: number; lo: number; hi: number }> = [
    { count: 5, lo: 0.9, hi: 0.97 },
    { count: 4, lo: 0.5, hi: 0.7 },
    { count: 3, lo: 0.15, hi: 0.3 },
  ];

  let fileIdx = 0;
  for (const regime of regimes) {
    for (let i = 0; i < regime.count && fileIdx < allFiles.length; i += 1, fileIdx += 1) {
      const ratio = rng.float(regime.lo, regime.hi);
      const total = rng.int(1200, 8000);
      const humanChars = Math.round(total * ratio);
      const aiChars = total - humanChars;
      // Spread updatedAt across the last 30 days, biased toward recent days
      // via x^2. Prior behaviour anchored every row within 5 days of now,
      // which made every counter fall inside the Today window regardless of
      // actual activity — so Manual % looked populated while the rest of
      // the Hero tiles were zero. Squaring the uniform sample weights the
      // distribution toward 0 (today) but still reaches back 30 days.
      const dayOffset = Math.floor(rng.next() ** 2 * 30);
      const hourJitterMs = rng.int(0, 24 * 60 * 60 * 1000 - 1);
      const updatedAt = new Date(
        nowMs - dayOffset * DAY_MS - hourJitterMs
      ).toISOString();
      rows.push({
        userId,
        filePath: allFiles[fileIdx],
        humanChars,
        aiChars,
        updatedAt,
      });
    }
  }
  return rows;
}
