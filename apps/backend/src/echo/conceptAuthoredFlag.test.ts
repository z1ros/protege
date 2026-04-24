import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Stickiness test for `setConceptAuthoredFlag`. The store module reads
 * `path.join(process.cwd(), ".protege-store.json")` at import time, so we
 * chdir into a fresh tmp dir BEFORE importing the module via dynamic
 * import. Each test gets a fresh module instance via `vi.resetModules` and
 * a fresh cwd so the on-disk file doesn't leak between tests or into the
 * real backend package dir.
 */

let originalCwd: string;
let tmpRoot: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpRoot = await mkdtemp(path.join(tmpdir(), "protege-store-test-root-"));
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

let tmpCwd: string;

beforeEach(async () => {
  tmpCwd = await mkdtemp(path.join(tmpRoot, "case-"));
  process.chdir(tmpCwd);
  vi.resetModules();
});

afterEach(async () => {
  process.chdir(tmpRoot);
  try {
    await rm(tmpCwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function loadStore() {
  // Dynamic import so each `vi.resetModules()` really gives us a fresh
  // module with FILE recomputed against the current cwd.
  return await import("../store.js");
}

describe("setConceptAuthoredFlag stickiness", () => {
  it("first call stamps hasBeenAuthored=true and sets firstAuthoredAt", async () => {
    const store = await loadStore();
    const uid = "u1";
    const concept = "react-hooks";
    await store.ensureUser(uid);
    await store.recordConcepts(uid, {
      filePath: "/tmp/fake-file.ts",
      fileHash: "h1",
      errorCount: 0,
      concepts: [concept],
      hasErrors: false,
    });
    const firstAt = "2026-04-01T00:00:00.000Z";
    await store.setConceptAuthoredFlag(uid, concept, firstAt);
    const states = await store.readConceptStates(uid);
    const row = states.find((s) => s.conceptName === concept);
    expect(row?.hasBeenAuthored).toBe(true);
    expect(row?.firstAuthoredAt).toBe(firstAt);
  });

  it("second call with later timestamp does NOT overwrite firstAuthoredAt", async () => {
    const store = await loadStore();
    const uid = "u2";
    const concept = "async-await";
    await store.ensureUser(uid);
    await store.recordConcepts(uid, {
      filePath: "/tmp/fake-file.ts",
      fileHash: "h2",
      errorCount: 0,
      concepts: [concept],
      hasErrors: false,
    });
    const firstAt = "2026-04-01T00:00:00.000Z";
    const laterAt = "2026-04-05T12:00:00.000Z";
    await store.setConceptAuthoredFlag(uid, concept, firstAt);
    await store.setConceptAuthoredFlag(uid, concept, laterAt);
    const states = await store.readConceptStates(uid);
    const row = states.find((s) => s.conceptName === concept);
    expect(row?.hasBeenAuthored).toBe(true);
    // firstAuthoredAt must stay pinned at the original value.
    expect(row?.firstAuthoredAt).toBe(firstAt);
  });

  it("setting flag on a non-existent concept is a no-op (no throw)", async () => {
    const store = await loadStore();
    const uid = "u3";
    await store.ensureUser(uid);
    await expect(
      store.setConceptAuthoredFlag(uid, "does-not-exist", "2026-04-01T00:00:00Z")
    ).resolves.toBeUndefined();
  });
});
