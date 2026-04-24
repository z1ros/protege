/**
 * v6 — Echo Supabase durability layer: shadow-write queue + cold-sync pull.
 *
 * Two responsibilities:
 *
 *   1. `shadowSupabaseWrite(label, fn)` — fire-and-forget background write
 *      to Supabase that never blocks the local-first request path.
 *      Silently no-ops when Supabase is not configured. Retries with
 *      exponential backoff (5s → 15s → 45s, capped at 3 attempts) then
 *      drops the row. Shadow writes are non-critical: the local JSON
 *      store stays authoritative.
 *
 *   2. `pullFromSupabaseIfCold(userId)` — one-shot cold hydrate. Pulls
 *      every Echo-era table from Supabase into the local store on first
 *      dashboard request per user per backend boot. Idempotent — gated
 *      by the `echoBootstrapped` flag on UserRow. Partial failures log
 *      and keep going; the bootstrap flag only flips once every table
 *      pull returns without error.
 *
 * The only durable invariant here is: **shadow writes never throw**. The
 * HTTP handler that enqueued them has already returned 200 to the client.
 */

import { isSupabaseEnabled } from "../supabase.js";
import {
  cloudReadBehaviorRollups,
  cloudReadCommitStories,
  cloudReadConceptEncounters,
  cloudReadConceptStatuses,
  cloudReadEchoEvents,
  cloudReadFileAuthorshipRows,
  cloudReadLineRewriteCounters,
  cloudReadRepoConceptIndex,
} from "../supabase.js";
import {
  appendConceptEncounter,
  appendEchoEvents,
  isEchoBootstrapped,
  markEchoBootstrapped,
  setConceptStatus,
  setFileAuthorship,
  upsertBehaviorRollup,
  upsertCommitStory,
  upsertLineRewriteCounters,
  upsertRepoConceptIndex,
  type EchoEventInput,
} from "../store.js";

/* ==========================================================
   Shadow-write queue
   ========================================================== */

const BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000];

interface ShadowSyncStatsInternal {
  enqueued: number;
  succeeded: number;
  failed: number;
  pending: number;
}

const stats: ShadowSyncStatsInternal = {
  enqueued: 0,
  succeeded: 0,
  failed: 0,
  pending: 0,
};

export interface ShadowSyncStats {
  enqueued: number;
  succeeded: number;
  failed: number;
  pending: number;
}

/**
 * Fire-and-forget: run `fn()` on the next microtask. Non-blocking.
 *
 * - Silent no-op when Supabase is not configured (fn is never called at all).
 * - On failure, retries with backoff 5s → 15s → 45s, capped at 3 attempts.
 * - Never throws. Errors go to `console.warn` with the `label`.
 * - Counters track enqueue / success / fail / pending for observability.
 */
export function shadowSupabaseWrite(
  label: string,
  fn: () => Promise<void>
): void {
  if (!isSupabaseEnabled()) return;
  // Cold-sync replays already-persisted rows back into the local store.
  // Skip the echo back to Supabase so we don't duplicate rows.
  if (shadowSuppressionDepth > 0) return;

  stats.enqueued += 1;
  stats.pending += 1;

  const attempt = (retryIndex: number): void => {
    // Microtask-defer so the caller's synchronous path returns first. Each
    // retry also uses `setTimeout(... , ms)` so we never starve the event loop.
    queueMicrotask(() => {
      fn()
        .then(() => {
          stats.succeeded += 1;
          stats.pending -= 1;
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (retryIndex >= BACKOFF_MS.length) {
            stats.failed += 1;
            stats.pending -= 1;
            console.warn(`[echo/sync] ${label} failed:`, message);
            return;
          }
          const waitMs = BACKOFF_MS[retryIndex];
          console.warn(
            `[echo/sync] ${label} attempt ${retryIndex + 1} failed; retrying in ${waitMs}ms:`,
            message
          );
          const t = setTimeout(() => attempt(retryIndex + 1), waitMs);
          // Unref so a pending retry never keeps the process alive past shutdown.
          if (typeof t.unref === "function") t.unref();
        });
    });
  };

  attempt(0);
}

/** Read-only snapshot of the queue counters. Stable shape for /echo/sync/stats. */
export function getShadowSyncStats(): ShadowSyncStats {
  return {
    enqueued: stats.enqueued,
    succeeded: stats.succeeded,
    failed: stats.failed,
    pending: stats.pending,
  };
}

/**
 * Process-wide suppression flag for shadow writes. Set while cold-sync
 * replays Supabase rows into the local store — prevents the hydrate path
 * from re-shadow-writing the rows we just pulled (which would be a no-op
 * for upserts but a duplicate-insert for `echo_events` and
 * `concept_encounters`).
 *
 * Counter, not a boolean, so nested calls compose correctly. The store
 * side peeks at `isShadowSuppressed()` before enqueueing.
 */
let shadowSuppressionDepth = 0;

export function isShadowSuppressed(): boolean {
  return shadowSuppressionDepth > 0;
}

async function withShadowSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  shadowSuppressionDepth += 1;
  try {
    return await fn();
  } finally {
    shadowSuppressionDepth -= 1;
  }
}

/* ==========================================================
   Cold-sync pull
   ========================================================== */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const THIRTY_FIVE_DAYS_MS = 35 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const ISO_DATE_LEN = 10; // "YYYY-MM-DD"

/** Date-arithmetic helper for behavior_daily_rollups window. */
function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, ISO_DATE_LEN);
}

/**
 * Populate the local store from Supabase on the first read per user. After a
 * successful hydrate the `echoBootstrapped` flag flips to true so future calls
 * are no-ops. Idempotent.
 *
 * Every table pull runs in parallel — they're independent. If a single pull
 * fails we log and keep going: partial hydration is still useful, and the
 * `echoBootstrapped` flag only flips when all pulls succeeded (so the next
 * request tries again).
 *
 * Silently no-ops when Supabase is not configured.
 *
 * @param userId resolved userId (already scoped to the request)
 * @param workspaceRoot optional — if present, repo_concept_index is limited
 *   to the active workspace only; if absent the pull is skipped (wildcard
 *   reads would be expensive and the widget re-populates on first scan).
 */
export async function pullFromSupabaseIfCold(
  userId: string,
  workspaceRoot?: string | null
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  if (!userId) return;

  if (await isEchoBootstrapped(userId)) return;

  const now = Date.now();
  const since30d = now - THIRTY_DAYS_MS;
  const since35d = now - THIRTY_FIVE_DAYS_MS;
  const since90d = now - NINETY_DAYS_MS;
  const startDate30 = yyyymmdd(new Date(since30d - 90 * 24 * 60 * 60 * 1000)); // full 120-day window for rollups
  const endDate = yyyymmdd(new Date(now));

  let allOk = true;
  const recordFailure = (label: string, err: unknown): void => {
    allOk = false;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[echo/sync] pullFromSupabaseIfCold ${label}:`, message);
  };

  await withShadowSuppressed(() => Promise.all([
    // ---- behavior_daily_rollups ----
    (async () => {
      try {
        const rows = await cloudReadBehaviorRollups(userId, startDate30, endDate);
        for (const r of rows) {
          await upsertBehaviorRollup({
            userId,
            date: r.date,
            activeMinutes: r.activeMinutes,
            totalMinutes: r.totalMinutes,
            sessionsCount: r.sessionsCount,
            sessionMinutes: r.sessionMinutes,
            hourHistogram: r.hourHistogram,
            linesAdded: r.linesAdded,
            linesRemoved: r.linesRemoved,
            linesNet: r.linesNet,
            filesTouched: r.filesTouched,
            fileHops: r.fileHops,
            archetypeHint: r.archetypeHint,
          });
        }
      } catch (err) {
        recordFailure("behaviorRollups", err);
      }
    })(),

    // ---- concept_statuses ----
    (async () => {
      try {
        const rows = await cloudReadConceptStatuses(userId);
        for (const r of rows) {
          await setConceptStatus(userId, r.concept, r.status);
        }
      } catch (err) {
        recordFailure("conceptStatuses", err);
      }
    })(),

    // ---- concept_encounters (last 30 days) ----
    (async () => {
      try {
        const rows = await cloudReadConceptEncounters(userId, since30d);
        for (const r of rows) {
          await appendConceptEncounter({
            userId,
            concept: r.concept,
            filePath: r.filePath,
            seenAt: r.seenAt,
            authorshipRatioAtTime: r.authorshipRatioAtTime,
            language: r.language,
          });
        }
      } catch (err) {
        recordFailure("conceptEncounters", err);
      }
    })(),

    // ---- file_authorship_counters (absolute values, not deltas) ----
    (async () => {
      try {
        const rows = await cloudReadFileAuthorshipRows(userId);
        for (const r of rows) {
          await setFileAuthorship(
            userId,
            r.filePath,
            r.humanChars,
            r.aiChars,
            r.updatedAt
          );
        }
      } catch (err) {
        recordFailure("fileAuthorshipCounters", err);
      }
    })(),

    // ---- line_rewrite_counters (last 30 days) ----
    (async () => {
      try {
        const rows = await cloudReadLineRewriteCounters(userId, since30d);
        // Group rows by filePath, then expand each row by its rewrite count so
        // the store's per-touch +1 increment lands at the same total as the
        // cloud row's `rewriteCount`. Clean cache wipes restore exact counters.
        const byFile = new Map<
          string,
          Array<{ fingerprint: string; sampleContent: string; ts: number }>
        >();
        for (const r of rows) {
          const tsMs = Date.parse(r.lastRewriteAt);
          const ts = Number.isFinite(tsMs) ? tsMs : now;
          const n = Math.max(1, Math.floor(r.rewriteCount));
          const bucket = byFile.get(r.filePath) ?? [];
          for (let i = 0; i < n; i += 1) {
            bucket.push({
              fingerprint: r.lineFingerprint,
              sampleContent: r.lastContent,
              ts,
            });
          }
          byFile.set(r.filePath, bucket);
        }
        for (const [filePath, touches] of byFile) {
          if (touches.length > 0) {
            await upsertLineRewriteCounters(userId, filePath, touches);
          }
        }
      } catch (err) {
        recordFailure("lineRewriteCounters", err);
      }
    })(),

    // ---- commit_stories (last 90 days) ----
    (async () => {
      try {
        const rows = await cloudReadCommitStories(userId, since90d, now);
        for (const r of rows) {
          await upsertCommitStory({
            userId,
            commitSha: r.commitSha,
            commitTs: r.commitTs,
            message: r.message,
            filesTouched: r.filesTouched,
            activeMinutes: r.activeMinutes,
            undoCount: r.undoCount,
            pasteCount: r.pasteCount,
            aiAcceptCount: r.aiAcceptCount,
            peakFocusMin: r.peakFocusMin,
          });
        }
      } catch (err) {
        recordFailure("commitStories", err);
      }
    })(),

    // ---- repo_concept_index (current workspace only, if provided) ----
    (async () => {
      if (!workspaceRoot) return;
      try {
        const rows = await cloudReadRepoConceptIndex(userId, workspaceRoot);
        for (const r of rows) {
          await upsertRepoConceptIndex({
            userId,
            workspaceRoot: r.workspaceRoot,
            concept: r.concept,
            language: r.language,
            fileCount: r.fileCount,
            firstSeenAt: r.firstSeenAt,
            lastSeenAt: r.lastSeenAt,
          });
        }
      } catch (err) {
        recordFailure("repoConceptIndex", err);
      }
    })(),

    // ---- echo_events (last 35 days, batched) ----
    (async () => {
      try {
        const rows = await cloudReadEchoEvents(userId, since35d);
        if (rows.length > 0) {
          const batch: EchoEventInput[] = rows.map((r) => ({
            userId,
            type: r.type,
            ts: r.ts,
            file: r.file ?? undefined,
            payload: r.payload ?? {},
          }));
          await appendEchoEvents(batch);
        }
      } catch (err) {
        recordFailure("echoEvents", err);
      }
    })(),
  ]).then(() => undefined));

  if (allOk) {
    try {
      await markEchoBootstrapped(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        "[echo/sync] pullFromSupabaseIfCold markEchoBootstrapped:",
        message
      );
    }
  }
}
