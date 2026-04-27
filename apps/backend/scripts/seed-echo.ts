import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import type {
  BehaviorDailyRollupRow,
  CommitStoryRowStore,
  ConceptEncounterRow,
  ConceptState,
  ConceptStatusRow,
  EchoEventRow,
  FileAuthorshipCounterRow,
  LineRewriteCounterRowStore,
  RepoConceptIndexRow,
  UserPreferenceRow,
  UserRow,
} from "../src/store.js";

import { createRng } from "./seed/random.js";
import { generateBehaviorRollups } from "./seed/generators/rollups.js";
import { generateEchoEvents } from "./seed/generators/events.js";
import { generateConcepts } from "./seed/generators/concepts.js";
import { generateFileAuthorship } from "./seed/generators/authorship.js";
import { generateLineRewriteCounters } from "./seed/generators/rewrites.js";
import { generateCommitStories } from "./seed/generators/commits.js";
import { generateRepoConceptIndex } from "./seed/generators/repoIndex.js";
import { generateUserPreferences } from "./seed/generators/preferences.js";

interface CliArgs {
  userId: string;
  workspaceRoot: string;
  seed: number;
  clean: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    userId: "local-dev",
    workspaceRoot: "/tmp/protege-seed-workspace",
    seed: 42,
    clean: false,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--userId=")) args.userId = arg.slice("--userId=".length);
    else if (arg.startsWith("--workspaceRoot="))
      args.workspaceRoot = arg.slice("--workspaceRoot=".length);
    else if (arg.startsWith("--seed=")) {
      const n = Number(arg.slice("--seed=".length));
      if (Number.isFinite(n)) args.seed = n;
    } else if (arg === "--clean") args.clean = true;
    else if (arg === "--dry-run") args.dryRun = true;
  }
  return args;
}

/**
 * Full store shape we read/write. Any table not touched by the seed is
 * passed through untouched so existing rows for other users are preserved.
 */
interface RawStore {
  users?: UserRow[];
  concepts?: ConceptState[];
  files?: unknown[];
  gains?: unknown[];
  chats?: unknown[];
  memories?: unknown[];
  sessions?: unknown[];
  echoEvents?: EchoEventRow[];
  behaviorRollups?: BehaviorDailyRollupRow[];
  lineRewriteCounters?: LineRewriteCounterRowStore[];
  commitStories?: CommitStoryRowStore[];
  userPreferences?: UserPreferenceRow[];
  fileAuthorshipCounters?: FileAuthorshipCounterRow[];
  conceptStatuses?: ConceptStatusRow[];
  conceptEncounters?: ConceptEncounterRow[];
  repoConceptIndex?: RepoConceptIndexRow[];
  [key: string]: unknown;
}

const STORE_PATH = path.join(process.cwd(), ".protege-store.json");

async function readStore(): Promise<RawStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as RawStore;
  } catch {
    return {};
  }
}

async function writeStore(store: RawStore): Promise<void> {
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

/** Drop every row owned by `userId` across every table the seed touches. */
function stripUser(store: RawStore, userId: string): void {
  const userTables: Array<keyof RawStore> = [
    "users",
    "concepts",
    "files",
    "memories",
    "sessions",
    "echoEvents",
    "behaviorRollups",
    "lineRewriteCounters",
    "commitStories",
    "userPreferences",
    "fileAuthorshipCounters",
    "conceptStatuses",
    "conceptEncounters",
    "repoConceptIndex",
  ];
  for (const table of userTables) {
    const rows = store[table];
    if (!Array.isArray(rows)) continue;
    store[table] = rows.filter((r: unknown) => {
      if (!r || typeof r !== "object") return true;
      return (r as { userId?: unknown }).userId !== userId;
    });
  }
}

function makeUserRow(userId: string, nowIso: string): UserRow {
  return {
    userId,
    username: "local-dev",
    createdAt: nowIso,
    unlockedMilestones: [],
    unlockedMilestoneAt: {},
    saveDays: [],
    dailyIq: [],
    longestStreak: 0,
    velocityLog: [],
    pillarSnapshots: [],
    // Skip cold-sync on next dashboard open. The seed has already put
    // rows into the local JSON (and optionally Supabase via --pushCloud),
    // so the first read doesn't need to re-hydrate.
    echoBootstrapped: true,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rng = createRng(args.seed);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const days = 30;

  console.log(
    `[seed-echo] userId=${args.userId} workspaceRoot=${args.workspaceRoot} seed=${args.seed} clean=${args.clean} dryRun=${args.dryRun}`
  );

  const store = await readStore();
  if (args.clean) {
    stripUser(store, args.userId);
    console.log(`[seed-echo] cleaned existing rows for userId=${args.userId}`);
  }

  // ===== Generate =====
  const rollups = generateBehaviorRollups({ userId: args.userId, days, nowMs, rng });
  const events = generateEchoEvents({ userId: args.userId, days, nowMs, rng });
  const concepts = generateConcepts({ userId: args.userId, days, nowMs, rng });
  const authorship = generateFileAuthorship({ userId: args.userId, nowMs, rng });
  const rewrites = generateLineRewriteCounters({ userId: args.userId, nowMs, rng });
  const commits = generateCommitStories({ userId: args.userId, nowMs, rng });
  const repoIndex = generateRepoConceptIndex({
    userId: args.userId,
    workspaceRoot: args.workspaceRoot,
    nowMs,
    rng,
  });
  const prefs = generateUserPreferences({ userId: args.userId });

  const summary: Record<string, number> = {
    users: 1,
    behaviorRollups: rollups.length,
    echoEvents: events.length,
    conceptStates: concepts.states.length,
    conceptStatuses: concepts.statuses.length,
    conceptEncounters: concepts.encounters.length,
    fileAuthorshipCounters: authorship.length,
    lineRewriteCounters: rewrites.length,
    commitStories: commits.length,
    repoConceptIndex: repoIndex.length,
    userPreferences: 1,
  };

  if (args.dryRun) {
    console.log("[seed-echo] --dry-run — skipping writes");
    printSummary(summary);
    return;
  }

  // ===== Merge =====
  // The JSON file is the single source of truth. We cannot go through the
  // store helpers because each one loads a process-local cache, so our
  // final write races against any intermediate helper write. One atomic
  // merge keeps the invariants intact.
  const echoEventRows: EchoEventRow[] = events.map((e) => ({
    id: `seed-${rng.hex(12)}`,
    userId: e.userId,
    type: e.type,
    ts: e.ts,
    file: e.file,
    payload: e.payload,
  }));

  store.users = [...(store.users ?? []), makeUserRow(args.userId, nowIso)];
  store.concepts = [...(store.concepts ?? []), ...concepts.states];
  store.echoEvents = [...(store.echoEvents ?? []), ...echoEventRows];
  store.behaviorRollups = [...(store.behaviorRollups ?? []), ...rollups];
  store.conceptStatuses = [...(store.conceptStatuses ?? []), ...concepts.statuses];
  store.conceptEncounters = [...(store.conceptEncounters ?? []), ...concepts.encounters];
  store.fileAuthorshipCounters = [
    ...(store.fileAuthorshipCounters ?? []),
    ...authorship,
  ];
  store.lineRewriteCounters = [
    ...(store.lineRewriteCounters ?? []),
    ...rewrites,
  ];
  store.commitStories = [...(store.commitStories ?? []), ...commits];
  store.repoConceptIndex = [...(store.repoConceptIndex ?? []), ...repoIndex];
  store.userPreferences = [...(store.userPreferences ?? []), prefs];

  // Baseline every table the store expects so a fresh file stays valid.
  store.files = store.files ?? [];
  store.gains = store.gains ?? [];
  store.chats = store.chats ?? [];
  store.memories = store.memories ?? [];
  store.sessions = store.sessions ?? [];

  await writeStore(store);

  printSummary(summary);
  console.log("[seed-echo] Seeded. Reload Echo to see.");
}

function printSummary(summary: Record<string, number>): void {
  const rows = Object.entries(summary);
  const maxKey = rows.reduce((m, [k]) => Math.max(m, k.length), 0);
  console.log("");
  console.log("[seed-echo] summary");
  for (const [key, count] of rows) {
    console.log(`  ${key.padEnd(maxKey, " ")} ${String(count).padStart(5, " ")}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("[seed-echo] failed:", err);
  process.exit(1);
});
