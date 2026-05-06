import { describe, it, expect } from "vitest";
import { classifyReadPattern } from "./rollupClassifier.js";

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
