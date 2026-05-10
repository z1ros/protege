import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CLUSTER_LABELS,
  CONCEPT_META,
  IQ_CEILING,
  IQ_K,
  PILLAR_MAX,
  TOTAL_WEIGHT,
  compositeIq,
  computeBreadth,
  computeConsistency,
  computeDepth,
  computeLevel,
  computeQuality,
  computeSynergies,
  computeVelocity,
  conceptCluster,
  conceptWeight,
  decayFactor,
  masteryCurve,
  qualityFactor,
} from "@protege/types";
import type {
  Cluster,
  ClusterSummary,
  ConceptLevel,
  ConceptRow as ApiConceptRow,
  DailyIqPoint,
  GainEvent,
  MilestoneSummary,
  Recommendation,
  StreakInfo,
} from "@protege/types";
import {
  MILESTONES,
  checkMilestones,
  milestoneBonusIq,
  milestoneDefinition,
} from "./milestones.js";
import { computeIqV2 } from "./iqV2.js";

/**
 * JSON-file-backed store for MVP. Shape mirrors the Supabase schema we'll
 * swap to later. All IQ math lives in @protege/types/concepts so backend
 * and extension stay in lockstep.
 *
 * NOTE (2026-05): Code IQ v3 (apps/backend/src/iq3/) is the new IQ
 * engine. Functions in this file marked @deprecated are read-only
 * during the v2→v3 transition and will be removed in a follow-up.
 * The concept-retrieval / memory (RAG) path is preserved.
 */

export interface UserRow {
  userId: string;
  username: string;
  createdAt: string;
  unlockedMilestones: string[];
  unlockedMilestoneAt: Record<string, string>;
  saveDays: string[];         // yyyy-mm-dd, unique + sorted
  dailyIq: DailyIqPoint[];    // last 30 days
  longestStreak: number;
  velocityLog: import("@protege/types").VelocityLogEntry[]; // last 12 weeks
  pillarSnapshots: import("@protege/types").DailyPillarSnapshot[]; // last 7 days
  /** v6 Rv6.C gate — once Supabase has hydrated this user's local cache,
   *  never cold-sync again until the local store is wiped (which resets this
   *  flag to false automatically since the user row has to be recreated).
   *  Absent → treated as false. */
  echoBootstrapped?: boolean;
}

export interface ConceptState {
  userId: string;
  conceptName: string;
  timesUsed: number;
  distinctFiles: string[];
  qualityFlags: number;
  bestContextScore: number; // highest context score seen (1.0-3.0)
  firstSeenAt: string;
  lastUsedAt: string;
  /** Authorship ratio (0..1) for the file where this concept was most
   *  recently detected. 1.0 = fully human-authored, 0.0 = fully AI.
   *  `null` when we have no author signal yet (brand new file, or concept
   *  detected before any keystroke_batch / ai_suggestion_accepted event
   *  arrived for that file). Populated by the /concept-used pipeline. */
  authorshipRatio: number | null;
  /** Sticky flag: once the concept crosses the manual-authorship threshold
   *  in any file ever, it stays true forever. Monotonic — never resets. */
  hasBeenAuthored: boolean;
  /** ISO timestamp set once when hasBeenAuthored first flips true. Stays
   *  at that original value on every subsequent authored detection. */
  firstAuthoredAt: string | null;
  /** Language the concept was first stamped with (e.g. "typescript",
   *  "python"). null when no language is known yet. Sticky — once set to a
   *  non-null value, later detections in other languages do not overwrite. */
  language: string | null;
}

export interface FileState {
  userId: string;
  filePath: string;
  lastHash: string;
  lastSavedAt: string;
  lastErrorCount: number;
}

export interface ChatRow {
  id: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type MemoryType =
  | "profile"    // stable facts about who they are, their stack, goals
  | "struggle"   // recurring pain points, mental-model gaps
  | "win"        // first-time successes, breakthroughs worth remembering
  | "decision"   // architectural choices they made & why
  | "preference" // style preferences: terse/verbose, direct/socratic
  | "context"    // short-term project notes
  | "concept";   // verified mastery — "user owns: [name] — verified [date]"

export interface MemoryRow {
  id: string;
  userId: string;
  type: MemoryType;
  content: string;
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
  /** Embedding of `content` (text-embedding-3-small, 1536 dims). Optional —
   *  rows written before embeddings shipped, or rows where the embedding
   *  call failed, omit it and fall back to non-semantic scoring. Backfilled
   *  lazily when a memory is touched. */
  embedding?: number[];
}

export interface SessionRow {
  userId: string;
  date: string;             // YYYY-MM-DD
  startedAt: string;
  lastActiveAt: string;
  filesTouched: string[];
  conceptsUsed: string[];
  endSummary?: string;      // written by Protege when session closes
}

/* ============ Echo tables (separate from CodeIQ) ============ */

export interface EchoEventRow {
  id: string;
  userId: string;
  type: string;
  ts: number;
  file?: string;
  concept?: string;
  payload: Record<string, unknown>;
}

export interface BehaviorDailyRollupRow {
  userId: string;
  date: string;                               // yyyy-mm-dd
  activeMinutes: number;
  totalMinutes: number;
  sessionsCount: number;
  sessionMinutes: number;
  hourHistogram: number[];
  linesAdded: number;
  linesRemoved: number;
  linesNet: number;
  filesTouched: string[];
  fileHops: number;
  archetypeHint: string | null;
}

export interface LineRewriteCounterRowStore {
  userId: string;
  filePath: string;
  lineFingerprint: string;
  rewriteCount: number;
  lastContent: string;
  lastRewriteAt: string;
}

export interface CommitStoryRowStore {
  userId: string;
  commitSha: string;
  commitTs: string;
  message: string;
  filesTouched: string[];
  activeMinutes: number;
  undoCount: number;
  pasteCount: number;
  aiAcceptCount: number;
  peakFocusMin: number;
}

export interface UserPreferenceRow {
  userId: string;
  storyModeNotify: boolean;
  /** v5 W15/W17 language picker. null === "All languages". Shared by both
   *  concept widgets so a user's chosen language is consistent. */
  echoConceptLanguage?: string | null;
  /** One-shot guard — once the v5 hasBeenAuthored backfill has run for this
   *  user, never run it again. Absence is equivalent to false. */
  backfillDone?: boolean;
}

/* ============ R1 authorship + concept-encounter tables ============ */

/** Per-file running char counters. Incremented on every keystroke_batch
 *  and ai_suggestion_accepted event. `ratio = human / (human + ai)` is a
 *  pure counter, no time inference. Capped at 500 recently-updated files
 *  per user. */
export interface FileAuthorshipCounterRow {
  userId: string;
  filePath: string;
  humanChars: number;
  aiChars: number;
  updatedAt: string;
}

/** User-owned known-state per concept. One row per (userId, concept).
 *  v5 enum: "unset" means no explicit state, "known" means the user has
 *  acknowledged the concept, "not_known" means they've flagged it as not
 *  known yet. Legacy v4 rows are migrated on load via
 *  migrateLegacyConceptStatus. */
export interface ConceptStatusRow {
  userId: string;
  concept: string;
  status: "unset" | "known" | "not_known";
  updatedAt: string;
}

/** File-open / save driven concept sighting. Authorship ratio is stamped
 *  at time of detection so the "In codebase" bucket can distinguish
 *  concepts the user encountered vs. concepts they authored. Deduped by
 *  (userId, concept, filePath, day-of-seenAt) to avoid flooding on
 *  repeated reopens. Capped at 5000 per user. */
export interface ConceptEncounterRow {
  userId: string;
  concept: string;
  filePath: string;
  seenAt: string;
  authorshipRatioAtTime: number | null;
  /** Language of the file at the moment of the encounter (e.g. "typescript").
   *  null when the host didn't resolve a language or sent "plaintext". */
  language: string | null;
}

/** v5 W17 substrate. One row per (userId, workspaceRoot, concept). Populated
 *  by the workspace scanner (Rv5.B) and read by W17. Capped at 10k rows per
 *  user; oldest-lastSeenAt evicted when the cap is exceeded. */
export interface RepoConceptIndexRow {
  userId: string;
  workspaceRoot: string;
  concept: string;
  language: string | null;
  fileCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Rv5.D one-shot migration helper. Collapses legacy v4 ConceptStatus row
 *  values onto the v5 triple. Idempotent: v5 values pass through unchanged;
 *  unknown inputs fall back to "unset" so a corrupt row can't crash boot.
 *
 *  v4 → v5:
 *    "default"   → "unset"
 *    "dismissed" → "not_known"
 *    "learning"  → "known" */
function migrateLegacyConceptStatus(
  status: unknown
): ConceptStatusRow["status"] {
  if (status === "unset" || status === "known" || status === "not_known") {
    return status;
  }
  if (status === "learning") return "known";
  if (status === "dismissed") return "not_known";
  // "default" and every unknown/malformed value fall through here.
  return "unset";
}

interface StoreShape {
  users: UserRow[];
  concepts: ConceptState[];
  files: FileState[];
  gains: GainEvent[];
  chats: ChatRow[];
  memories: MemoryRow[];
  sessions: SessionRow[];
  echoEvents: EchoEventRow[];
  behaviorRollups: BehaviorDailyRollupRow[];
  lineRewriteCounters: LineRewriteCounterRowStore[];
  commitStories: CommitStoryRowStore[];
  userPreferences: UserPreferenceRow[];
  fileAuthorshipCounters: FileAuthorshipCounterRow[];
  conceptStatuses: ConceptStatusRow[];
  conceptEncounters: ConceptEncounterRow[];
  repoConceptIndex: RepoConceptIndexRow[];
}

const FILE = path.join(process.cwd(), ".protege-store.json");
let cache: StoreShape | null = null;

/* ============ v6 shadow-write bridge ============
 *
 * Every durable Echo mutation fires a background write to Supabase after
 * the local persist returns. The bridge uses a dynamic import of the
 * `echo/sync` module so we break the potential cycle (sync.ts imports
 * from store.ts, and store.ts wants `shadowSupabaseWrite`).
 *
 * Failures in the bridge itself are swallowed — the whole point is that
 * shadow writes never slow or fail the local path. */
let _shadowBridge: {
  shadowSupabaseWrite(label: string, fn: () => Promise<void>): void;
} | null = null;
let _shadowBridgePromise: Promise<void> | null = null;

function loadShadowBridge(): void {
  if (_shadowBridge || _shadowBridgePromise) return;
  _shadowBridgePromise = import("./echo/sync.js")
    .then((mod) => {
      _shadowBridge = { shadowSupabaseWrite: mod.shadowSupabaseWrite };
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[protege] shadow-sync bridge load failed:", message);
    });
}

/** Enqueue a fire-and-forget Supabase shadow write. Silently no-ops when
 *  Supabase isn't configured (the bridge itself checks `isSupabaseEnabled`).
 *  Never throws. Never awaited. */
function shadowWrite(label: string, fn: () => Promise<void>): void {
  if (_shadowBridge) {
    _shadowBridge.shadowSupabaseWrite(label, fn);
    return;
  }
  // Bridge not loaded yet — kick off the import and queue the shadow write
  // once resolved. On the first call per process the bridge lands within a
  // microtask so there's effectively zero delay after that.
  loadShadowBridge();
  if (_shadowBridgePromise) {
    _shadowBridgePromise
      .then(() => {
        if (_shadowBridge) _shadowBridge.shadowSupabaseWrite(label, fn);
      })
      .catch(() => {
        // Bridge load failure is already logged above.
      });
  }
}

/** Test-only escape hatch: drop the in-memory cache so the next `load()`
 *  re-reads from disk (or re-initializes from the empty shape if the file
 *  was removed between tests). Not used in production code paths. */
export function __resetStoreCache(): void {
  cache = null;
}

async function load(): Promise<StoreShape> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    cache = {
      users: (parsed.users ?? []).map((u: any) => ({
        userId: u.userId,
        username: u.username ?? "local-dev",
        createdAt: u.createdAt ?? new Date().toISOString(),
        unlockedMilestones: u.unlockedMilestones ?? [],
        unlockedMilestoneAt: u.unlockedMilestoneAt ?? {},
        saveDays: u.saveDays ?? [],
        dailyIq: u.dailyIq ?? [],
        longestStreak: u.longestStreak ?? 0,
        velocityLog: (u as any).velocityLog ?? [],
        pillarSnapshots: (u as any).pillarSnapshots ?? [],
        // v6 Rv6.C: absent flag on existing rows → treated as false so the
        // first dashboard fetch after upgrade triggers a cold-sync.
        echoBootstrapped:
          typeof (u as any).echoBootstrapped === "boolean"
            ? (u as any).echoBootstrapped
            : false,
      })),
      concepts: (parsed.concepts ?? []).map((c: any) => ({
        userId: c.userId,
        conceptName: c.conceptName,
        timesUsed: c.timesUsed ?? 0,
        distinctFiles: Array.isArray(c.distinctFiles) ? c.distinctFiles : [],
        qualityFlags: c.qualityFlags ?? 0,
        bestContextScore: (c as any).bestContextScore ?? 1.0,
        firstSeenAt: c.firstSeenAt ?? c.lastUsedAt ?? new Date().toISOString(),
        lastUsedAt: c.lastUsedAt ?? new Date().toISOString(),
        authorshipRatio:
          typeof (c as any).authorshipRatio === "number"
            ? (c as any).authorshipRatio
            : null,
        hasBeenAuthored: (c as any).hasBeenAuthored === true,
        firstAuthoredAt:
          typeof (c as any).firstAuthoredAt === "string"
            ? (c as any).firstAuthoredAt
            : null,
        language:
          typeof (c as any).language === "string" &&
          (c as any).language.length > 0
            ? (c as any).language
            : null,
      })),
      files: (parsed.files ?? []).map((f: any) => ({
        userId: f.userId,
        filePath: f.filePath,
        lastHash: f.lastHash,
        lastSavedAt: f.lastSavedAt,
        lastErrorCount: f.lastErrorCount ?? 0,
      })),
      gains: parsed.gains ?? [],
      chats: parsed.chats ?? [],
      memories: parsed.memories ?? [],
      sessions: parsed.sessions ?? [],
      echoEvents: parsed.echoEvents ?? [],
      behaviorRollups: (parsed.behaviorRollups ?? []).map((r: any) => ({
        userId: r.userId,
        date: r.date,
        activeMinutes: r.activeMinutes ?? 0,
        totalMinutes: r.totalMinutes ?? 0,
        sessionsCount: r.sessionsCount ?? 0,
        sessionMinutes: r.sessionMinutes ?? 0,
        hourHistogram: Array.isArray(r.hourHistogram) && r.hourHistogram.length === 24
          ? r.hourHistogram
          : new Array(24).fill(0),
        linesAdded: r.linesAdded ?? 0,
        linesRemoved: r.linesRemoved ?? 0,
        linesNet: r.linesNet ?? 0,
        filesTouched: Array.isArray(r.filesTouched) ? r.filesTouched : [],
        fileHops: r.fileHops ?? 0,
        archetypeHint: r.archetypeHint ?? null,
      })),
      lineRewriteCounters: parsed.lineRewriteCounters ?? [],
      commitStories: parsed.commitStories ?? [],
      userPreferences: (parsed.userPreferences ?? []).map((r: any) => {
        // Defensive pickup: only known keys. Legacy `echoConceptFilters`
        // rows on disk are silently dropped (Rv5.D cleanup) — no deployed
        // panels still read them.
        const row: UserPreferenceRow = {
          userId: r.userId,
          storyModeNotify: !!r.storyModeNotify,
        };
        if (typeof r.echoConceptLanguage === "string" || r.echoConceptLanguage === null) {
          row.echoConceptLanguage = r.echoConceptLanguage ?? null;
        }
        if (typeof r.backfillDone === "boolean") {
          row.backfillDone = r.backfillDone;
        }
        return row;
      }),
      fileAuthorshipCounters: (parsed.fileAuthorshipCounters ?? []).map(
        (r: any) => ({
          userId: r.userId,
          filePath: r.filePath,
          humanChars: typeof r.humanChars === "number" ? r.humanChars : 0,
          aiChars: typeof r.aiChars === "number" ? r.aiChars : 0,
          updatedAt: r.updatedAt ?? new Date().toISOString(),
        })
      ),
      conceptStatuses: (parsed.conceptStatuses ?? []).map((r: any) => ({
        userId: r.userId,
        concept: r.concept,
        // Rv5.D one-shot migration: collapse legacy v4 values onto the v5
        // triple. Idempotent — rows already v5 pass through unchanged.
        status: migrateLegacyConceptStatus(r.status),
        updatedAt: r.updatedAt ?? new Date().toISOString(),
      })),
      conceptEncounters: (parsed.conceptEncounters ?? []).map((r: any) => ({
        userId: r.userId,
        concept: r.concept,
        filePath: r.filePath,
        seenAt: r.seenAt,
        authorshipRatioAtTime:
          typeof r.authorshipRatioAtTime === "number"
            ? r.authorshipRatioAtTime
            : null,
        language:
          typeof r.language === "string" && r.language.length > 0
            ? r.language
            : null,
      })),
      repoConceptIndex: ((parsed as any).repoConceptIndex ?? []).map((r: any) => ({
        userId: r.userId,
        workspaceRoot: r.workspaceRoot,
        concept: r.concept,
        language:
          typeof r.language === "string" && r.language.length > 0
            ? r.language
            : null,
        fileCount: typeof r.fileCount === "number" ? r.fileCount : 0,
        firstSeenAt: r.firstSeenAt ?? new Date().toISOString(),
        lastSeenAt: r.lastSeenAt ?? r.firstSeenAt ?? new Date().toISOString(),
      })),
    };
  } catch {
    cache = {
      users: [],
      concepts: [],
      files: [],
      gains: [],
      chats: [],
      memories: [],
      sessions: [],
      echoEvents: [],
      behaviorRollups: [],
      lineRewriteCounters: [],
      commitStories: [],
      userPreferences: [],
      fileAuthorshipCounters: [],
      conceptStatuses: [],
      conceptEncounters: [],
      repoConceptIndex: [],
    };
  }
  return cache;
}

/* ============ Mentor memory (compounding knowledge about the learner) ============ */

/** TYPE_WEIGHT was the sole ranking signal in the legacy snapshot. After the
 *  hybrid (semantic + decay + recency) score landed, type matters far less —
 *  it's only used as a normalized 0..1 tiebreaker. Range collapsed accordingly. */
const TYPE_WEIGHT_RAW: Record<MemoryType, number> = {
  profile: 1.0,
  preference: 0.9,
  // Owned concepts rank high — they directly shape "don't re-teach this"
  // decisions in the teaching loop, so we want them surfaced reliably.
  concept: 0.85,
  struggle: 0.7,
  decision: 0.5,
  win: 0.4,
  context: 0.3,
};

/** FSRS-style hyperbolic recency on memory: same shape as concept decayFactor
 *  but tuned for facts (stability scales with `useCount`). Returns 0..1. */
function memoryRecencyFactor(
  lastUsedAt: string,
  useCount: number,
  nowMs: number
): number {
  const last = Date.parse(lastUsedAt);
  if (Number.isNaN(last)) return 1;
  const days = Math.max(0, (nowMs - last) / 86_400_000);
  const stability = 5 + Math.max(0, useCount) * 1.5;
  return 1 / (1 + days / (9 * stability));
}

/** Reconciliation candidate: similar existing memories returned by the
 *  vector lookup so the LLM merge step (Mem0-style) can decide
 *  ADD/UPDATE/DELETE/NOOP on the incoming content. */
export interface MemoryCandidate {
  row: MemoryRow;
  similarity: number;
}

/** Find top-N existing memories closest to a candidate `content` string.
 *  Used by the write-time reconciliation step in the memory route. */
export async function findSimilarMemories(
  userId: string,
  contentEmbedding: number[],
  topN = 3,
  threshold = 0.78
): Promise<MemoryCandidate[]> {
  const { cosineSimilarity } = await import("./embeddings.js");
  const s = await load();
  const mine = s.memories.filter(
    (m) => m.userId === userId && m.embedding && m.embedding.length > 0
  );
  const scored = mine.map((row) => ({
    row,
    similarity: cosineSimilarity(row.embedding!, contentEmbedding),
  }));
  return scored
    .filter((x) => x.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);
}

export async function addMemory(
  userId: string,
  type: MemoryType,
  content: string
): Promise<MemoryRow> {
  const { embed } = await import("./embeddings.js");
  const s = await load();
  const trimmed = content.trim().slice(0, 500);
  const existing = s.memories.find(
    (m) => m.userId === userId && m.type === type && m.content === trimmed
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.lastUsedAt = now;
    existing.useCount += 1;
    if (!existing.embedding) {
      const e = await embed(trimmed);
      if (e) existing.embedding = e;
    }
    await save();
    return existing;
  }
  const embedding = await embed(trimmed);
  const row: MemoryRow = {
    id: crypto.randomUUID(),
    userId,
    type,
    content: trimmed,
    createdAt: now,
    lastUsedAt: now,
    useCount: 0,
    ...(embedding ? { embedding } : {}),
  };
  s.memories.push(row);
  await save();
  return row;
}

/** Apply a Mem0-style reconciliation decision computed by the route layer.
 *  Keeps store-level invariants (single writer, save-after-mutate) here. */
export async function applyMemoryUpdate(
  userId: string,
  id: string,
  newContent: string
): Promise<MemoryRow | null> {
  const { embed } = await import("./embeddings.js");
  const s = await load();
  const row = s.memories.find((m) => m.userId === userId && m.id === id);
  if (!row) return null;
  const trimmed = newContent.trim().slice(0, 500);
  if (trimmed === row.content) return row;
  row.content = trimmed;
  row.lastUsedAt = new Date().toISOString();
  row.useCount += 1;
  const e = await embed(trimmed);
  if (e) row.embedding = e;
  await save();
  return row;
}

export async function removeMemory(userId: string, id: string): Promise<boolean> {
  const s = await load();
  const before = s.memories.length;
  s.memories = s.memories.filter((m) => !(m.userId === userId && m.id === id));
  if (s.memories.length < before) {
    await save();
    return true;
  }
  return false;
}

/** Legacy snapshot kept for callers that don't have a query (e.g. the GET
 *  /memory listing route). Hybrid score with no semantic term — pure
 *  decay × type-weight × use-count. */
export async function getMemorySnapshot(
  userId: string,
  limit = 12
): Promise<MemoryRow[]> {
  const s = await load();
  const mine = s.memories.filter((m) => m.userId === userId);
  const now = Date.now();
  const scored = mine.map((m) => {
    const recency = memoryRecencyFactor(m.lastUsedAt, m.useCount, now);
    const type = TYPE_WEIGHT_RAW[m.type] ?? 0.5;
    const useFactor = Math.min(1, m.useCount / 10);
    const score = 0.55 * recency + 0.30 * type + 0.15 * useFactor;
    return { row: m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.row);
}

/** Contextual retrieval — Anthropic-style hybrid score over the user's
 *  memory bank given a free-text query (e.g. active file content + last
 *  user turn). Lazy-backfills missing embeddings on the fly so older rows
 *  participate in semantic ranking after a cold start. */
export async function getRelevantMemories(
  userId: string,
  queryText: string,
  limit = 12
): Promise<MemoryRow[]> {
  const { embed, cosineSimilarity } = await import("./embeddings.js");
  const s = await load();
  const mine = s.memories.filter((m) => m.userId === userId);
  if (mine.length === 0) return [];

  const queryEmbedding = await embed(queryText);
  let mutated = false;

  if (queryEmbedding) {
    const stale = mine.filter(
      (m) => !m.embedding || m.embedding.length === 0
    );
    if (stale.length > 0) {
      const { embedMany } = await import("./embeddings.js");
      const fills = await embedMany(stale.map((m) => m.content));
      for (let i = 0; i < stale.length; i++) {
        const e = fills[i];
        if (e) {
          stale[i].embedding = e;
          mutated = true;
        }
      }
    }
  }

  const now = Date.now();
  const scored = mine.map((m) => {
    const recency = memoryRecencyFactor(m.lastUsedAt, m.useCount, now);
    const type = TYPE_WEIGHT_RAW[m.type] ?? 0.5;
    const useFactor = Math.min(1, m.useCount / 10);
    const semantic =
      queryEmbedding && m.embedding && m.embedding.length > 0
        ? Math.max(0, cosineSimilarity(m.embedding, queryEmbedding))
        : 0;
    const score = queryEmbedding
      ? 0.55 * semantic + 0.20 * recency + 0.15 * type + 0.10 * useFactor
      : 0.55 * recency + 0.30 * type + 0.15 * useFactor;
    return { row: m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  if (mutated) await save();
  return scored.slice(0, limit).map((x) => x.row);
}

export async function touchMemoryUsage(userId: string, ids: string[]) {
  const s = await load();
  const now = new Date().toISOString();
  for (const id of ids) {
    const row = s.memories.find((m) => m.userId === userId && m.id === id);
    if (row) {
      row.lastUsedAt = now;
      row.useCount += 1;
    }
  }
  await save();
}

/* ============ Session tracking (morning greeting + continuity) ============ */

function dateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export async function openSession(userId: string): Promise<{
  isFirstToday: boolean;
  lastSession: SessionRow | null;
  session: SessionRow;
}> {
  const s = await load();
  const today = dateKey();
  let session = s.sessions.find((x) => x.userId === userId && x.date === today);
  const now = new Date().toISOString();
  let isFirstToday = false;

  if (!session) {
    isFirstToday = true;
    session = {
      userId,
      date: today,
      startedAt: now,
      lastActiveAt: now,
      filesTouched: [],
      conceptsUsed: [],
    };
    s.sessions.push(session);
    await save();
  } else {
    session.lastActiveAt = now;
    await save();
  }

  const past = s.sessions
    .filter((x) => x.userId === userId && x.date !== today)
    .sort((a, b) => b.date.localeCompare(a.date));
  const lastSession = past[0] ?? null;

  return { isFirstToday, lastSession, session };
}

export async function writeSessionSummary(
  userId: string,
  summary: string
): Promise<void> {
  const s = await load();
  const today = dateKey();
  const session = s.sessions.find(
    (x) => x.userId === userId && x.date === today
  );
  if (session) {
    session.endSummary = summary.slice(0, 500);
    await save();
  }
}

export async function touchSessionFile(userId: string, filePath: string) {
  const s = await load();
  const today = dateKey();
  const session = s.sessions.find(
    (x) => x.userId === userId && x.date === today
  );
  if (session && !session.filesTouched.includes(filePath)) {
    session.filesTouched.push(filePath);
    if (session.filesTouched.length > 30) session.filesTouched.shift();
    await save();
  }
}

let _saveQueue: Promise<void> = Promise.resolve();
let _batchDepth = 0;
let _pendingSaveInBatch = false;

function _flushSave(): Promise<void> {
  if (!cache) return Promise.resolve();
  const c = cache;
  _saveQueue = _saveQueue
    .catch(() => undefined)
    .then(() => fs.writeFile(FILE, JSON.stringify(c, null, 2)));
  return _saveQueue;
}

async function save() {
  if (!cache) return;
  if (_batchDepth > 0) {
    _pendingSaveInBatch = true;
    return;
  }
  await _flushSave();
}

/**
 * Run `fn` with store writes coalesced into a single file write at the end.
 * Nested/concurrent batches are reference-counted — the flush runs when the
 * outermost batch exits. Writes within the batch still mutate the in-memory
 * cache immediately, so subsequent reads inside the batch observe their own
 * writes.
 */
export async function withStoreBatch<T>(fn: () => Promise<T>): Promise<T> {
  _batchDepth += 1;
  try {
    return await fn();
  } finally {
    _batchDepth -= 1;
    if (_batchDepth === 0 && _pendingSaveInBatch) {
      _pendingSaveInBatch = false;
      await _flushSave();
    }
  }
}

export async function ensureUser(userId: string, username = "local-dev") {
  const s = await load();
  if (!s.users.find((u) => u.userId === userId)) {
    s.users.push({
      userId,
      username,
      createdAt: new Date().toISOString(),
      unlockedMilestones: [],
      unlockedMilestoneAt: {},
      saveDays: [],
      dailyIq: [],
      longestStreak: 0,
      velocityLog: [],
      pillarSnapshots: [],
      echoBootstrapped: false,
    });
    await save();
  }
}

/** v6 Rv6.C cold-sync gate — true once Supabase has successfully hydrated
 *  the local cache for this user. Returns false for absent/new users so the
 *  first dashboard request triggers a hydrate. */
export async function isEchoBootstrapped(userId: string): Promise<boolean> {
  const s = await load();
  const row = s.users.find((u) => u.userId === userId);
  return row?.echoBootstrapped === true;
}

/** Flip the Rv6.C cold-sync gate to true. Idempotent — calling on an
 *  already-bootstrapped user is a no-op write. Creates the user row if
 *  missing so this is safe to call without a preceding `ensureUser`. */
export async function markEchoBootstrapped(userId: string): Promise<void> {
  const s = await load();
  let row = s.users.find((u) => u.userId === userId);
  if (!row) {
    row = {
      userId,
      username: "local-dev",
      createdAt: new Date().toISOString(),
      unlockedMilestones: [],
      unlockedMilestoneAt: {},
      saveDays: [],
      dailyIq: [],
      longestStreak: 0,
      velocityLog: [],
      pillarSnapshots: [],
      echoBootstrapped: true,
    };
    s.users.push(row);
    await save();
    return;
  }
  if (row.echoBootstrapped === true) return;
  row.echoBootstrapped = true;
  await save();
}

/**
 * Get the ISO 8601 week string for a date: "2026-W16".
 * Correctly handles year boundaries: Dec 31 can be W01 of next year,
 * and Jan 1 can be W52/53 of the previous year.
 */
export function isoWeek(d: Date): string {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO week starts on Monday. Adjust to nearest Thursday (ISO rule).
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  // The ISO year is the year of the Thursday
  const isoYear = tmp.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(weekNo).padStart(2, "0")}`;
}

function yyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Compute current streak from a sorted array of yyyy-mm-dd strings. */
function computeStreak(saveDays: string[]): StreakInfo {
  if (saveDays.length === 0) {
    return { current: 0, longest: 0, lastSaveDate: null };
  }
  const today = yyyymmdd(new Date());
  const yesterday = yyyymmdd(new Date(Date.now() - 86_400_000));
  const set = new Set(saveDays);
  const last = saveDays[saveDays.length - 1];

  let current = 0;
  if (set.has(today) || set.has(yesterday)) {
    let cursor = set.has(today) ? today : yesterday;
    while (set.has(cursor)) {
      current += 1;
      const d = new Date(cursor + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 1);
      cursor = yyyymmdd(d);
    }
  }

  // Longest streak: scan the sorted unique list.
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of saveDays) {
    if (prev === null) {
      run = 1;
    } else {
      const pd = new Date(prev + "T00:00:00Z");
      pd.setUTCDate(pd.getUTCDate() + 1);
      run = yyyymmdd(pd) === day ? run + 1 : 1;
    }
    if (run > longest) longest = run;
    prev = day;
  }
  return { current, longest: Math.max(longest, current), lastSaveDate: last };
}

/**
 * Check whether the given file's content hash has changed since last save.
 * Returns a small bag: whether content changed, and the drop in error count
 * (so fix-a-finding bonuses can be awarded).
 */
async function touchFile(
  userId: string,
  filePath: string,
  hash: string,
  errorCount: number
): Promise<{ changed: boolean; errorDrop: number }> {
  const s = await load();
  const row = s.files.find(
    (f) => f.userId === userId && f.filePath === filePath
  );
  const now = new Date().toISOString();
  if (!row) {
    s.files.push({
      userId,
      filePath,
      lastHash: hash,
      lastSavedAt: now,
      lastErrorCount: errorCount,
    });
    return { changed: true, errorDrop: 0 };
  }
  if (row.lastHash === hash) {
    row.lastSavedAt = now;
    return { changed: false, errorDrop: 0 };
  }
  const drop = Math.max(0, row.lastErrorCount - errorCount);
  row.lastHash = hash;
  row.lastSavedAt = now;
  row.lastErrorCount = errorCount;
  return { changed: true, errorDrop: drop };
}

export interface RecordOptions {
  filePath: string;
  fileHash: string;
  concepts: string[];
  contextScores?: Record<string, number>; // concept name → 1.0-3.0 context multiplier
  hasErrors: boolean;
  errorCount: number;
}

export interface RecordResult {
  skipped: boolean;
  codeIq: number;
  totalConcepts: number;
  gains: GainEvent[];
}

export async function recordConcepts(
  userId: string,
  opts: RecordOptions
): Promise<RecordResult> {
  const s = await load();
  const { changed, errorDrop } = await touchFile(
    userId,
    opts.filePath,
    opts.fileHash,
    opts.errorCount
  );

  if (!changed) {
    const snap = await getUserSnapshotInternal(userId);
    return {
      skipped: true,
      codeIq: snap.codeIq,
      totalConcepts: snap.totalConcepts,
      gains: [],
    };
  }

  // Snapshot IQ contributions BEFORE mutation so we can compute per-concept deltas.
  const before = new Map<string, number>();
  for (const c of s.concepts.filter((c) => c.userId === userId)) {
    before.set(c.conceptName, iqContribution(c));
  }

  const now = new Date().toISOString();
  const currentWeek = isoWeek(new Date());

  // Velocity tracking: detect new concepts, level-ups, new domains BEFORE mutation
  let newConceptCount = 0;
  let levelUpCount = 0;
  let newDomainCount = 0;
  const existingDomains = new Set(
    s.concepts.filter((c) => c.userId === userId).map((c) => conceptCluster(c.conceptName))
  );

  for (const name of opts.concepts) {
    let row = s.concepts.find(
      (c) => c.userId === userId && c.conceptName === name
    );

    // Detect velocity events BEFORE incrementing
    if (!row) {
      newConceptCount++;
      const domain = conceptCluster(name);
      if (!existingDomains.has(domain)) {
        newDomainCount++;
        existingDomains.add(domain); // don't double-count within this batch
      }
    } else {
      // Detect level-up: mastery tier crossing at times 3 (→Functional), 8 (→Competent), 15 (→Expert)
      const nextTimes = row.timesUsed + 1;
      if (nextTimes === 3 || nextTimes === 8 || nextTimes === 15) {
        levelUpCount++;
      }
    }

    if (!row) {
      row = {
        userId,
        conceptName: name,
        timesUsed: 0,
        distinctFiles: [],
        qualityFlags: 0,
        bestContextScore: 1.0,
        firstSeenAt: now,
        lastUsedAt: now,
        authorshipRatio: null,
        hasBeenAuthored: false,
        firstAuthoredAt: null,
        language: null,
      };
      s.concepts.push(row);
    }
    row.timesUsed += 1;
    row.lastUsedAt = now;
    // Track the highest context score we've ever seen for this concept
    const ctxScore = opts.contextScores?.[name] ?? 1.0;
    if (ctxScore > row.bestContextScore) {
      row.bestContextScore = ctxScore;
    }
    if (!row.distinctFiles.includes(opts.filePath)) {
      row.distinctFiles.push(opts.filePath);
    }
    if (opts.hasErrors) {
      row.qualityFlags = Math.min(row.qualityFlags + 1, 6);
    }
  }

  // Per-concept deltas → gain events
  const gains: GainEvent[] = [];
  const shortFile = path.basename(opts.filePath);
  for (const name of opts.concepts) {
    const row = s.concepts.find(
      (c) => c.userId === userId && c.conceptName === name
    )!;
    const after = iqContribution(row);
    const prior = before.get(name) ?? 0;
    const delta = Math.round(after - prior);
    if (delta !== 0) {
      gains.push({
        concept: name,
        cluster: conceptCluster(name),
        deltaIq: delta,
        file: shortFile,
        ts: now,
        kind: "concept",
      });
    }
  }

  // Fix-a-finding bonus — granted when error count drops between saves.
  if (errorDrop > 0) {
    gains.push({
      concept: `Fixed ${errorDrop} issue${errorDrop === 1 ? "" : "s"}`,
      cluster: "error-handling",
      deltaIq: Math.min(20, errorDrop * 4),
      file: shortFile,
      ts: now,
      kind: "fix",
    });
  }

  // Update user streak & daily snapshot
  const user = s.users.find((u) => u.userId === userId)!;
  const today = yyyymmdd(new Date());
  if (!user.saveDays.includes(today)) {
    user.saveDays.push(today);
    user.saveDays.sort();
  }

  // Compute streak & IQ for milestone context
  const streak = computeStreak(user.saveDays);
  user.longestStreak = Math.max(user.longestStreak, streak.longest);

  // Update velocity log for the current week
  if (newConceptCount > 0 || levelUpCount > 0 || newDomainCount > 0) {
    let weekEntry = user.velocityLog.find((v) => v.week === currentWeek);
    if (!weekEntry) {
      weekEntry = { week: currentWeek, newConcepts: 0, levelUps: 0, newDomains: 0 };
      user.velocityLog.push(weekEntry);
    }
    weekEntry.newConcepts += newConceptCount;
    weekEntry.levelUps += levelUpCount;
    weekEntry.newDomains += newDomainCount;
    // Keep only last 12 weeks
    user.velocityLog.sort((a, b) => a.week.localeCompare(b.week));
    if (user.velocityLog.length > 12) {
      user.velocityLog = user.velocityLog.slice(-12);
    }
  }

  const preliminarySnap = await computeSnapshot(userId, s);

  // Milestone check — uses pre-bonus context
  const ctx = {
    totalConcepts: preliminarySnap.rows.length,
    clustersTouched: new Set(
      preliminarySnap.rows.map((r) => r.cluster)
    ) as Set<Cluster>,
    clustersComplete: new Set(
      preliminarySnap.clusters
        .filter((c) => c.concepts > 0 && c.concepts === c.total)
        .map((c) => c.cluster)
    ) as Set<Cluster>,
    expertCount: preliminarySnap.rows.filter((r) => r.level === "expert").length,
    streakDays: streak.current,
    codeIq: preliminarySnap.codeIq,
  };

  const already = new Set(user.unlockedMilestones);
  const unlocks = checkMilestones(already, ctx);
  for (const u of unlocks) {
    user.unlockedMilestones.push(u.id);
    user.unlockedMilestoneAt[u.id] = u.at;
    gains.push({
      concept: u.title,
      cluster: "language-core", // used only as a tag for styling
      deltaIq: u.bonusIq,
      file: shortFile,
      ts: u.at,
      kind: "milestone",
    });
  }

  // Update today's daily IQ snapshot
  const finalSnap = await computeSnapshot(userId, s);
  const dayEntry = user.dailyIq.find((d) => d.date === today);
  if (dayEntry) {
    if (finalSnap.codeIq > dayEntry.codeIq) dayEntry.codeIq = finalSnap.codeIq;
  } else {
    user.dailyIq.push({ date: today, codeIq: finalSnap.codeIq });
    user.dailyIq.sort((a, b) => a.date.localeCompare(b.date));
    if (user.dailyIq.length > 30) user.dailyIq = user.dailyIq.slice(-30);
  }

  // Push gains to ring buffer (keep last 200)
  s.gains.push(...gains);
  if (s.gains.length > 200) s.gains = s.gains.slice(-200);

  await save();

  // ===== Supabase cloud sync (fire-and-forget) =====
  // Writes to Supabase in the background. If it fails, local JSON
  // already has the data — cloud sync will catch up on next save.
  try {
    const { isSupabaseEnabled, recordCloudConcepts, syncUserStats, recordCloudGain } =
      await import("./supabase.js");
    if (isSupabaseEnabled()) {
      // Sync concepts
      recordCloudConcepts(
        userId,
        opts.concepts,
        opts.contextScores ?? {},
        opts.filePath,
        opts.hasErrors
      ).catch((e) => console.warn("[protege] cloud concept sync failed:", e));

      // Sync user stats
      syncUserStats(userId, {
        codeIq: finalSnap.codeIq,
        longestStreak: user.longestStreak,
        saveDays: user.saveDays,
        dailyIq: user.dailyIq,
        velocityLog: user.velocityLog,
        pillarSnapshots: user.pillarSnapshots,
        unlockedMilestones: user.unlockedMilestones,
        unlockedMilestoneAt: user.unlockedMilestoneAt,
      }).catch((e) => console.warn("[protege] cloud stats sync failed:", e));

      // Sync gain events
      for (const g of gains) {
        recordCloudGain(userId, {
          concept: g.concept,
          cluster: g.cluster,
          deltaIq: g.deltaIq,
          file: g.file,
          kind: g.kind ?? "concept",
        }).catch(() => {});
      }
    }
  } catch {
    // Supabase module not available — silently skip
  }

  return {
    skipped: false,
    codeIq: finalSnap.codeIq,
    totalConcepts: finalSnap.rows.length,
    gains,
  };
}

/** Raw (pre-bonus) IQ contribution of a single concept row.
 *  @deprecated v2 IQ math — superseded by iq3 composite. Retained while
 *  the v2 webview still consumes per-concept iqContribution. */
function iqContribution(row: ConceptState): number {
  const w = conceptWeight(row.conceptName);
  const m = masteryCurve(row.timesUsed);
  const d = decayFactor(row.lastUsedAt, Date.now(), row.timesUsed);
  const q = qualityFactor(row.qualityFlags);
  return w * m * d * q * IQ_K;
}

function levelFor(
  row: ConceptState,
  effectiveMastery: number,
  daysSinceUsed: number
): ConceptLevel {
  if (
    row.timesUsed >= 15 &&
    row.distinctFiles.length >= 3 &&
    daysSinceUsed <= 14 &&
    effectiveMastery >= 0.7
  ) {
    return "expert";
  }
  if (row.timesUsed >= 8 && row.distinctFiles.length >= 2) return "competent";
  if (row.timesUsed >= 3) return "functional";
  return "familiar";
}

interface InternalSnapshot {
  user: UserRow;
  codeIq: number;               // composite + bonus, capped
  baseIq: number;
  bonusIq: number;
  totalConcepts: number;
  rows: ApiConceptRow[];
  clusters: ClusterSummary[];
  recentGains: GainEvent[];
  streak: StreakInfo;
  dailyIq: DailyIqPoint[];
  milestones: MilestoneSummary[];
  recommendations: Recommendation[];
  pillars: import("@protege/types").IqPillars;
  level: import("@protege/types").LevelInfo;
  synergies: import("@protege/types").SynergyResult;
  velocity: import("@protege/types").VelocityInfo;
  breakdown: import("@protege/types").IqBreakdown;
  iqV2: import("@protege/types").IqV2;
}

async function computeSnapshot(
  userId: string,
  s: StoreShape
): Promise<InternalSnapshot> {
  const userConcepts = s.concepts.filter((c) => c.userId === userId);
  const now = Date.now();

  const rows: ApiConceptRow[] = userConcepts.map((c) => {
    const w = conceptWeight(c.conceptName);
    const raw = masteryCurve(c.timesUsed);
    const d = decayFactor(c.lastUsedAt, now, c.timesUsed);
    const q = qualityFactor(c.qualityFlags);
    const effective = raw * d * q;
    const iq = w * effective * IQ_K;
    const daysSinceUsed = Math.max(
      0,
      (now - Date.parse(c.lastUsedAt)) / 86_400_000
    );
    return {
      name: c.conceptName,
      cluster: conceptCluster(c.conceptName),
      weight: w,
      rawMastery: raw,
      mastery: effective,
      timesUsed: c.timesUsed,
      distinctFiles: c.distinctFiles.length,
      iqContribution: Math.round(iq * 10) / 10,
      level: levelFor(c, effective, daysSinceUsed),
      lastUsedAt: c.lastUsedAt,
      daysSinceUsed: Math.round(daysSinceUsed * 10) / 10,
    };
  });

  rows.sort((a, b) => b.iqContribution - a.iqContribution);

  // NOTE: the old MVP single-sum IQ (`rows.reduce(iqContribution)`) is dead.
  // Code IQ is now computed from the five-pillar composite below.

  const user = s.users.find((u) => u.userId === userId)!;
  const bonusIq = milestoneBonusIq(user.unlockedMilestones);

  // Cluster aggregation
  const allClusters = Object.keys(CLUSTER_LABELS) as Cluster[];
  const clusters: ClusterSummary[] = allClusters.map((cl) => {
    const touched = rows.filter((r) => r.cluster === cl);
    const total = CONCEPT_META.filter((m) => m.cluster === cl).length;
    const iq = touched.reduce((sum, r) => sum + r.iqContribution, 0);
    const progress =
      touched.length > 0
        ? touched.reduce((s, r) => s + r.mastery, 0) / touched.length
        : 0;
    return {
      cluster: cl,
      label: CLUSTER_LABELS[cl],
      concepts: touched.length,
      total,
      iq: Math.round(iq),
      progress,
    };
  });

  const streak = computeStreak(user.saveDays);
  const recentGains = s.gains
    .filter(() => true)
    .slice(-12)
    .reverse();

  // Milestone summaries
  const unlockedSet = new Set(user.unlockedMilestones);
  const milestones: MilestoneSummary[] = MILESTONES.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    bonusIq: m.bonusIq,
    unlocked: unlockedSet.has(m.id),
    unlockedAt: user.unlockedMilestoneAt[m.id] ?? null,
  }));

  // Recommendations: for each cluster the user has touched, find the
  // highest-weight concept they HAVEN'T touched yet.
  const touchedNames = new Set(rows.map((r) => r.name));
  const touchedClusters = new Set(
    rows.map((r) => r.cluster)
  ) as Set<Cluster>;
  const recommendations: Recommendation[] = [];
  for (const cl of touchedClusters) {
    const candidates = CONCEPT_META.filter(
      (m) => m.cluster === cl && !touchedNames.has(m.name)
    ).sort((a, b) => b.weight - a.weight);
    const pick = candidates[0];
    if (pick) {
      recommendations.push({
        concept: pick.name,
        cluster: cl,
        weight: pick.weight,
        reason: `You're active in ${CLUSTER_LABELS[cl]} — try this next.`,
      });
    }
  }
  // Also suggest one untouched cluster if user has ≥3 concepts already.
  if (rows.length >= 3) {
    const untouchedClusters = allClusters.filter(
      (cl) => !touchedClusters.has(cl)
    );
    for (const cl of untouchedClusters.slice(0, 1)) {
      const pick = CONCEPT_META.filter((m) => m.cluster === cl).sort(
        (a, b) => a.weight - b.weight
      )[0];
      if (pick) {
        recommendations.push({
          concept: pick.name,
          cluster: cl,
          weight: pick.weight,
          reason: `Branch out into ${CLUSTER_LABELS[cl]}.`,
        });
      }
    }
  }
  const topRecs = recommendations.slice(0, 4);

  // ===== Five-Pillar IQ computation =====
  // Build depth input — multiply weight by best context score.
  // A useState(0) with contextScore 1.0 gets weight × 1. A custom hook
  // composing 4 hooks with types + tests gets weight × 3. This makes the
  // Depth pillar reflect HOW you use skills, not just IF.
  const depthInput: import("@protege/types").DepthInput[] = rows.map((r) => {
    const conceptState = userConcepts.find((c) => c.conceptName === r.name);
    const ctxMul = conceptState?.bestContextScore ?? 1.0;
    return {
      mastery: r.mastery,
      weight: r.weight * ctxMul, // context score amplifies the weight
      timesUsed: r.timesUsed,
      distinctFiles: r.distinctFiles,
      daysSinceUsed: r.daysSinceUsed,
    };
  });

  // Domain counts for breadth
  const domainCounts = new Map<string, number>();
  for (const r of rows) {
    domainCounts.set(r.cluster, (domainCounts.get(r.cluster) ?? 0) + 1);
  }

  // Velocity: compute from the real velocity log (not approximations)
  const vLog = user.velocityLog;
  const currentWeekKey = isoWeek(new Date());
  const thisWeekEntry = vLog.find((v) => v.week === currentWeekKey) ?? {
    week: currentWeekKey,
    newConcepts: 0,
    levelUps: 0,
    newDomains: 0,
  };
  // Trailing 4-week averages — ALWAYS divide by 4, not by actual weeks.
  // This prevents a user's first week (10 concepts) from showing as
  // "10/week average" when the real average over 4 weeks is 2.5.
  const last4Weeks = vLog.slice(-4);
  const avgNewConcepts = last4Weeks.reduce((s, w) => s + w.newConcepts, 0) / 4;
  const avgLevelUps = last4Weeks.reduce((s, w) => s + w.levelUps, 0) / 4;
  const avgNewDomains = last4Weeks.reduce((s, w) => s + w.newDomains, 0) / 4;
  const streakMul = Math.min(1.5, 1 + streak.current / 30);

  const velocityInfo: import("@protege/types").VelocityInfo = {
    avgNewConceptsPerWeek: Math.round(avgNewConcepts * 10) / 10,
    avgLevelUpsPerWeek: Math.round(avgLevelUps * 10) / 10,
    avgNewDomainsPerWeek: Math.round(avgNewDomains * 10) / 10,
    thisWeek: thisWeekEntry,
    recentWeeks: vLog.slice(-12),
    streakMultiplier: Math.round(streakMul * 100) / 100,
  };

  // Consistency: count save days in last 30 days
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);
  const saveDaysLast30 = user.saveDays.filter((d) => d >= thirtyDaysAgoStr).length;
  // Decay-resistant skills: skills with >14 days old that still have decent mastery
  const decayResistant = rows.filter(
    (r) => r.daysSinceUsed > 14 && r.mastery > 0.4
  ).length;

  // Quality: compute from recent file states
  const userFiles = s.files.filter((f) => f.userId === userId);
  const totalSaves = Math.max(1, userFiles.length);
  const cleanSaves = userFiles.filter((f) => f.lastErrorCount === 0).length;
  const cleanSaveRate = cleanSaves / totalSaves;
  // Fix rate: approximate from gains (fix-kind gains / total error files)
  const fixGains = s.gains.filter(
    (g) => g.kind === "fix"
  ).length;
  const errorFiles = userFiles.filter((f) => f.lastErrorCount > 0).length;
  const fixRate = errorFiles > 0 ? Math.min(1, fixGains / errorFiles) : 1;
  // Bug density: total errors / approximate total lines (rough estimate)
  const totalErrors = userFiles.reduce((s, f) => s + f.lastErrorCount, 0);
  const bugDensity = totalSaves > 0 ? totalErrors / (totalSaves * 50) : 0; // assume ~50 lines per file avg
  // Recurring bugs: simplified — if >3 error files, there are recurring patterns
  const recurringBugCount = Math.max(0, errorFiles - 3);

  const depthScore = computeDepth(depthInput);
  // Compute synergies — cross-domain bonus + gap penalties
  const synergies = computeSynergies(domainCounts);
  const rawBreadth = computeBreadth(domainCounts, allClusters.length);
  // Apply synergy multiplier × penalty to breadth score
  const breadthScore = Math.min(
    PILLAR_MAX.breadth,
    Math.round(rawBreadth * synergies.multiplier * synergies.penalty)
  );
  const velocityScore = computeVelocity({
    newConceptsPerWeek: avgNewConcepts,
    levelUpsPerMonth: avgLevelUps * 4, // convert weekly avg to monthly
    streakDays: streak.current,
  });
  const consistencyScore = computeConsistency({
    streakCurrent: streak.current,
    streakLongest: streak.longest,
    saveDaysLast30,
    decayResistantSkills: decayResistant,
  });
  const qualityScore = computeQuality({
    cleanSaveRate,
    fixRate,
    bugDensity,
    recurringBugCount,
  });

  const pillars: import("@protege/types").IqPillars = {
    depth: {
      id: "depth",
      label: "Depth",
      score: depthScore,
      max: PILLAR_MAX.depth,
      delta: 0, // TODO: compare with yesterday's snapshot
      explanation: rows.length > 0
        ? `${rows.filter((r) => r.mastery >= 0.7).length} expert-level skills across ${rows.length} detected`
        : "Save a file to start building depth",
    },
    breadth: {
      id: "breadth",
      label: "Breadth",
      score: breadthScore,
      max: PILLAR_MAX.breadth,
      delta: 0,
      explanation: `${[...domainCounts.values()].filter((c) => c >= 3).length} domains · ${synergies.active.length} synergies${synergies.gaps.length > 0 ? ` · ${synergies.gaps.length} gap${synergies.gaps.length > 1 ? "s" : ""}` : ""}`,
    },
    velocity: {
      id: "velocity",
      label: "Velocity",
      score: velocityScore,
      max: PILLAR_MAX.velocity,
      delta: 0,
      explanation: `${avgNewConcepts.toFixed(1)} concepts/wk avg, ${thisWeekEntry.newConcepts} this week, ${streakMul.toFixed(2)}× streak`,
    },
    consistency: {
      id: "consistency",
      label: "Consistency",
      score: consistencyScore,
      max: PILLAR_MAX.consistency,
      delta: 0,
      explanation: `${streak.current}-day streak, coded ${saveDaysLast30}/30 days`,
    },
    quality: {
      id: "quality",
      label: "Quality",
      score: qualityScore,
      max: PILLAR_MAX.quality,
      delta: 0,
      explanation: `${Math.round(cleanSaveRate * 100)}% clean saves, ${Math.round(fixRate * 100)}% fix rate`,
    },
    composite: 0, // computed below
  };
  pillars.composite = compositeIq(pillars);

  // Override codeIq with the five-pillar composite + milestone bonus
  const pillarIq = Math.min(IQ_CEILING, pillars.composite + bonusIq);

  // ===== Engineering Level computation =====
  const expertSkillCount = rows.filter((r) => r.mastery >= 0.7 && r.distinctFiles >= 3 && r.daysSinceUsed <= 14).length;
  const detectedDomainCount = [...domainCounts.keys()].length;

  const level = computeLevel(
    pillars.composite,
    pillars,
    expertSkillCount,
    detectedDomainCount,
    streak.current,
    rows.length
  );

  // ===== Daily IQ Breakdown — "where did my points come from?" =====
  const todayStr = yyyymmdd(new Date());
  const todaySnapshot: import("@protege/types").DailyPillarSnapshot = {
    date: todayStr,
    depth: depthScore,
    breadth: breadthScore,
    velocity: velocityScore,
    consistency: consistencyScore,
    quality: qualityScore,
    composite: pillars.composite,
  };

  // Find yesterday's snapshot for delta computation
  const yesterdayStr = yyyymmdd(new Date(Date.now() - 86_400_000));
  const yesterdaySnap = user.pillarSnapshots.find((s) => s.date === yesterdayStr) ?? null;

  const deltas = {
    depth: yesterdaySnap ? depthScore - yesterdaySnap.depth : 0,
    breadth: yesterdaySnap ? breadthScore - yesterdaySnap.breadth : 0,
    velocity: yesterdaySnap ? velocityScore - yesterdaySnap.velocity : 0,
    consistency: yesterdaySnap ? consistencyScore - yesterdaySnap.consistency : 0,
    quality: yesterdaySnap ? qualityScore - yesterdaySnap.quality : 0,
    composite: yesterdaySnap ? pillars.composite - yesterdaySnap.composite : 0,
  };

  // Update pillar explanations with deltas
  pillars.depth.delta = deltas.depth;
  pillars.breadth.delta = deltas.breadth;
  pillars.velocity.delta = deltas.velocity;
  pillars.consistency.delta = deltas.consistency;
  pillars.quality.delta = deltas.quality;

  // Top gain: the pillar with the biggest positive delta
  const pillarDeltas = [
    { name: "Depth", d: deltas.depth, score: depthScore, max: PILLAR_MAX.depth },
    { name: "Breadth", d: deltas.breadth, score: breadthScore, max: PILLAR_MAX.breadth },
    { name: "Velocity", d: deltas.velocity, score: velocityScore, max: PILLAR_MAX.velocity },
    { name: "Consistency", d: deltas.consistency, score: consistencyScore, max: PILLAR_MAX.consistency },
    { name: "Quality", d: deltas.quality, score: qualityScore, max: PILLAR_MAX.quality },
  ];
  const topGainPillar = pillarDeltas.filter((p) => p.d > 0).sort((a, b) => b.d - a.d)[0];
  const topLossPillar = pillarDeltas.filter((p) => p.d < 0).sort((a, b) => a.d - b.d)[0];
  let topGain = topGainPillar ? `${topGainPillar.name} +${topGainPillar.d} (${topGainPillar.score}/${topGainPillar.max})` : null;
  // If no gain but there IS a loss, surface the loss instead
  if (!topGain && topLossPillar) {
    topGain = `${topLossPillar.name} ${topLossPillar.d} — skills decaying or consistency dropping`;
  }

  // Biggest gap: the pillar with the lowest score relative to its max
  const weakest = [...pillarDeltas].sort((a, b) => (a.score / a.max) - (b.score / b.max))[0];
  let biggestGap: string | null = null;
  if (weakest && weakest.score < weakest.max * 0.5) {
    biggestGap = `${weakest.name} is your weakest area at ${weakest.score}/${weakest.max}`;
    // If this pillar also went DOWN, emphasize the decline
    if (weakest.d < 0) {
      biggestGap += ` (dropped ${Math.abs(weakest.d)} since yesterday)`;
    }
  }

  // Suggestion: actionable advice based on the gap
  let suggestion: string | null = null;
  if (weakest) {
    if (weakest.name === "Quality" && qualityScore < 80) {
      suggestion = "Fix the recurring findings in your recent files — each clean save pushes Quality up fast";
    } else if (weakest.name === "Breadth" && breadthScore < 80) {
      suggestion = "Try writing code in a new domain this week — even a small script in Python or a CSS layout counts";
    } else if (weakest.name === "Velocity" && velocityScore < 60) {
      suggestion = "Learn one new concept today — your velocity is below average and a single new skill moves the needle";
    } else if (weakest.name === "Consistency" && consistencyScore < 60) {
      suggestion = "Code every day, even for 10 minutes — streaks compound your Consistency score exponentially";
    } else if (weakest.name === "Depth" && depthScore < 100) {
      suggestion = "Use your existing skills in more files and with TypeScript types — depth rewards sophisticated usage";
    }
  }

  const breakdown: import("@protege/types").IqBreakdown = {
    today: todaySnapshot,
    yesterday: yesterdaySnap,
    deltas,
    topGain,
    biggestGap,
    suggestion,
  };

  // Persist today's snapshot (overwrite if already exists, keep last 7 days)
  const existingIdx = user.pillarSnapshots.findIndex((ps) => ps.date === todayStr);
  if (existingIdx >= 0) {
    user.pillarSnapshots[existingIdx] = todaySnapshot;
  } else {
    user.pillarSnapshots.push(todaySnapshot);
  }
  if (user.pillarSnapshots.length > 7) {
    user.pillarSnapshots = user.pillarSnapshots.slice(-7);
  }

  // ---- Code IQ v2 — computed in parallel with v1 during the transition ----
  const iqV2 = computeIqV2({
    user,
    rows,
    clusters,
    synergies,
    velocity: velocityInfo,
    streak,
    gains: recentGains,
    nowMs: now,
  });

  // totalConcepts is displayed as `X / RULE_COUNT` in the webview, so
  // the numerator must only count concepts the current rule set knows
  // about. `rows` can include orphan names from prior taxonomy versions
  // (renamed/removed concepts that still exist on the user record),
  // which used to push the numerator above the denominator (e.g. 44/41).
  const ruleSetNames = new Set(CONCEPT_META.map((m) => m.name));
  const totalConceptsInRuleset = rows.filter((r) => ruleSetNames.has(r.name)).length;

  return {
    user,
    codeIq: pillarIq,
    baseIq: pillars.composite,
    bonusIq,
    totalConcepts: totalConceptsInRuleset,
    rows,
    clusters,
    recentGains,
    streak,
    dailyIq: user.dailyIq.slice(),
    milestones,
    recommendations: topRecs,
    pillars,
    level,
    synergies,
    velocity: velocityInfo,
    breakdown,
    iqV2,
  };
}

async function getUserSnapshotInternal(
  userId: string
): Promise<InternalSnapshot> {
  const s = await load();
  return computeSnapshot(userId, s);
}

export async function getUserSnapshot(userId: string) {
  return getUserSnapshotInternal(userId);
}

export const RULE_COUNT = CONCEPT_META.length;
/** @deprecated v2 IQ ceiling — iq3 uses 0–1000 rank scale via iq3/rank. */
export const MAX_IQ = IQ_CEILING;
export const TOTAL_CONCEPT_WEIGHT = TOTAL_WEIGHT;

export async function appendChat(
  userId: string,
  role: "user" | "assistant",
  content: string
) {
  const s = await load();
  s.chats.push({
    id: crypto.randomUUID(),
    userId,
    role,
    content,
    createdAt: new Date().toISOString(),
  });
  await save();
}

export async function getRecentChat(userId: string, limit = 20) {
  const s = await load();
  return s.chats.filter((c) => c.userId === userId).slice(-limit);
}

/* ============ Echo — persistence helpers ============ */

// Events older than this are purged on the next write so the JSON file
// doesn't grow unbounded. The nightly rollup consumes raw events and the
// dashboard reads only the last 30 days.
const ECHO_EVENT_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const ECHO_MAX_EVENTS_PER_USER = 50_000;

export interface EchoEventInput {
  userId: string;
  type: string;
  ts: number;
  file?: string;
  concept?: string;
  payload: Record<string, unknown>;
  // Stable client-side dedup id. Optional on emit (locally generated when
  // omitted). On cold-sync replay the caller MUST supply the id read from
  // Supabase so the local row matches the cloud row 1:1 — that's what
  // lets the upsert-with-conflict-key on the cloud side dedupe correctly.
  id?: string;
}

export async function appendEchoEvents(events: EchoEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const s = await load();
  const now = Date.now();
  // Assign id ONCE per input event so the local row, the shadow-write
  // snapshot, and any later cold-sync round-trip all share the same
  // client_event_id. Generating a fresh id at each call site would
  // break post-restart idempotency.
  const stamped = events.map((e) => ({
    ...e,
    id: e.id ?? crypto.randomUUID(),
  }));
  for (const e of stamped) {
    s.echoEvents.push({
      id: e.id,
      userId: e.userId,
      type: e.type,
      ts: e.ts,
      file: e.file,
      concept: e.concept,
      payload: e.payload,
    });
  }
  // Retention sweep + per-user cap.
  const cutoff = now - ECHO_EVENT_RETENTION_MS;
  s.echoEvents = s.echoEvents.filter((e) => e.ts >= cutoff);
  const perUser = new Map<string, EchoEventRow[]>();
  for (const e of s.echoEvents) {
    const bucket = perUser.get(e.userId);
    if (bucket) bucket.push(e);
    else perUser.set(e.userId, [e]);
  }
  const trimmed: EchoEventRow[] = [];
  for (const [, bucket] of perUser) {
    bucket.sort((a, b) => a.ts - b.ts);
    const kept = bucket.length > ECHO_MAX_EVENTS_PER_USER
      ? bucket.slice(bucket.length - ECHO_MAX_EVENTS_PER_USER)
      : bucket;
    trimmed.push(...kept);
  }
  s.echoEvents = trimmed;
  await save();

  // v6 shadow-write — fire-and-forget batch per user. We coalesce the input
  // `events` array (which may contain multiple userIds) into one Supabase
  // insert per user so a big mixed batch isn't N lonely round-trips.
  const byUser = new Map<string, typeof stamped>();
  for (const e of stamped) {
    const bucket = byUser.get(e.userId);
    if (bucket) bucket.push(e);
    else byUser.set(e.userId, [e]);
  }
  for (const [uid, batch] of byUser) {
    const snapshot = batch.map((e) => ({
      clientEventId: e.id,
      type: e.type,
      ts: e.ts,
      file: e.file,
      payload: e.payload,
    }));
    shadowWrite("appendEchoEvents", async () => {
      const { cloudAppendEchoEvents } = await import("./supabase.js");
      await cloudAppendEchoEvents(uid, snapshot);
    });
  }

  return events.length;
}

export async function readEchoEvents(
  userId: string,
  sinceMs: number,
  untilMs: number = Date.now()
): Promise<EchoEventRow[]> {
  const s = await load();
  return s.echoEvents.filter(
    (e) => e.userId === userId && e.ts >= sinceMs && e.ts <= untilMs
  );
}

export async function listEchoUsers(sinceMs: number): Promise<string[]> {
  const s = await load();
  const seen = new Set<string>();
  for (const e of s.echoEvents) {
    if (e.ts >= sinceMs) seen.add(e.userId);
  }
  return [...seen];
}

/** Earliest EchoEvent timestamp for a user, or null if they have none.
 *  Used to clamp dashboard windows so new users don't see a sea of
 *  empty "days before you joined" bars. */
export async function getFirstEchoEventTs(
  userId: string
): Promise<number | null> {
  const s = await load();
  let min: number | null = null;
  for (const e of s.echoEvents) {
    if (e.userId !== userId) continue;
    if (min === null || e.ts < min) min = e.ts;
  }
  return min;
}

export async function upsertBehaviorRollup(row: BehaviorDailyRollupRow): Promise<void> {
  const s = await load();
  const idx = s.behaviorRollups.findIndex(
    (r) => r.userId === row.userId && r.date === row.date
  );
  if (idx >= 0) s.behaviorRollups[idx] = row;
  else s.behaviorRollups.push(row);
  // Keep last 120 rollups per user to cap size.
  const perUser = new Map<string, BehaviorDailyRollupRow[]>();
  for (const r of s.behaviorRollups) {
    const bucket = perUser.get(r.userId);
    if (bucket) bucket.push(r);
    else perUser.set(r.userId, [r]);
  }
  const trimmed: BehaviorDailyRollupRow[] = [];
  for (const [, bucket] of perUser) {
    bucket.sort((a, b) => a.date.localeCompare(b.date));
    trimmed.push(...bucket.slice(-120));
  }
  s.behaviorRollups = trimmed;
  await save();

  // v6 shadow-write — upsert the single row we just wrote. Cap enforcement
  // is handled cloud-side by a retention cron (see v6 plan), not here.
  const snapshot: BehaviorDailyRollupRow = { ...row };
  shadowWrite("upsertBehaviorRollup", async () => {
    const { cloudUpsertBehaviorRollup } = await import("./supabase.js");
    await cloudUpsertBehaviorRollup({
      userId: snapshot.userId,
      date: snapshot.date,
      activeMinutes: snapshot.activeMinutes,
      totalMinutes: snapshot.totalMinutes,
      sessionsCount: snapshot.sessionsCount,
      sessionMinutes: snapshot.sessionMinutes,
      hourHistogram: snapshot.hourHistogram,
      linesAdded: snapshot.linesAdded,
      linesRemoved: snapshot.linesRemoved,
      linesNet: snapshot.linesNet,
      filesTouched: snapshot.filesTouched,
      fileHops: snapshot.fileHops,
      archetypeHint: snapshot.archetypeHint,
    });
  });
}

export async function readBehaviorRollups(
  userId: string,
  startDate: string,
  endDate: string
): Promise<BehaviorDailyRollupRow[]> {
  const s = await load();
  return s.behaviorRollups
    .filter((r) => r.userId === userId && r.date >= startDate && r.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function upsertLineRewriteCounters(
  userId: string,
  filePath: string,
  touches: Array<{ fingerprint: string; sampleContent: string; ts: number }>
): Promise<void> {
  if (touches.length === 0) return;
  const s = await load();
  for (const t of touches) {
    const row = s.lineRewriteCounters.find(
      (r) =>
        r.userId === userId &&
        r.filePath === filePath &&
        r.lineFingerprint === t.fingerprint
    );
    if (row) {
      row.rewriteCount += 1;
      row.lastContent = t.sampleContent;
      row.lastRewriteAt = new Date(t.ts).toISOString();
    } else {
      s.lineRewriteCounters.push({
        userId,
        filePath,
        lineFingerprint: t.fingerprint,
        rewriteCount: 1,
        lastContent: t.sampleContent,
        lastRewriteAt: new Date(t.ts).toISOString(),
      });
    }
  }
  await save();

  // v6 shadow-write — ship the same per-touch list to Supabase. The cloud
  // helper handles read-then-upsert semantics so the cloud count matches
  // the local count once flushed.
  const snapshot = touches.map((t) => ({ ...t }));
  shadowWrite("upsertLineRewriteCounters", async () => {
    const { cloudUpsertLineRewriteCounters } = await import("./supabase.js");
    await cloudUpsertLineRewriteCounters(userId, filePath, snapshot);
  });
}

export async function topLineRewrite(
  userId: string,
  sinceMs: number
): Promise<LineRewriteCounterRowStore | null> {
  const s = await load();
  const cutoff = new Date(sinceMs).toISOString();
  const mine = s.lineRewriteCounters.filter(
    (r) => r.userId === userId && r.lastRewriteAt >= cutoff
  );
  if (mine.length === 0) return null;
  mine.sort((a, b) => b.rewriteCount - a.rewriteCount);
  return mine[0];
}

export async function upsertCommitStory(row: CommitStoryRowStore): Promise<void> {
  const s = await load();
  const idx = s.commitStories.findIndex(
    (r) => r.userId === row.userId && r.commitSha === row.commitSha
  );
  if (idx >= 0) s.commitStories[idx] = row;
  else s.commitStories.push(row);
  // Cap per user at 200 commits.
  const perUser = s.commitStories.filter((r) => r.userId === row.userId);
  if (perUser.length > 200) {
    perUser.sort((a, b) => a.commitTs.localeCompare(b.commitTs));
    const drop = new Set(perUser.slice(0, perUser.length - 200).map((r) => r.commitSha));
    s.commitStories = s.commitStories.filter(
      (r) => !(r.userId === row.userId && drop.has(r.commitSha))
    );
  }
  await save();

  // v6 shadow-write — upsert keyed by (user_id, commit_sha).
  const snapshot: CommitStoryRowStore = { ...row };
  shadowWrite("upsertCommitStory", async () => {
    const { cloudUpsertCommitStory } = await import("./supabase.js");
    await cloudUpsertCommitStory({
      userId: snapshot.userId,
      commitSha: snapshot.commitSha,
      commitTs: snapshot.commitTs,
      message: snapshot.message,
      activeMinutes: snapshot.activeMinutes,
      undoCount: snapshot.undoCount,
      pasteCount: snapshot.pasteCount,
      aiAcceptCount: snapshot.aiAcceptCount,
      filesTouched: snapshot.filesTouched,
      peakFocusMin: snapshot.peakFocusMin,
    });
  });
}

export async function readCommitStories(
  userId: string,
  sinceMs: number,
  untilMs: number = Date.now()
): Promise<CommitStoryRowStore[]> {
  const s = await load();
  const since = new Date(sinceMs).toISOString();
  const until = new Date(untilMs).toISOString();
  return s.commitStories
    .filter((r) => r.userId === userId && r.commitTs >= since && r.commitTs <= until)
    .sort((a, b) => b.commitTs.localeCompare(a.commitTs));
}

/** Read all ConceptState rows for a user. W1/W15/W16 read directly. */
export async function readConceptStates(userId: string): Promise<ConceptState[]> {
  const s = await load();
  return s.concepts.filter((c) => c.userId === userId);
}

/** Heuristic mastery filter for the Did-You-Know tip selector. A concept is
 *  treated as "likely known" when any of these signals fire — usage volume,
 *  authorship (manual write across the threshold), or breadth across files.
 *  Conservative on purpose: tips are aimed at *new* concepts, so a single
 *  positive signal is enough to suppress one. Keep these constants colocated
 *  with the heuristic so the policy lives in one place. */
const MASTERY_TIMES_USED = 5;
const MASTERY_DISTINCT_FILES = 2;

export async function readLikelyKnownConcepts(userId: string): Promise<string[]> {
  const states = await readConceptStates(userId);
  return states
    .filter(
      (c) =>
        c.timesUsed >= MASTERY_TIMES_USED ||
        c.hasBeenAuthored ||
        c.distinctFiles.length >= MASTERY_DISTINCT_FILES
    )
    .map((c) => c.conceptName);
}

/** Read recent GainEvents across all users. The global ring buffer has no
 *  userId field, so callers filter client-side by concept name. */
export async function readRecentGains(limit = 200): Promise<GainEvent[]> {
  const s = await load();
  return s.gains.slice(-limit);
}

/** Read EchoEvent rows of a specific type for a user across the given
 *  window. Used by widget aggregators that key off a single event kind. */
export async function readEchoEventsByType(
  userId: string,
  type: string,
  sinceMs: number,
  untilMs: number = Date.now()
): Promise<EchoEventRow[]> {
  const s = await load();
  return s.echoEvents.filter(
    (e) => e.userId === userId && e.type === type && e.ts >= sinceMs && e.ts <= untilMs
  );
}

export async function getEchoPreferences(userId: string): Promise<UserPreferenceRow> {
  const s = await load();
  const row = s.userPreferences.find((r) => r.userId === userId);
  return row ?? { userId, storyModeNotify: false };
}

export async function setEchoPreferences(
  userId: string,
  patch: Partial<Omit<UserPreferenceRow, "userId">>
): Promise<UserPreferenceRow> {
  const s = await load();
  let row = s.userPreferences.find((r) => r.userId === userId);
  if (!row) {
    row = { userId, storyModeNotify: false };
    s.userPreferences.push(row);
  }
  if (typeof patch.storyModeNotify === "boolean") {
    row.storyModeNotify = patch.storyModeNotify;
  }
  // echoConceptLanguage may be explicitly set to null ("All languages"),
  // so check for property presence rather than truthiness.
  if (
    Object.prototype.hasOwnProperty.call(patch, "echoConceptLanguage")
  ) {
    const next = patch.echoConceptLanguage;
    if (next === null || (typeof next === "string" && next.length > 0)) {
      row.echoConceptLanguage = next;
    }
  }
  if (typeof patch.backfillDone === "boolean") {
    row.backfillDone = patch.backfillDone;
  }
  await save();
  return row;
}

/* ============ R1 authorship + encounter helpers ============ */

const MAX_FILE_AUTHORSHIP_ROWS_PER_USER = 500;
const MAX_CONCEPT_ENCOUNTERS_PER_USER = 5000;

/** Increment per-file human/ai char counters. One call per event batch.
 *  Either field may be 0 when the caller only has one side to bump. */
export async function bumpFileAuthorship(
  userId: string,
  filePath: string,
  delta: { humanChars: number; aiChars: number }
): Promise<void> {
  if (!filePath) return;
  const h = Math.max(0, Number.isFinite(delta.humanChars) ? delta.humanChars : 0);
  const a = Math.max(0, Number.isFinite(delta.aiChars) ? delta.aiChars : 0);
  if (h === 0 && a === 0) return;
  const s = await load();
  const now = new Date().toISOString();
  let row = s.fileAuthorshipCounters.find(
    (r) => r.userId === userId && r.filePath === filePath
  );
  if (!row) {
    row = {
      userId,
      filePath,
      humanChars: 0,
      aiChars: 0,
      updatedAt: now,
    };
    s.fileAuthorshipCounters.push(row);
  }
  row.humanChars += h;
  row.aiChars += a;
  row.updatedAt = now;

  // Cap per user inline — only inspect this user's rows, not all users'.
  const userRows = s.fileAuthorshipCounters.filter((r) => r.userId === userId);
  if (userRows.length > MAX_FILE_AUTHORSHIP_ROWS_PER_USER) {
    userRows.sort((x, y) => x.updatedAt.localeCompare(y.updatedAt));
    const dropCount = userRows.length - MAX_FILE_AUTHORSHIP_ROWS_PER_USER;
    const drop = new Set<string>();
    for (let i = 0; i < dropCount; i += 1) drop.add(userRows[i].filePath);
    s.fileAuthorshipCounters = s.fileAuthorshipCounters.filter(
      (r) => r.userId !== userId || !drop.has(r.filePath)
    );
  }
  await save();

  // v6 shadow-write — delta bump. Cloud helper does read-then-upsert to
  // stay consistent with local's increment semantics.
  shadowWrite("bumpFileAuthorship", async () => {
    const { cloudBumpFileAuthorship } = await import("./supabase.js");
    await cloudBumpFileAuthorship(userId, filePath, h, a);
  });
}

/** v6 Rv6.C absolute setter — used by cold-sync to replay the cloud's
 *  authoritative counts into the local store without double-counting via
 *  the delta-incrementer. Guards against double-hydration: if the local
 *  row already matches (or exceeds, somehow) the cloud values, no-op. */
export async function setFileAuthorship(
  userId: string,
  filePath: string,
  humanChars: number,
  aiChars: number,
  updatedAt: string
): Promise<void> {
  if (!filePath) return;
  const h = Math.max(0, Number.isFinite(humanChars) ? Math.floor(humanChars) : 0);
  const a = Math.max(0, Number.isFinite(aiChars) ? Math.floor(aiChars) : 0);
  const s = await load();
  let row = s.fileAuthorshipCounters.find(
    (r) => r.userId === userId && r.filePath === filePath
  );
  if (!row) {
    row = {
      userId,
      filePath,
      humanChars: h,
      aiChars: a,
      updatedAt: updatedAt || new Date().toISOString(),
    };
    s.fileAuthorshipCounters.push(row);
  } else {
    // Double-hydration guard: prefer the larger side (cloud or local). If the
    // local row has already accumulated writes past the cloud value (e.g.
    // bootstrap ran late after a keystroke landed), keep the local value.
    row.humanChars = Math.max(row.humanChars, h);
    row.aiChars = Math.max(row.aiChars, a);
    row.updatedAt = updatedAt || row.updatedAt;
  }
  await save();
}

export async function readFileAuthorship(
  userId: string,
  filePath: string
): Promise<FileAuthorshipCounterRow | undefined> {
  const s = await load();
  return s.fileAuthorshipCounters.find(
    (r) => r.userId === userId && r.filePath === filePath
  );
}

/** Read all authorship counter rows for a user. W1 Hero's `manualPct`
 *  aggregates human/ai chars across every file touched within the window
 *  (caller filters by `updatedAt`). */
export async function readFileAuthorshipRows(
  userId: string
): Promise<FileAuthorshipCounterRow[]> {
  const s = await load();
  return s.fileAuthorshipCounters.filter((r) => r.userId === userId);
}

/** Pure math for the authorship ratio. Split out so both `getAuthorshipRatio`
 *  and unit tests can share the same numerator/denominator handling. Returns
 *  null when the inputs are unusable (non-finite, or total ≤ 0 after clamping
 *  negatives to 0). Otherwise returns humanChars / total in [0,1]. */
export function computeAuthorshipRatio(
  humanChars: number,
  aiChars: number
): number | null {
  if (!Number.isFinite(humanChars) || !Number.isFinite(aiChars)) return null;
  const h = humanChars < 0 ? 0 : humanChars;
  const a = aiChars < 0 ? 0 : aiChars;
  const total = h + a;
  if (total <= 0) return null;
  return h / total;
}

/** Read the authorship ratio in-memory without touching disk more than
 *  necessary. Returns null when the file has no counters yet (so callers
 *  can bucket those concepts as "In codebase"). */
export async function getAuthorshipRatio(
  userId: string,
  filePath: string
): Promise<number | null> {
  const row = await readFileAuthorship(userId, filePath);
  if (!row) return null;
  return computeAuthorshipRatio(row.humanChars, row.aiChars);
}

export async function setConceptStatus(
  userId: string,
  concept: string,
  status: ConceptStatusRow["status"]
): Promise<ConceptStatusRow> {
  const s = await load();
  const now = new Date().toISOString();
  let row = s.conceptStatuses.find(
    (r) => r.userId === userId && r.concept === concept
  );
  if (!row) {
    row = { userId, concept, status, updatedAt: now };
    s.conceptStatuses.push(row);
  } else {
    row.status = status;
    row.updatedAt = now;
  }
  await save();

  // v6 shadow-write — upsert keyed by (user_id, concept).
  shadowWrite("setConceptStatus", async () => {
    const { cloudSetConceptStatus } = await import("./supabase.js");
    await cloudSetConceptStatus(userId, concept, status);
  });

  return row;
}

export async function readConceptStatuses(
  userId: string
): Promise<ConceptStatusRow[]> {
  const s = await load();
  return s.conceptStatuses.filter((r) => r.userId === userId);
}

/** Append a ConceptEncounter, deduping by (userId, concept, filePath,
 *  day-of-seenAt). Repeated reopens on the same day won't create duplicate
 *  rows — but a sighting the next day will. */
export async function appendConceptEncounter(
  row: ConceptEncounterRow
): Promise<boolean> {
  if (!row.concept || !row.filePath) return false;
  const s = await load();
  const day = row.seenAt.slice(0, 10); // yyyy-mm-dd from ISO string
  const dup = s.conceptEncounters.find(
    (r) =>
      r.userId === row.userId &&
      r.concept === row.concept &&
      r.filePath === row.filePath &&
      r.seenAt.slice(0, 10) === day
  );
  if (dup) return false;
  s.conceptEncounters.push(row);

  // Cap per user — keep the 5000 most recent by seenAt.
  const perUser = new Map<string, ConceptEncounterRow[]>();
  for (const r of s.conceptEncounters) {
    const bucket = perUser.get(r.userId);
    if (bucket) bucket.push(r);
    else perUser.set(r.userId, [r]);
  }
  const kept: ConceptEncounterRow[] = [];
  for (const [, bucket] of perUser) {
    if (bucket.length > MAX_CONCEPT_ENCOUNTERS_PER_USER) {
      bucket.sort((x, y) => x.seenAt.localeCompare(y.seenAt));
      kept.push(
        ...bucket.slice(bucket.length - MAX_CONCEPT_ENCOUNTERS_PER_USER)
      );
    } else {
      kept.push(...bucket);
    }
  }
  s.conceptEncounters = kept;
  await save();

  // v6 shadow-write — insert the one encounter we just persisted. Dedup
  // against same-day sightings is enforced locally above; cloud cron
  // handles the 5000-per-user cap.
  const snapshot: ConceptEncounterRow = { ...row };
  shadowWrite("appendConceptEncounter", async () => {
    const { cloudAppendConceptEncounter } = await import("./supabase.js");
    await cloudAppendConceptEncounter({
      userId: snapshot.userId,
      concept: snapshot.concept,
      filePath: snapshot.filePath,
      language: snapshot.language,
      seenAt: snapshot.seenAt,
      authorshipRatioAtTime: snapshot.authorshipRatioAtTime,
    });
  });

  return true;
}

export async function readConceptEncounters(
  userId: string,
  sinceMs: number,
  untilMs: number = Date.now()
): Promise<ConceptEncounterRow[]> {
  const s = await load();
  const since = new Date(sinceMs).toISOString();
  const until = new Date(untilMs).toISOString();
  return s.conceptEncounters.filter(
    (r) => r.userId === userId && r.seenAt >= since && r.seenAt <= until
  );
}

/** Set authorshipRatio on a user's ConceptState row. No-op if the concept
 *  hasn't been recorded yet (recordConcepts creates the row before this
 *  is called in the /concept-used flow). */
export async function setConceptAuthorshipRatio(
  userId: string,
  conceptName: string,
  ratio: number | null
): Promise<void> {
  const s = await load();
  const row = s.concepts.find(
    (c) => c.userId === userId && c.conceptName === conceptName
  );
  if (!row) return;
  row.authorshipRatio = ratio;
  await save();

  // v6 shadow-write — targeted patch on the sticky Rv5 columns only.
  // Using `cloudPatchConceptExtras` (not `recordCloudConcepts`) so we don't
  // bump `times_used` every time an AI-accept / keystroke flips the ratio.
  shadowWrite("setConceptAuthorshipRatio", async () => {
    const { cloudPatchConceptExtras } = await import("./supabase.js");
    await cloudPatchConceptExtras(userId, conceptName, {
      authorshipRatio: ratio,
    });
  });
}

/** Monotonic setter: once hasBeenAuthored is true for a concept, this
 *  function never flips it back, and never overwrites firstAuthoredAt.
 *  Invariant: `hasBeenAuthored` is append-only true; this is the ONLY
 *  writer, and it never sets false. */
export async function setConceptAuthoredFlag(
  userId: string,
  conceptName: string,
  authoredAt: string
): Promise<void> {
  const s = await load();
  const row = s.concepts.find(
    (c) => c.userId === userId && c.conceptName === conceptName
  );
  if (!row) return;
  if (row.hasBeenAuthored) return;
  row.hasBeenAuthored = true;
  row.firstAuthoredAt = authoredAt;
  await save();

  // v6 shadow-write — monotonic flip to true + stamp firstAuthoredAt. The
  // cloud helper respects the same stickiness (no true→false, no overwrite
  // of the first timestamp).
  shadowWrite("setConceptAuthoredFlag", async () => {
    const { cloudPatchConceptExtras } = await import("./supabase.js");
    await cloudPatchConceptExtras(userId, conceptName, {
      hasBeenAuthored: true,
      firstAuthoredAt: authoredAt,
    });
  });
}

/** Stamp the language onto a ConceptState row. Sticky — only overwrites
 *  a null language. Once a language is set, later detections in another
 *  language don't flip it. */
export async function setConceptLanguage(
  userId: string,
  conceptName: string,
  language: string | null
): Promise<void> {
  if (!language) return;
  const s = await load();
  const row = s.concepts.find(
    (c) => c.userId === userId && c.conceptName === conceptName
  );
  if (!row) return;
  if (row.language) return;
  row.language = language;
  await save();

  // v6 shadow-write — sticky language column patch. Cloud helper only
  // writes when the Postgres column is still null, mirroring local semantics.
  shadowWrite("setConceptLanguage", async () => {
    const { cloudPatchConceptExtras } = await import("./supabase.js");
    await cloudPatchConceptExtras(userId, conceptName, { language });
  });
}

const MAX_REPO_CONCEPT_INDEX_PER_USER = 10_000;

/** Upsert a RepoConceptIndex row keyed by (userId, workspaceRoot, concept).
 *  Caller passes the authoritative fileCount for that concept in that
 *  workspace — we replace, not increment. `firstSeenAt` is preserved on
 *  existing rows; `lastSeenAt` advances to the new value. LRU-evicts by
 *  `lastSeenAt` when the per-user cap is exceeded. */
export async function upsertRepoConceptIndex(
  row: RepoConceptIndexRow
): Promise<void> {
  if (!row.userId || !row.workspaceRoot || !row.concept) return;
  const s = await load();
  const existing = s.repoConceptIndex.find(
    (r) =>
      r.userId === row.userId &&
      r.workspaceRoot === row.workspaceRoot &&
      r.concept === row.concept
  );
  if (existing) {
    existing.language = row.language ?? existing.language ?? null;
    existing.fileCount = Math.max(0, row.fileCount);
    existing.lastSeenAt = row.lastSeenAt;
    // firstSeenAt preserved
  } else {
    s.repoConceptIndex.push({
      userId: row.userId,
      workspaceRoot: row.workspaceRoot,
      concept: row.concept,
      language: row.language ?? null,
      fileCount: Math.max(0, row.fileCount),
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    });
  }

  // LRU cap per user.
  const perUser = new Map<string, RepoConceptIndexRow[]>();
  for (const r of s.repoConceptIndex) {
    const bucket = perUser.get(r.userId);
    if (bucket) bucket.push(r);
    else perUser.set(r.userId, [r]);
  }
  const kept: RepoConceptIndexRow[] = [];
  for (const [, bucket] of perUser) {
    if (bucket.length > MAX_REPO_CONCEPT_INDEX_PER_USER) {
      bucket.sort((x, y) => x.lastSeenAt.localeCompare(y.lastSeenAt));
      kept.push(
        ...bucket.slice(bucket.length - MAX_REPO_CONCEPT_INDEX_PER_USER)
      );
    } else {
      kept.push(...bucket);
    }
  }
  s.repoConceptIndex = kept;
  await save();

  // v6 shadow-write — upsert keyed by (user_id, workspace_root, concept).
  const snapshot: RepoConceptIndexRow = { ...row };
  shadowWrite("upsertRepoConceptIndex", async () => {
    const { cloudUpsertRepoConceptIndex } = await import("./supabase.js");
    await cloudUpsertRepoConceptIndex({
      userId: snapshot.userId,
      workspaceRoot: snapshot.workspaceRoot,
      concept: snapshot.concept,
      language: snapshot.language ?? null,
      fileCount: Math.max(0, snapshot.fileCount),
      firstSeenAt: snapshot.firstSeenAt,
      lastSeenAt: snapshot.lastSeenAt,
    });
  });
}

/** Read every RepoConceptIndex row for a user + workspace. */
export async function readRepoConceptIndex(
  userId: string,
  workspaceRoot: string
): Promise<RepoConceptIndexRow[]> {
  const s = await load();
  return s.repoConceptIndex.filter(
    (r) => r.userId === userId && r.workspaceRoot === workspaceRoot
  );
}

/** Diagnostic snapshot — returns everything that has changed in the
 *  store for a user since `sinceMs`. Used by the `/echo/debug/recent`
 *  inspector endpoint so the extension can verify data is flowing from
 *  event → store correctly. Read-only; never modifies state. */
export interface RecentChangesSnapshot {
  since: string;
  now: string;
  echoEvents: Array<{
    ts: number;
    type: string;
    file: string | undefined;
    payload: Record<string, unknown>;
  }>;
  echoEventsByType: Record<string, number>;
  fileAuthorshipCounters: Array<{
    filePath: string;
    humanChars: number;
    aiChars: number;
    updatedAt: string;
  }>;
  conceptStates: Array<{
    conceptName: string;
    timesUsed: number;
    authorshipRatio: number | null;
    hasBeenAuthored: boolean;
    lastUsedAt: string;
    firstAuthoredAt: string | null;
  }>;
  conceptEncounters: Array<{
    concept: string;
    filePath: string;
    seenAt: string;
    authorshipRatioAtTime: number | null;
  }>;
  behaviorRollups: Array<{
    date: string;
    activeMinutes: number;
    linesAdded: number;
    linesRemoved: number;
    archetypeHint: string | null;
  }>;
  commitStories: Array<{
    commitSha: string;
    commitTs: string;
    message: string;
  }>;
  conceptStatuses: Array<{
    concept: string;
    status: ConceptStatusRow["status"];
    updatedAt: string;
  }>;
}

export async function getRecentChanges(
  userId: string,
  sinceMs: number
): Promise<RecentChangesSnapshot> {
  const s = await load();
  const nowMs = Date.now();
  const sinceIso = new Date(sinceMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  // ----- echoEvents: cap at 100 most recent by ts desc -----
  const recentEvents = s.echoEvents
    .filter((e) => e.userId === userId && e.ts >= sinceMs)
    .sort((a, b) => b.ts - a.ts);
  const echoEventsTrimmed = recentEvents.slice(0, 100).map((e) => ({
    ts: e.ts,
    type: e.type,
    file: e.file,
    payload: e.payload,
  }));
  const echoEventsByType: Record<string, number> = {};
  for (const e of recentEvents) {
    echoEventsByType[e.type] = (echoEventsByType[e.type] ?? 0) + 1;
  }

  // ----- fileAuthorshipCounters: rows updated since -----
  const fileAuthorshipCounters = s.fileAuthorshipCounters
    .filter((r) => r.userId === userId && r.updatedAt >= sinceIso)
    .map((r) => ({
      filePath: r.filePath,
      humanChars: r.humanChars,
      aiChars: r.aiChars,
      updatedAt: r.updatedAt,
    }));

  // ----- conceptStates: rows with lastUsedAt >= since OR firstAuthoredAt >= since -----
  const conceptStates = s.concepts
    .filter((c) => {
      if (c.userId !== userId) return false;
      if (c.lastUsedAt && c.lastUsedAt >= sinceIso) return true;
      if (c.firstAuthoredAt && c.firstAuthoredAt >= sinceIso) return true;
      return false;
    })
    .map((c) => ({
      conceptName: c.conceptName,
      timesUsed: c.timesUsed,
      authorshipRatio: c.authorshipRatio,
      hasBeenAuthored: c.hasBeenAuthored,
      lastUsedAt: c.lastUsedAt,
      firstAuthoredAt: c.firstAuthoredAt,
    }));

  // ----- conceptEncounters: rows with seenAt >= since, cap 100 by seenAt desc -----
  const recentEncounters = s.conceptEncounters
    .filter((r) => r.userId === userId && r.seenAt >= sinceIso)
    .sort((a, b) => b.seenAt.localeCompare(a.seenAt));
  const conceptEncounters = recentEncounters.slice(0, 100).map((r) => ({
    concept: r.concept,
    filePath: r.filePath,
    seenAt: r.seenAt,
    authorshipRatioAtTime: r.authorshipRatioAtTime,
  }));

  // ----- behaviorRollups: today's date or within 2 days of since -----
  const todayDate = new Date(nowMs).toISOString().slice(0, 10);
  const sinceMinus2Days = new Date(sinceMs - 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const behaviorRollups = s.behaviorRollups
    .filter(
      (r) =>
        r.userId === userId &&
        (r.date === todayDate || r.date >= sinceMinus2Days)
    )
    .map((r) => ({
      date: r.date,
      activeMinutes: r.activeMinutes,
      linesAdded: r.linesAdded,
      linesRemoved: r.linesRemoved,
      archetypeHint: r.archetypeHint,
    }));

  // ----- commitStories: rows with commitTs >= since -----
  const commitStories = s.commitStories
    .filter((r) => r.userId === userId && r.commitTs >= sinceIso)
    .map((r) => ({
      commitSha: r.commitSha,
      commitTs: r.commitTs,
      message: r.message,
    }));

  // ----- conceptStatuses: rows with updatedAt >= since -----
  const conceptStatuses = s.conceptStatuses
    .filter((r) => r.userId === userId && r.updatedAt >= sinceIso)
    .map((r) => ({
      concept: r.concept,
      status: r.status,
      updatedAt: r.updatedAt,
    }));

  return {
    since: sinceIso,
    now: nowIso,
    echoEvents: echoEventsTrimmed,
    echoEventsByType,
    fileAuthorshipCounters,
    conceptStates,
    conceptEncounters,
    behaviorRollups,
    commitStories,
    conceptStatuses,
  };
}

/* ==========================================================
   concept_tips — generalized "Did you know?" tip cache.
   ----------------------------------------------------------
   User-agnostic: rows are keyed by (language, concept_name,
   prompt_version). Lookups + writes go through Supabase
   directly; there is no local-store fallback because the
   whole point is global sharing. When Supabase is not
   configured, both helpers no-op.
   ========================================================== */

export interface ConceptTipRow {
  tip: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export async function getConceptTips(
  language: string,
  concepts: string[],
  promptVersion: number
): Promise<Record<string, string>> {
  if (concepts.length === 0) return {};
  const { getSupabase } = await import("./supabase.js");
  const sb = getSupabase();
  if (!sb) return {};

  const { data, error } = await sb
    .from("concept_tips")
    .select("concept_name, tip")
    .eq("language", language)
    .eq("prompt_version", promptVersion)
    .in("concept_name", concepts);

  if (error) {
    console.warn("[protege] getConceptTips failed:", error.message);
    return {};
  }
  if (!data) return {};

  const out: Record<string, string> = {};
  for (const r of data) {
    const row = r as { concept_name: string; tip: string };
    out[row.concept_name] = row.tip;
  }
  return out;
}

export async function putConceptTips(
  language: string,
  promptVersion: number,
  rows: Record<string, ConceptTipRow>
): Promise<void> {
  const entries = Object.entries(rows);
  if (entries.length === 0) return;

  const { getSupabase } = await import("./supabase.js");
  const sb = getSupabase();
  if (!sb) return;

  const payload = entries.map(([concept_name, r]) => ({
    language,
    concept_name,
    prompt_version: promptVersion,
    tip: r.tip,
    model: r.model,
    tokens_in: r.tokensIn,
    tokens_out: r.tokensOut,
  }));

  // Idempotent write: a concurrent first-time view of the same concept
  // collides on the unique index and we silently skip — first writer wins,
  // every other writer's row is discarded without an error.
  const { error } = await sb
    .from("concept_tips")
    .upsert(payload, {
      onConflict: "language,concept_name,prompt_version",
      ignoreDuplicates: true,
    });
  if (error) {
    console.warn("[protege] putConceptTips failed:", error.message);
  }
}
