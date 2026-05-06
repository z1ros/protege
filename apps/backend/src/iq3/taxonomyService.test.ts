import { describe, it, expect } from "vitest";
import {
  fieldsForConcept,
  fieldVectorFromConceptCounts,
} from "./taxonomyService.js";

describe("taxonomyService", () => {
  it("returns tags for a known concept", () => {
    expect(fieldsForConcept("py-pytorch")).toContain("ml");
  });

  it("falls back to generalist for unknown concepts", () => {
    expect(fieldsForConcept("not-a-real-concept-xyz")).toEqual(["generalist"]);
  });

  it("computes a field vector from concept demonstration counts", () => {
    const counts = { "py-pytorch": 3, "py-numpy": 2, "react-hooks": 1 };
    const v = fieldVectorFromConceptCounts(counts);
    expect(v.ml).toBeGreaterThan(v.web);
    expect(Object.values(v).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 5);
  });
});
