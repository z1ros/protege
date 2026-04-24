import type { BehaviorDailyRollupRow } from "../../../src/store.js";
import type { Rng } from "../random.js";
import { FILES_BY_LANGUAGE, LANGUAGES } from "../fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function yyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface Options {
  userId: string;
  days: number;
  nowMs: number;
  rng: Rng;
}

export function generateBehaviorRollups(
  opts: Options
): BehaviorDailyRollupRow[] {
  const { userId, days, nowMs, rng } = opts;
  const allFiles = LANGUAGES.flatMap((l) => FILES_BY_LANGUAGE[l]);
  const rows: BehaviorDailyRollupRow[] = [];

  for (let i = 0; i < days; i += 1) {
    const dayStart = nowMs - i * DAY_MS;
    const d = new Date(dayStart);
    const date = yyyymmdd(d);

    // 20% chance of a zero-activity day to exercise empty states.
    const isZeroDay = rng.bool(0.2);
    if (isZeroDay) {
      rows.push({
        userId,
        date,
        activeMinutes: 0,
        totalMinutes: 0,
        sessionsCount: 0,
        sessionMinutes: 0,
        hourHistogram: new Array(24).fill(0),
        linesAdded: 0,
        linesRemoved: 0,
        linesNet: 0,
        filesTouched: [],
        fileHops: 0,
        archetypeHint: null,
      });
      continue;
    }

    // Recency bias: recent days more active.
    const recencyBoost = 1 - i / (days * 2);
    const activeMinutes = Math.round(rng.int(15, 180) * recencyBoost);
    const totalMinutes = Math.round(activeMinutes * rng.float(1.1, 1.4));
    const sessionsCount = Math.max(1, Math.min(4, Math.ceil(activeMinutes / 45)));
    const sessionMinutes = Math.round(activeMinutes * rng.float(0.8, 1.0));

    // Hour histogram — concentrate activity in a 3-5 hour window.
    const hourHistogram = new Array(24).fill(0) as number[];
    const peakHour = rng.int(9, 21);
    let minutesRemaining = activeMinutes;
    for (let h = 0; h < 24 && minutesRemaining > 0; h += 1) {
      const dist = Math.min(4, Math.abs(h - peakHour));
      if (dist >= 4) continue;
      const share = Math.round(minutesRemaining * rng.float(0.1, 0.5));
      hourHistogram[h] = Math.min(share, minutesRemaining);
      minutesRemaining -= hourHistogram[h];
    }
    if (minutesRemaining > 0) hourHistogram[peakHour] += minutesRemaining;

    const linesAdded = rng.int(10, 220);
    const linesRemoved = rng.int(0, Math.max(1, Math.floor(linesAdded * 0.4)));
    const touchedCount = rng.int(1, Math.min(5, allFiles.length));
    const filesTouched = rng.shuffle(allFiles).slice(0, touchedCount);

    rows.push({
      userId,
      date,
      activeMinutes,
      totalMinutes,
      sessionsCount,
      sessionMinutes,
      hourHistogram,
      linesAdded,
      linesRemoved,
      linesNet: linesAdded - linesRemoved,
      filesTouched,
      fileHops: rng.int(touchedCount, touchedCount * 5),
      archetypeHint: null,
    });
  }

  return rows;
}
