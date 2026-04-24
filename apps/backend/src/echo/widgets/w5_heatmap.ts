import type { MonthlyHeatmapPayload } from "@protege/types";
import { readBehaviorRollups } from "../../store.js";
import { DAY_MS, dateKey, rangeDates } from "../util/shared.js";

const HEATMAP_DAYS = 30;

/**
 * W5 30-day activity heatmap. This widget is always 30 days regardless of
 * the selected window — the spec is explicit. Cells are padded with empty
 * days so the grid renders a full month even on first launch.
 */
export async function assembleHeatmapPayload(
  userId: string,
  _windowStart: number,
  windowEnd: number
): Promise<MonthlyHeatmapPayload> {
  const end = windowEnd;
  const start = end - (HEATMAP_DAYS - 1) * DAY_MS;
  const startDate = dateKey(start);
  const endDate = dateKey(end);
  const rollups = await readBehaviorRollups(userId, startDate, endDate);
  const byDate = new Map(rollups.map((r) => [r.date, r]));

  const dates = rangeDates(start, end);
  const cells = dates.map((date) => {
    const row = byDate.get(date);
    return {
      date,
      activeMinutes: row?.activeMinutes ?? 0,
      filesTouched: row ? row.filesTouched.length : 0,
    };
  });

  // Trim to exactly HEATMAP_DAYS cells — rangeDates can return 29/31 around
  // DST edges if anything ever slips through.
  const trimmed = cells.slice(-HEATMAP_DAYS);
  const maxMinutes = trimmed.reduce((m, c) => Math.max(m, c.activeMinutes), 0);

  return {
    cells: trimmed,
    maxMinutes,
  };
}
