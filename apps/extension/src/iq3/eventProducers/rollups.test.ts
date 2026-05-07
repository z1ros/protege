import { describe, it, expect } from "vitest";
import { classifyReadPattern, shouldCountAsEdit } from "./rollupClassifier.js";

/**
 * Unit tests for the rollup classifier(s). The full producer wires
 * VS Code APIs and a setTimeout-based windowing layer; testing those
 * end-to-end requires a VS Code mock + fake timers and is verified
 * manually via dev-host smoke. The classifier is the only piece that
 * carries a non-trivial decision boundary, so we cover it here.
 */
describe("classifyReadPattern", () => {
  it("returns 'deep' for >=30s + >=2 navs", () => {
    expect(classifyReadPattern(35000, 2)).toBe("deep");
    expect(classifyReadPattern(60000, 5)).toBe("deep");
  });

  it("returns 'jump-in' for <5s + 0 navs", () => {
    expect(classifyReadPattern(2000, 0)).toBe("jump-in");
    expect(classifyReadPattern(0, 0)).toBe("jump-in");
  });

  it("returns 'skim' for in-between values", () => {
    expect(classifyReadPattern(10000, 1)).toBe("skim");
    expect(classifyReadPattern(35000, 1)).toBe("skim"); // long but few navs
    expect(classifyReadPattern(2000, 1)).toBe("skim"); // fast but a nav
    expect(classifyReadPattern(20000, 0)).toBe("skim");
  });

  it("treats the 30s + 2-nav threshold as inclusive", () => {
    expect(classifyReadPattern(30000, 2)).toBe("deep");
  });

  it("treats the 5s threshold as exclusive (5s exactly is NOT jump-in)", () => {
    expect(classifyReadPattern(5000, 0)).toBe("skim");
  });
});

/**
 * Codex review follow-up: paste/AI-accept rollups self-invalidated
 * because the originating event is itself a text_change. Gate on
 * `TextDocument.version` (primary) plus a small time-grace
 * (defensive secondary) so the paste's own change handler doesn't
 * flip editedDuring on its own paste.
 */
describe("shouldCountAsEdit", () => {
  it("rejects same-version change (the paste itself)", () => {
    expect(shouldCountAsEdit(5, 5, 1000, 2000)).toBe(false);
  });

  it("rejects within grace window even if version higher", () => {
    expect(shouldCountAsEdit(5, 6, 1000, 1050)).toBe(false);
  });

  it("accepts higher version + outside grace", () => {
    expect(shouldCountAsEdit(5, 6, 1000, 2000)).toBe(true);
  });

  it("rejects lower version (impossible but defensive)", () => {
    expect(shouldCountAsEdit(5, 4, 1000, 2000)).toBe(false);
  });
});
