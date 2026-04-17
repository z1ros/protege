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

/**
 * JSON-file-backed store for MVP. Shape mirrors the Supabase schema we'll
 * swap to later. All IQ math lives in @protege/types/concepts so backend
 * and extension stay in lockstep.
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
  | "context";   // short-term project notes

export interface MemoryRow {
  id: string;
  userId: string;
  type: MemoryType;
  content: string;
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
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

interface StoreShape {
  users: UserRow[];
  concepts: ConceptState[];
  files: FileState[];
  gains: GainEvent[];
  chats: ChatRow[];
  memories: MemoryRow[];
  sessions: SessionRow[];
}

const FILE = path.join(process.cwd(), ".protege-store.json");
let cache: StoreShape | null = null;

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
    };
  }
  return cache;
}

/* ============ Mentor memory (compounding knowledge about the learner) ============ */

const TYPE_WEIGHT: Record<MemoryType, number> = {
  profile: 10,
  preference: 9,
  struggle: 7,
  decision: 5,
  win: 4,
  context: 3,
};

export async function addMemory(
  userId: string,
  type: MemoryType,
  content: string
): Promise<MemoryRow> {
  const s = await load();
  const trimmed = content.trim().slice(0, 500);
  // Dedupe: if an identical entry exists, refresh it instead of duplicating
  const existing = s.memories.find(
    (m) => m.userId === userId && m.type === type && m.content === trimmed
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.lastUsedAt = now;
    existing.useCount += 1;
    await save();
    return existing;
  }
  const row: MemoryRow = {
    id: crypto.randomUUID(),
    userId,
    type,
    content: trimmed,
    createdAt: now,
    lastUsedAt: now,
    useCount: 0,
  };
  s.memories.push(row);
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

export async function getMemorySnapshot(
  userId: string,
  limit = 12
): Promise<MemoryRow[]> {
  const s = await load();
  const mine = s.memories.filter((m) => m.userId === userId);
  // Relevance = type weight + recency boost (days since last used, capped)
  const now = Date.now();
  const scored = mine.map((m) => {
    const ageMs = now - Date.parse(m.lastUsedAt);
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 5 - ageDays * 0.1);
    return { row: m, score: TYPE_WEIGHT[m.type] + recencyBoost + m.useCount * 0.5 };
  });
  scored.sort((a, b) => b.score - a.score);
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

async function save() {
  if (!cache) return;
  await fs.writeFile(FILE, JSON.stringify(cache, null, 2));
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
    });
    await save();
  }
}

/**
 * Get the ISO 8601 week string for a date: "2026-W16".
 * Correctly handles year boundaries: Dec 31 can be W01 of next year,
 * and Jan 1 can be W52/53 of the previous year.
 */
function isoWeek(d: Date): string {
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

/** Raw (pre-bonus) IQ contribution of a single concept row. */
function iqContribution(row: ConceptState): number {
  const w = conceptWeight(row.conceptName);
  const m = masteryCurve(row.timesUsed);
  const d = decayFactor(row.lastUsedAt);
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
    const d = decayFactor(c.lastUsedAt, now);
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

  return {
    user,
    codeIq: pillarIq,
    baseIq: pillars.composite,
    bonusIq,
    totalConcepts: rows.length,
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
