/**
 * Concept metadata + regex detection rules.
 *
 * weight:  0.3 trivial · 1.0 core · 2.0 advanced · 3.0 expert
 * cluster: used by the Concepts tab to group related skills
 *
 * Responsibility split:
 *   - JS/TS concepts: detected by the AST layer (astDetector.ts). The
 *     entries below still carry weight + cluster metadata so callers like
 *     weakSpots and IQ scoring can look them up by name, but their
 *     `languages` arrays are empty so the regex runner skips them.
 *   - Python concepts: detected by the regex runner here (detector.ts) —
 *     AST doesn't cover Python. Python regexes are hand-tuned; the rest
 *     are metadata-only.
 */

export type Cluster =
  | "react"
  | "async"
  | "functional"
  | "types"
  | "language-core"
  | "error-handling"
  | "python";

export interface Rule {
  name: string;
  /** Languages the regex should run against. Empty = metadata-only (AST handles it). */
  languages: string[];
  patterns: RegExp[];
  weight: number;
  cluster: Cluster;
}

const PY = ["python"];

export const RULES: Rule[] = [
  // ===== React (metadata-only — AST detects these) =====
  { name: "React useState",      languages: [], weight: 1.2, cluster: "react", patterns: [] },
  { name: "React useEffect",     languages: [], weight: 1.5, cluster: "react", patterns: [] },
  { name: "React useEffect cleanup", languages: [], weight: 2.2, cluster: "react", patterns: [] },
  { name: "React useMemo",       languages: [], weight: 2.0, cluster: "react", patterns: [] },
  { name: "React useCallback",   languages: [], weight: 2.0, cluster: "react", patterns: [] },
  { name: "React useRef",        languages: [], weight: 1.5, cluster: "react", patterns: [] },
  { name: "React useReducer",    languages: [], weight: 2.5, cluster: "react", patterns: [] },
  { name: "React custom hook",   languages: [], weight: 2.8, cluster: "react", patterns: [] },
  { name: "React component",     languages: [], weight: 1.0, cluster: "react", patterns: [] },

  // ===== Async (metadata-only — AST detects these) =====
  { name: "async/await",         languages: [], weight: 1.5, cluster: "async", patterns: [] },
  { name: "Promises",            languages: [], weight: 1.5, cluster: "async", patterns: [] },
  { name: "Promise.all concurrency", languages: [], weight: 2.0, cluster: "async", patterns: [] },
  { name: "Async iteration",     languages: [], weight: 2.2, cluster: "async", patterns: [] },
  { name: "Fetch API",           languages: [], weight: 0.8, cluster: "async", patterns: [] },

  // ===== Error handling (metadata-only — AST detects the JS/TS try/catch) =====
  { name: "Error handling",      languages: [], weight: 1.2, cluster: "error-handling", patterns: [] },

  // ===== Functional (metadata-only — AST detects these) =====
  { name: "Array map",           languages: [], weight: 0.6, cluster: "functional", patterns: [] },
  { name: "Array filter",        languages: [], weight: 0.6, cluster: "functional", patterns: [] },
  { name: "Array reduce",        languages: [], weight: 1.8, cluster: "functional", patterns: [] },
  { name: "Reducer pattern",     languages: [], weight: 2.5, cluster: "functional", patterns: [] },
  { name: "Higher-order function", languages: [], weight: 2.3, cluster: "functional", patterns: [] },
  { name: "Destructuring",       languages: [], weight: 0.5, cluster: "functional", patterns: [] },
  { name: "Spread / rest",       languages: [], weight: 0.5, cluster: "functional", patterns: [] },
  { name: "Arrow functions",     languages: [], weight: 0.3, cluster: "functional", patterns: [] },

  // ===== Language core (metadata-only — AST detects these) =====
  { name: "Classes",             languages: [], weight: 1.0, cluster: "language-core", patterns: [] },
  { name: "Template literals",   languages: [], weight: 0.3, cluster: "language-core", patterns: [] },
  { name: "Optional chaining",   languages: [], weight: 0.4, cluster: "language-core", patterns: [] },
  { name: "Nullish coalescing",  languages: [], weight: 0.4, cluster: "language-core", patterns: [] },
  { name: "ES modules",          languages: [], weight: 0.4, cluster: "language-core", patterns: [] },

  // ===== TypeScript types (metadata-only — AST detects these) =====
  { name: "TypeScript interface", languages: [], weight: 1.0, cluster: "types", patterns: [] },
  { name: "TypeScript type alias", languages: [], weight: 1.0, cluster: "types", patterns: [] },
  { name: "TypeScript generics", languages: [], weight: 2.0, cluster: "types", patterns: [] },
  { name: "Generic constraints", languages: [], weight: 2.5, cluster: "types", patterns: [] },
  { name: "Conditional types",   languages: [], weight: 3.0, cluster: "types", patterns: [] },
  { name: "Discriminated unions", languages: [], weight: 2.8, cluster: "types", patterns: [] },

  // ===== Python (regex-detected — AST doesn't cover Python) =====
  { name: "Python list comprehension", languages: PY, weight: 1.2, cluster: "python",
    patterns: [/\[[^\]]*\bfor\b[^\]]*\]/] },
  // Dotted decorators like @functools.wraps and @app.route.
  { name: "Python decorators",   languages: PY, weight: 2.0, cluster: "python",
    patterns: [/^@[\w.]+/m] },
  // Non-greedy so it doesn't cross unrelated code between `with` and `as`.
  { name: "Python with-statement", languages: PY, weight: 1.0, cluster: "python",
    patterns: [/\bwith\s+.+?\s+as\s+\w+\s*:/] },
  { name: "Python try/except",   languages: PY, weight: 1.2, cluster: "error-handling",
    patterns: [/\btry\s*:[\s\S]*?\bexcept\b/] },
  // Inner bracket class `[^{}]+` excludes nested braces in format specs like `f"{x:{w}}"`.
  { name: "Python f-string",     languages: PY, weight: 0.4, cluster: "python",
    patterns: [/f["'][^"']*\{[^{}]+\}/] },
  { name: "Python async/await",  languages: PY, weight: 1.8, cluster: "async",
    patterns: [/\basync\s+def\b/, /\bawait\s+/] },
  // Single-line arg annotation OR return-type annotation (catches multi-line signatures).
  { name: "Python type hints",   languages: PY, weight: 1.2, cluster: "types",
    patterns: [
      /def\s+\w+\s*\([^)]*:\s*\w+/,
      /def\s+\w+\s*\([\s\S]{0,200}?\)\s*->\s*[\w\[\], ]+\s*:/,
    ] },
];

/** Sum of all rule weights — the theoretical maximum before calibration. */
export const TOTAL_WEIGHT = RULES.reduce((s, r) => s + r.weight, 0);

/** Lookup by concept name. */
const RULE_BY_NAME = new Map(RULES.map((r) => [r.name, r]));

export function getRule(name: string): Rule | undefined {
  return RULE_BY_NAME.get(name);
}

export function getWeight(name: string): number {
  return RULE_BY_NAME.get(name)?.weight ?? 1.0;
}

export function getCluster(name: string): Cluster {
  return RULE_BY_NAME.get(name)?.cluster ?? "language-core";
}

export const CLUSTER_LABELS: Record<Cluster, string> = {
  react: "React",
  async: "Async & Promises",
  functional: "Functional JS",
  types: "Type Systems",
  "language-core": "Language Core",
  "error-handling": "Error Handling",
  python: "Python Idioms",
};
