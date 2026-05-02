import { Hono } from "hono";
import type {
  CommitStory,
  DashboardResponse,
  EchoEvent,
  EchoWindow,
} from "@protege/types";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import {
  appendConceptEncounter,
  appendEchoEvents,
  bumpFileAuthorship,
  ensureUser,
  getAuthorshipRatio,
  getEchoPreferences,
  getFirstEchoEventTs,
  getRecentChanges,
  readRepoConceptIndex,
  setConceptStatus,
  setEchoPreferences,
  upsertCommitStory,
  upsertLineRewriteCounters,
  upsertRepoConceptIndex,
  withStoreBatch,
  type EchoEventInput,
} from "../store.js";
import { runRollupNow } from "../echo/jobs.js";
import {
  getShadowSyncStats,
  pullFromSupabaseIfCold,
} from "../echo/sync.js";
import { assembleHeroPayload } from "../echo/widgets/w1_hero.js";
import { assemblePolarPayload } from "../echo/widgets/w2_polar.js";
import { assembleHeatmapPayload } from "../echo/widgets/w5_heatmap.js";
import { assembleLinesPayload } from "../echo/widgets/w8_lines.js";
import { assembleRewrittenLinePayload } from "../echo/widgets/w10_rewritten.js";
import {
  assembleCommitStoriesPayload,
  enrichAndStoreCommit,
} from "../echo/widgets/w11_commits.js";
import { assembleSaveTapePayload } from "../echo/widgets/w12_saveTape.js";
import { assembleIndependencePayload } from "../echo/widgets/w14_independence.js";
import { assembleConceptsCoveredPayload } from "../echo/widgets/w15_conceptsCovered.js";
import { assembleConceptsMomentumPayload } from "../echo/widgets/w16_conceptsMomentum.js";
import { assembleRepoConceptsPayload } from "../echo/widgets/w17_repoConcepts.js";

/**
 * Echo REST surface. Accepts the extension's batched EchoEvent stream,
 * commit enrichments, and preference updates. GET /echo/dashboard
 * returns a stub response with every widget payload slot present —
 * widget agents fill in real aggregation per widget.
 */

export const echoRoute = new Hono();

echoRoute.use("*", githubAuth());

// ===== Simple per-user rate limit =====
// Not production-grade. Enough to keep a runaway extension from flooding
// the JSON store. Replace with shared state when we move to Supabase.
const POST_WINDOW_MS = 60_000;
const MAX_POSTS_PER_WINDOW = 10;
const MAX_EVENTS_PER_POST = 500;
const ipWindow = new Map<string, number[]>();

function checkRateLimit(bucket: string): boolean {
  const now = Date.now();
  const arr = ipWindow.get(bucket) ?? [];
  const pruned = arr.filter((t) => now - t < POST_WINDOW_MS);
  if (pruned.length >= MAX_POSTS_PER_WINDOW) {
    ipWindow.set(bucket, pruned);
    return false;
  }
  pruned.push(now);
  ipWindow.set(bucket, pruned);
  return true;
}

// Rv5.B repo-scan rate bucket — stricter because each POST can land up to
// ~1000 files' worth of concept rows. 5 POSTs per 5 minutes is enough
// headroom for the scanner's 40 POST max + a couple of user-triggered
// re-scans per window.
const REPO_SCAN_WINDOW_MS = 5 * 60_000;
const MAX_REPO_SCAN_POSTS_PER_WINDOW = 5;
const MAX_REPO_SCAN_BATCHES_PER_POST = 50;
const MAX_CONCEPTS_PER_BATCH = 500;
const repoScanWindow = new Map<string, number[]>();

function checkRepoScanRateLimit(bucket: string): boolean {
  const now = Date.now();
  const arr = repoScanWindow.get(bucket) ?? [];
  const pruned = arr.filter((t) => now - t < REPO_SCAN_WINDOW_MS);
  if (pruned.length >= MAX_REPO_SCAN_POSTS_PER_WINDOW) {
    repoScanWindow.set(bucket, pruned);
    return false;
  }
  pruned.push(now);
  repoScanWindow.set(bucket, pruned);
  return true;
}


function validateEchoEvent(value: unknown): value is EchoEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (typeof e.type !== "string" || e.type.length > 64) return false;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return false;
  return true;
}

function echoEventToInput(userId: string, e: EchoEvent): EchoEventInput {
  const { type, ts, ...rest } = e as { type: string; ts: number } & Record<string, unknown>;
  const file =
    typeof (rest as { file?: unknown }).file === "string"
      ? ((rest as { file?: string }).file ?? undefined)
      : undefined;
  return {
    userId,
    type,
    ts,
    file,
    payload: rest as Record<string, unknown>,
  };
}

echoRoute.post("/events", async (c) => {
  const bucket = c.req.header("x-user-id") ?? c.req.header("x-forwarded-for") ?? "anon";
  if (!checkRateLimit(`events:${bucket}`)) {
    return c.json({ error: "rate limited" }, 429);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "body must be an object" }, 400);
  }
  const typed = body as { userId?: string; events?: unknown };
  const userId = resolveUserId(c, typed.userId);
  await ensureUser(userId);

  const rawEvents = Array.isArray(typed.events) ? typed.events : [];
  if (rawEvents.length === 0) {
    return c.json({ ok: true, accepted: 0 });
  }
  if (rawEvents.length > MAX_EVENTS_PER_POST) {
    return c.json({ error: `max ${MAX_EVENTS_PER_POST} events per POST` }, 413);
  }

  const accepted: EchoEventInput[] = [];
  const rewriteTouchesByFile = new Map<
    string,
    Array<{ fingerprint: string; sampleContent: string; ts: number }>
  >();
  // Aggregate authorship bumps by file so 200 keystroke_batch events for
  // the same file collapse into a single store write.
  const authorshipBumps = new Map<
    string,
    { humanChars: number; aiChars: number }
  >();
  const conceptEncounterEvents: Array<{
    file: string;
    concept: string;
    ts: number;
    language: string | null;
  }> = [];
  const commitEnrichments: Array<{
    commitSha: string;
    commitTs: number;
    priorCommitTs: number;
    message: string;
    filesTouched: string[];
  }> = [];
  let priorCommitTsCursor = 0;

  for (const raw of rawEvents) {
    if (!validateEchoEvent(raw)) continue;
    accepted.push(echoEventToInput(userId, raw));

    // Side-effect: keep LineRewriteCounter fresh on line_diff events.
    if (raw.type === "line_diff") {
      const fingerprints = (raw as { rewrittenFingerprints?: unknown[] })
        .rewrittenFingerprints;
      if (Array.isArray(fingerprints) && raw.file) {
        const bucketArr = rewriteTouchesByFile.get(raw.file) ?? [];
        for (const fp of fingerprints) {
          if (!fp || typeof fp !== "object") continue;
          const record = fp as Record<string, unknown>;
          if (typeof record.fingerprint !== "string") continue;
          bucketArr.push({
            fingerprint: record.fingerprint,
            sampleContent:
              typeof record.sampleContent === "string" ? record.sampleContent : "",
            ts: raw.ts,
          });
        }
        rewriteTouchesByFile.set(raw.file, bucketArr);
      }
    }

    // Side-effect: keystroke_batch bumps the file's human char counter.
    // A workspace-safety check keeps a malicious client from poking at
    // arbitrary paths.
    if (raw.type === "keystroke_batch") {
      const rec = raw as { file?: string; charsTyped?: unknown };
      if (typeof rec.file === "string" && isSafeWorkspacePath(rec.file)) {
        const chars =
          typeof rec.charsTyped === "number" && Number.isFinite(rec.charsTyped)
            ? Math.max(0, Math.floor(rec.charsTyped))
            : 0;
        if (chars > 0) {
          const prior = authorshipBumps.get(rec.file) ?? {
            humanChars: 0,
            aiChars: 0,
          };
          prior.humanChars += chars;
          authorshipBumps.set(rec.file, prior);
        }
      }
    }

    // Side-effect: ai_suggestion_accepted bumps the AI char counter.
    if (raw.type === "ai_suggestion_accepted") {
      const rec = raw as { file?: string; charsAccepted?: unknown; chars?: unknown };
      if (typeof rec.file === "string" && isSafeWorkspacePath(rec.file)) {
        // Prefer the explicit charsAccepted field; fall back to `chars`
        // for backward-compat with older extension builds.
        const explicit =
          typeof rec.charsAccepted === "number" && Number.isFinite(rec.charsAccepted)
            ? rec.charsAccepted
            : undefined;
        const legacy =
          typeof rec.chars === "number" && Number.isFinite(rec.chars)
            ? rec.chars
            : undefined;
        const chars = Math.max(0, Math.floor(explicit ?? legacy ?? 0));
        if (chars > 0) {
          const prior = authorshipBumps.get(rec.file) ?? {
            humanChars: 0,
            aiChars: 0,
          };
          prior.aiChars += chars;
          authorshipBumps.set(rec.file, prior);
        }
      }
    }

    // Side-effect: concept_encountered stamps an encounter row with the
    // current authorship ratio so the widget can bucket it later.
    if (raw.type === "concept_encountered") {
      const rec = raw as {
        file?: string;
        concept?: string;
        language?: unknown;
      };
      if (
        typeof rec.file === "string" &&
        isSafeWorkspacePath(rec.file) &&
        typeof rec.concept === "string" &&
        rec.concept.length > 0 &&
        rec.concept.length <= 200
      ) {
        conceptEncounterEvents.push({
          file: rec.file,
          concept: rec.concept,
          ts: raw.ts,
          language: sanitizeLanguage(rec.language),
        });
      }
    }

    // Side-effect: on commit_detected events without a matching /echo/commits
    // POST, compute enrichment from event rows between this and the prior
    // commit and upsert the CommitStory row.
    if (raw.type === "commit_detected") {
      const rec = raw as {
        sha?: string;
        message?: string;
        filesTouched?: unknown;
      };
      if (typeof rec.sha === "string" && rec.sha.length > 0) {
        const prior = priorCommitTsCursor || Math.max(0, raw.ts - 24 * 60 * 60 * 1000);
        commitEnrichments.push({
          commitSha: rec.sha,
          commitTs: raw.ts,
          priorCommitTs: prior,
          message: typeof rec.message === "string" ? rec.message : "",
          filesTouched: Array.isArray(rec.filesTouched)
            ? rec.filesTouched.filter((f: unknown): f is string => typeof f === "string")
            : [],
        });
        priorCommitTsCursor = raw.ts;
      }
    }
  }

  // Coalesce every store mutation below into a single JSON write at the
  // end. Without this, a batch of 20 rewrite files + 5 commits + 20
  // authorship bumps + 30 concept encounters triggers ~75 full-store
  // writes before the handler returns.
  await withStoreBatch(async () => {
    if (accepted.length > 0) {
      await appendEchoEvents(accepted);
    }
    for (const [filePath, touches] of rewriteTouchesByFile) {
      await upsertLineRewriteCounters(userId, filePath, touches);
    }
    for (const enr of commitEnrichments) {
      try {
        await enrichAndStoreCommit({ userId, ...enr });
      } catch (err) {
        console.warn("[echo] commit enrichment failed:", err);
      }
    }

    // Flush aggregated authorship bumps — one write per file per POST.
    for (const [filePath, delta] of authorshipBumps) {
      try {
        await bumpFileAuthorship(userId, filePath, delta);
      } catch (err) {
        console.warn("[echo] authorship bump failed:", err);
      }
    }

    // Flush concept encounters. Authorship bumps above are flushed FIRST so
    // the ratio we stamp on each encounter reflects chars from the same
    // batch (otherwise a first-ever save would always stamp null).
    for (const ev of conceptEncounterEvents) {
      try {
        const ratio = await getAuthorshipRatio(userId, ev.file);
        await appendConceptEncounter({
          userId,
          concept: ev.concept,
          filePath: ev.file,
          seenAt: new Date(ev.ts).toISOString(),
          authorshipRatioAtTime: ratio,
          language: ev.language,
        });
      } catch (err) {
        console.warn("[echo] concept encounter append failed:", err);
      }
    }
  });

  return c.json({ ok: true, accepted: accepted.length });
});

/** Reject obvious path traversal / absolute-drive shenanigans from client input.
 *  The extension always reports absolute paths; we just verify the shape looks
 *  like a real filesystem path the user could own. */
export function isSafeWorkspacePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 2000) return false;
  if (p.includes("\0")) return false;
  if (p.includes("../") || p.includes("..\\")) return false;
  return true;
}

/** Rv5.B stricter batch-file validator: must be safe AND live under the
 *  declared workspaceRoot. Backend never reads files — this is purely a
 *  sanity guard so a malicious extension can't poison the index with
 *  paths outside the workspace the scan is running against. */
export function isSafeBatchFilePath(workspaceRoot: string, filePath: string): boolean {
  if (!isSafeWorkspacePath(filePath)) return false;
  // Accept paths that start with the workspace root (either exact or as a
  // prefix followed by a path separator). We don't resolve symlinks here;
  // the extension sends pre-resolved fsPaths from VS Code APIs.
  if (filePath === workspaceRoot) return true;
  const withSep = workspaceRoot.endsWith("/") || workspaceRoot.endsWith("\\")
    ? workspaceRoot
    : workspaceRoot + (workspaceRoot.includes("\\") ? "\\" : "/");
  return filePath.startsWith(withSep);
}

/** Rv5.A language label validator. Accepts null/undefined (both → null) or a
 *  short lowercase alphanumeric identifier. Anything else falls back to null so
 *  a malicious or malformed client can't inject arbitrary group labels. */
const LANGUAGE_PATTERN = /^[a-z][a-z0-9\-]{0,31}$/;

export function sanitizeLanguage(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  if (value === "plaintext") return null;
  if (!LANGUAGE_PATTERN.test(value)) return null;
  return value;
}

echoRoute.post("/commits", async (c) => {
  const bucket = c.req.header("x-user-id") ?? c.req.header("x-forwarded-for") ?? "anon";
  if (!checkRateLimit(`commits:${bucket}`)) {
    return c.json({ error: "rate limited" }, 429);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "body must be an object" }, 400);
  }
  const typed = body as { userId?: string; story?: CommitStory };
  const userId = resolveUserId(c, typed.userId);
  const story = typed.story;
  if (
    !story ||
    typeof story.commitSha !== "string" ||
    typeof story.commitTs !== "string" ||
    typeof story.message !== "string"
  ) {
    return c.json({ error: "story payload invalid" }, 400);
  }
  if (story.commitSha.length > 80 || story.message.length > 4000) {
    return c.json({ error: "story payload too large" }, 413);
  }
  await ensureUser(userId);
  await upsertCommitStory({
    userId,
    commitSha: story.commitSha,
    commitTs: story.commitTs,
    message: story.message,
    filesTouched: Array.isArray(story.filesTouched) ? story.filesTouched.slice(0, 200) : [],
    activeMinutes: numeric(story.activeMinutes),
    undoCount: numeric(story.undoCount),
    pasteCount: numeric(story.pasteCount),
    aiAcceptCount: numeric(story.aiAcceptCount),
    peakFocusMin: numeric(story.peakFocusMin),
  });
  return c.json({ ok: true });
});

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Rv5.B — `POST /echo/repo-scan`
 *
 * The extension's workspaceConceptScanner batches concept detections per
 * file and POSTs chunks of up to 50 files here. We validate every path
 * server-side (backend never trusts the extension's claimed
 * workspaceRoot for filesystem access — it's just an index key), drop
 * malformed inputs, and upsert `RepoConceptIndex` rows keyed by
 * (userId, workspaceRoot, concept).
 *
 * fileCount overcounting note: the upsert helper replaces `fileCount`,
 * so we sum the existing row's count plus the distinct-file count in
 * THIS POST. Re-scanning the same workspace will briefly overcount —
 * the widget does not claim perfect file counts and the order-of-
 * magnitude is what matters. Occasional drift is acceptable; the
 * alternative (tracking a set of files-ever-seen per concept) is
 * storage bloat for no user-visible gain.
 */
interface RepoScanBatch {
  file: string;
  language: string | null;
  concepts: string[];
}

function validateRepoScanBatch(
  workspaceRoot: string,
  raw: unknown
): RepoScanBatch | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.file !== "string") return null;
  if (!isSafeBatchFilePath(workspaceRoot, b.file)) return null;
  const language = sanitizeLanguage(b.language);
  if (!Array.isArray(b.concepts)) return null;
  const concepts: string[] = [];
  const seen = new Set<string>();
  for (const c of b.concepts) {
    if (typeof c !== "string") continue;
    if (c.length < 1 || c.length > 200) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    concepts.push(c);
    if (concepts.length >= MAX_CONCEPTS_PER_BATCH) break;
  }
  if (concepts.length === 0) return null;
  return { file: b.file, language, concepts };
}

echoRoute.post("/repo-scan", async (c) => {
  const bucket =
    c.req.header("x-user-id") ?? c.req.header("x-forwarded-for") ?? "anon";
  if (!checkRepoScanRateLimit(`repo-scan:${bucket}`)) {
    return c.json({ error: "rate limited" }, 429);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "body must be an object" }, 400);
  }
  const typed = body as {
    userId?: string;
    workspaceRoot?: unknown;
    batches?: unknown;
  };
  const userId = resolveUserId(c, typed.userId);
  if (typeof typed.workspaceRoot !== "string" || !isSafeWorkspacePath(typed.workspaceRoot)) {
    return c.json({ error: "workspaceRoot missing or malformed" }, 400);
  }
  const workspaceRoot = typed.workspaceRoot;
  const rawBatches = Array.isArray(typed.batches) ? typed.batches : [];
  if (rawBatches.length > MAX_REPO_SCAN_BATCHES_PER_POST) {
    return c.json(
      { error: `max ${MAX_REPO_SCAN_BATCHES_PER_POST} batches per POST` },
      413
    );
  }
  await ensureUser(userId);

  // Aggregate per concept: count distinct files seen in THIS POST, carry
  // the first valid language stamp we encounter for that concept.
  const perConcept = new Map<
    string,
    { files: Set<string>; language: string | null }
  >();
  let fileCount = 0;
  for (const raw of rawBatches) {
    const batch = validateRepoScanBatch(workspaceRoot, raw);
    if (!batch) continue;
    fileCount += 1;
    for (const concept of batch.concepts) {
      const entry = perConcept.get(concept);
      if (entry) {
        entry.files.add(batch.file);
        if (!entry.language && batch.language) entry.language = batch.language;
      } else {
        perConcept.set(concept, {
          files: new Set([batch.file]),
          language: batch.language,
        });
      }
    }
  }

  if (perConcept.size === 0) {
    return c.json({ ok: true, accepted: 0, files: fileCount });
  }

  // Load the existing rows once per POST so we can compute incremental
  // fileCount without doing a read+write round-trip per concept.
  const existingRows = await readRepoConceptIndex(userId, workspaceRoot);
  const existingByConcept = new Map<string, (typeof existingRows)[number]>();
  for (const row of existingRows) existingByConcept.set(row.concept, row);

  const nowIso = new Date().toISOString();
  let accepted = 0;
  for (const [concept, info] of perConcept) {
    const existing = existingByConcept.get(concept);
    // See "fileCount overcounting note" above: we add the POST's distinct
    // file count to whatever the row already stored. Idempotent on a
    // never-before-seen concept; briefly overcounts on repeat scans.
    const fileCountForRow = (existing?.fileCount ?? 0) + info.files.size;
    const firstSeenAt = existing?.firstSeenAt ?? nowIso;
    const language = info.language ?? existing?.language ?? null;
    try {
      await upsertRepoConceptIndex({
        userId,
        workspaceRoot,
        concept,
        language,
        fileCount: fileCountForRow,
        firstSeenAt,
        lastSeenAt: nowIso,
      });
      accepted += 1;
    } catch (err) {
      console.warn("[echo] repo-scan upsert failed:", err);
    }
  }

  return c.json({ ok: true, accepted, files: fileCount });
});

function windowRange(window: EchoWindow): { startMs: number; endMs: number } {
  // Anchor the window to the start of today UTC so the returned span
  // covers an exact number of calendar days:
  //   today → 1 day, week → 7 days, month → 30 days.
  // Using a rolling `now - 24h` spans two UTC dates whenever the user
  // opens the dashboard past midnight UTC, which makes the date axis
  // render one extra day.
  const now = new Date();
  const endMs = now.getTime();
  const todayStartMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const day = 24 * 60 * 60 * 1000;
  switch (window) {
    case "today":
      return { startMs: todayStartMs, endMs };
    case "week":
      return { startMs: todayStartMs - 6 * day, endMs };
    case "month":
      return { startMs: todayStartMs - 29 * day, endMs };
    default:
      return { startMs: todayStartMs, endMs };
  }
}

// Debounce rollup work so a user mashing the window picker doesn't pin
// CPU. The job is idempotent and processes cross-user data, so a single
// global clock is enough. 5s is short enough that live dev feedback
// feels immediate while still preventing a tight refresh loop from burning
// 35 days of aggregation on every click.
const MIN_MAINTENANCE_GAP_MS = 5_000;
let lastRollupAt = 0;

async function safeWidget<T>(
  name: string,
  p: Promise<T | null>
): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    console.warn(`[echo] widget ${name} failed:`, err);
    return null;
  }
}

/**
 * Diagnostic: `GET /echo/debug/recent?since=<ms>&userId=<id>` — returns a
 * snapshot of everything that has changed in the store for `userId` since
 * the given timestamp. The extension's "Show Echo Store Diff" command
 * pretty-prints the result so the user can verify the event →
 * batcher → backend → store pipeline is writing the rows it should.
 *
 * No rate limit: read-only, intended for local debugging only.
 */
/**
 * v6 Rv6.B observability: `GET /echo/sync/stats` — dev-only peek at the
 * shadow-write queue counters (enqueued / succeeded / failed / pending).
 * Read-only; no userId scoping because counters are process-global. Useful
 * for verifying Supabase shadow writes are flowing under load.
 */
echoRoute.get("/sync/stats", (c) => {
  return c.json(getShadowSyncStats());
});

// Diagnostic endpoint — dumps raw rows changed since `since=<ms>` across
// 7+ user-scoped tables. Useful for local debugging of the Echo pipeline,
// but it leaks more raw data than any production endpoint should expose.
// Locked behind a non-production gate: only enabled when NODE_ENV !==
// "production" OR when PROTEGE_DEBUG_ENDPOINTS=1 is explicitly set in the
// Railway dashboard. Keep both legs — the env override is for short-lived
// production debugging windows where you flip the flag, fetch, flip it
// back, without redeploying.
echoRoute.get("/debug/recent", async (c) => {
  const debugAllowed =
    process.env.NODE_ENV !== "production" ||
    process.env.PROTEGE_DEBUG_ENDPOINTS === "1";
  if (!debugAllowed) {
    return c.json({ error: "not_found" }, 404);
  }
  const userId = resolveUserId(c, undefined);
  await ensureUser(userId);
  const rawSince = c.req.query("since");
  const parsed = rawSince !== undefined ? parseInt(rawSince, 10) : NaN;
  const sinceMs =
    Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now() - 5 * 60_000;
  const snapshot = await getRecentChanges(userId, sinceMs);
  return c.json(snapshot);
});

echoRoute.get("/dashboard", async (c) => {
  const window = (c.req.query("window") as EchoWindow) ?? "today";
  if (window !== "today" && window !== "week" && window !== "month") {
    return c.json({ error: "window must be today|week|month" }, 400);
  }
  const userId = resolveUserId(c, undefined);
  await ensureUser(userId);

  // v6 Rv6.C cold-sync — the FIRST dashboard request per user after a
  // cache wipe hydrates the local store from Supabase. Idempotent + gated
  // by `echoBootstrapped` flag so repeat calls are near-free. Parse the
  // workspaceRoot early so repo_concept_index pulls only the active one.
  const rawWorkspaceRootForColdSync = c.req.query("workspaceRoot");
  const workspaceRootForColdSync =
    typeof rawWorkspaceRootForColdSync === "string" &&
    isSafeWorkspacePath(rawWorkspaceRootForColdSync)
      ? rawWorkspaceRootForColdSync
      : null;
  try {
    await pullFromSupabaseIfCold(userId, workspaceRootForColdSync);
  } catch (err) {
    // pullFromSupabaseIfCold catches internally, but belt-and-braces —
    // a cold-sync failure must never 500 the dashboard.
    console.warn("[echo] pullFromSupabaseIfCold (unexpected throw):", err);
  }

  // Only re-run the rollup job if enough time has passed since the last
  // ad-hoc invocation. The scheduled job still runs on its own interval;
  // this gate just keeps per-request work bounded.
  const now = Date.now();
  if (now - lastRollupAt > MIN_MAINTENANCE_GAP_MS) {
    lastRollupAt = now;
    try {
      await runRollupNow();
    } catch (err) {
      console.warn("[echo] rollup before dashboard failed:", err);
    }
  }

  const { startMs: rawStartMs, endMs } = windowRange(window);

  // Clamp windowStart to user's first event so new-user dashboards don't
  // render a wall of empty "before you joined" bars. Also decide whether
  // the prior-window delta is even computable — hide it if the user's
  // history can't cover the prior span.
  const DAY = 24 * 60 * 60 * 1000;
  const firstEventTs = await getFirstEchoEventTs(userId).catch(() => null);
  const requestedSpanMs = endMs - rawStartMs;
  let startMs = rawStartMs;
  let historyDays: number | null = null;
  let priorWindowHidden = false;
  if (firstEventTs !== null) {
    if (firstEventTs > rawStartMs) {
      startMs = firstEventTs;
      // Report whole days of user history, clamped to window length.
      const spanDays = Math.max(1, Math.ceil((endMs - startMs) / DAY));
      const windowDays = Math.max(1, Math.round(requestedSpanMs / DAY));
      historyDays = Math.min(spanDays, windowDays);
    }
    // Prior delta requires a full prior span's worth of history.
    if (firstEventTs > rawStartMs - requestedSpanMs) {
      priorWindowHidden = true;
    }
  } else {
    historyDays = 0;
    priorWindowHidden = true;
  }

  // Rv5.C: the extension passes the active workspace root as a query param
  // so the W17 aggregator can key its RepoConceptIndex lookup. Backend
  // never touches the filesystem with this path — it's a pure index key —
  // but we validate anyway so a malicious caller can't inject weird JSON
  // into the response by poisoning the input.
  const rawWorkspaceRoot = c.req.query("workspaceRoot");
  const workspaceRoot =
    typeof rawWorkspaceRoot === "string" && isSafeWorkspacePath(rawWorkspaceRoot)
      ? rawWorkspaceRoot
      : null;

  // Widget aggregators run in parallel but isolated — a single failure
  // nulls its own payload rather than 500-ing the whole dashboard.
  const [
    heroPayload,
    polarPayload,
    heatmapPayload,
    independencePayload,
    conceptsCoveredPayload,
    repoConceptsPayload,
    conceptsMomentumPayload,
    linesPayload,
    rewrittenPayload,
    commitsPayload,
    saveTapePayload,
    prefs,
  ] = await Promise.all([
    safeWidget("hero", assembleHeroPayload(userId, startMs, endMs)),
    safeWidget("polar", assemblePolarPayload(userId, startMs, endMs)),
    safeWidget("heatmap", assembleHeatmapPayload(userId, startMs, endMs)),
    safeWidget("independence", assembleIndependencePayload(userId, startMs, endMs)),
    safeWidget(
      "conceptsCovered",
      assembleConceptsCoveredPayload(userId, startMs, endMs)
    ),
    safeWidget("repoConcepts", assembleRepoConceptsPayload(userId, workspaceRoot)),
    safeWidget(
      "conceptsMomentum",
      assembleConceptsMomentumPayload(userId, startMs, endMs)
    ),
    safeWidget("lines", assembleLinesPayload(userId, startMs, endMs)),
    safeWidget("rewritten", assembleRewrittenLinePayload(userId, startMs, endMs)),
    safeWidget("commits", assembleCommitStoriesPayload(userId, startMs, endMs)),
    safeWidget("saveTape", assembleSaveTapePayload(userId, startMs, endMs)),
    getEchoPreferences(userId).catch(() => ({ userId, storyModeNotify: false })),
  ]);

  const response: DashboardResponse = {
    window,
    generatedAt: new Date().toISOString(),
    historyDays,
    priorWindowHidden,
    hero: heroPayload,
    polar: polarPayload,
    heatmap: heatmapPayload,
    independence: independencePayload,
    conceptsCovered: conceptsCoveredPayload,
    repoConcepts: repoConceptsPayload,
    conceptsMomentum: conceptsMomentumPayload,
    lines: linesPayload,
    rewrittenLine: rewrittenPayload,
    commits: commitsPayload,
    saveTape: saveTapePayload,
    storyMode: {
      notify: prefs.storyModeNotify,
      nextDrop: null,
    },
  };

  return c.json(response);
});

echoRoute.get("/preferences", async (c) => {
  const userId = resolveUserId(c, undefined);
  await ensureUser(userId);
  const prefs = await getEchoPreferences(userId);
  return c.json({
    preferences: {
      storyModeNotify: prefs.storyModeNotify,
      echoConceptLanguage: prefs.echoConceptLanguage ?? null,
    },
  });
});

echoRoute.post("/preferences", async (c) => {
  const userId = resolveUserId(c, undefined);
  await ensureUser(userId);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "body must be an object" }, 400);
  }
  const typed = body as {
    storyModeNotify?: unknown;
    echoConceptLanguage?: unknown;
  };
  const patch: Partial<{
    storyModeNotify: boolean;
    echoConceptLanguage: string | null;
  }> = {};
  if (typeof typed.storyModeNotify === "boolean") {
    patch.storyModeNotify = typed.storyModeNotify;
  }
  // Accept `null` explicitly as "All languages"; otherwise sanitize via
  // the existing language allow-list so a malicious caller can't set an
  // arbitrary label into the preferences row.
  if (Object.prototype.hasOwnProperty.call(typed, "echoConceptLanguage")) {
    const raw = typed.echoConceptLanguage;
    if (raw === null) {
      patch.echoConceptLanguage = null;
    } else {
      const sanitized = sanitizeLanguage(raw);
      patch.echoConceptLanguage = sanitized;
    }
  }
  const row = await setEchoPreferences(userId, patch);
  return c.json({
    ok: true,
    preferences: {
      storyModeNotify: row.storyModeNotify,
      echoConceptLanguage: row.echoConceptLanguage ?? null,
    },
  });
});

// v5 concept status enum — strict. Rv5.D dropped the v4 (default /
// dismissed / learning) shim because the store is now migrated on boot
// and no deployed panel builds still send the legacy values.
const CONCEPT_STATUS_VALUES = new Set(["unset", "known", "not_known"]);

type ConceptStatusV5 = "unset" | "known" | "not_known";

function isConceptStatusV5(value: string): value is ConceptStatusV5 {
  return CONCEPT_STATUS_VALUES.has(value);
}

echoRoute.post("/concepts/status", async (c) => {
  const bucket =
    c.req.header("x-user-id") ?? c.req.header("x-forwarded-for") ?? "anon";
  if (!checkRateLimit(`concept-status:${bucket}`)) {
    return c.json({ error: "rate limited" }, 429);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "body must be an object" }, 400);
  }
  const typed = body as {
    userId?: unknown;
    concept?: unknown;
    status?: unknown;
  };
  const userId = resolveUserId(
    c,
    typeof typed.userId === "string" ? typed.userId : undefined
  );
  if (
    typeof typed.concept !== "string" ||
    typed.concept.length < 1 ||
    typed.concept.length > 200
  ) {
    return c.json({ error: "concept must be a 1..200 char string" }, 400);
  }
  if (typeof typed.status !== "string" || !isConceptStatusV5(typed.status)) {
    return c.json({ error: "status must be unset|known|not_known" }, 400);
  }
  await ensureUser(userId);
  await setConceptStatus(userId, typed.concept, typed.status);
  return c.json({ ok: true });
});
