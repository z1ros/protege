import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { computeLineDiff } from "@protege/types";

// Mirror the extension's hasher so fingerprints are deterministic here too.
const hashers = {
  hashString: (s: string) =>
    createHash("sha1").update(s).digest("hex").slice(0, 16),
};

describe("computeLineDiff", () => {
  it("empty prior, 3-line current → 3 added, 0 removed, 0 rewritten", () => {
    const res = computeLineDiff([], ["a", "b", "c"], "f.ts", hashers);
    expect(res.linesAdded).toBe(3);
    expect(res.linesRemoved).toBe(0);
    expect(res.rewritten).toHaveLength(0);
  });

  it("identical prior/current → 0/0/0", () => {
    const lines = ["a", "b", "c"];
    const res = computeLineDiff(lines, [...lines], "f.ts", hashers);
    expect(res.linesAdded).toBe(0);
    expect(res.linesRemoved).toBe(0);
    expect(res.rewritten).toHaveLength(0);
  });

  it("single line appended → 1 added, 0 removed, 0 rewritten", () => {
    const res = computeLineDiff(
      ["a", "b"],
      ["a", "b", "c"],
      "f.ts",
      hashers
    );
    expect(res.linesAdded).toBe(1);
    expect(res.linesRemoved).toBe(0);
    expect(res.rewritten).toHaveLength(0);
  });

  it("single line removed → 0 added, 1 removed, 0 rewritten", () => {
    const res = computeLineDiff(
      ["a", "b", "c"],
      ["a", "b"],
      "f.ts",
      hashers
    );
    expect(res.linesAdded).toBe(0);
    expect(res.linesRemoved).toBe(1);
    expect(res.rewritten).toHaveLength(0);
  });

  it("line at index 2 replaced → +1/-1 AND 1 rewrite fingerprint", () => {
    const res = computeLineDiff(
      ["a", "b", "foo"],
      ["a", "b", "bar"],
      "f.ts",
      hashers
    );
    expect(res.linesAdded).toBe(1);
    expect(res.linesRemoved).toBe(1);
    expect(res.rewritten).toHaveLength(1);
    expect(res.rewritten[0].roughLine).toBe(3);
    expect(res.rewritten[0].sampleContent).toBe("bar");
  });

  it("two adjacent lines swapped → multiset equal but 2 rewrites", () => {
    const res = computeLineDiff(
      ["a", "b"],
      ["b", "a"],
      "f.ts",
      hashers
    );
    expect(res.linesAdded).toBe(0);
    expect(res.linesRemoved).toBe(0);
    expect(res.rewritten).toHaveLength(2);
  });

  it("blank-line-only change is ignored", () => {
    const res = computeLineDiff(
      ["  ", "foo"],
      ["", "foo"],
      "f.ts",
      hashers
    );
    expect(res.linesAdded).toBe(0);
    expect(res.linesRemoved).toBe(0);
    expect(res.rewritten).toHaveLength(0);
  });
});
