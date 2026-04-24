import type { HeroWidgetPayload } from "@protege/types";
import {
  readBehaviorRollups,
  readConceptStates,
  readFileAuthorshipRows,
} from "../../store.js";
import { DAY_MS, dateKey, rangeDates } from "../util/shared.js";

/**
 * W1 Hero aggregator. Four tiles:
 *   - Time in Editor  (totalMinutes)
 *   - Lines Written   (linesAdded)
 *   - Concepts Mastered (ConceptState crossed mastery in window)
 *   - Manual %        (aggregate authorship ratio across files in window)
 *
 * activeMinutes is retained for the sparkline + trend arrow only.
 */
export async function assembleHeroPayload(
  userId: string,
  windowStart: number,
  windowEnd: number
): Promise<HeroWidgetPayload> {
  const startDate = dateKey(windowStart);
  const endDate = dateKey(windowEnd);
  const rollups = await readBehaviorRollups(userId, startDate, endDate);
  const byDate = new Map(rollups.map((r) => [r.date, r]));

  let activeMinutes = 0;
  let timeInEditor = 0;
  let linesWritten = 0;
  for (const r of rollups) {
    activeMinutes += r.activeMinutes;
    timeInEditor += r.totalMinutes;
    // Lines written = lines authored. Using `linesNet` makes a single
    // deletion render as "-1", which reads like a bug.
    linesWritten += r.linesAdded;
  }

  // Concepts mastered this window — mastery threshold per plan.
  const conceptStates = await readConceptStates(userId);
  const windowStartIso = new Date(windowStart).toISOString();
  const windowEndIso = new Date(windowEnd).toISOString();
  let conceptsMastered = 0;
  for (const c of conceptStates) {
    if (c.timesUsed < 3) continue;
    if (c.distinctFiles.length < 2) continue;
    if (c.lastUsedAt < windowStartIso || c.lastUsedAt > windowEndIso) continue;
    conceptsMastered += 1;
  }

  // Manual % — sum human + ai chars across rows touched in the window.
  const authorshipRows = await readFileAuthorshipRows(userId);
  let humanTotal = 0;
  let aiTotal = 0;
  for (const row of authorshipRows) {
    if (row.updatedAt < windowStartIso || row.updatedAt > windowEndIso) continue;
    humanTotal += row.humanChars;
    aiTotal += row.aiChars;
  }
  const manualDenom = humanTotal + aiTotal;
  // Gate manualPct on session activity. FileAuthorshipCounter rows can exist
  // independently of BehaviorRollup activity (counters persist across sessions,
  // so a row's `updatedAt` can fall inside a window even when the user was
  // not coding). Showing a ratio while timeInEditor/linesWritten are zero
  // reads like a bug, so we hide it instead.
  const manualPctHidden = timeInEditor === 0;
  const manualPct =
    manualPctHidden || manualDenom === 0 ? 0 : humanTotal / manualDenom;

  // Sparkline: trailing 7 calendar days of the window, padded with zeros.
  const sparkDays = rangeDates(Math.max(windowStart, windowEnd - 6 * DAY_MS), windowEnd);
  const sparkline = sparkDays.map((d) => byDate.get(d)?.activeMinutes ?? 0);

  // Prior-window delta of activeMinutes.
  const windowMs = Math.max(DAY_MS, windowEnd - windowStart);
  const priorStart = windowStart - windowMs;
  const priorEnd = windowStart - 1;
  const priorRollups = await readBehaviorRollups(
    userId,
    dateKey(priorStart),
    dateKey(priorEnd)
  );
  let trendDelta: number | null = null;
  if (priorRollups.length > 0 || rollups.length > 0) {
    const priorActive = priorRollups.reduce((s, r) => s + r.activeMinutes, 0);
    trendDelta = activeMinutes - priorActive;
  }

  return {
    timeInEditor,
    activeMinutes,
    linesWritten,
    conceptsMastered,
    manualPct,
    manualPctHidden,
    sparkline,
    trendDelta,
  };
}
