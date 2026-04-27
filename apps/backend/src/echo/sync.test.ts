import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Regression tests for `pullFromSupabaseIfCold` concurrency guard.
 *
 * The store reads `path.join(process.cwd(), ".protege-store.json")` at
 * import time, so we chdir into a fresh tmp dir BEFORE each dynamic import
 * via `vi.resetModules`. This mirrors the pattern in conceptAuthoredFlag.test.ts.
 *
 * We use `vi.doMock` (not hoisted) so local mock instances can be captured
 * per test, then `vi.resetModules()` + dynamic import to get a fresh module.
 */

let originalCwd: string;
let tmpRoot: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpRoot = await mkdtemp(path.join(tmpdir(), "protege-sync-test-"));
  process.chdir(tmpRoot);
});

afterAll(async () => {
  process.chdir(originalCwd);
  try {
    await rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(async () => {
  const tmpCwd = await mkdtemp(path.join(tmpRoot, "case-"));
  process.chdir(tmpCwd);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../supabase.js");
  vi.doUnmock("../store.js");
});

// ---------------------------------------------------------------------------
// T1: Concurrent same-user — cloud reads called exactly once
// ---------------------------------------------------------------------------
describe("T1: concurrent same-userId calls deduplicate cloud reads", () => {
  it("fires each cloudRead* exactly once when 5 concurrent calls share the same userId", async () => {
    // Counterfactual: would fail if there were no in-flight guard — cloudRead* would be called 5 times.

    const cloudReadBehaviorRollups = vi.fn().mockResolvedValue([]);
    const cloudReadCommitStories = vi.fn().mockResolvedValue([]);
    const cloudReadConceptEncounters = vi.fn().mockResolvedValue([]);
    const cloudReadConceptStatuses = vi.fn().mockResolvedValue([]);
    const cloudReadEchoEvents = vi.fn().mockResolvedValue([]);
    const cloudReadFileAuthorshipRows = vi.fn().mockResolvedValue([]);
    const cloudReadLineRewriteCounters = vi.fn().mockResolvedValue([]);
    const cloudReadRepoConceptIndex = vi.fn().mockResolvedValue([]);

    let bootstrapped = false;

    vi.doMock("../supabase.js", () => ({
      isSupabaseEnabled: () => true,
      cloudReadBehaviorRollups,
      cloudReadCommitStories,
      cloudReadConceptEncounters,
      cloudReadConceptStatuses,
      cloudReadEchoEvents,
      cloudReadFileAuthorshipRows,
      cloudReadLineRewriteCounters,
      cloudReadRepoConceptIndex,
    }));

    vi.doMock("../store.js", () => ({
      isEchoBootstrapped: vi.fn(async (_userId: string) => bootstrapped),
      markEchoBootstrapped: vi.fn(async (_userId: string) => {
        bootstrapped = true;
      }),
      appendConceptEncounter: vi.fn().mockResolvedValue(undefined),
      appendEchoEvents: vi.fn().mockResolvedValue(undefined),
      setConceptStatus: vi.fn().mockResolvedValue(undefined),
      setFileAuthorship: vi.fn().mockResolvedValue(undefined),
      upsertBehaviorRollup: vi.fn().mockResolvedValue(undefined),
      upsertCommitStory: vi.fn().mockResolvedValue(undefined),
      upsertLineRewriteCounters: vi.fn().mockResolvedValue(undefined),
      upsertRepoConceptIndex: vi.fn().mockResolvedValue(undefined),
    }));

    const { pullFromSupabaseIfCold } = await import("./sync.js");

    await Promise.all(
      Array.from({ length: 5 }, () =>
        pullFromSupabaseIfCold("userA", "/workspace")
      )
    );

    expect(cloudReadBehaviorRollups).toHaveBeenCalledTimes(1);
    expect(cloudReadCommitStories).toHaveBeenCalledTimes(1);
    expect(cloudReadConceptEncounters).toHaveBeenCalledTimes(1);
    expect(cloudReadConceptStatuses).toHaveBeenCalledTimes(1);
    expect(cloudReadEchoEvents).toHaveBeenCalledTimes(1);
    expect(cloudReadFileAuthorshipRows).toHaveBeenCalledTimes(1);
    expect(cloudReadLineRewriteCounters).toHaveBeenCalledTimes(1);
    expect(cloudReadRepoConceptIndex).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// T2: Concurrent different-user — each user gets its own hydrate
// ---------------------------------------------------------------------------
describe("T2: concurrent different-userId calls each get their own hydrate", () => {
  it("fires each cloudRead* exactly twice when userA and userB both call concurrently", async () => {
    // Counterfactual: would fail if the guard used a boolean instead of a per-user set — userB would be skipped.

    const cloudReadBehaviorRollups = vi.fn().mockResolvedValue([]);
    const cloudReadCommitStories = vi.fn().mockResolvedValue([]);
    const cloudReadConceptEncounters = vi.fn().mockResolvedValue([]);
    const cloudReadConceptStatuses = vi.fn().mockResolvedValue([]);
    const cloudReadEchoEvents = vi.fn().mockResolvedValue([]);
    const cloudReadFileAuthorshipRows = vi.fn().mockResolvedValue([]);
    const cloudReadLineRewriteCounters = vi.fn().mockResolvedValue([]);
    const cloudReadRepoConceptIndex = vi.fn().mockResolvedValue([]);

    const bootstrapped = new Set<string>();

    vi.doMock("../supabase.js", () => ({
      isSupabaseEnabled: () => true,
      cloudReadBehaviorRollups,
      cloudReadCommitStories,
      cloudReadConceptEncounters,
      cloudReadConceptStatuses,
      cloudReadEchoEvents,
      cloudReadFileAuthorshipRows,
      cloudReadLineRewriteCounters,
      cloudReadRepoConceptIndex,
    }));

    vi.doMock("../store.js", () => ({
      isEchoBootstrapped: vi.fn(async (userId: string) =>
        bootstrapped.has(userId)
      ),
      markEchoBootstrapped: vi.fn(async (userId: string) => {
        bootstrapped.add(userId);
      }),
      appendConceptEncounter: vi.fn().mockResolvedValue(undefined),
      appendEchoEvents: vi.fn().mockResolvedValue(undefined),
      setConceptStatus: vi.fn().mockResolvedValue(undefined),
      setFileAuthorship: vi.fn().mockResolvedValue(undefined),
      upsertBehaviorRollup: vi.fn().mockResolvedValue(undefined),
      upsertCommitStory: vi.fn().mockResolvedValue(undefined),
      upsertLineRewriteCounters: vi.fn().mockResolvedValue(undefined),
      upsertRepoConceptIndex: vi.fn().mockResolvedValue(undefined),
    }));

    const { pullFromSupabaseIfCold } = await import("./sync.js");

    await Promise.all([
      pullFromSupabaseIfCold("userA", "/workspace"),
      pullFromSupabaseIfCold("userB", "/workspace"),
    ]);

    expect(cloudReadBehaviorRollups).toHaveBeenCalledTimes(2);
    expect(cloudReadCommitStories).toHaveBeenCalledTimes(2);
    expect(cloudReadConceptEncounters).toHaveBeenCalledTimes(2);
    expect(cloudReadConceptStatuses).toHaveBeenCalledTimes(2);
    expect(cloudReadEchoEvents).toHaveBeenCalledTimes(2);
    expect(cloudReadFileAuthorshipRows).toHaveBeenCalledTimes(2);
    expect(cloudReadLineRewriteCounters).toHaveBeenCalledTimes(2);
    expect(cloudReadRepoConceptIndex).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// T3: Failure case — in-flight marker released on error so next call retries
// ---------------------------------------------------------------------------
describe("T3: in-flight marker released on cloud-read failure", () => {
  it("second call re-invokes cloud reads after first call throws internally", async () => {
    // Counterfactual: would fail if the in-flight marker leaked on throw (no try/finally).

    let callCount = 0;
    const cloudReadBehaviorRollups = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("cloud read failed");
      return [];
    });

    let bootstrapped = false;

    vi.doMock("../supabase.js", () => ({
      isSupabaseEnabled: () => true,
      cloudReadBehaviorRollups,
      cloudReadCommitStories: vi.fn().mockResolvedValue([]),
      cloudReadConceptEncounters: vi.fn().mockResolvedValue([]),
      cloudReadConceptStatuses: vi.fn().mockResolvedValue([]),
      cloudReadEchoEvents: vi.fn().mockResolvedValue([]),
      cloudReadFileAuthorshipRows: vi.fn().mockResolvedValue([]),
      cloudReadLineRewriteCounters: vi.fn().mockResolvedValue([]),
      cloudReadRepoConceptIndex: vi.fn().mockResolvedValue([]),
    }));

    vi.doMock("../store.js", () => ({
      isEchoBootstrapped: vi.fn(async (_userId: string) => bootstrapped),
      markEchoBootstrapped: vi.fn(async (_userId: string) => {
        bootstrapped = true;
      }),
      appendConceptEncounter: vi.fn().mockResolvedValue(undefined),
      appendEchoEvents: vi.fn().mockResolvedValue(undefined),
      setConceptStatus: vi.fn().mockResolvedValue(undefined),
      setFileAuthorship: vi.fn().mockResolvedValue(undefined),
      upsertBehaviorRollup: vi.fn().mockResolvedValue(undefined),
      upsertCommitStory: vi.fn().mockResolvedValue(undefined),
      upsertLineRewriteCounters: vi.fn().mockResolvedValue(undefined),
      upsertRepoConceptIndex: vi.fn().mockResolvedValue(undefined),
    }));

    const { pullFromSupabaseIfCold } = await import("./sync.js");

    // First call — cloudReadBehaviorRollups throws internally; function must not propagate
    await expect(
      pullFromSupabaseIfCold("userA", "/workspace")
    ).resolves.toBeUndefined();

    // Second call — the in-flight guard must have been cleared, so reads run again
    await pullFromSupabaseIfCold("userA", "/workspace");

    expect(cloudReadBehaviorRollups).toHaveBeenCalledTimes(2);
  });
});
