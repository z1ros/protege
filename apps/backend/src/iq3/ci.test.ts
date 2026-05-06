import { describe, it, expect } from "vitest";
import { composeHeadlineCi } from "./ci.js";

describe("CI composer", () => {
  it("returns wider CI when pillar uncertainties are large", () => {
    const a = composeHeadlineCi({
      pillarHalfWidths: [50, 50, 50, 50, 50, 50],
      fieldEntropy: 0.3,
    });
    const b = composeHeadlineCi({
      pillarHalfWidths: [10, 10, 10, 10, 10, 10],
      fieldEntropy: 0.3,
    });
    expect(a.halfWidth).toBeGreaterThan(b.halfWidth);
  });

  it("returns wider CI when field entropy is high", () => {
    const a = composeHeadlineCi({
      pillarHalfWidths: [30, 30, 30, 30, 30, 30],
      fieldEntropy: 0.9,
    });
    const b = composeHeadlineCi({
      pillarHalfWidths: [30, 30, 30, 30, 30, 30],
      fieldEntropy: 0.1,
    });
    expect(a.halfWidth).toBeGreaterThan(b.halfWidth);
  });
});
