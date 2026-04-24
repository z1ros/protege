import {
  getEchoPreferences,
  listEchoUsers,
  readConceptStates,
  readEchoEvents,
  setConceptAuthoredFlag,
  setEchoPreferences,
  upsertBehaviorRollup,
  type EchoEventRow,
  type BehaviorDailyRollupRow,
} from "../store.js";

/** Ratio threshold above which a concept is considered authored. Mirrors
 *  the /concept-used route's constant so backfill and live bumps agree. */
const MANUAL_AUTHORSHIP_THRESHOLD = 0.5;

/**
 * Echo nightly jobs. The rollup job aggregates raw EchoEvent rows into
 * per-day BehaviorDailyRollupRow entries. Idempotent by design: the
 * aggregation recomputes each day's row from the source events, so
 * re-running never double-counts.
 */

export interface JobContext {
  now: number;
}

type JobHandler = (ctx: JobContext) => Promise<void>;

interface JobRegistration {
  name: "rollup" | "archetypeClassifier";
  intervalMs: number;
  handler: JobHandler;
}

const DAILY_MS = 24 * 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;
/** Rollup reprocesses 35 days so late-arriving events still land. */
const ROLLUP_LOOKBACK_MS = 35 * DAILY_MS;
/** One session_tick covers this many minutes of total time. */
const TICK_MINUTES = 1;

let timers: ReturnType<typeof setInterval>[] = [];

function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function hourOf(ms: number): number {
  return new Date(ms).getUTCHours();
}

interface Aggregator {
  activeMinutes: number;
  totalMinutes: number;
  sessionsCount: number;
  sessionMinutes: number;
  hourHistogram: number[];
  linesAdded: number;
  linesRemoved: number;
  filesTouched: Set<string>;
  fileHops: number;
  /** Tracks the last focused language so future widgets can attribute
   *  partial ticks without re-reading the full event stream. Not emitted
   *  on the rollup row today — kept live during aggregation only. */
  lastLanguage: string | null;
  lastFocusTs: number | null;
}

function freshAgg(): Aggregator {
  return {
    activeMinutes: 0,
    totalMinutes: 0,
    sessionsCount: 0,
    sessionMinutes: 0,
    hourHistogram: new Array<number>(24).fill(0),
    linesAdded: 0,
    linesRemoved: 0,
    filesTouched: new Set<string>(),
    fileHops: 0,
    lastLanguage: null,
    lastFocusTs: null,
  };
}

function finalize(
  userId: string,
  date: string,
  agg: Aggregator
): BehaviorDailyRollupRow {
  return {
    userId,
    date,
    activeMinutes: Math.round(agg.activeMinutes),
    totalMinutes: Math.round(agg.totalMinutes),
    sessionsCount: agg.sessionsCount,
    sessionMinutes: Math.round(agg.sessionMinutes),
    hourHistogram: agg.hourHistogram.map((v) => Math.round(v)),
    linesAdded: agg.linesAdded,
    linesRemoved: agg.linesRemoved,
    linesNet: agg.linesAdded - agg.linesRemoved,
    filesTouched: [...agg.filesTouched].slice(0, 200),
    fileHops: agg.fileHops,
    archetypeHint: null,
  };
}

function aggregateEvents(events: EchoEventRow[]): Map<string, Aggregator> {
  const byDate = new Map<string, Aggregator>();
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  for (const e of sorted) {
    const date = dateKey(e.ts);
    const agg = byDate.get(date) ?? freshAgg();
    if (!byDate.has(date)) byDate.set(date, agg);

    switch (e.type) {
      case "session_tick": {
        const payload = e.payload as {
          file?: string | null;
          language?: string | null;
          focusStretchMs?: number;
        };
        agg.totalMinutes += TICK_MINUTES;
        agg.hourHistogram[hourOf(e.ts)] += TICK_MINUTES;
        const stretchMin = Math.max(0, (payload.focusStretchMs ?? 0) / 60_000);
        if (stretchMin > 0) {
          agg.activeMinutes += TICK_MINUTES;
        }
        if (typeof payload.language === "string" && payload.language.length > 0) {
          agg.lastLanguage = payload.language;
        }
        if (typeof payload.file === "string" && payload.file.length > 0) {
          agg.filesTouched.add(payload.file);
        }
        break;
      }
      case "session_boundary": {
        const payload = e.payload as {
          kind?: string;
          activeMs?: number;
        };
        if (payload.kind === "end") {
          agg.sessionsCount += 1;
          const mins = Math.max(0, (payload.activeMs ?? 0) / 60_000);
          agg.sessionMinutes += mins;
        }
        break;
      }
      case "line_diff": {
        const payload = e.payload as {
          linesAdded?: number;
          linesRemoved?: number;
        };
        agg.linesAdded += Math.max(0, payload.linesAdded ?? 0);
        agg.linesRemoved += Math.max(0, payload.linesRemoved ?? 0);
        if (typeof e.file === "string" && e.file.length > 0) {
          agg.filesTouched.add(e.file);
        }
        break;
      }
      case "file_focus_change": {
        const payload = e.payload as {
          file?: string | null;
          language?: string | null;
        };
        if (typeof payload.file === "string" && payload.file.length > 0) {
          agg.filesTouched.add(payload.file);
          agg.fileHops += 1;
        }
        if (typeof payload.language === "string" && payload.language.length > 0) {
          agg.lastLanguage = payload.language;
        }
        break;
      }
      case "keystroke_batch": {
        const payload = e.payload as { language?: string };
        if (typeof payload.language === "string" && payload.language.length > 0) {
          agg.lastLanguage = payload.language;
        }
        if (typeof e.file === "string" && e.file.length > 0) {
          agg.filesTouched.add(e.file);
        }
        break;
      }
      default:
        break;
    }
  }
  return byDate;
}

async function rollupJob(_ctx: JobContext): Promise<void> {
  const since = Date.now() - ROLLUP_LOOKBACK_MS;
  const users = await listEchoUsers(since);
  if (users.length === 0) return;
  for (const userId of users) {
    // One-shot retroactive pass: flip hasBeenAuthored on concepts whose
    // existing authorshipRatio already satisfies the threshold. Gated by
    // UserPreferenceRow.backfillDone so it runs exactly once per user.
    try {
      await backfillAuthoredFlag(userId);
    } catch (err) {
      console.warn(`[echo/rollup] backfill failed for ${userId}:`, err);
    }

    const userEvents = await readEchoEvents(userId, since);
    if (userEvents.length === 0) continue;
    const byDate = aggregateEvents(userEvents);
    for (const [date, agg] of byDate) {
      await upsertBehaviorRollup(finalize(userId, date, agg));
    }
  }
}

/** Rv5.A backfill. Runs exactly once per user, gated by
 *  UserPreferenceRow.backfillDone. For every ConceptState where
 *  `hasBeenAuthored === false` and `authorshipRatio >= 0.5`, flips the
 *  sticky flag and stamps firstAuthoredAt = lastUsedAt (best available
 *  approximation — we never stored the original authoring timestamp). */
export async function backfillAuthoredFlag(userId: string): Promise<void> {
  const prefs = await getEchoPreferences(userId);
  if (prefs.backfillDone) return;
  const rows = await readConceptStates(userId);
  for (const row of rows) {
    if (row.hasBeenAuthored) continue;
    if (
      row.authorshipRatio === null ||
      row.authorshipRatio < MANUAL_AUTHORSHIP_THRESHOLD
    ) {
      continue;
    }
    // setConceptAuthoredFlag is monotonic — safe even if we race with a
    // live /concept-used bump.
    await setConceptAuthoredFlag(userId, row.conceptName, row.lastUsedAt);
  }
  await setEchoPreferences(userId, { backfillDone: true });
}

async function archetypeClassifierJob(_ctx: JobContext): Promise<void> {
  // Stub — W2 widget agent fills in. Should read per-user hourHistogram
  // from BehaviorDailyRollup and assign an archetypeHint using the plan's
  // heuristic table.
}

const jobs: JobRegistration[] = [
  { name: "rollup", intervalMs: HOURLY_MS, handler: rollupJob },
  {
    name: "archetypeClassifier",
    intervalMs: DAILY_MS,
    handler: archetypeClassifierJob,
  },
];

export function registerEchoJobs(): void {
  // Re-entry guard. Today this is only called once from index.ts, but any
  // future lifecycle hook (test harness, in-process restart, HMR) that
  // calls it again would silently stack duplicate rollup loops. Call
  // shutdownEchoJobs() first if you need to reschedule.
  if (timers.length > 0) return;
  for (const job of jobs) {
    const jitter = Math.floor(Math.random() * 30_000);
    const kick = setTimeout(() => {
      const ctx: JobContext = { now: Date.now() };
      job.handler(ctx).catch((err) => {
        console.warn(`[echo/${job.name}] handler error:`, err);
      });
      const loop = setInterval(() => {
        const loopCtx: JobContext = { now: Date.now() };
        job.handler(loopCtx).catch((err) => {
          console.warn(`[echo/${job.name}] handler error:`, err);
        });
      }, job.intervalMs);
      timers.push(loop);
    }, jitter);
    timers.push(kick as unknown as ReturnType<typeof setInterval>);
  }
}

export function shutdownEchoJobs(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

/** Exposed so the dashboard can trigger an ad-hoc aggregation rather than
 *  waiting for the next scheduled tick. The function is idempotent. */
export async function runRollupNow(): Promise<void> {
  await rollupJob({ now: Date.now() });
}
