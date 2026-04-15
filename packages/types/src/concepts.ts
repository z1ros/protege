/**
 * Concept metadata shared by backend (for weights, clusters, IQ math)
 * and extension (for display). The regex patterns for detection live only
 * in the extension — the backend never needs to parse source code.
 */

export type Cluster =
  | "react"
  | "async"
  | "functional"
  | "types"
  | "language-core"
  | "error-handling"
  | "python";

export interface ConceptMeta {
  name: string;
  weight: number; // 0.3 trivial · 1.0 core · 2.0 advanced · 3.0 expert
  cluster: Cluster;
}

export const CONCEPT_META: ConceptMeta[] = [
  // React
  { name: "React useState",          weight: 1.2, cluster: "react" },
  { name: "React useEffect",         weight: 1.5, cluster: "react" },
  { name: "React useEffect cleanup", weight: 2.2, cluster: "react" },
  { name: "React useMemo",           weight: 2.0, cluster: "react" },
  { name: "React useCallback",       weight: 2.0, cluster: "react" },
  { name: "React useRef",            weight: 1.5, cluster: "react" },
  { name: "React useReducer",        weight: 2.5, cluster: "react" },
  { name: "React custom hook",       weight: 2.8, cluster: "react" },
  { name: "React component",         weight: 1.0, cluster: "react" },

  // Async
  { name: "async/await",             weight: 1.5, cluster: "async" },
  { name: "Promises",                weight: 1.5, cluster: "async" },
  { name: "Promise.all concurrency", weight: 2.0, cluster: "async" },
  { name: "Async iteration",         weight: 2.2, cluster: "async" },
  { name: "Fetch API",               weight: 0.8, cluster: "async" },

  // Error handling
  { name: "Error handling",          weight: 1.2, cluster: "error-handling" },

  // Functional
  { name: "Array map",               weight: 0.6, cluster: "functional" },
  { name: "Array filter",            weight: 0.6, cluster: "functional" },
  { name: "Array reduce",            weight: 1.8, cluster: "functional" },
  { name: "Reducer pattern",         weight: 2.5, cluster: "functional" },
  { name: "Higher-order function",   weight: 2.3, cluster: "functional" },
  { name: "Destructuring",           weight: 0.5, cluster: "functional" },
  { name: "Spread / rest",           weight: 0.5, cluster: "functional" },
  { name: "Arrow functions",         weight: 0.3, cluster: "functional" },

  // Language core
  { name: "Classes",                 weight: 1.0, cluster: "language-core" },
  { name: "Template literals",       weight: 0.3, cluster: "language-core" },
  { name: "Optional chaining",       weight: 0.4, cluster: "language-core" },
  { name: "Nullish coalescing",      weight: 0.4, cluster: "language-core" },
  { name: "ES modules",              weight: 0.4, cluster: "language-core" },

  // TS types
  { name: "TypeScript interface",    weight: 1.0, cluster: "types" },
  { name: "TypeScript type alias",   weight: 1.0, cluster: "types" },
  { name: "TypeScript generics",     weight: 2.0, cluster: "types" },
  { name: "Generic constraints",     weight: 2.5, cluster: "types" },
  { name: "Conditional types",       weight: 3.0, cluster: "types" },
  { name: "Discriminated unions",    weight: 2.8, cluster: "types" },

  // Python
  { name: "Python list comprehension", weight: 1.2, cluster: "python" },
  { name: "Python decorators",       weight: 2.0, cluster: "python" },
  { name: "Python with-statement",   weight: 1.0, cluster: "python" },
  { name: "Python try/except",       weight: 1.2, cluster: "error-handling" },
  { name: "Python f-string",         weight: 0.4, cluster: "python" },
  { name: "Python async/await",      weight: 1.8, cluster: "async" },
  { name: "Python type hints",       weight: 1.2, cluster: "types" },
];

export const TOTAL_WEIGHT = CONCEPT_META.reduce((s, m) => s + m.weight, 0);

const BY_NAME = new Map(CONCEPT_META.map((m) => [m.name, m]));

export function conceptMeta(name: string): ConceptMeta | undefined {
  return BY_NAME.get(name);
}

export function conceptWeight(name: string): number {
  return BY_NAME.get(name)?.weight ?? 1.0;
}

export function conceptCluster(name: string): Cluster {
  return BY_NAME.get(name)?.cluster ?? "language-core";
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

/**
 * MVP IQ math — shared formula so backend and extension agree.
 *
 * Mastery curve: exponential — first uses feel rewarding, then taper.
 *   m(times) = 1 - exp(-times / 5)  → 63% @ 5, 86% @ 10, 95% @ 15
 *
 * Decay: linear over 60 days since last use, floor 30%.
 *   d(days) = max(0.3, 1 - days / 60)
 *
 * Quality penalty: each save that had errors on this concept costs 10%,
 * floor 40%. So a user who consistently produces buggy code can't coast.
 *   q(flags) = max(0.4, 1 - flags * 0.1)
 *
 * IQ = round( sum( weight[c] * m(t) * d(days) * q(flags) ) * K )
 *      K = 1000 / TOTAL_WEIGHT       (calibrated so max reachable = 1000)
 */

export const IQ_CEILING = 1000;
export const IQ_K = IQ_CEILING / TOTAL_WEIGHT;

export function masteryCurve(timesUsed: number): number {
  if (timesUsed <= 0) return 0;
  return 1 - Math.exp(-timesUsed / 5);
}

export function decayFactor(lastUsedAt: string, nowMs = Date.now()): number {
  const last = Date.parse(lastUsedAt);
  if (Number.isNaN(last)) return 1;
  const days = Math.max(0, (nowMs - last) / 86_400_000);
  return Math.max(0.3, 1 - days / 60);
}

export function qualityFactor(qualityFlags: number): number {
  return Math.max(0.4, 1 - qualityFlags * 0.1);
}
