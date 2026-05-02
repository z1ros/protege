import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sha256OfFile } from "./fetchAssets.js";

/**
 * Tests for `sha256OfFile` — written against its docstring only.
 *
 * Spec recap:
 *   - Stream-hashes a file with SHA-256, returns hex digest.
 *   - Streaming so memory stays flat regardless of archive size.
 *
 * NOTE: We exported the helper for testability. The full
 * `fetchVoiceAssets` integrity-check flow that consumes this helper is
 * documented in the parent task's "manual repro" section — it requires
 * a fake HTTP server that's outside this unit test's scope.
 */
describe("sha256OfFile", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fetchAssets-test-"));
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it("hashes the canonical 'abc' test vector", async () => {
    const p = path.join(tmpDir, "abc.txt");
    fs.writeFileSync(p, "abc");
    const hash = await sha256OfFile(p);
    // Canonical SHA-256("abc") fixture from FIPS 180-4.
    expect(hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("matches an in-memory crypto.createHash reference for a 5MB random buffer", async () => {
    const buf = crypto.randomBytes(5 * 1024 * 1024);
    const expected = crypto.createHash("sha256").update(buf).digest("hex");
    const p = path.join(tmpDir, "random-5mb.bin");
    fs.writeFileSync(p, buf);
    const actual = await sha256OfFile(p);
    expect(actual).toBe(expected);
  });

  it("rejects when the file does not exist", async () => {
    const p = path.join(tmpDir, "definitely-not-a-real-file.bin");
    await expect(sha256OfFile(p)).rejects.toBeDefined();
  });

  it("hashes an empty file to the canonical SHA-256 of empty input", async () => {
    const p = path.join(tmpDir, "empty.bin");
    fs.writeFileSync(p, "");
    const hash = await sha256OfFile(p);
    // SHA-256 of zero-length input.
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});
