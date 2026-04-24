import type {
  ConceptsMomentumPayload,
  ConceptsMomentumPoint,
} from "@protege/types";
import { readConceptEncounters, readConceptStates } from "../../store.js";
import { rangeDates } from "../util/shared.js";

const SAMPLE_CAP = 5;
const HOUR_MS = 60 * 60 * 1000;
/** Windows whose span fits inside ~a day switch to hourly buckets. The 30h
 *  ceiling leaves slack for DST / timezone-boundary effects without spilling
 *  into the multi-day window definitions. */
const HOURLY_CUTOFF_MS = 30 * HOUR_MS;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Daily label — "Wed 22" ({weekday} {day-of-month}). Matches the previous
 *  frontend `shortLabel` so the UI is unchanged in daily mode. */
function dailyLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/** Hourly label — "HH:00", zero-padded. */
function hourlyLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * W16 Concepts Momentum. Groups *first-ever* concept sightings by day (or
 * by hour on the Today window) across the window. A concept counts once
 * per user regardless of how many times it was touched later.
 *
 * Primary source: ConceptState.firstSeenAt — reliable single source of
 * truth for concepts the user has actually authored. Secondary source:
 * ConceptEncounter.seenAt — surfaces concepts that flooded in when a
 * third-party repo was opened but never authored.
 */
export async function assembleConceptsMomentumPayload(
  userId: string,
  windowStart: number,
  windowEnd: number
): Promise<ConceptsMomentumPayload | null> {
  const startIso = new Date(windowStart).toISOString();
  const endIso = new Date(windowEnd).toISOString();

  const [states, encounters] = await Promise.all([
    readConceptStates(userId),
    readConceptEncounters(userId, windowStart, windowEnd),
  ]);

  // Per-concept first-seen timestamp across both sources. Authored rows
  // win because they're the more reliable signal (one canonical row per
  // concept per user, updated on /concept-used).
  const firstSeen = new Map<string, string>();
  for (const s of states) {
    if (!s.firstSeenAt) continue;
    firstSeen.set(s.conceptName, s.firstSeenAt);
  }
  for (const e of encounters) {
    const prior = firstSeen.get(e.concept);
    if (!prior || e.seenAt < prior) {
      firstSeen.set(e.concept, e.seenAt);
    }
  }

  // Short spans (Today window ≤ 30h) → hourly mode so the chart has 24
  // visible points instead of a 1-2 dot line.
  const span = windowEnd - windowStart;
  const mode: "hourly" | "daily" = span <= HOURLY_CUTOFF_MS ? "hourly" : "daily";

  if (mode === "hourly") {
    // Group concepts whose first-seen timestamp falls inside the window by
    // UTC hour-of-day. The bucket key is "HH" so the frontend can read the
    // hour without re-parsing.
    const byHour = new Map<number, string[]>();
    for (const [concept, seenAt] of firstSeen) {
      if (seenAt < startIso || seenAt > endIso) continue;
      const hour = new Date(seenAt).getUTCHours();
      const bucket = byHour.get(hour) ?? [];
      bucket.push(concept);
      byHour.set(hour, bucket);
    }

    const points: ConceptsMomentumPoint[] = [];
    for (let h = 0; h < 24; h += 1) {
      const concepts = byHour.get(h) ?? [];
      concepts.sort();
      const sampleNames = concepts.slice(0, SAMPLE_CAP);
      const overflow = Math.max(0, concepts.length - sampleNames.length);
      points.push({
        bucket: String(h).padStart(2, "0"),
        label: hourlyLabel(h),
        count: concepts.length,
        sampleNames,
        overflow,
      });
    }

    if (points.every((p) => p.count === 0)) return null;
    return { points, mode };
  }

  // Daily mode — one bucket per UTC day in the window.
  const byDay = new Map<string, string[]>();
  for (const [concept, seenAt] of firstSeen) {
    if (seenAt < startIso || seenAt > endIso) continue;
    const day = seenAt.slice(0, 10);
    const bucket = byDay.get(day) ?? [];
    bucket.push(concept);
    byDay.set(day, bucket);
  }

  const dates = rangeDates(windowStart, windowEnd);
  const points: ConceptsMomentumPoint[] = dates.map((date) => {
    const concepts = byDay.get(date) ?? [];
    concepts.sort();
    const sampleNames = concepts.slice(0, SAMPLE_CAP);
    const overflow = Math.max(0, concepts.length - sampleNames.length);
    return {
      bucket: date,
      label: dailyLabel(date),
      count: concepts.length,
      sampleNames,
      overflow,
    };
  });

  if (points.every((p) => p.count === 0)) return null;
  return { points, mode };
}
