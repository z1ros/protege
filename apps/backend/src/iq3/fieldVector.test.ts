import { describe, it, expect } from "vitest";
import { detectFieldFromRepo, updateFieldVector } from "./fieldVector.js";
import { uniformFieldPrior } from "@protege/types";

describe("repo archaeology", () => {
  it("flags 'web' for a typical React repo", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: ["react", "next", "tailwindcss"],
      fileExtensions: { ".tsx": 12, ".ts": 5, ".css": 4 },
      infraFiles: [],
    });
    expect(result.web).toBeGreaterThan(0.4);
    expect(result.web).toBeGreaterThan(result.ml);
  });

  it("flags 'ml' for a typical PyTorch repo", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: [],
      requirementsTxt: ["torch", "numpy", "pandas"],
      fileExtensions: { ".py": 30, ".ipynb": 8 },
      infraFiles: [],
    });
    expect(result.ml).toBeGreaterThan(0.4);
  });

  it("flags 'devOps' for an infra-heavy repo", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: [],
      fileExtensions: { ".yaml": 20, ".tf": 10, ".sh": 5 },
      infraFiles: ["Dockerfile", "k8s/deployment.yaml", "main.tf"],
    });
    expect(result.devOps).toBeGreaterThan(0.35);
  });

  it("returns a uniform-ish vector for empty signals", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: [],
      fileExtensions: {},
      infraFiles: [],
    });
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(result.generalist).toBeGreaterThan(0.15);
  });

  it("vector always sums to 1.0", () => {
    const result = detectFieldFromRepo({
      packageJsonDeps: ["react", "torch"],
      fileExtensions: { ".tsx": 5, ".py": 10 },
      infraFiles: ["Dockerfile"],
    });
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});

describe("combined field vector update", () => {
  it("blends repo + concepts + self-declared with spec weights", () => {
    const v = updateFieldVector({
      prior: uniformFieldPrior(),
      repoSignals: { packageJsonDeps: ["react"], fileExtensions: { ".tsx": 5 }, infraFiles: [] },
      conceptCounts: { "py-pytorch": 3 },
      selfDeclared: "ml",
      daysSinceLastUpdate: 1,
    });
    // ML or web should dominate (mix of strong signals)
    const dom = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
    expect(["ml", "web"]).toContain(dom);
    expect(Object.values(v).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 5);
  });
});
