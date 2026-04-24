import type { PolarClockPayload, PolarClockArc } from "@protege/types";
import { readBehaviorRollups, readEchoEvents, isoWeek } from "../../store.js";
import { dateKey } from "../util/shared.js";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourToWallClock(hour: number, minutes: number): string {
  const total = hour + minutes / 60;
  const h24 = Math.floor(total) % 24;
  const m = Math.round((total - Math.floor(total)) * 60) % 60;
  const suffix = h24 >= 12 ? "pm" : "am";
  const h12 = ((h24 + 11) % 12) + 1;
  const mStr = m.toString().padStart(2, "0");
  return `${h12}:${mStr}${suffix}`;
}

export function archetypeForPeak(peakHour: number): string {
  if (peakHour >= 22 || peakHour < 4) return "night-owl";
  if (peakHour < 8) return "dawn-coder";
  if (peakHour < 12) return "morning-builder";
  if (peakHour < 17) return "afternoon-builder";
  return "evening-coder";
}

/**
 * W2 Polar clock. Sums hour histogram across window rollups for archetype
 * classification and derives the per-session arc list from session_boundary
 * event pairs (start/end).
 */
export async function assemblePolarPayload(
  userId: string,
  windowStart: number,
  windowEnd: number
): Promise<PolarClockPayload> {
  const startDate = dateKey(windowStart);
  const endDate = dateKey(windowEnd);
  const rollups = await readBehaviorRollups(userId, startDate, endDate);

  const hourHistogram = new Array<number>(24).fill(0);
  let totalMinutes = 0;
  let weekendMinutes = 0;
  for (const r of rollups) {
    for (let h = 0; h < 24; h += 1) {
      hourHistogram[h] += r.hourHistogram[h] ?? 0;
    }
    const dayMinutes = r.hourHistogram.reduce((s, v) => s + v, 0);
    totalMinutes += dayMinutes;
    const dow = new Date(`${r.date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) weekendMinutes += dayMinutes;
  }

  // Derive sessions from session_boundary events in the window. We pair
  // `start` with the next `end`; orphan boundaries are ignored.
  const events = await readEchoEvents(userId, windowStart, windowEnd);
  const boundaries = events
    .filter((e) => e.type === "session_boundary")
    .sort((a, b) => a.ts - b.ts);

  const sessions: PolarClockArc[] = [];
  let pendingStart: number | null = null;
  let totalSessions = 0;
  let maxMinutes = 0;

  for (const ev of boundaries) {
    const payload = ev.payload as { kind?: string; activeMs?: number };
    if (payload.kind === "start") {
      pendingStart = ev.ts;
    } else if (payload.kind === "end") {
      const endTs = ev.ts;
      const startTs = pendingStart ?? endTs - (payload.activeMs ?? 0);
      pendingStart = null;
      const minutes = Math.max(
        1,
        (payload.activeMs ?? endTs - startTs) / 60_000
      );
      maxMinutes = Math.max(maxMinutes, minutes);

      const startDate2 = new Date(startTs);
      const endDate2 = new Date(endTs);
      const startHour =
        startDate2.getUTCHours() + startDate2.getUTCMinutes() / 60;
      let endHour = endDate2.getUTCHours() + endDate2.getUTCMinutes() / 60;
      // If the session crosses midnight (endDate2 date > startDate2 date),
      // extend endHour past 24 so the arc draws in one continuous stroke.
      if (
        endDate2.getUTCFullYear() !== startDate2.getUTCFullYear() ||
        endDate2.getUTCMonth() !== startDate2.getUTCMonth() ||
        endDate2.getUTCDate() !== startDate2.getUTCDate()
      ) {
        endHour += 24;
      }
      if (endHour <= startHour) endHour = startHour + Math.max(1 / 60, minutes / 60);

      const weekday = startDate2.getUTCDay();
      const label = `${WEEKDAY_NAMES[weekday]} ${hourToWallClock(
        startDate2.getUTCHours(),
        startDate2.getUTCMinutes()
      )} · ${Math.round(minutes)} min`;

      const dayKey = startDate2.toISOString().slice(0, 10);
      const weekKey = isoWeek(startDate2);
      sessions.push({
        startHour,
        endHour,
        weekday,
        intensity: 0, // set below after maxMinutes known
        label,
        startTs,
        dayKey,
        weekKey,
      });
      totalSessions += 1;
    }
  }

  // Normalize intensity using the window's max session minutes (floor 0.2,
  // ceiling 1.0). This keeps short arcs visible and long arcs saturated.
  if (maxMinutes > 0) {
    for (const s of sessions) {
      const ratio = Math.max(0.2, Math.min(1, (s.endHour - s.startHour) / (maxMinutes / 60)));
      s.intensity = ratio;
    }
  }

  // Pick peak hour as argmax of hourHistogram.
  let peakHour: number | null = null;
  let peakValue = 0;
  for (let h = 0; h < 24; h += 1) {
    if (hourHistogram[h] > peakValue) {
      peakValue = hourHistogram[h];
      peakHour = h;
    }
  }

  // Window-aware archetype rules:
  //   - Today + <3 sessions → encouraging "Keep Going!"
  //   - Week/Month + <3 sessions → "finding your rhythm"
  //   - Otherwise → peak-hour archetype (with weekend-hacker override)
  //
  // Span <= 30h classifies as "today"; anything longer is week or month
  // and both share the original "finding your rhythm" copy.
  const windowIsToday = windowEnd - windowStart <= 30 * 60 * 60 * 1000;
  let archetype: string;
  let archetypeCaption: string;
  if (totalSessions < 3 || peakHour === null) {
    if (windowIsToday) {
      archetype = "Keep Going!";
      archetypeCaption = "Code a few sessions to find your rhythm";
    } else {
      archetype = "finding your rhythm";
      archetypeCaption = "Not enough sessions yet";
    }
  } else {
    if (totalMinutes > 0 && weekendMinutes / totalMinutes > 0.4) {
      archetype = "weekend-hacker";
    } else {
      archetype = archetypeForPeak(peakHour);
    }
    archetypeCaption = `peak: ${hourToWallClock(peakHour, 0)} · ${peakValue}m`;
  }

  return {
    sessions,
    hourHistogram,
    archetype,
    archetypeCaption,
    peakHour,
  };
}
