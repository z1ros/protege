import type { LinesWrittenPayload, LinesWrittenDay } from "@protege/types";
import { readBehaviorRollups } from "../../store.js";
import { dateKey, rangeDates } from "../util/shared.js";

/**
 * W8 Lines written. Expands the daily rollups into a contiguous day series
 * (zero-filled), computes cumulative net, and identifies the biggest
 * writing day by lines-added.
 */
export async function assembleLinesPayload(
  userId: string,
  windowStart: number,
  windowEnd: number
): Promise<LinesWrittenPayload> {
  const startDate = dateKey(windowStart);
  const endDate = dateKey(windowEnd);
  const rollups = await readBehaviorRollups(userId, startDate, endDate);
  const byDate = new Map(rollups.map((r) => [r.date, r]));

  const dates = rangeDates(windowStart, windowEnd);
  const days: LinesWrittenDay[] = dates.map((date) => {
    const r = byDate.get(date);
    return {
      date,
      linesAdded: r?.linesAdded ?? 0,
      linesRemoved: r?.linesRemoved ?? 0,
      linesNet: r?.linesNet ?? 0,
    };
  });

  const cumulativeNet = days.reduce((s, d) => s + d.linesNet, 0);

  let biggestDay: LinesWrittenDay | null = null;
  for (const d of days) {
    if (d.linesAdded <= 0) continue;
    if (!biggestDay || d.linesAdded > biggestDay.linesAdded) biggestDay = d;
  }

  return {
    days,
    cumulativeNet,
    biggestDay,
  };
}
