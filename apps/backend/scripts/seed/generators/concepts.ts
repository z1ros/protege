import type {
  ConceptState,
  ConceptStatusRow,
  ConceptEncounterRow,
} from "../../../src/store.js";
import type { Rng } from "../random.js";
import {
  CONCEPTS_BY_LANGUAGE,
  EXT_BY_LANGUAGE,
  FILES_BY_LANGUAGE,
  LANGUAGES,
  type Language,
} from "../fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Minimum number of concepts whose `firstSeenAt` lands inside today's
 *  window. Guarantees W16's hourly Today chart has visible points instead
 *  of rendering as empty state. */
const MIN_TODAY_FIRSTSEEN = 4;

interface Options {
  userId: string;
  days: number;
  nowMs: number;
  rng: Rng;
}

export interface GeneratedConcepts {
  states: ConceptState[];
  statuses: ConceptStatusRow[];
  encounters: ConceptEncounterRow[];
}

/**
 * Pick a concept pool across the 3 seeded languages. Returns ~30 concept
 * names distributed across languages, plus the language they map to.
 */
function pickConceptPool(rng: Rng): Array<{ concept: string; language: Language }> {
  const pool: Array<{ concept: string; language: Language }> = [];
  for (const lang of LANGUAGES) {
    const names = CONCEPTS_BY_LANGUAGE[lang];
    const take = rng.int(8, Math.min(12, names.length));
    for (const name of rng.shuffle(names).slice(0, take)) {
      pool.push({ concept: name, language: lang });
    }
  }
  return pool;
}

export function generateConcepts(opts: Options): GeneratedConcepts {
  const { userId, days, nowMs, rng } = opts;
  const pool = pickConceptPool(rng);
  const states: ConceptState[] = [];
  const encounters: ConceptEncounterRow[] = [];

  // Intended split across the pool:
  //   first 15  → Yours (hasBeenAuthored=true, high authorshipRatio)
  //   next 10   → AI Used (hasBeenAuthored=false, authorshipRatio<0.5)
  //   last ~5   → Untouched (authorshipRatio=null, hasBeenAuthored=false)
  const yoursCount = 15;
  const aiUsedCount = 10;

  for (let i = 0; i < pool.length; i += 1) {
    const { concept, language } = pool[i];
    const filePool = FILES_BY_LANGUAGE[language];
    const distinctFileCount = rng.int(1, Math.min(5, filePool.length));
    const distinctFiles = rng.shuffle(filePool).slice(0, distinctFileCount);
    const firstSeenDaysAgo = rng.int(0, days - 1);
    const firstSeenAt = new Date(nowMs - firstSeenDaysAgo * DAY_MS).toISOString();
    const lastUsedAt = new Date(
      nowMs - rng.int(0, Math.max(0, firstSeenDaysAgo)) * DAY_MS
    ).toISOString();

    let timesUsed: number;
    let authorshipRatio: number | null;
    let hasBeenAuthored: boolean;
    let firstAuthoredAt: string | null;

    if (i < yoursCount) {
      // Yours bucket — some cross the "mastered" threshold.
      timesUsed = i < 8 ? rng.int(3, 15) : rng.int(1, 4);
      authorshipRatio = rng.float(0.75, 1.0);
      hasBeenAuthored = true;
      firstAuthoredAt = firstSeenAt;
    } else if (i < yoursCount + aiUsedCount) {
      // AI Used bucket.
      timesUsed = rng.int(1, 5);
      authorshipRatio = rng.float(0.05, 0.45);
      hasBeenAuthored = false;
      firstAuthoredAt = null;
    } else {
      // Untouched bucket — no author signal, low counts.
      timesUsed = rng.int(1, 2);
      authorshipRatio = null;
      hasBeenAuthored = false;
      firstAuthoredAt = null;
    }

    states.push({
      userId,
      conceptName: concept,
      timesUsed,
      distinctFiles,
      qualityFlags: rng.int(0, 2),
      bestContextScore: rng.float(1.0, 3.0),
      firstSeenAt,
      lastUsedAt,
      authorshipRatio,
      hasBeenAuthored,
      firstAuthoredAt,
      language,
    });

    // Encounters: seed ~2-4 per concept, spread across its distinctFiles.
    const encounterCount = rng.int(2, 4);
    for (let k = 0; k < encounterCount; k += 1) {
      const file = distinctFiles[rng.int(0, distinctFiles.length - 1)];
      const daysAgo = rng.int(0, Math.max(0, firstSeenDaysAgo));
      const seenAt = new Date(
        nowMs - daysAgo * DAY_MS - rng.int(0, 23) * 60 * 60 * 1000
      ).toISOString();
      encounters.push({
        userId,
        concept,
        filePath: file,
        seenAt,
        authorshipRatioAtTime: authorshipRatio,
        language,
      });
    }
  }

  // Ensure W16's Today hourly chart renders with data. Rewrite a handful
  // of concepts' firstSeenAt to land inside today (spread across
  // different hours) so the 24-bucket chart has visible points.
  const todayCount = Math.min(MIN_TODAY_FIRSTSEEN, states.length);
  const shuffledStates = rng.shuffle(states.map((_, i) => i)).slice(0, todayCount);
  for (const idx of shuffledStates) {
    const hoursAgo = rng.int(0, 22);
    const minutesJitter = rng.int(0, 59);
    const todayTs = new Date(
      nowMs - hoursAgo * HOUR_MS - minutesJitter * 60 * 1000
    ).toISOString();
    states[idx].firstSeenAt = todayTs;
    // Keep firstAuthoredAt consistent when present so W15's "authored"
    // bucket doesn't pin a firstAuthoredAt older than firstSeenAt.
    if (states[idx].firstAuthoredAt) {
      states[idx].firstAuthoredAt = todayTs;
    }
    // Bump lastUsedAt forward if the old value predates today's firstSeenAt.
    if (states[idx].lastUsedAt < todayTs) {
      states[idx].lastUsedAt = todayTs;
    }
  }

  // Cap encounters around 80.
  while (encounters.length > 80) encounters.pop();

  // Statuses: ~12 random concepts get an explicit known/not_known marker.
  const statusNames = rng.shuffle(states.map((s) => s.conceptName)).slice(0, 12);
  const statuses: ConceptStatusRow[] = statusNames.map((concept) => {
    const r = rng.int(0, 100);
    const status: ConceptStatusRow["status"] =
      r < 50 ? "known" : r < 85 ? "not_known" : "unset";
    return {
      userId,
      concept,
      status,
      updatedAt: new Date(nowMs - rng.int(0, days - 1) * DAY_MS).toISOString(),
    };
  });

  // Light sanity: ensure the extension ext/language mapping at least matches
  // the file paths used in the encounters (no-op here — encounters already
  // route through FILES_BY_LANGUAGE with matching extensions).
  void EXT_BY_LANGUAGE;

  return { states, statuses, encounters };
}
