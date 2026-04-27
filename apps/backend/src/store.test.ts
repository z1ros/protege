/**
 * Regression tests for three behavioral contracts in store.ts:
 *   A — save() serializes concurrent writes (no interleaving / truncation)
 *   B — withStoreBatch collapses inner saves to one fs.writeFile call
 *   C — bumpFileAuthorship cap sweep is per-user, doesn't drop other users' rows
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "protege-store-test-"));
}

/**
 * Dynamically import store.ts after setting process.cwd() to a temp dir so
 * the module-level `FILE` constant points to a throwaway location.
 * Each call returns a fresh module (via cache-busting query string trick with
 * vitest's `vi.resetModules`).
 */
async function loadStoreFresh(cwd: string) {
  vi.resetModules();
  const orig = process.cwd();
  process.chdir(cwd);
  try {
    const mod = await import("./store.js");
    return mod;
  } finally {
    process.chdir(orig);
  }
}

// ---------------------------------------------------------------------------
// Contract A — save() serializes concurrent writes
// ---------------------------------------------------------------------------

describe("Contract A — concurrent mutations produce valid, complete JSON", () => {
  let tmpDir: string;
  let origCwd: string;
  let store: Awaited<ReturnType<typeof loadStoreFresh>>;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    origCwd = process.cwd();
    store = await loadStoreFresh(tmpDir);
    // Ensure the module cwd stays pointing to tmpDir for the duration of the test
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("A1 — 50 concurrent bumpFileAuthorship calls produce parseable JSON with all rows", async () => {
    // Counterfactual: would fail if two parallel writes interleaved and truncated each other.
    const userId = "user-a1";
    // Prime the cache with one sequential call so all concurrent callers share the same cache object
    await store.ensureUser(userId);
    const filePaths = Array.from({ length: 50 }, (_, i) => `/project/file-${i}.ts`);

    await Promise.all(
      filePaths.map((fp) =>
        store.bumpFileAuthorship(userId, fp, { humanChars: 10, aiChars: 5 })
      )
    );

    const storeFile = path.join(tmpDir, ".protege-store.json");
    const raw = await fs.readFile(storeFile, "utf-8");
    const parsed = JSON.parse(raw) as { fileAuthorshipCounters: Array<{ userId: string; filePath: string }> };

    expect(() => JSON.parse(raw)).not.toThrow();

    const userRows = parsed.fileAuthorshipCounters.filter(
      (r) => r.userId === userId
    );
    expect(userRows.length).toBe(50);

    const presentPaths = new Set(userRows.map((r) => r.filePath));
    for (const fp of filePaths) {
      expect(presentPaths.has(fp)).toBe(true);
    }
  });

  it("A2 — mixed concurrent mutations (bumpFileAuthorship + appendEchoEvents) produce valid JSON", async () => {
    // Counterfactual: would fail if two parallel writes interleaved and truncated each other.
    const userId = "user-a2";
    // Prime the cache before firing concurrent mutations
    await store.ensureUser(userId);
    const bumps = Array.from({ length: 25 }, (_, i) =>
      store.bumpFileAuthorship(userId, `/proj/f${i}.ts`, { humanChars: 1, aiChars: 0 })
    );
    const echoEvents = Array.from({ length: 25 }, (_, i) =>
      store.appendEchoEvents([
        { userId, type: "keystroke_batch", ts: Date.now() + i, payload: {} },
      ])
    );

    await Promise.all([...bumps, ...echoEvents]);

    const storeFile = path.join(tmpDir, ".protege-store.json");
    const raw = await fs.readFile(storeFile, "utf-8");

    expect(() => JSON.parse(raw)).not.toThrow();

    const parsed = JSON.parse(raw) as {
      fileAuthorshipCounters: Array<{ userId: string }>;
      echoEvents: Array<{ userId: string }>;
    };
    const authorshipRows = parsed.fileAuthorshipCounters.filter(
      (r) => r.userId === userId
    );
    expect(authorshipRows.length).toBe(25);
  });

  it("A3 — all bumpFileAuthorship totals are correct after concurrent writes", async () => {
    // Counterfactual: would fail if a write interleaved and dropped an in-flight mutation.
    const userId = "user-a3";
    const filePath = "/project/shared.ts";

    // Prime the cache first
    await store.ensureUser(userId);

    // Fire 20 concurrent bumps of 5 human chars each to the same file
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.bumpFileAuthorship(userId, filePath, { humanChars: 5, aiChars: 0 })
      )
    );

    const rows = await store.readFileAuthorshipRows(userId);
    const row = rows.find((r) => r.filePath === filePath);
    expect(row).toBeDefined();
    // All 20 increments of 5 must be reflected
    expect(row!.humanChars).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Contract B — withStoreBatch collapses inner saves to one fs.writeFile call
// ---------------------------------------------------------------------------

describe("Contract B — withStoreBatch collapses saves to one writeFile call", () => {
  let tmpDir: string;
  let origCwd: string;
  let store: Awaited<ReturnType<typeof loadStoreFresh>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: MockInstance<(...args: any[]) => any>;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    origCwd = process.cwd();
    store = await loadStoreFresh(tmpDir);
    process.chdir(tmpDir);
    // Spy AFTER module load so we capture writes through the same fs import
    writeSpy = vi.spyOn(fs, "writeFile");
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("B1 — N mutations inside withStoreBatch produce exactly 1 writeFile call", async () => {
    // Counterfactual: would fail if every mutation called writeFile unconditionally during batch.
    const userId = "user-b1";
    writeSpy.mockClear();

    await store.withStoreBatch(async () => {
      for (let i = 0; i < 10; i++) {
        await store.bumpFileAuthorship(userId, `/f${i}.ts`, { humanChars: 1, aiChars: 0 });
      }
      for (let i = 0; i < 5; i++) {
        await store.appendEchoEvents([
          { userId, type: "test", ts: Date.now() + i, payload: {} },
        ]);
      }
      for (let i = 0; i < 3; i++) {
        await store.setConceptStatus(userId, `concept-${i}`, "known");
      }
    });

    // Only one writeFile should have been issued (at batch exit)
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("B2 — without withStoreBatch, N mutations call writeFile at least N times (baseline)", async () => {
    // Counterfactual: if writeFile were somehow suppressed globally this test would fail, proving the spy works.
    const userId = "user-b2";
    writeSpy.mockClear();

    for (let i = 0; i < 5; i++) {
      await store.bumpFileAuthorship(userId, `/g${i}.ts`, { humanChars: 1, aiChars: 0 });
    }
    for (let i = 0; i < 3; i++) {
      await store.appendEchoEvents([
        { userId, type: "baseline", ts: Date.now() + i, payload: {} },
      ]);
    }

    expect(writeSpy.mock.calls.length).toBeGreaterThanOrEqual(8);
  });

  it("B3 — nested withStoreBatch calls produce exactly 1 writeFile at outermost exit", async () => {
    // Counterfactual: would fail if the inner batch exit flushed prematurely.
    const userId = "user-b3";
    writeSpy.mockClear();

    await store.withStoreBatch(async () => {
      await store.bumpFileAuthorship(userId, "/outer.ts", { humanChars: 1, aiChars: 0 });
      await store.withStoreBatch(async () => {
        await store.bumpFileAuthorship(userId, "/inner.ts", { humanChars: 2, aiChars: 0 });
        await store.appendEchoEvents([
          { userId, type: "nested", ts: Date.now(), payload: {} },
        ]);
      });
      await store.setConceptStatus(userId, "after-inner", "known");
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("B4 — state written inside a batch is observable via public readers after batch resolves", async () => {
    // Counterfactual: would fail if the batch discarded mutations instead of deferring only the flush.
    const userId = "user-b4";

    await store.withStoreBatch(async () => {
      await store.bumpFileAuthorship(userId, "/batch-file.ts", { humanChars: 42, aiChars: 7 });
      await store.setConceptStatus(userId, "batch-concept", "not_known");
    });

    const rows = await store.readFileAuthorshipRows(userId);
    const authRow = rows.find((r) => r.filePath === "/batch-file.ts");
    expect(authRow).toBeDefined();
    expect(authRow!.humanChars).toBe(42);
    expect(authRow!.aiChars).toBe(7);

    const statuses = await store.readConceptStatuses(userId);
    const statusRow = statuses.find((r) => r.concept === "batch-concept");
    expect(statusRow).toBeDefined();
    expect(statusRow!.status).toBe("not_known");
  });
});

// ---------------------------------------------------------------------------
// Contract C — bumpFileAuthorship cap is per-user, doesn't drop other users
// ---------------------------------------------------------------------------

describe("Contract C — bumpFileAuthorship cap is per-user isolation", () => {
  let tmpDir: string;
  let origCwd: string;
  let store: Awaited<ReturnType<typeof loadStoreFresh>>;

  // The module-level cap constant
  const CAP = 500;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    origCwd = process.cwd();
    store = await loadStoreFresh(tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: insert `count` rows for a given userId using bumpFileAuthorship.
   * We stagger updatedAt by bumping with slightly different ts via Date manipulation.
   * Since bumpFileAuthorship stamps updatedAt = new Date().toISOString() internally,
   * we insert sequentially so rows get distinct updatedAt values.
   */
  async function seedRows(
    userId: string,
    count: number,
    prefix = "file"
  ): Promise<string[]> {
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      const fp = `/${prefix}-${i}.ts`;
      paths.push(fp);
      await store.bumpFileAuthorship(userId, fp, { humanChars: 1, aiChars: 0 });
    }
    return paths;
  }

  it("C1 — bumping userA beyond cap does not drop any of userB's rows", async () => {
    // Counterfactual: would fail if the sweep iterated all users and accidentally dropped userB's rows.
    const userA = "cap-user-a";
    const userB = "cap-user-b";

    // Seed userB with 10 rows — well below cap
    const userBPaths = await seedRows(userB, 10, "b-file");

    // Seed userA with CAP + 10 rows to trigger the cap sweep multiple times
    await seedRows(userA, CAP + 10, "a-file");

    const bRows = await store.readFileAuthorshipRows(userB);
    expect(bRows.length).toBe(10);

    const presentBPaths = new Set(bRows.map((r) => r.filePath));
    for (const fp of userBPaths) {
      expect(presentBPaths.has(fp)).toBe(true);
    }
  });

  it("C2 — userA's row count does not exceed MAX_FILE_AUTHORSHIP_ROWS_PER_USER after overshooting", async () => {
    // Counterfactual: would fail if the cap sweep never ran or ran only for other users.
    const userA = "cap-user-a2";

    await seedRows(userA, CAP + 20, "cap-file");

    const aRows = await store.readFileAuthorshipRows(userA);
    expect(aRows.length).toBeLessThanOrEqual(CAP);
  });

  it("C3 — eviction drops oldest-by-updatedAt rows for the current user", async () => {
    // Counterfactual: would fail if the eviction kept oldest and dropped newest.
    const userId = "cap-user-c3";

    // Seed exactly CAP rows — these are "old"
    const oldPaths = await seedRows(userId, CAP, "old");

    // Now add one more — this triggers eviction of the oldest row
    const newPath = "/new-file.ts";
    await store.bumpFileAuthorship(userId, newPath, { humanChars: 1, aiChars: 0 });

    const rows = await store.readFileAuthorshipRows(userId);
    expect(rows.length).toBeLessThanOrEqual(CAP);

    const presentPaths = new Set(rows.map((r) => r.filePath));

    // The newly added file must survive
    expect(presentPaths.has(newPath)).toBe(true);

    // The very first old file (oldest updatedAt) should have been evicted
    expect(presentPaths.has(oldPaths[0])).toBe(false);
  });

  it("C1b — userB's row values are unmodified after userA cap sweep", async () => {
    // Counterfactual: would fail if the cap rebuild accidentally mutated other users' rows.
    const userA = "cap-user-a-vals";
    const userB = "cap-user-b-vals";

    await store.bumpFileAuthorship(userB, "/b-special.ts", { humanChars: 99, aiChars: 33 });
    await seedRows(userA, CAP + 5, "av-file");

    const bRows = await store.readFileAuthorshipRows(userB);
    const bRow = bRows.find((r) => r.filePath === "/b-special.ts");
    expect(bRow).toBeDefined();
    expect(bRow!.humanChars).toBe(99);
    expect(bRow!.aiChars).toBe(33);
  });
});
