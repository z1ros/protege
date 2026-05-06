import { describe, it, expect } from "vitest";
import { detectFieldFromRepo } from "./fieldVector.js";

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
