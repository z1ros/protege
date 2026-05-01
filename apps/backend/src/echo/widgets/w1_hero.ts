import type { HeroWidgetPayload } from "@protege/types";
import {
  readBehaviorRollups,
  readConceptStates,
  readEchoEvents,
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

  // Manual % — window-bounded from raw EchoEvents to match the
  // Independence-trend widget (W14) exactly. Bug fix (2026-04-30):
  // the prior version summed `FileAuthorshipCounter.humanChars/aiChars`
  // (per-file LIFETIME totals) filtered by `updatedAt in window`. So a
  // file touched once in the window contributed ALL of its historical
  // authorship to the "this window's ratio" — Hero would show 68%
  // while Independence Trend showed 16% for the same window. Now both
  // widgets read the same event stream within `[windowStart, windowEnd]`
  // and produce the same number.
  const eventRows = await readEchoEvents(userId, windowStart, windowEnd);
  let humanTotal = 0;
  let aiTotal = 0;
  for (const row of eventRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (row.type === "keystroke_batch") {
      const v = p.charsTyped;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        humanTotal += Math.floor(v);
      }
    } else if (row.type === "ai_suggestion_accepted") {
      const accepted = p.charsAccepted;
      const fallback = p.chars;
      if (typeof accepted === "number" && Number.isFinite(accepted)) {
        aiTotal += Math.max(0, Math.floor(accepted));
      } else if (typeof fallback === "number" && Number.isFinite(fallback)) {
        aiTotal += Math.max(0, Math.floor(fallback));
      }
    }
  }
  const manualDenom = humanTotal + aiTotal;
  // Hide the ratio when the user wasn't actually coding in the window
  // (timeInEditor=0). Otherwise a stray event from cross-session sync
  // could show a number that looks like a bug to the user.
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
